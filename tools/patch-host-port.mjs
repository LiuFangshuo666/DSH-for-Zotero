// 让提取出的 dsh 宿主支持环境变量端口（否则端口写死 19387，与桌面版冲突）。
//
// 背景：dsh-desktop-host/lib/index.js 里把端口硬编码在 args 中：
//     args: ["--no-open", "--port", "19387"]
// 我们拉起独立宿主时因此必然与桌面版撞端口（实测 EADDRINUSE）。
//
// 做法：把该字面量替换为读取 DSH_FOR_ZOTERO_PORT（缺省 19387）。
// **只改这一处**，并且改的是我们自己的提取副本，不动用户安装的 Harness。
// 幂等：已替换过则跳过。
//
// 用法：node tools/patch-host-port.mjs --runtime <提取目录> [--dry-run]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--runtime") out.runtime = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.runtime) {
  console.error(
    "用法: node tools/patch-host-port.mjs --runtime <提取目录> [--dry-run]",
  );
  process.exit(2);
}

const target = join(
  args.runtime,
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "index.js",
);
if (!existsSync(target)) {
  console.error(`找不到宿主入口：${target}`);
  process.exit(1);
}

const MARKER = "DSH_FOR_ZOTERO_PORT";
let text = readFileSync(target, "utf8");

if (text.includes(MARKER)) {
  console.log("已打过端口补丁（幂等跳过）");
  process.exit(0);
}

// 匹配 args 数组里的端口字面量："--port", "19387"
const pattern = /("--port",\s*\n?\s*)"19387"/;
if (!pattern.test(text)) {
  // 退化匹配：直接替换裸字面量，但仍要求上下文含 --port
  const loose = /(\.\.\.\s*)?("--port"\s*,\s*)"19387"/;
  if (!loose.test(text)) {
    console.error("未找到硬编码端口，宿主版本可能已变化；请人工确认后再处理。");
    process.exit(1);
  }
  text = text.replace(loose, `$1$2String(process.env.${MARKER} ?? "19387")`);
} else {
  text = text.replace(pattern, `$1String(process.env.${MARKER} ?? "19387")`);
}

// 在文件顶部加一行注释，便于日后识别这是被改过的副本
const banner =
  `// [DSH-for-Zotero] 端口改为读取环境变量 ${MARKER}（缺省 19387），` +
  `以便与桌面版 Harness 并行运行。此行及下方 args 的改动由插件维护。\n`;
text = banner + text;

if (args.dryRun) {
  console.log("[dry-run] 将写入补丁到 " + target);
  process.exit(0);
}
writeFileSync(target, text);
console.log(`已打端口补丁：${target}`);
console.log(`  端口来源：process.env.${MARKER}（缺省 19387）`);
