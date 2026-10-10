/**
 * 同一轮多段助手正文的合并（真机 bug 的回归测试）。
 *
 * 症状：**"会话显示不全，回答停在半句"**。
 * 原因：`readTurn` 里用赋值而非合并，多步执行（调用工具）时后面每一段都
 * 覆盖前一段，最后一条若只有工具调用（正文空）还会被 `if (text)` 跳过。
 *
 * 这类 bug 的危险之处在于**看起来像模型输出问题**，很容易被误判、
 * 也很难从界面上看出是插件丢内容。所以两种语义都要钉住。
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
const { mergeResponseText } = bundle;

describe("多段助手正文合并", function () {
  it("累积式：多步执行的每段都保留，段间补空行", function () {
    // 第一段：说明 + 第一句；第二段：工具调用后的续写
    let text = mergeResponseText("", "我先查一下这个分类里的条目。");
    text = mergeResponseText(
      text,
      "查到了 39 条。需要我接着做标签整理方案吗？",
    );
    assert.match(text, /我先查一下这个分类里的条目。/);
    assert.match(
      text,
      /需要我接着做标签整理方案吗？/,
      "第二段不能覆盖第一段 —— 这正是「回答停在半句」的根因",
    );
    assert.match(text, /\n\n/, "两段之间应有空行，避免两句话粘成一句");
  });

  it("重发式：新文本含旧全文时采用新的，不重复", function () {
    const first = "第一句。";
    const resent = "第一句。第二句。";
    const merged = mergeResponseText(first, resent);
    assert.equal(merged, resent, "重发式应直接采用新的");
    assert.equal(
      (merged.match(/第一句。/g) ?? []).length,
      1,
      "不能出现重复的第一句",
    );
  });

  it("重复投递同一段时不追加", function () {
    const text = "只有一段。";
    assert.equal(mergeResponseText(text, text), text);
  });

  it("空的新段不改变已有内容（最后一条只有工具调用的情况）", function () {
    const text = "已有内容。";
    assert.equal(mergeResponseText(text, ""), text);
  });

  it("已有为空时直接采用新段", function () {
    assert.equal(mergeResponseText("", "第一段"), "第一段");
  });

  it("多段累积后再来一次重发，结果仍然正确（真实序列）", function () {
    // 模拟真实事件序列：段1 → 段2（累积）→ 重发全文（含段1+段2+段3）
    let text = mergeResponseText("", "先看一下。");
    text = mergeResponseText(text, "看完了，共 39 条。");
    text = mergeResponseText(
      text,
      "先看一下。\n\n看完了，共 39 条。\n\n要我继续吗？",
    );
    assert.equal(text, "先看一下。\n\n看完了，共 39 条。\n\n要我继续吗？");
    assert.equal((text.match(/先看一下。/g) ?? []).length, 1, "不得重复");
  });
});
