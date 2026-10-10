/**
 * 标签差异计算。
 *
 * ## 为什么必须被测试
 *
 * 这是"整理标签"的**破坏性**部分：`next` 是该条目最终的完整标签列表，
 * 不在其中的原有标签会被**真的删掉**。算错一次就是成批丢标签，
 * 而 Zotero 的撤销栈只能回退最近一步。
 *
 * （旧方案文件那套已撤掉 —— Agent 现在直接调 `setTags` 工具写库；
 *   但差异计算本身仍被工具复用，所以留在这里并被测试钉住。）
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
const { diffTags, isSystemTag } = bundle;

describe("标签差异计算", function () {
  it("完全重整：期望的列表就是最终结果", function () {
    const diff = diffTags(["旧标签", "另一个"], ["新标签"]);
    assert.deepEqual(diff.next, ["新标签"]);
    assert.deepEqual(diff.add, ["新标签"]);
    assert.deepEqual(diff.remove, ["旧标签", "另一个"]);
  });

  it("**保留**以 _ 开头的系统标签（Zotero 内部用，删了可能出问题）", function () {
    const diff = diffTags(["_README", "旧标签"], ["新标签"]);
    assert.deepEqual(diff.kept, ["_README"]);
    assert.deepEqual(diff.next, ["_README", "新标签"]);
    assert.ok(!diff.remove.includes("_README"), "系统标签绝不能被删");
    assert.deepEqual(diff.remove, ["旧标签"]);
  });

  it("结果里不出现重复标签（期望里写重了也只算一次）", function () {
    // current = [a, b]，期望 = [b, b, c]
    // → 最终 [b, c]：b 保留、c 新增、a 被删（它不在期望里）
    const diff = diffTags(["a", "b"], ["b", "b", "c"]);
    assert.deepEqual(diff.next, ["b", "c"]);
    assert.deepEqual(diff.add, ["c"], "重复的 b 不算新增（它本来就在）");
    assert.deepEqual(
      diff.remove,
      ["a"],
      "不在期望里的 a 会被删 —— 完全重整的语义",
    );
  });

  it("内容一致时没有增删（调用方据此跳过写入）", function () {
    const diff = diffTags(["a", "b"], ["b", "a"]);
    assert.deepEqual(diff.add, []);
    assert.deepEqual(diff.remove, []);
  });

  it("清空全部标签是允许的（Agent 明确要求清空时）", function () {
    const diff = diffTags(["a", "b"], []);
    assert.deepEqual(diff.next, []);
    assert.deepEqual(diff.remove, ["a", "b"]);
  });

  it("isSystemTag 只认下划线开头", function () {
    assert.equal(isSystemTag("_README"), true);
    assert.equal(isSystemTag("RTL生成"), false);
    assert.equal(isSystemTag("_"), true);
  });
});
