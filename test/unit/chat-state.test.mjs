/**
 * 对话状态机与展示逻辑的测试。
 *
 * 用真实录制形状的 chunk（来自对 live dsh 的实测，见 docs/DSH集成与桥接协议.md §8.1）
 * 走完整流程，断言逐字累加、块定稿、取消/放弃的呈现、状态行与输入可用性。
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const chat = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  reduce,
  initialState,
  replay,
  toView,
  statusLine,
  canSend,
  isTurnActive,
  harnessUnknown,
  __resetMessageSeq,
} = chat;

// 实测记录到的 chunk 序列（模型输出"桥接成功"，含 reasoning 块）
const liveChunks = [
  { type: "block-start", index: 0, blockType: "reasoning" },
  { type: "block-end", index: 0, block: { type: "reasoning", text: "" } },
  { type: "block-start", index: 1, blockType: "text" },
  { type: "text-delta", index: 1, text: "桥" },
  { type: "text-delta", index: 1, text: "接" },
  { type: "text-delta", index: 1, text: "成功" },
  { type: "block-end", index: 1, block: { type: "text", text: "桥接成功" } },
  { type: "usage", usage: { inputTokens: 6587, outputTokens: 4 } },
  { type: "finish", reason: { kind: "stop" } },
];

function play(chunks, options = {}) {
  let state = reduce(initialState(), {
    kind: "ready",
    sessionId: "session-abc",
    transport: "chrome-worker",
    resumed: false,
  });
  state = reduce(state, { kind: "prompt-accepted", text: "只回复四个字" });
  state = reduce(state, { kind: "assistant-start" });
  for (const chunk of chunks) {
    state = reduce(state, { kind: "assistant-delta", chunk });
  }
  if (!options.noEnd) {
    state = reduce(state, {
      kind: "assistant-end",
      outcome: options.outcome ?? "committed",
    });
  }
  return state;
}

describe("对话状态机：逐字累加", function () {
  it("text-delta 按顺序累加：先桥、后接、再成功", function () {
    let state = play(liveChunks.slice(0, 4), { noEnd: true }); // 只到第一个 delta
    const cells = toView(state);
    assert.equal(cells[cells.length - 1].text, "桥");
    state = reduce(state, {
      kind: "assistant-delta",
      chunk: { type: "text-delta", index: 1, text: "接" },
    });
    assert.equal(toView(state).pop().text, "桥接");
    state = reduce(state, {
      kind: "assistant-delta",
      chunk: { type: "text-delta", index: 1, text: "成功" },
    });
    assert.equal(toView(state).pop().text, "桥接成功");
  });

  it("block-end 用最终文本定稿，且不再处于 streaming", function () {
    const state = play(liveChunks);
    const cells = toView(state);
    const last = cells[cells.length - 1];
    assert.equal(last.kind, "assistant");
    assert.equal(last.text, "桥接成功");
    assert.equal(last.streaming, false, "生成结束后不应再标记 streaming");
    assert.equal(state.generating, false);
  });

  it("空 reasoning 块不产生可见文本，非空 reasoning 折叠为思考行", function () {
    let state = play(liveChunks);
    assert.ok(
      !toView(state).pop().text.includes("思考"),
      "空 reasoning 不应出现",
    );

    let s = reduce(initialState(), {
      kind: "ready",
      sessionId: "x",
      transport: "t",
      resumed: false,
    });
    s = reduce(s, { kind: "assistant-start" });
    s = reduce(s, {
      kind: "assistant-delta",
      chunk: { type: "block-start", index: 0, blockType: "reasoning" },
    });
    s = reduce(s, {
      kind: "assistant-delta",
      chunk: { type: "text-delta", index: 0, text: "先看方法部分" },
    });
    s = reduce(s, {
      kind: "assistant-delta",
      chunk: { type: "block-start", index: 1, blockType: "text" },
    });
    s = reduce(s, {
      kind: "assistant-delta",
      chunk: { type: "text-delta", index: 1, text: "结论" },
    });
    assert.equal(toView(s).pop().text, "思考：先看方法部分\n结论");
  });

  it("usage / finish 不改变可见文本", function () {
    const before = play(liveChunks.slice(0, 7), { noEnd: true });
    const after = play(liveChunks, { noEnd: true });
    assert.equal(toView(before).pop().text, toView(after).pop().text);
  });

  it("丢帧容忍：没有 block-start 的 text-delta 也能补建块", function () {
    let state = reduce(initialState(), {
      kind: "ready",
      sessionId: "x",
      transport: "t",
      resumed: false,
    });
    state = reduce(state, {
      kind: "assistant-delta",
      chunk: { type: "text-delta", index: 3, text: "裸增量" },
    });
    assert.equal(toView(state).pop().text, "裸增量");
    assert.equal(state.generating, true, "收到 delta 即视为生成中");
  });
});

describe("对话状态机：用户消息与提示", function () {
  it("提问后立即出现用户消息，且输入被禁用（生成中）", function () {
    let state = play(liveChunks);
    const cells = toView(state);
    assert.equal(cells[0].kind, "user");
    assert.equal(cells[0].text, "只回复四个字");
    assert.equal(canSend(state), true, "生成结束后可再次输入");
  });

  it("生成中不允许发送", function () {
    let state = play(liveChunks, { noEnd: true });
    assert.equal(state.generating, true);
    assert.equal(canSend(state), false);
  });

  it("未连接时不允许发送", function () {
    assert.equal(canSend(initialState()), false);
  });
});

describe("对话状态机：结束与取消", function () {
  it("committed 不追加提示", function () {
    const state = play(liveChunks, { outcome: "committed" });
    assert.ok(!toView(state).some((c) => c.kind === "notice"));
  });

  it("cancelled 追加已停止生成提示，且消息定稿", function () {
    const state = play(liveChunks, { outcome: "cancelled" });
    const notices = toView(state).filter((c) => c.kind === "notice");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].text, "已停止生成");
    assert.equal(notices[0].level, "info");
    assert.equal(state.generating, false);
    assert.equal(state.cancelPending, false);
  });

  it("abandoned 追加警告级提示", function () {
    const state = play(liveChunks, { outcome: "abandoned" });
    const notices = toView(state).filter((c) => c.kind === "notice");
    assert.equal(notices[0].level, "warn");
  });

  it("点停止后进入 cancelPending，结束事件清掉它", function () {
    let state = play(liveChunks, { noEnd: true });
    state = reduce(state, { kind: "cancel-requested" });
    assert.equal(state.cancelPending, true);
    assert.equal(canSend(state), false, "停止中不接受新输入");
    state = reduce(state, { kind: "assistant-end", outcome: "cancelled" });
    assert.equal(state.cancelPending, false);
  });
});

describe("对话状态机：连接状态与状态行", function () {
  it("就绪后状态行包含端口、会话与传输载体", function () {
    const state = play(liveChunks);
    const line = statusLine(state, 19387);
    assert.match(line, /已连接 dsh · 19387/);
    assert.match(line, /会话 session-abc/);
  });

  it("fault 清空连接状态并显示错误码", function () {
    let state = play(liveChunks);
    state = reduce(state, {
      kind: "fault",
      code: "client/network",
      message: "端口不可达",
    });
    assert.equal(state.connected, false);
    assert.equal(state.generating, false);
    assert.match(statusLine(state, 19387), /未连接 dsh（client\/network）/);
  });

  it("ready 会清掉上一次的 fault，并标记是否恢复会话", function () {
    let state = reduce(initialState(), {
      kind: "fault",
      code: "x",
      message: "y",
    });
    state = reduce(state, {
      kind: "ready",
      sessionId: "s2",
      transport: "main-window",
      resumed: true,
    });
    assert.equal(state.lastFault, undefined);
    assert.match(statusLine(state, 3080), /已恢复/);
    assert.match(statusLine(state, 3080), /3080/);
  });

  it("生成中状态行显示生成中，取消后显示正在停止", function () {
    let state = play(liveChunks, { noEnd: true });
    assert.match(statusLine(state, 19387), /生成中…/);
    state = reduce(state, { kind: "cancel-requested" });
    assert.match(statusLine(state, 19387), /正在停止…/);
  });
});

describe("对话状态机：消息上限", function () {
  it("消息数超过上限时丢弃最早的消息", function () {
    let state = reduce(initialState(), {
      kind: "ready",
      sessionId: "s",
      transport: "t",
      resumed: false,
    });
    for (let i = 0; i < 260; i++) {
      state = reduce(state, { kind: "prompt-accepted", text: `q${i}` });
    }
    assert.ok(state.messages.length <= 200, `实际 ${state.messages.length}`);
    assert.equal(
      state.messages[state.messages.length - 1].blocks[0].text,
      "q259",
    );
  });
});

describe("harness 运行状态（退出界面再回来不能显示成空闲）", function () {
  /**
   * 真机反馈："对话容易因轮询读取超时或**中途退出会话界面**而被判断为
   * 一轮对话的结束，缺乏对 harness 状态的监测表示。"
   *
   * 机制：`state.generating` 是**界面实例**的状态。退出会话页再回来是新实例，
   * 它初始为 `false` —— 界面显示空闲，而 harness 那边上一轮**还在跑**。
   * 用户以为答完了就追问一句，于是轮次错乱。
   */
  const ready = () =>
    reduce(initialState(), {
      kind: "ready",
      sessionId: "s-1",
      transport: "polling",
      resumed: true,
    });

  it("harness 说还在跑时：状态行明确写出来，且**禁止发送**", function () {
    const state = reduce(ready(), { kind: "harness", running: true });
    assert.match(
      statusLine(state, 19400),
      /仍在运行/,
      "必须显示「仍在运行」 —— 否则用户以为已经答完",
    );
    assert.ok(
      !canSend(state),
      "harness 还在跑时不能让用户再发一句（那正是轮次错乱的成因）",
    );
    assert.ok(isTurnActive(state), "isTurnActive 应为真");
  });

  it("**关键**：新实例（generating=false）也不会被当成空闲", function () {
    // 这正是"退出界面再回来"的场景：面板是新实例，generating 是初始的 false，
    // 唯一的状态来源就是问出来的 harnessRunning。
    let state = ready();
    assert.equal(state.generating, false, "前提：新实例不在生成");
    state = reduce(state, { kind: "harness", running: true });
    assert.ok(
      isTurnActive(state),
      "generating=false 但 harness 在跑 → 仍应算作「这一轮进行中」",
    );
    assert.match(statusLine(state, 19400), /仍在运行/);
  });

  it("harness 明确说没在跑 → 显示空闲、允许发送", function () {
    const state = reduce(ready(), { kind: "harness", running: false });
    assert.ok(!/仍在运行|状态未知/.test(statusLine(state, 19400)));
    assert.ok(canSend(state), "确实停了就该能发送");
    assert.ok(!harnessUnknown(state), "false 不是「未知」");
  });

  it("「问不到」（undefined）≠ 空闲：必须显示「状态未知」", function () {
    // 把 undefined 当 false，就是"在 RPC 抖动时宣布这一轮结束了" ——
    // 正是用户反馈的误判。宁可含糊也不能说谎。
    const state = reduce(ready(), { kind: "harness", running: undefined });
    assert.match(
      statusLine(state, 19400),
      /状态未知/,
      "问不到时要明确说不知道，而不是显示成空闲",
    );
    assert.ok(harnessUnknown(state));
  });

  it("没问过 harness 时不显示任何多余字样", function () {
    // 不能因为"还没问"就写"状态未知" —— 那是噪声，不是信息。
    const state = ready();
    const line = statusLine(state, 19400);
    assert.ok(!/仍在运行|状态未知/.test(line), `实际：${line}`);
    assert.ok(!harnessUnknown(state), "还没问过不算「未知」");
  });

  it("committed 结束后清成「确实停了」", function () {
    let state = reduce(ready(), { kind: "harness", running: true });
    state = reduce(state, { kind: "assistant-end", outcome: "committed" });
    assert.equal(state.harnessRunning, false, "harness 明确报过 turn/end");
    assert.ok(canSend(state));
    assert.ok(!/仍在运行/.test(statusLine(state, 19400)));
  });

  it("**abandoned**（我们等够了）结束时应变成「未知」，而不是「空闲」", function () {
    // ⚠️ 这条是本次反馈的核心：`abandoned` 的语义是**我们停止等待**，
    // 不是"harness 干完了"（state.ts 里那条注释写得很清楚）。
    // 结束就写 false，等于"把读取超时当成一轮对话的结束"。
    let state = reduce(ready(), { kind: "harness", running: true });
    state = reduce(state, { kind: "assistant-end", outcome: "abandoned" });
    assert.equal(
      state.harnessRunning,
      undefined,
      "abandoned 只能变成「未知」，不能变成 false（那会谎称它停了）",
    );
    assert.ok(harnessUnknown(state), "应当显示「运行状态未知」");
  });

  it("运行中的助手消息在**重开界面后**仍显示为进行中（光标不消失）", function () {
    let state = reduce(ready(), { kind: "prompt-accepted", text: "问" });
    state = reduce(state, { kind: "assistant-start" });
    state = reduce(state, {
      kind: "assistant-delta",
      chunk: { type: "block-start", index: 0, blockType: "text" },
    });
    state = reduce(state, {
      kind: "assistant-delta",
      chunk: { type: "text-delta", index: 0, text: "半句" },
    });
    // 模拟"退出界面再回来"：generating 回到 false，只有 harness 的答案还在
    state = { ...state, generating: false };
    state = reduce(state, { kind: "harness", running: true });
    const cells = toView(state);
    const assistant = cells.find((c) => c.kind === "assistant");
    assert.ok(assistant, "应有助手消息");
    assert.equal(
      assistant.streaming,
      true,
      "仍在跑时不能把消息标成已定稿 —— 否则界面看起来已经答完了",
    );
  });
});

describe("replay 等价于顺序 reduce", function () {
  it("重放同一事件序列得到相同可见文本", function () {
    __resetMessageSeq();
    const events = [
      { kind: "ready", sessionId: "s", transport: "t", resumed: false },
      { kind: "prompt-accepted", text: "问题" },
      { kind: "assistant-start" },
      ...liveChunks.map((chunk) => ({ kind: "assistant-delta", chunk })),
      { kind: "assistant-end", outcome: "committed" },
    ];
    const fixedNow = 1_700_000_000_000;
    const replayed = replay(events, fixedNow);
    const sequential = events.reduce(
      (s, e) => reduce(s, e, fixedNow),
      initialState(),
    );
    assert.deepEqual(toView(replayed), toView(sequential));
  });
});
