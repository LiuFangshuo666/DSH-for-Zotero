// 精确验证：字符串型 offset/size 会导致什么后果，以及正确做法。
import { readFileSync, existsSync, statSync } from "node:fs";

const buf = readFileSync("E:/deepseek harness/resources/app.asar");
const hs = buf.readUInt32LE(12);
const header = buf.subarray(16, 16 + hs).toString("utf8");
const tree = JSON.parse(header.slice(0, header.lastIndexOf("}") + 1));
const dataStart = 16 + hs;

const node =
  tree.files.dsh.files.node_modules.files["@deepseek-ai"].files[
    "dsh-desktop-host"
  ].files.lib.files["index.js"];
console.log("=== 头部记录 ===");
console.log("  size 类型:", typeof node.size, "值:", JSON.stringify(node.size));
console.log(
  "  offset 类型:",
  typeof node.offset,
  "值:",
  JSON.stringify(node.offset),
);

// ① 用原始（字符串）值切片
const asIs = buf.subarray(
  dataStart + node.offset,
  dataStart + node.offset + node.size,
);
// ② 用 Number() 转换后切片
const num = buf.subarray(
  dataStart + Number(node.offset),
  dataStart + Number(node.offset) + Number(node.size),
);

console.log("\n=== 切片结果对比 ===");
console.log(`  字符串运算: ${asIs.length} 字节`);
console.log(`  Number 运算: ${num.length} 字节`);
console.log(
  `  前者前 60 字符: ${JSON.stringify(asIs.toString("utf8").slice(0, 60))}`,
);
console.log(
  `  后者前 60 字符: ${JSON.stringify(num.toString("utf8").slice(0, 60))}`,
);

// 为什么字符串会出错：JS 的 + 会做字符串拼接
console.log("\n=== 为什么字符串会出错 ===");
console.log(
  `  dataStart + offset（字符串拼接方向） = ${typeof (dataStart + node.offset)}`,
);
console.log(
  `  实际值前 40 位: ${String(dataStart + node.offset).slice(0, 40)}`,
);
console.log(
  `  → 作为 subarray 参数会被强制转成数字，得到巨大索引，于是切片为空`,
);

// ③ 插件实际提取出来的文件
const extracted =
  process.env.USERPROFILE +
  "/Zotero/dsh-for-zotero/runtime/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js";
const localTest =
  "E:/zotero-plugin-project/dsh-runtime-test/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js";
for (const [label, p] of [
  ["插件数据目录", extracted],
  ["我 Node 提取的", localTest],
]) {
  if (existsSync(p)) {
    console.log(`\n  ${label}: ${statSync(p).size} 字节`);
  } else {
    console.log(`\n  ${label}: 不存在`);
  }
}
