// 严格核对构建产物是否包含本轮的全部改动。
//
// ⚠️ 用 Node 而不是 PowerShell 做匹配：中文在产物里是 \uXXXX 转义形式，
//    PowerShell 的编码处理会让中文搜索**悄悄失效**（已踩过多次，包括最近一次：
//    我据此误判"诊断没进产物"，其实进了）。
//
// 用法：node tools/verify-bundle.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 仓库根目录。
 *
 * ⚠️ 用**脚本自身位置**推导，不要用产物路径往上数几层 ——
 * 数错过一次（`../../../` 只到了 `.scaffold/`），而那种错误会让校验
 * 以"读不到文件"的形式失败，看起来像清单不存在，而不是路径写错。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const file =
  process.argv[2] ??
  join(repoRoot, ".scaffold/build/addon/content/scripts/dshforzotero.js");
const text = readFileSync(file, "utf8");
const contentDir = file.replace(/scripts[\\/]dshforzotero\.js$/, "");
const page = readFileSync(join(contentDir, "sessionPage.js"), "utf8");
const xhtml = readFileSync(join(contentDir, "session.xhtml"), "utf8");

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
//
// ⚠️ 路径分隔符要同时接受 `/` 与 `\`：早先只写了 `content/scripts/`，
// 而用 `path.join` 拼出来的路径在 Windows 上是反斜杠 —— 正则不匹配时
// `replace` 原样返回补丁**自身**的路径，于是这里读到的是 `dshforzotero.js`
// 的内容，三项 bootstrap 检查全部失败，看起来像"产物缺了 bootstrap 特性"。
const bootstrap = readFileSync(
  file.replace(/content[\\/]scripts[\\/]dshforzotero\.js$/, "bootstrap.js"),
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

// ── update.json 必须与**当前产物**一致 ────────────────────────────
//
// 真机踩到：`npm run build` 会生成**新的 xpi**（构建内嵌时间戳，字节每次都不同），
// 但仓库根的 `update.json` **不会**跟着变 —— 于是清单里的 sha512 指向上一份产物。
//
// 后果是**安静而严重**的：发布者在 Gitee 上传的是新 xpi，而清单哈希是旧的，
// 用户自动更新时校验不通过 → 更新失败，而两边看起来都"正常"。
//
// 所以把这条纳入 `npm run verify`。注意 `verify` 的顺序里**先 build、
// 再 update:json、最后才是这里** —— 否则 build 刚换过产物，清单必然对不上，
// 这条检查会永远失败（本检查上线时就踩了这一步）。
{
  const rootUpdate = join(repoRoot, "update.json");
  const xpiPath = join(repoRoot, ".scaffold/build/dsh-for-zotero.xpi");
  let note;
  try {
    const manifest = JSON.parse(readFileSync(rootUpdate, "utf8"));
    const key = Object.keys(manifest.addons ?? {})[0];
    const want = manifest.addons?.[key]?.updates?.[0]?.update_hash;
    const xpi = readFileSync(xpiPath);
    const have = `sha512:${createHash("sha512").update(xpi).digest("hex")}`;
    if (!want) note = ["update.json 里没有 update_hash", false];
    else if (want === have) note = ["update.json 的哈希与产物一致", true];
    else
      note = [
        "update.json 的哈希与产物**不一致** —— 构建后忘了同步清单。" +
          "跑 `npm run update:json`（它会校验并搬运脚手架生成的清单）",
        false,
      ];
  } catch (error) {
    note = [
      `读不到仓库根的 update.json：${
        error instanceof Error ? error.message : String(error)
      }`,
      false,
    ];
  }
  if (!note[1]) failed++;
  console.log(`${note[1] ? "✅" : "❌"} ${note[0]}`);
}

console.log("");
console.log(failed === 0 ? "全部通过" : `${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
