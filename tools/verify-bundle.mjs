// 严格核对构建产物是否包含本轮的全部改动。
//
// ⚠️ 用 Node 而不是 PowerShell 做匹配：中文在产物里是 \uXXXX 转义形式，
//    PowerShell 的编码处理会让中文搜索**悄悄失效**（已踩过多次，包括最近一次：
//    我据此误判"诊断没进产物"，其实进了）。
//
// 用法：node tools/verify-bundle.mjs
import { readFileSync } from "node:fs";

const file =
  process.argv[2] ??
  "E:/zotero-plugin-project/dsh-for-zotero/.scaffold/build/addon/content/scripts/dshforzotero.js";
const text = readFileSync(file, "utf8");
const contentDir = file.replace(/scripts\/dshforzotero\.js$/, "");
const page = readFileSync(`${contentDir}sessionPage.js`, "utf8");
const xhtml = readFileSync(`${contentDir}session.xhtml`, "utf8");

/** 把 JS 源码里的 \uXXXX 转义还原，便于按中文查找 */
function decodeEscapes(input) {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}
const decoded = decodeEscapes(text);
const pageDecoded = decodeEscapes(page);

const checks = [
  // ── 取一轮文本：两条路径都必须合并（只修一处时这里会报警）──────────
  [
    "实时分支合并取文（mergeResponseText ≥5 处调用）",
    () => (text.match(/mergeResponseText\(/g) ?? []).length >= 5,
  ],
  ["多段正文合并的实现存在", () => /function mergeResponseText/.test(text)],

  // ── 诊断：必须**落盘**（appendPanelLog），且去重 ────────────────────
  [
    "诊断走 appendPanelLog（落盘，不是 this.log）",
    // ⚠️ 断言必须**与格式无关**：这里早先写的是
    // `/appendPanelLog\("session",\s*`[^`]*assistant/` —— 要求参数紧邻。
    // 一跑 prettier 就把参数拆成了多行，于是**逻辑没坏而检查报错**，
    // 把我引向"诊断丢了"这个错误结论。现在只看两件事：
    //   ① 产物里确实有 appendPanelLog 调用；② 那条诊断文案用于它。
    // 中间隔多少空白/换行都不影响 —— 检查的是**行为**，不是排版。
    () =>
      /appendPanelLog\(/.test(text) &&
      /appendPanelLog\(\s*["']session["']\s*,\s*`[^`]*assistant/s.test(text),
  ],
  ["诊断带块构成", () => decoded.includes("本轮 assistant 块构成")],
  ["诊断去重（不刷屏）", () => /lastBlockShapeLog/.test(text)],
  ["诊断含结束状态", () => decoded.includes("已结束=")],

  // ── 卡住时的出路 ──────────────────────────────────────────────────
  ["可取消轮次（cancelTurn）", () => /cancelTurn/.test(text)],
  ["可送入补充内容（steer）", () => /steerSession/.test(text)],
  ["页面：停止生成逻辑", () => /stopGenerating/.test(page)],
  ["页面：停止生成按钮元素", () => /id="stop"/.test(xhtml)],
  ["页面：补充说明按钮元素", () => /id="steer"/.test(xhtml)],
  [
    "页面：增量回显",
    () => /function \(partial\)/.test(page) || /onDelta/.test(page),
  ],
  ["页面：本轮结束标记", () => pageDecoded.includes("本轮结束")],
  ["页面：Agent 在等你提示", () => pageDecoded.includes("Agent 在等你")],

  // ── 会话能力（手工枚举的清单，容易漏）────────────────────────────
  ["能力：保存回答为笔记", () => /saveReplyAsNote/.test(text)],
  ["能力：删除确认", () => /confirmPendingDeletion/.test(text)],
  ["能力：刷新工作区材料", () => /refreshWorkspace/.test(text)],

  // ── bootstrap 关键点 ─────────────────────────────────────────────
  [
    "启动期：addon 懒加载（不再顶层 new SelectionToolbar）",
    () => !/^\s{0,2}var selectionToolbar = new SelectionToolbar/m.test(text),
  ],
];

let failed = 0;
for (const [label, test] of checks) {
  let ok = false;
  try {
    ok = test();
  } catch {
    ok = false;
  }
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
}

// bootstrap.js 单独核对
const bootstrap = readFileSync(
  file.replace(/content\/scripts\/dshforzotero\.js$/, "bootstrap.js"),
  "utf8",
);
const bootstrapChecks = [
  [
    "bootstrap: _globalThis 指向真正的 globalThis",
    /ctx\._globalThis\s*=\s*globalThis/.test(bootstrap),
  ],
  [
    "bootstrap: addon 有 getter",
    /defineProperty\(globalScope,\s*"addon"[\s\S]{0,300}?get\s*[:(]/.test(
      bootstrap,
    ),
  ],
  [
    "bootstrap: addon 有 setter（必须，产物会赋值）",
    /defineProperty\(globalScope,\s*"addon"[\s\S]{0,300}?set\s*[:(]/.test(
      bootstrap,
    ),
  ],
];
for (const [label, ok] of bootstrapChecks) {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
}

console.log("");
console.log(failed === 0 ? "全部通过" : `${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
