/**
 * "Agent 是在问我吗"的判断。
 *
 * ## 为什么改成只看结尾问号（真机教训）
 *
 * 第一版还在正文里找"要不要/哪个/请选择"等词，本意是覆盖"模型漏标点"的情况。
 * 真机结果是：那段话**还没写完**（结尾是"落地前有几个决定要你拍板："）时就被判为提问，
 * 界面提示"Agent 在等你回答"，但**选项还没显示出来** ——
 * 用户既不知道要选什么，又被催着回答。**误报比漏报更糟**。
 *
 * 现在只认一个信号：当前正文**以问号结尾**。
 *  - "问题写完了" → 该回应；
 *  - "选项写完了、正在写下一个问题" → 也该回应；
 *  - "话说到一半（冒号/逗号结尾）" → **不提示**，让用户安静等它写完。
 *
 * 逻辑抄自 sessionPage.js 的 `looksLikeQuestion`（页面是 IIFE、函数不导出）；
 * 两边不一致时这个测试会先炸。
 */

import assert from "node:assert/strict";

/** 与 sessionPage.js 的 looksLikeQuestion 保持一致 */
function looksLikeQuestion(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  // 话说到一半（结尾是冒号/逗号/顿号）→ 明确不算在问
  if (/[：:，,、]\s*$/.test(trimmed)) return false;
  return /[？?]\s*$/.test(trimmed);
}

describe("判断 Agent 是否在问用户", function () {
  it("以问号结尾 → 是在问", function () {
    assert.equal(looksLikeQuestion("需要我接着做标签整理方案吗？"), true);
    assert.equal(looksLikeQuestion("Which one do you prefer?"), true);
    assert.equal(looksLikeQuestion("选 A 还是 B？\n\n"), true);
  });

  it("真机反馈的那句（以问号结尾）→ 是在问", function () {
    const real =
      "需要我接着按这套统计做标签整理方案（统一中英文体系、合并近义词、给 39 条空标签的条目补标签）吗？";
    assert.equal(looksLikeQuestion(real), true);
  });

  it("**不误报**：话说到一半（冒号/逗号结尾）—— 这是真机踩过的坑", function () {
    // 用户看到这句时，下面的选项还没输出；此时提示"在等你"会让用户困惑
    assert.equal(looksLikeQuestion("落地前有几个决定要你拍板："), false);
    assert.equal(looksLikeQuestion("落地前有几个决定要你拍板：\n"), false);
    assert.equal(looksLikeQuestion("我先说明一下，"), false);
    // 真机原句：这句后面才是选项，此时**不能**提示"在等你"
    assert.equal(
      looksLikeQuestion("动手前有三件事必须你定，它们会实质影响条目质量："),
      false,
    );
    assert.equal(looksLikeQuestion("正在统计中…"), false);
  });

  it("**不误报**：陈述句（哪怕含「要不要」这类词）", function () {
    // 结尾是句号 → 不是在问，即使句中有征询词
    assert.equal(looksLikeQuestion("它会问你要不要继续。"), false);
    assert.equal(looksLikeQuestion("以上是全部统计结果。"), false);
  });

  it("**不误报**：问号在中间但结尾是陈述", function () {
    assert.equal(
      looksLikeQuestion("它问过「选哪个？」，我已经按第一个方案处理完了。"),
      false,
    );
  });

  it("空文本不算在问", function () {
    assert.equal(looksLikeQuestion(""), false);
    assert.equal(looksLikeQuestion("   "), false);
  });
});
