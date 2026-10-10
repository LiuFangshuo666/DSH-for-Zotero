/**
 * 条目类型的规整（中文别名 / 大小写 / 分隔符）。
 *
 * ## 为什么必须单测（真机故障）
 *
 * Agent 传了 `"itemType": "网页"` —— 它照着我写的**中文说明**推断（说明里只写了
 * `itemType?`，没列合法值），而白名单只认英文 `webpage`。结果是
 * **用户点了"确认新建"之后四条全部失败**：`不支持的条目类型 网页`。
 *
 * 一次"用户确认了却没成功"比一次报错更伤 —— 用户以为是自己操作错了。
 * 所以这里把规整逻辑钉死：合法的直接用、中文别名映射、大小写与分隔符容错、
 * 真的不认识才拒，并且**拒的时候要给出可用值**。
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
const { ALLOWED_ITEM_TYPES, normalizeItemType } = bundle;

describe("条目类型规整", function () {
  it("**真机原句**：中文「网页」必须被接受（这正是那次失败的值）", function () {
    assert.equal(normalizeItemType("网页"), "webpage");
  });

  it("常见中文类型名都映射到正确标识符", function () {
    assert.equal(normalizeItemType("期刊文章"), "journalArticle");
    assert.equal(normalizeItemType("会议论文"), "conferencePaper");
    assert.equal(normalizeItemType("图书"), "book");
    assert.equal(normalizeItemType("学位论文"), "thesis");
    assert.equal(normalizeItemType("报告"), "report");
    assert.equal(normalizeItemType("预印本"), "preprint");
    assert.equal(normalizeItemType("手稿"), "manuscript");
  });

  it("英文标识符原样通过", function () {
    for (const t of ALLOWED_ITEM_TYPES) {
      assert.equal(normalizeItemType(t), t);
    }
  });

  it("忽略大小写与分隔符（`Web Page` / `web_page` 都算 webpage）", function () {
    assert.equal(normalizeItemType("WebPage"), "webpage");
    assert.equal(normalizeItemType("Web Page"), "webpage");
    assert.equal(normalizeItemType("web_page"), "webpage");
    assert.equal(normalizeItemType("Journal-Article"), "journalArticle");
  });

  it("前后空白不影响", function () {
    assert.equal(normalizeItemType("  webpage  "), "webpage");
    assert.equal(normalizeItemType("  网页  "), "webpage");
  });

  it("未给类型时按最常用的期刊文章（而不是报错）", function () {
    assert.equal(normalizeItemType(undefined), "journalArticle");
    assert.equal(normalizeItemType(""), "journalArticle");
  });

  it("**真的不认识**才返回 undefined —— 由调用方给出可操作的错误", function () {
    assert.equal(normalizeItemType("外星文献"), undefined);
    assert.equal(normalizeItemType("podcast"), undefined);
  });
});
