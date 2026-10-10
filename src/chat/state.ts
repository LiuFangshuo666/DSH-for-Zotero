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
  | { kind: "cancel-requested" };

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
    const streaming =
      message.role === "assistant" &&
      message.blocks.some((b) => !b.done) &&
      state.generating;
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
  if (state.generating)
    parts.push(state.cancelPending ? "正在停止…" : "生成中…");
  return parts.join(" · ");
}

/** 输入区是否可用 */
export function canSend(state: ChatState): boolean {
  return state.connected && !state.generating && !state.cancelPending;
}
