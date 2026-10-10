// 从 app.asar 提取 dsh 运行时树到目标目录（方案 A 的实施工具）。
//
// 为什么需要：新设计要求"插件自己拉起专属 dsh 宿主，与本机 Harness 隔离"。
// 桌面版的宿主无法从 asar 内直接运行（普通 Node 不认 asar），因此必须先把
// /dsh/ 树落到磁盘。整棵树是自洽的（@deepseek-ai/dsh 内部含 profile-boot），
// 不需要重新安装依赖。
//
// 用法：
//   node tools/extract-dsh-runtime.mjs --asar "<app.asar>" --dest "<目标目录>" [--dry-run]
//
// 设计要点：
//  - **幂等**：已存在且大小一致的文件跳过（除非 --force），支持中断后续跑。
//  - **可核对**：结束后写一份 manifest.json（文件数、总字节、来源 asar 的摘要）。
//  - 只提取 /dsh/ 前缀；解包目录（app.asar.unpacked）里的原生模块由调用方按需链接。

import {
  mkdirSync,
  existsSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

function parseArgs(argv) {
  const out = { dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--asar") out.asar = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
    else if (a === "--prefix") out.prefix = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.asar || !args.dest) {
  console.error(
    "用法: node tools/extract-dsh-runtime.mjs --asar <app.asar> --dest <目录> [--prefix /dsh/] [--dry-run] [--force]",
  );
  process.exit(2);
}
const prefix = args.prefix ?? "/dsh/";

console.log(`来源 asar: ${args.asar}`);
console.log(`目标目录 : ${args.dest}`);
console.log(`提取前缀 : ${prefix}${args.dryRun ? "   [dry-run]" : ""}`);

const t0 = Date.now();
const buf = readFileSync(args.asar);
console.log(
  `已读入 asar：${(buf.length / 1024 / 1024).toFixed(1)} MB，耗时 ${Date.now() - t0} ms`,
);

// ── 解析 asar 头部 ──────────────────────────────────────────
// asar 不是普通 ZIP：头部（pickle）在**文件起始处**，不在尾部。
//   偏移 0  : uint32 = 4            （pickle 头长度）
//   偏移 4  : uint32 = headerSize+8 之类的 pickle 载荷长度
//   偏移 8  : uint32 = headerSize+4
//   偏移 12 : uint32 = headerSize    ← JSON 头的字节数
//   偏移 16 : JSON 头（形如 {"files":{...}}，可能有尾随填充）
// 文件数据从 16 + headerSize 起算，每条目的 offset 是相对该起点的偏移。
const headerSize = buf.readUInt32LE(12);
const headerJson = buf.subarray(16, 16 + headerSize).toString("utf8");
const tree = JSON.parse(headerJson.slice(0, headerJson.lastIndexOf("}") + 1));

/** 收集 { 相对路径 -> {offset,size} } */
const files = [];
(function walk(node, pre) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = pre + "/" + name;
    if (value.files) walk(value, p);
    else if (value.offset !== undefined && value.size !== undefined) {
      files.push({
        path: p,
        offset: Number(value.offset),
        size: Number(value.size),
      });
    }
  }
})(tree, "");

const targets = files.filter((f) => f.path.startsWith(prefix));
const totalBytes = targets.reduce((sum, f) => sum + f.size, 0);
console.log(
  `asar 内共 ${files.length} 个文件；命中前缀 ${targets.length} 个，合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
);

if (args.dryRun) {
  console.log("\n[dry-run] 未写入任何文件。");
  process.exit(0);
}

// ── 提取 ────────────────────────────────────────────────────
// 数据区起点：头部之后（asar 没有逐条本地头，file 数据按 offset 从 dataStart 起算）
const dataStart = 16 + headerSize;
let written = 0;
let skipped = 0;
let bytesWritten = 0;
const started = Date.now();

for (const file of targets) {
  const rel = file.path.slice(prefix.length); // 去掉前缀
  const dest = join(args.dest, rel);
  try {
    if (!args.force && existsSync(dest) && statSync(dest).size === file.size) {
      skipped++;
      continue;
    }
  } catch {
    // 继续覆盖写
  }
  mkdirSync(dirname(dest), { recursive: true });
  const data = buf.subarray(
    dataStart + file.offset,
    dataStart + file.offset + file.size,
  );
  writeFileSync(dest, data);
  written++;
  bytesWritten += file.size;
  if (written % 2000 === 0) {
    const secs = (Date.now() - started) / 1000;
    console.log(
      `  已写入 ${written} 个（${(bytesWritten / 1024 / 1024).toFixed(0)} MB），${secs.toFixed(0)}s`,
    );
  }
}

// ── 写 manifest，便于日后核对与增量重提取 ────────────────────
const manifest = {
  schema: "dsh-for-zotero/runtime/v1",
  sourceAsar: args.asar,
  sourceAsarBytes: buf.length,
  prefix,
  extractedAt: new Date().toISOString(),
  fileCount: targets.length,
  totalBytes,
  written,
  skipped,
};
mkdirSync(args.dest, { recursive: true });
writeFileSync(
  join(args.dest, "dsh-runtime-manifest.json"),
  JSON.stringify(manifest, null, 2),
);

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n完成：写入 ${written} 个，跳过（已存在且大小一致）${skipped} 个，共 ${(bytesWritten / 1024 / 1024).toFixed(1)} MB，耗时 ${secs}s`,
);
console.log(`manifest: ${join(args.dest, "dsh-runtime-manifest.json")}`);

// 顺带报告顶层目录，便于人工确认
try {
  console.log(
    "目标目录顶层：" + readdirSync(args.dest).slice(0, 10).join(", "),
  );
} catch {
  // 忽略
}
