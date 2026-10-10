// 把 app.asar.unpacked 里的原生模块合并进提取出的 dsh 运行时树。
//
// 为什么必须做：asar 内的文件是**压缩存储**的，提取出来的 `.node` 无法被 `dlopen`
// （实测报 `No usable native binding found for node-addon-require-builtin-win32-x64-msvc`）。
// 可加载的二进制在 `app.asar.unpacked/dsh/node_modules/...`，两边目录结构一致，
// 因此按路径覆盖即可。
//
// 与 extract-dsh-runtime.mjs 的关系：那个脚本负责"从 asar 提取 JS 树"，
// 本脚本负责"用磁盘上的原生模块覆盖同名文件"。两步合起来才是完整的运行时。
//
// 用法：
//   node tools/merge-native-modules.mjs --unpacked "<app.asar.unpacked>/dsh" --dest "<提取目录>" [--dry-run]

import {
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--unpacked") out.unpacked = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.unpacked || !args.dest) {
  console.error(
    "用法: node tools/merge-native-modules.mjs --unpacked <app.asar.unpacked/dsh> --dest <提取目录> [--dry-run]",
  );
  process.exit(2);
}

/** 递归列出文件 */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

console.log(`来源（解包）: ${args.unpacked}`);
console.log(`目标（提取）: ${args.dest}`);

const files = listFiles(args.unpacked);
console.log(`解包目录共 ${files.length} 个文件`);

// 只关心原生二进制与它们的清单：.node/.dll/.exe 以及 @swc、@img 等包的完整内容
const wanted = (p) =>
  /\.(node|dll|exe|so|dylib)$/i.test(p) ||
  /[\\/](@swc|@img|node-pty|sherpa-onnx-win-x64|node-addon-require-builtin-win32-x64-msvc)[\\/]/i.test(
    p,
  );

let copied = 0;
let skipped = 0;
let bytes = 0;
for (const src of files) {
  if (!wanted(src)) continue;
  const rel = relative(args.unpacked, src);
  const dest = join(args.dest, rel);
  const size = statSync(src).size;
  // 已存在且大小相同 → 跳过（幂等）
  if (existsSync(dest) && statSync(dest).size === size) {
    skipped++;
    continue;
  }
  if (!args.dryRun) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  copied++;
  bytes += size;
}

console.log(
  `\n${args.dryRun ? "[dry-run] 将" : "已"}复制 ${copied} 个原生文件（${(bytes / 1024 / 1024).toFixed(1)} MB），跳过 ${skipped} 个（已一致）`,
);

// 报告关键的绑定文件是否到位
const keyCandidates = [
  "node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilt/win32-x64-msvc-napi-v9.node",
  "node_modules/node-pty/build/Release/pty.node",
];
for (const rel of keyCandidates) {
  const p = join(args.dest, rel);
  console.log(`  ${existsSync(p) ? "✅" : "⚠️ "} ${rel}`);
}
