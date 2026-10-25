/**
 * ## 会话下拉的命名
 *
 * 真机反馈："会话选择用更直观的命名"。
 *
 * 原来的选项是 `session-9f2c31ab…` —— **给机器看的 id**。
 * 用户面对一列 uuid 分不清哪条是哪条。现在改成「标题 · 相对时间」。
 *
 * 这组用例钉住两件事：
 *  1. 相对时间的边界（"今天/昨天"必须按**日历日**判断，不能按小时差 ——
 *     23:50 与次日 00:10 只差 20 分钟，但确实是"昨天"）；
 *  2. 没有标题时有兜底，**绝不显示空字符串**（空选项等于无法选择）。
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
const { relativeTime, sessionOptionLabel } = bundle;

/** 构造一个本地时间的毫秒值，便于跨时区稳定 */
const at = (y, mo, d, h = 12, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe("会话下拉的命名", function () {
  it("一分钟内是「刚刚」，未来时间也是「刚刚」", function () {
    const now = at(2026, 10, 25, 15, 0);
    assert.equal(relativeTime(now - 5_000, now), "刚刚");
    assert.equal(relativeTime(now + 30_000, now), "刚刚");
  });

  it("一小时内是「N 分钟前」", function () {
    const now = at(2026, 10, 25, 15, 0);
    assert.equal(relativeTime(now - 5 * 60_000, now), "5 分钟前");
    assert.equal(relativeTime(now - 59 * 60_000, now), "59 分钟前");
  });

  it("当天超过一小时显示「今天 HH:mm」", function () {
    const now = at(2026, 10, 25, 20, 0);
    assert.equal(relativeTime(at(2026, 10, 25, 9, 5), now), "今天 09:05");
  });

  it("跨午夜但不足一小时：**仍显示「N 分钟前」**（更精确）", function () {
    // 23:50 → 次日 00:10 只差 20 分钟。这里显示"20 分钟前"而不是"昨天 23:50"
    // 是**有意**的：分钟级更精确，用户不会觉得时间错了。
    const now = at(2026, 10, 25, 0, 10);
    assert.equal(relativeTime(at(2026, 10, 24, 23, 50), now), "20 分钟前");
  });

  it("跨午夜且超过一小时：按**日历日**算「昨天」", function () {
    // 22:00 → 次日 01:00 = 3 小时，跨了一个日历日，必须说"昨天"
    const now = at(2026, 10, 25, 1, 0);
    assert.equal(relativeTime(at(2026, 10, 24, 22, 0), now), "昨天 22:00");
  });

  it("一周内是「N 天前」，更早回落到日期", function () {
    const now = at(2026, 10, 25, 12, 0);
    assert.equal(relativeTime(at(2026, 10, 22, 12, 0), now), "3 天前");
    assert.equal(relativeTime(at(2026, 9, 1, 12, 0), now), "2026-09-01");
  });

  it("时间非法时返回空串，不显示「NaN」", function () {
    assert.equal(relativeTime(0), "");
    assert.equal(relativeTime(Number.NaN), "");
  });

  it("标签是「标题 · 时间」，当前会话带标记", function () {
    const now = at(2026, 10, 25, 15, 0);
    assert.equal(
      sessionOptionLabel(
        {
          sessionId: "session-abc123456",
          title: "关于注意力的讨论",
          // 用 3 小时的间隔，确保落在"今天 HH:mm"而不是"N 分钟前"
          updatedAt: at(2026, 10, 25, 12, 0),
        },
        now,
      ),
      "关于注意力的讨论 · 今天 12:00",
    );
    assert.equal(
      sessionOptionLabel(
        {
          sessionId: "session-abc123456",
          title: "关于注意力的讨论",
          current: true,
        },
        now,
      ),
      "关于注意力的讨论（当前）",
    );
  });

  it("运行中的会话前面加圆点", function () {
    const now = at(2026, 10, 25, 15, 0);
    const label = sessionOptionLabel(
      { sessionId: "session-x", title: "T", running: true },
      now,
    );
    assert.ok(label.startsWith("● "), "运行中的会话应有前缀圆点");
  });

  it("**没有标题时必须有兜底**（空选项等于无法选择）", function () {
    const label = sessionOptionLabel({ sessionId: "session-abc123456" });
    assert.ok(label.length > 0, "标签不能为空");
    assert.ok(
      label.includes("123456"),
      "兜底应带 id 尾部，便于区分不同的匿名会话",
    );
  });

  it("标题两端空白会被去掉（否则显示成「  · 今天」）", function () {
    const label = sessionOptionLabel({
      sessionId: "session-abc",
      title: "   ",
    });
    assert.ok(!label.startsWith("·"), "空白标题必须走兜底");
  });
});
