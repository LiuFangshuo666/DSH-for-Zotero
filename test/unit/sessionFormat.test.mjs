/**
 * ## 会话日志格式版本探针
 *
 * dsh 的会话日志是**带版本**的（`SESSION_FORMAT_VERSION`），而且真的会变 ——
 * dsh 自带 `session-format-v0-to-v1` / `v1-to-v2` / `v2-to-v3` 等迁移包就是证据。
 *
 * 插件靠**事件类型名与字段形状**解析回答。这些一变，后果**不是报错而是静默**：
 *
 * - 事件名变了 → 一个都匹配不上 → 界面显示"回答为空"，而宿主其实答得好好的；
 * - 字段位置变了 → 正文读到空串 → 用户以为模型没输出。
 *
 * 这类"什么都没坏、但什么都没显示"最难查，所以插件现在会把版本号读出来比对，
 * 不一致就**明确记一条日志**。
 *
 * 为什么抽成纯函数：真机验证需要一台**正在运行**的宿主，而那恰恰是出问题时
 * 最不可能具备的条件（本次想验时宿主就是 ECONNREFUSED）。
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
const { findSessionFormatVersion } = bundle;

/** 构造一条带版本号的记录（形状取自真机：挂在 delivery-accepted 事件上） */
const withVersion = (version) => ({
  type: "event",
  event: {
    type: "session-log-deepseek/delivery-accepted",
    data: { sessionId: "s", sessionFormatVersion: version, throughSeq: 1 },
  },
});

describe("会话日志格式版本探针", function () {
  it("能从真机形状里读出 4", function () {
    assert.equal(findSessionFormatVersion([withVersion(4)]), 4);
  });

  it("读不到时返回 undefined —— **不能猜**（更老的格式可能没这个字段）", function () {
    assert.equal(findSessionFormatVersion([]), undefined);
    assert.equal(
      findSessionFormatVersion([{ event: { type: "turn/start", data: {} } }]),
      undefined,
    );
    // 类型不对也不算
    assert.equal(findSessionFormatVersion([withVersion("4")]), undefined);
  });

  it("在混合记录里能找到那一条（不要求排在第一个）", function () {
    const records = [
      { event: { type: "turn/start", data: {} } },
      { event: { type: "assistant/message", data: {} } },
      withVersion(5),
    ];
    assert.equal(findSessionFormatVersion(records), 5);
  });

  it("记录形状畸形时不得抛异常（畸形数据不能把整轮问答打断）", function () {
    for (const bad of [
      null,
      undefined,
      {},
      { event: null },
      { event: { data: null } },
      "string",
      42,
    ]) {
      assert.doesNotThrow(() => findSessionFormatVersion([bad]));
    }
  });
});
