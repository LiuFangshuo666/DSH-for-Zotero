/**
 * 对话状态机与展示逻辑（纯逻辑，无 DOM、无 Zotero 依赖，可单测）。
 *
 * 设计要点：
 *  - **传输无关**：不管答案来自 `session/follow` 流式帧还是 `session/page` 轮询，
 *    都归一成 `AssistantDelta` 事件，状态机不认识载体。这样 M0 的三项通道确认
 *    结果无论哪种，这一层都不用改。
 *  - **节点可变、文本追加**：同一个助手消息由多个"块"组成（reasoning / text / …）。
 *    `block-start` 建块、`text-delta` 追加、`block-end` 定稿，据此可做逐字渲染。
 *  - **事件可重放**：`reduce` 只依赖前一个状态与一个事件，便于测试与排障。
 */

// ── 来自 dsh 的增量（由传输层归一化后送入） ──────────────────

export type DshChunk =
  | { type: "block-start"; index: number; blockType?: string }
  | {
      type: "block-end";
      index: number;
      block?: { type?: string; text?: string };
    }
  | { type: "text-delta"; index: number; text: string }
  | { type: "usage"; index?: number; usage?: Record<string, unknown> }
  | { type: "finish"; index?: number; reason?: unknown }
  | { type: string; index?: number; [key: string]: unknown };

export type ChatEvent =
  /** 会话已就绪（新建或恢复） */
  | { kind: "ready"; sessionId: string; transport: string; resumed: boolean }
  /** 传输层报告的问题 */
  | { kind: "fault"; code: string; message: string }
  /** 用户提问已被接受 */
  | { kind: "prompt-accepted"; text: string }
  /** 助手开始生成 */
  | { kind: "assistant-start" }
  /** 助手增量（token/块级） */
  | { kind: "assistant-delta"; chunk: DshChunk }
  /** 助手这一轮结束（committed / abandoned / 用户取消） */
  | { kind: "assistant-end"; outcome: "committed" | "abandoned" | "cancelled" }
  /**
   * 生成过程中的**说明性提示**（不影响对话内容）。
   *
   * 为什么需要：Agent 多步执行时可能好几分钟没有可见输出。先前界面只是"不动"，
   * 用户无法区分「还在跑」与「卡死了」—— 于是会去关界面或再发一句，
   * 结果是轮次错乱。有了这个事件，界面能明确说"仍在生成"。
   */
  | { kind: "assistant-note"; note: string }
  /**
   * 载入历史对话（真机反馈"看不到会话历史"）。
   * 打开面板或切回已聊过的文献时，用 dsh 里已有的一问一答回填消息列表，
   * 否则界面只显示当前这一轮，用户以为记录丢了。
   */
  | { kind: "history"; turns: Array<{ prompt: string; response: string }> }
  /** 生成状态变化（用于"正在生成…"与停止按钮） */
  | { kind: "status"; generating: boolean }
  /** 用户点了停止 */
  | { kind: "cancel-requested" }
  /**
   * harness 侧的真实运行状态（**跨界面重启**的唯一状态来源）。
   *
   * ## 为什么需要它（真机反馈）
   *
   * 用户："对话容易因轮询读取超时或**中途退出会话界面**而被判断为一轮对话的结束，
   * 缺乏对 harness 状态的监测表示。"
   *
   * `status.generating` 是**界面实例**的状态：退出会话页再回来就是新实例，
   * 它初始为 `false` —— 于是界面显示空闲，而 harness 那边上一轮**还在跑**。
   * 用户以为结束了，追问一句，就得到轮次错乱。
   *
   * 与 `generating` 的分工：
   *  - `generating`：**本界面**知道正在生成（我们自己发的提问）；
   *  - `harnessRunning`：**问过 harness** 得到的答案，界面重启也有效。
   *
   * `running` 为 `undefined` 表示**问不到**（RPC 抖动），这时界面**不能**
   * 宣布"已结束"，只能说"状态未知"。
   */
  | { kind: "harness"; running: boolean | undefined; at?: number };

// ── 展示模型 ────────────────────────────────────────────────

export interface ChatBlock {
  /** dsh 给的块序号（只用于排序，允许不连续） */
  index: number;
  blockType: string;
  text: string;
  done: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "notice";
  blocks: ChatBlock[];
  /** notice 用：提示级别 */
  level?: "info" | "warn" | "error";
  createdAt: number;
}

export interface ChatState {
  sessionId?: string;
  transport?: string;
  resumed: boolean;
  /** 传输层是否就绪（否则输入应禁用） */
  connected: boolean;
  generating: boolean;
  messages: ChatMessage[];
  /** 最近一次错误（面板顶部显示） */
  lastFault?: { code: string; message: string };
  /** 取消是否已发出（避免重复点击） */
  cancelPending: boolean;
  /**
   * 问过 harness 的结果：这个会话的 agent 是否仍在跑。
   *
   * ⚠️ 与 `generating` **不是**一回事，两个都要看：
   *  - `generating` 只说明**本界面实例**知道正在生成；
   *  - 本字段在**退出界面再回来**之后仍然有效（面板挂载时会重新问一次）。
   *
   * `undefined` = 问不到（RPC 抖动）—— 界面必须显示"状态未知"，
   * **不能**显示成"空闲"。
   */
  harnessRunning?: boolean;
  /** 上一次问 harness 的时刻（用于显示"从 HH:MM 起仍在运行"） */
  harnessCheckedAt?: number;
}

export function initialState(): ChatState {
  return {
    connected: false,
    resumed: false,
    generating: false,
    messages: [],
    cancelPending: false,
  };
}

/**
 * 这一轮是否**仍在进行**（界面据此禁用输入并显示进度）。
 *
 * 取两者的**并集**：`generating` 是本界面知道的，`harnessRunning` 是问出来的。
 * 任一说"在跑"就当在跑 —— 宁可多显示一会儿"仍在生成"（用户会看到它结束），
 * 也不要在它其实还在跑时显示空闲（那会诱导用户追问，导致轮次错乱）。
 *
 * ⚠️ `harnessRunning === undefined`（问不到）**不算**在跑，但也不等于空闲：
 * 调用方应当用 `harnessUnknown()` 单独区分这两种情况。
 */
export function isTurnActive(state: ChatState): boolean {
  return state.generating || state.harnessRunning === true;
}

/** 状态**未知**（问不到 harness）—— 与"确实空闲"必须分开处理 */
export function harnessUnknown(state: ChatState): boolean {
  return (
    state.harnessCheckedAt !== undefined && state.harnessRunning === undefined
  );
}

const MAX_MESSAGES = 200;

let messageSeq = 0;
function nextId(prefix: string): string {
  messageSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${messageSeq}`;
}

/** 供测试重置（避免依赖时间/序号） */
export function __resetMessageSeq(): void {
  messageSeq = 0;
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    blocks: m.blocks.map((b) => ({ ...b })),
  }));
}

function trimmed(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > MAX_MESSAGES
    ? messages.slice(messages.length - MAX_MESSAGES)
    : messages;
}

/**
 * 把 dsh 的 chunk 落到消息块上。
 *
 * 块用**列表 + index 字段**表示，不用数组下标：dsh 的块序号可以不连续
 * （例如只有 index 3），用数组会在中间留空洞，`map` 又会跳过空洞导致渲染读到 undefined。
 */
function applyChunk(blocks: ChatBlock[], chunk: DshChunk): ChatBlock[] {
  const next = blocks.map((b) => ({ ...b }));
  const index = typeof chunk.index === "number" ? chunk.index : -1;
  const find = (i: number) => next.findIndex((b) => b.index === i);

  switch (chunk.type) {
    case "block-start": {
      const at = find(index);
      const blockType =
        typeof chunk.blockType === "string" ? chunk.blockType : "text";
      if (at >= 0) {
        next[at] = { ...next[at], blockType, done: false };
      } else {
        next.push({ index, blockType, text: "", done: false });
      }
      return next;
    }
    case "text-delta": {
      const text = typeof chunk.text === "string" ? chunk.text : "";
      const at = find(index);
      if (at >= 0) {
        next[at] = { ...next[at], text: next[at].text + text, done: false };
      } else {
        next.push({ index, blockType: "text", text, done: false });
      }
      return next;
    }
    case "block-end": {
      const finalBlock = chunk.block as
        | { type?: unknown; text?: unknown }
        | undefined;
      const finalText =
        typeof finalBlock?.text === "string" ? finalBlock.text : undefined;
      const blockType =
        typeof finalBlock?.type === "string" ? finalBlock.type : "text";
      const at = find(index);
      if (at >= 0) {
        const current = next[at];
        next[at] = {
          ...current,
          // 只在最终文本更完整时采用（避免定稿反而丢字）
          text:
            finalText !== undefined && finalText.length >= current.text.length
              ? finalText
              : current.text,
          done: true,
        };
      } else if (finalText !== undefined) {
        next.push({ index, blockType, text: finalText, done: true });
      }
      return next;
    }
    default:
      // usage / finish / 未知类型：不改变可见文本
      return next;
  }
}

/** 追加一条助手消息的载体（不导出，内部用） */
function pushAssistant(messages: ChatMessage[], time: number): ChatMessage[] {
  return [
    ...cloneMessages(messages),
    { id: nextId("a"), role: "assistant", blocks: [], createdAt: time },
  ];
}

/** 找到最后一条仍在生成中的助手消息下标 */
function lastOpenAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    return i;
  }
  return -1;
}

/**
 * 状态机的唯一入口。纯函数：相同输入必得相同输出（时间戳由参数注入，便于测试）。
 */
export function reduce(
  state: ChatState,
  event: ChatEvent,
  now: number = Date.now(),
): ChatState {
  switch (event.kind) {
    case "ready":
      return {
        ...state,
        connected: true,
        sessionId: event.sessionId,
        transport: event.transport,
        resumed: event.resumed,
        lastFault: undefined,
      };

    case "fault":
      return {
        ...state,
        connected: false,
        generating: false,
        cancelPending: false,
        lastFault: { code: event.code, message: event.message },
      };

    case "history": {
      // 历史回填：整段替换消息列表（此时还没有本轮消息）。
      // 空 response 的轮次（例如被取消）跳过，避免出现空白气泡。
      const messages = event.turns
        .filter((turn) => turn.prompt.trim() || turn.response.trim())
        .flatMap((turn) => {
          const list = [];
          if (turn.prompt.trim()) {
            list.push({
              id: nextId("u"),
              role: "user" as const,
              blocks: [
                { index: 0, blockType: "text", text: turn.prompt, done: true },
              ],
              createdAt: now,
            });
          }
          if (turn.response.trim()) {
            list.push({
              id: nextId("a"),
              role: "assistant" as const,
              blocks: [
                {
                  index: 0,
                  blockType: "text",
                  text: turn.response,
                  done: true,
                },
              ],
              createdAt: now,
            });
          }
          return list;
        });
      return { ...state, messages };
    }

    case "prompt-accepted": {
      const messages = [
        ...cloneMessages(state.messages),
        {
          id: nextId("u"),
          role: "user" as const,
          blocks: [
            { index: 0, blockType: "text", text: event.text, done: true },
          ],
          createdAt: now,
        },
      ];
      return { ...state, messages: trimmed(messages), lastFault: undefined };
    }

    case "harness": {
      // 记下**问到的时刻**：界面要能说"从 14:32 起仍在运行"，
      // 而不是只给一个没有时间基准的"运行中"。
      return {
        ...state,
        harnessRunning: event.running,
        harnessCheckedAt: now,
      };
    }

    case "assistant-start": {
      const messages = pushAssistant(state.messages, now);
      return { ...state, messages, generating: true, cancelPending: false };
    }

    case "assistant-delta": {
      // 没有进行中的助手消息就先建一条（容忍 start 丢帧）
      const messages =
        lastOpenAssistantIndex(state.messages) >= 0
          ? cloneMessages(state.messages)
          : pushAssistant(state.messages, now);
      const index = lastOpenAssistantIndex(messages);
      if (index < 0) return state;
      messages[index] = {
        ...messages[index],
        blocks: applyChunk(messages[index].blocks, event.chunk),
      };
      return { ...state, messages, generating: true };
    }

    case "assistant-note": {
      // 生成过程中的说明（例如"仍在生成"）——
      // **不改变** generating 状态，只往对话流里插一条提示。
      // 这不是错误也不是结束，所以 level 用 info。
      const messages = cloneMessages(state.messages);
      messages.push({
        id: nextId("n"),
        role: "notice",
        blocks: [{ index: 0, blockType: "text", text: event.note, done: true }],
        level: "info",
        createdAt: now,
      });
      return { ...state, messages: trimmed(messages) };
    }

    case "assistant-end": {
      const messages = cloneMessages(state.messages);
      const index = lastOpenAssistantIndex(messages);
      if (index >= 0) {
        messages[index] = {
          ...messages[index],
          blocks: messages[index].blocks.map((b) => ({ ...b, done: true })),
        };
      }
      if (event.outcome !== "committed") {
        messages.push({
          id: nextId("n"),
          role: "notice",
          blocks: [
            {
              index: 0,
              blockType: "text",
              text:
                event.outcome === "cancelled"
                  ? "已停止生成"
                  : // ⚠️ 这里不能只说"已放弃"（真机误导）。
                    //
                    // `abandoned` 的两种成因性质完全不同：
                    //  - **等够了**：我们不再盯着看，但 **harness 可能还在跑** ——
                    //    用户需要知道"回答可能稍后补齐"，否则他会以为这一问失败了；
                    //  - **本轮出错**：host 明确回了 error（那条分支在此之前就返回了，
                    //    走的是 fault，不会到这里）。
                    // 所以文案要说明"我们停了，但它可能还在继续"，并给出下一步。
                    "插件已停止等待这一轮（可能超时）。**harness 那边可能仍在继续生成** —— " +
                    "稍后点「刷新材料」或重新打开会话即可看到完整回答。",
              done: true,
            },
          ],
          level: event.outcome === "cancelled" ? "info" : "warn",
          createdAt: now,
        });
      }
      return {
        ...state,
        messages: trimmed(messages),
        generating: false,
        cancelPending: false,
        // ⚠️ 结束**不等于**"harness 停了"，按结局区分（这正是用户反馈的那类误判）：
        //
        //  - `committed`：harness 明确报了 `turn/end` → 它确实停了 → `false`；
        //  - `cancelled`：用户点了停止 → 会走 cancel 流程，同样按"已停"处理；
        //  - `abandoned`：**我们等够了，不是它干完了**（见上面那条注释）。
        //    这时**必须保持"未知"**（`undefined`）而不是写成 `false` ——
        //    写成 `false` 就是"把读取超时当成一轮对话的结束"，
        //    用户于是以为可以追问，而 harness 还在跑 → 轮次错乱。
        ...(event.outcome === "abandoned"
          ? { harnessRunning: undefined, harnessCheckedAt: now }
          : { harnessRunning: false, harnessCheckedAt: now }),
      };
    }

    case "status":
      return {
        ...state,
        generating: event.generating,
        cancelPending: event.generating ? state.cancelPending : false,
      };

    case "cancel-requested":
      return { ...state, cancelPending: true };

    default:
      return state;
  }
}

/** 批量重放事件（等价于顺序 reduce） */
export function replay(events: ChatEvent[], now?: number): ChatState {
  return events.reduce(
    (state, event) => reduce(state, event, now),
    initialState(),
  );
}

// ── 展示逻辑 ────────────────────────────────────────────────

export interface ViewCell {
  kind: "user" | "assistant" | "notice";
  /** 已完成文本（逐字渲染时也已包含当前增量） */
  text: string;
  level?: "info" | "warn" | "error";
  /** 仍在生成（UI 可加光标/动画） */
  streaming: boolean;
}

/**
 * 把消息转成可渲染的单元格。
 * 助手消息里的 reasoning 块以"思考：…"形式折叠成一行摘要，避免刷屏。
 */
export function toView(state: ChatState): ViewCell[] {
  return state.messages.map((message) => {
    if (message.role === "notice") {
      return {
        kind: "notice" as const,
        text: message.blocks.map((b) => b.text).join(""),
        level: message.level ?? "info",
        streaming: false,
      };
    }
    const ordered = [...message.blocks].sort((a, b) => a.index - b.index);
    const parts: string[] = [];
    for (const block of ordered) {
      if (block.blockType === "reasoning") {
        if (block.text.trim().length > 0)
          parts.push(`思考：${block.text.trim()}`);
      } else {
        parts.push(block.text);
      }
    }
    // ⚠️ 用 `isTurnActive` 而不是只看 `generating`：退出界面再回来时
    // `generating` 是新实例的初始值 `false`，而 harness 那边可能还在跑。
    // 用并集判断，光标才会继续显示 —— 否则界面看起来已经答完了。
    const streaming =
      message.role === "assistant" &&
      message.blocks.some((b) => !b.done) &&
      isTurnActive(state);
    return {
      kind:
        message.role === "user" ? ("user" as const) : ("assistant" as const),
      text: parts.join("\n"),
      streaming,
    };
  });
}

/** 面板顶部状态行文案 */
export function statusLine(state: ChatState, port: number): string {
  if (state.lastFault) return `未连接 dsh（${state.lastFault.code}）`;
  if (!state.connected) return "正在连接 dsh…";
  const parts = [`已连接 dsh · ${port}`];
  if (state.sessionId) parts.push(`会话 ${state.sessionId.slice(0, 14)}…`);
  if (state.resumed) parts.push("已恢复");
  if (state.generating) {
    parts.push(state.cancelPending ? "正在停止…" : "生成中…");
  } else if (state.harnessRunning === true) {
    // ⚠️ 这条分支专门服务"退出界面再回来"：本实例没有在生成，
    // 但**问过 harness**，它说还在跑。不显示这句，用户就会以为已经答完。
    parts.push(
      state.harnessCheckedAt
        ? `仍在运行（自 ${clockOf(state.harnessCheckedAt)} 起）`
        : "仍在运行",
    );
  } else if (harnessUnknown(state)) {
    // 问不到 ≠ 空闲。含糊其辞也比谎称"空闲"好 —— 后者会诱导用户追问。
    parts.push("运行状态未知");
  }
  return parts.join(" · ");
}

/** 把时间戳格式化成 `HH:MM`（状态行用，不带秒以免抖动） */
function clockOf(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * 输入区是否可用。
 *
 * ⚠️ 用 `isTurnActive` 而不是只看 `generating`：harness 还在跑时**不能**让用户
 * 再发一句 —— 那正是"追问一句得到轮次错乱"的成因。
 */
export function canSend(state: ChatState): boolean {
  return state.connected && !isTurnActive(state) && !state.cancelPending;
}
