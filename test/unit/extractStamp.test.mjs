/**
 * ## 提取戳：布局版本 + **源 asar 指纹**
 *
 * 真机场景（2026-10-17 一天内发生两次）：用户升级桌面端 DSH，
 * 而插件**继续跑旧版本的提取副本** —— 因为 `isPrepared()` 只看"提取过没有"。
 *
 * ```text
 *   桌面端: 0.2.1-rc.1 → rc.2（asar 在 17:20 更新）
 *   提取副本: 仍是 rc.1
 *   用户以为: 升级已经生效
 * ```
 *
 * 那本身不算坏（副本自洽，能跑），但它是**状态不一致** —— 而这个项目里
 * 每一次"界面/日志与现实不一致"都要花很长时间才查清。
 *
 * 所以戳里除了布局版本，还记**源 asar 的大小与路径**：
 * 桌面端更新 → 大小变 → 重新提取（约 10–15 秒，一次性）。
 *
 * ⚠️ 用**大小**不用哈希：约 180 MB 的文件，`isPrepared()` 每次都要判断，
 * 读全文中不可行。大小对内容变化已足够敏感。
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const { parseExtractStamp } = bundle;

describe("提取戳的解析", function () {
  it("能解析「版本|大小|路径」", function () {
    const out = parseExtractStamp(
      "2|182720179|E:\\DeepSeek Harness\\resources\\app.asar",
    );
    assert.ok(out);
    assert.equal(out.layout, 2);
    assert.equal(out.asarSize, 182720179);
    assert.equal(out.asarPath, "E:\\DeepSeek Harness\\resources\\app.asar");
  });

  it("**旧格式（只有版本号）必须被视为不一致**", function () {
    // 这是修复前写下的戳。若把它当成有效，用户升级后永远不会重新提取。
    assert.equal(parseExtractStamp("2"), undefined);
    assert.equal(parseExtractStamp("2|182720179"), undefined);
  });

  it("畸形内容一律返回 undefined（不能当成「有效」）", function () {
    for (const bad of [
      "",
      "   ",
      "abc|def|ghi",
      "2|not-a-number|path",
      "|182720179|path",
      "2|182720179|",
    ]) {
      assert.equal(
        parseExtractStamp(bad),
        undefined,
        JSON.stringify(bad) + " 应被拒绝",
      );
    }
  });

  it("路径里含 `|` 时不丢字符（从第 3 段起拼回）", function () {
    const out = parseExtractStamp("2|100|C:\\odd|dir\\app.asar");
    assert.ok(out);
    assert.equal(out.asarPath, "C:\\odd|dir\\app.asar");
  });

  it("前后空白不影响解析（文件可能带换行）", function () {
    const out = parseExtractStamp("\n 3|5|p \n");
    assert.ok(out);
    assert.equal(out.layout, 3);
    assert.equal(out.asarSize, 5);
  });
});
