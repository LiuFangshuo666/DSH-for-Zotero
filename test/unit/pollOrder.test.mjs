/**
 * ## `pollOnce` 必须先读 `turn/end`，再判"盯了多久"
 *
 * 真机缺陷（2026-10-17）：正文已经**完整显示**在界面上，状态行却还是"生成中…"。
 *
 * 实测宿主侧完全干净：
 *
 * ```text
 *   session/list        → running = false（77 个会话里 0 个在跑）
 *   session/page        → turn/end 就在末尾，最后一个 turn/start 之后有 turn/end
 *   maxMessages=200     → 仍返回全部 287 条（没有分页截断）
 * ```
 *
 * 也就是说 `turn/end` **一直可见**，而界面没结束 —— 问题在代码的**顺序**：
 *
 * ```js
 *   if (Date.now() - pollStartedAt > POLL_MAX_MS) {
 *     const state = await harnessRunning(...);
 *     if (state === false) { 结束; return; }
 *     extendPollingDeadline(); return;      // ← 在这里返回，下面的 readTurn 永不执行
 *   }
 *   const turn = await readTurn(...);       // ← 超时后再也不看 turn/end
 * ```
 *
 * 于是**一旦超时，`turn/end` 就再也读不到了**，只剩"问 harness 在不在跑"。
 * 而 `harnessRunning` 在"会话不在列表里"和"RPC 失败"两种情况下都返回 `undefined`，
 * 代码选择"继续等" —— **界面就永远停在生成中**。
 *
 * `turn/end` 是**权威结束信号**，与"盯了多久"无关。这条守卫盯的就是这个顺序。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const source = readFileSync(join(root, "src", "chat", "transport.ts"), "utf8");

/**
 * 取出 `pollOnce` 方法体，并**剥掉注释**。
 *
 * ⚠️ 必须先剥注释：这段方法的文档注释里为了解释缺陷，本身同时提到了
 * `POLL_MAX_MS` 与 `readTurn` —— 不剥就会把**说明文字**当成代码顺序。
 * 本项目已经因为"守卫把文档当违规"误报过多次，这是同一个坑。
 */
function pollOnceBody() {
  const start = source.indexOf("private async pollOnce(");
  assert.ok(start > 0, "找不到 pollOnce");
  const nextMethod = source.indexOf("\n  private ", start + 10);
  const end = nextMethod > 0 ? nextMethod : source.length;
  return source
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/^\s*\/\/.*$/gm, ""); // 行注释
}

describe("轮询结束判定：先看 turn/end，再看耗时", function () {
  it("**`readTurn` 必须出现在 `POLL_MAX_MS` 判断之前**", function () {
    const body = pollOnceBody();
    const readAt = body.indexOf("this.readTurn(");
    const timeoutAt = body.indexOf("POLL_MAX_MS");
    assert.ok(readAt > 0, "pollOnce 里必须调用 readTurn");
    assert.ok(timeoutAt > 0, "pollOnce 里必须有 POLL_MAX_MS 兜底");
    assert.ok(
      readAt < timeoutAt,
      "readTurn 必须在 POLL_MAX_MS 之前调用 —— 否则一旦超时，" +
        "`turn/end` 再也读不到，界面会永远停在生成中（真机缺陷）",
    );
  });

  it("超时分支不得在读取本轮之前 `return`", function () {
    const body = pollOnceBody();
    const timeoutAt = body.indexOf("POLL_MAX_MS");
    const readAt = body.indexOf("this.readTurn(");
    // 超时判断之前的那段里，不能有"提前收尾"的 return
    const before = body.slice(0, timeoutAt);
    assert.ok(
      !/extendPollingDeadline\(\);\s*return;/.test(before),
      "不得在 readTurn 之前就 extendPollingDeadline 并 return",
    );
    assert.ok(readAt < timeoutAt, "顺序不对");
  });

  it("harness 说停了必须**收尾**（否则 generating 永远为真）", function () {
    const body = pollOnceBody();
    assert.match(
      body,
      /state === false[\s\S]{0,200}this\.stopPolling\(\)/,
      "harness 明确说停了时要 stopPolling",
    );
    assert.match(
      body,
      /state === false[\s\S]{0,300}emitAssistantEnd\(/,
      "harness 明确说停了时要 emitAssistantEnd —— 只停轮询不发结束，" +
        "界面仍会停在生成中",
    );
  });

  it("`turn.ended` 为真时必须 emitAssistantEnd", function () {
    const body = pollOnceBody();
    assert.match(
      body,
      /turn\.ended[\s\S]{0,220}emitAssistantEnd\(/,
      "看到 ended 却不发结束事件，界面就停在生成中",
    );
  });
});
