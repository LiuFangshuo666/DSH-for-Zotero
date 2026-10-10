// 验证插件侧 RuntimeManager.extractFromAsar 的**算法**是否正确。
//
// 动机：那段逻辑在 Zotero 沙箱里跑（TS + IOUtils），难以单独调试；而它一旦出错，
// 表现会是"插件启动后一直连不上"这种难定位的症状。所以这里用 Node 复刻同一套算法
// （头部解析 → 前缀过滤 → 数据切片 → 幂等跳过），跑一遍并与已知结果核对。
//
// 与 TS 版的一致性要求：偏移 12 取头长度、JSON 从 16 起、数据从 16+头长度 起、
// 只取 /dsh/ 前缀、已存在且大小相同则跳过。
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const asar = process.argv[2];
const dest = process.argv[3];
if (!asar || !dest) {
  console.error(
    "用法: node tools/verify-extract-algorithm.mjs <app.asar> <目标目录>",
  );
  process.exit(2);
}

const ASAR_PREFIX = "/dsh/";
const bytes = readFileSync(asar);
console.log(`asar: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);

// ① 头部解析（与 TS 版同一算法）
const headerSize = bytes.readUInt32LE(12);
const headerText = bytes.subarray(16, 16 + headerSize).toString("utf8");
const tree = JSON.parse(headerText.slice(0, headerText.lastIndexOf("}") + 1));
const dataStart = 16 + headerSize;
console.log(`头部长度 ${headerSize}，数据起点 ${dataStart}`);

// ② 收集 /dsh/ 前缀下的文件
const targets = [];
(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (value.files) walk(value, p);
    else if (value.offset !== undefined && value.size !== undefined) {
      if (p.startsWith(ASAR_PREFIX))
        targets.push({
          path: p,
          offset: Number(value.offset),
          size: Number(value.size),
        });
    }
  }
})({ files: tree.files }, "");
console.log(`命中 ${ASAR_PREFIX} 的文件：${targets.length} 个`);

// ③ 与第一次提取的结果核对（幂等性）：全部应被跳过
let skipped = 0;
let missing = 0;
let sizeMismatch = 0;
for (const t of targets) {
  const rel = t.path.slice(ASAR_PREFIX.length);
  const d = join(dest, ...rel.split("/"));
  if (!existsSync(d)) {
    missing++;
    continue;
  }
  if (statSync(d).size === t.size) skipped++;
  else sizeMismatch++;
}
console.log(`\n与目标目录核对（幂等性）：`);
console.log(`  大小一致（会被跳过）: ${skipped}`);
console.log(`  缺失               : ${missing}`);
console.log(`  大小不一致          : ${sizeMismatch}`);

// ④ 抽 3 个关键文件验证**内容**能正确切片（防止偏移算错但大小恰好对上）
const critical = [
  "/dsh/package.json",
  "/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot.js",
];
// 宿主入口是**例外**：它被端口补丁刻意改过，因此内容必然与 asar 不一致。
// 单独核对"补丁还在"，而不是要求内容相同 —— 这一点最初被我写成了失败条件。
const patchedEntry =
  "/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js";
console.log(`\n关键文件内容抽样核对（不含被补丁改过的宿主入口）：`);
let allOk = true;
for (const path of critical) {
  const t = targets.find((x) => x.path === path);
  if (!t) {
    console.log(`  ⚠️  asar 里没有 ${path}`);
    continue;
  }
  const rel = path.slice(ASAR_PREFIX.length);
  const d = join(dest, ...rel.split("/"));
  if (!existsSync(d)) {
    console.log(`  ❌ 目标缺失 ${rel}`);
    allOk = false;
    continue;
  }
  const expected = bytes.subarray(
    dataStart + t.offset,
    dataStart + t.offset + t.size,
  );
  const actual = readFileSync(d);
  const same = expected.length === actual.length && expected.equals(actual);
  console.log(`  ${same ? "✅" : "❌"} ${rel}（${actual.length} 字节）`);
  if (!same) allOk = false;
}

// 宿主入口：补丁必须存在，且内容应与 asar **不同**（否则说明补丁丢了）
{
  const t = targets.find((x) => x.path === patchedEntry);
  const d = join(dest, ...patchedEntry.slice(ASAR_PREFIX.length).split("/"));
  if (t && existsSync(d)) {
    const expected = bytes.subarray(
      dataStart + t.offset,
      dataStart + t.offset + t.size,
    );
    const actual = readFileSync(d);
    const patched = actual.toString("utf8").includes("DSH_FOR_ZOTERO_PORT");
    const differs = !expected.equals(actual);
    console.log(
      `  ${patched && differs ? "✅" : "❌"} 宿主入口已被补丁修改（${expected.length} → ${actual.length} 字节）`,
    );
    if (!patched || !differs) allOk = false;
  } else {
    console.log(`  ❌ 宿主入口缺失`);
    allOk = false;
  }
}

// ⑤ 抽查宿主入口的端口补丁是否还在
const hostEntry = join(
  dest,
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "index.js",
);
if (existsSync(hostEntry)) {
  const text = readFileSync(hostEntry, "utf8");
  console.log(
    `\n端口补丁：${text.includes("DSH_FOR_ZOTERO_PORT") ? "✅ 存在" : "❌ 丢失"}`,
  );
  console.log(
    `原生绑定：${existsSync(join(dest, "node_modules", "node-addon-require-builtin-win32-x64-msvc", "prebuilt", "win32-x64-msvc-napi-v9.node")) ? "✅ 存在" : "❌ 缺失"}`,
  );
}

// ⑥ 顶层清单
console.log(`\n目标顶层：${readdirSync(dest).slice(0, 8).join(", ")}`);

// 汇总：唯一允许的大小差异就是被补丁改过的宿主入口。
// 最初我把"有任何差异"当成失败，于是必然报错 —— 判定条件本身写错了。
const expectedMismatch = sizeMismatch === 1 ? 1 : 0;
const ok = allOk && missing === 0 && sizeMismatch === expectedMismatch;
console.log(
  `\n结论：算法${ok ? "✅ 正确" : "❌ 有问题"}` +
    `（期望的差异：宿主入口 1 个；实际不一致 ${sizeMismatch} 个）`,
);
process.exit(ok ? 0 : 1);
