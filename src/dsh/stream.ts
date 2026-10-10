/**
 * DSH `session/follow` 流式通道。
 *
 * 按优先级尝试三种载体，并把"哪一种成功"如实上报（M0 需要这个结论）：
 *  1. `ChromeWorker`（首选：插件沙箱白名单里有 ChromeWorker，worker 内有 WebSocket）
 *  2. 主窗口 `WebSocket`（Zotero 自身 XPCOM 代码就是这么用的）
 *  3. 不可用 → 由上层降级为轮询（`session/page`）
 *
 * 帧协议见 docs/DSH集成与桥接协议.md §6。
 */

import type { DshRuntimeConfig } from "./config";

export type StreamTransport = "chrome-worker" | "main-window" | "unavailable";

export interface FollowFrame {
  type?: string;
  streamId?: string;
  value?: unknown;
  error?: { code?: string; message?: string };
}

export interface FollowOptions {
  /** 会话地址：{ kind:'session', sessionId } */
  sessionId: string;
  assistantStream?: boolean;
  onFrame: (frame: FollowFrame) => void;
  onClose?: (info: { transport: StreamTransport; reason: string }) => void;
  /** 等待握手与开场帧的时限（毫秒） */
  openTimeoutMs?: number;
}

// ⚠️ 这里原有 `workerUrl()` —— 它产出的字符串与下面 `workerCandidates()` **完全相同**，
// 而实际加载走的是后者（见 loadSocketWorker）。两份实现只会漂移，
// 且 hooks.ts 里还有一条注释提到旧名字，让人以为它仍在被使用。

/**
 * 产出可读的 worker 加载诊断信息。
 *
 * 单独成函数（而不是内联到加载处）是为了**自检能复现同一串地址** ——
 * worker 加载失败时用户看到的地址必须与真实尝试的一致，否则"看日志排查"就没意义。
 */
export function workerCandidates(): string[] {
  const ref = addon.data.config.addonRef;
  return [`chrome://${ref}/content/dshSocketWorker.js`];
}

interface TransportHandle {
  transport: StreamTransport;
  send: (data: unknown) => void;
  close: () => void;
}

function connectWithWorker(
  config: DshRuntimeConfig,
  onText: (text: string) => void,
  onError: (message: string) => void,
  onClosed: (reason: string) => void,
): TransportHandle | { error: string } {
  const WorkerCtor = (globalThis as unknown as { ChromeWorker?: typeof Worker })
    .ChromeWorker;
  if (typeof WorkerCtor !== "function") {
    return { error: "沙箱里没有 ChromeWorker" };
  }
  const urls = workerCandidates();
  let worker: Worker | undefined;
  let lastError = "";
  /** worker 建立后是否已收到过消息 —— 用于区分"加载期失败"与"运行期失败" */
  let started = false;
  for (const url of urls) {
    try {
      worker = new WorkerCtor(url);
      break;
    } catch (error) {
      lastError = `${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!worker) {
    return { error: `ChromeWorker 加载失败（${lastError || "未知原因"}）` };
  }

  worker.onmessage = (event: Event) => {
    started = true;
    const msg = (event as unknown as { data?: unknown }).data as
      | {
          type?: string;
          data?: string;
          message?: string;
          code?: number;
          reason?: string;
        }
      | undefined;
    switch (msg?.type) {
      case "open":
        worker?.postMessage({
          type: "send",
          data: JSON.stringify({ __internal: "open" }),
        });
        // 真正的 open 帧由调用方通过 send() 发出；这里只通知就绪
        onText("__worker_open__");
        break;
      case "message":
        if (typeof msg.data === "string") onText(msg.data);
        break;
      case "error":
        onError(msg.message ?? "worker 报告错误");
        break;
      case "close":
        onClosed(
          `worker socket closed code=${msg.code ?? "?"} ${msg.reason ?? ""}`.trim(),
        );
        break;
      default:
        break;
    }
  };
  /**
   * worker 级错误（脚本加载失败、未捕获异常等）。
   *
   * 实测只报 "worker 错误：unknown" —— 说明 `message` 为空。
   * Gecko 的错误事件是 `ErrorEvent`，字段不全时也要把**能拿到的都拿出来**
   * （filename/lineno/colno/error），否则这条自检结论没有可操作性。
   */
  worker.onerror = (event: Event) => {
    const info = event as unknown as {
      message?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
      error?: { message?: string; name?: string };
    };
    const parts = [
      info.message || info.error?.message || info.error?.name || "unknown",
      info.filename ? `@ ${info.filename}` : "",
      typeof info.lineno === "number"
        ? `:${info.lineno}${typeof info.colno === "number" ? `:${info.colno}` : ""}`
        : "",
      // 事件本身不带 message 时，提示是哪一步失败的（构造/加载/首帧）
      `（阶段：${started ? "运行期" : "加载期"}）`,
    ].filter(Boolean);
    onError(`worker 错误：${parts.join(" ")}`);
  };

  worker.postMessage({ type: "connect", url: config.wsUrl });
  return {
    transport: "chrome-worker",
    send: (data) =>
      worker.postMessage({ type: "send", data: JSON.stringify(data) }),
    close: () => {
      try {
        worker.terminate();
      } catch {
        // 忽略
      }
    },
  };
}

function connectWithMainWindow(
  config: DshRuntimeConfig,
  onText: (text: string) => void,
  onError: (message: string) => void,
  onClosed: (reason: string) => void,
): TransportHandle | { error: string } {
  const win = Zotero.getMainWindow() as unknown as {
    WebSocket?: typeof WebSocket;
  } | null;
  const Ctor =
    win?.WebSocket ??
    (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof Ctor !== "function") {
    return { error: "拿不到可用的 WebSocket 构造器（主窗口与沙箱都没有）" };
  }
  let socket: WebSocket;
  try {
    socket = new Ctor(config.wsUrl);
  } catch (error) {
    return {
      error: `WebSocket 构造失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  socket.onopen = () => onText("__worker_open__");
  socket.onmessage = (event: Event) => {
    const data = (event as unknown as { data?: unknown }).data;
    onText(typeof data === "string" ? data : String(data));
  };
  socket.onerror = () => onError("主窗口 WebSocket 连接错误");
  socket.onclose = (event: Event) => {
    const info = event as unknown as { code?: number; reason?: string };
    onClosed(
      `main-window socket closed code=${info.code ?? "?"}${info.reason ? ` ${info.reason}` : ""}`,
    );
  };
  return {
    transport: "main-window",
    send: (data) => socket.send(JSON.stringify(data)),
    close: () => {
      try {
        socket.close();
      } catch {
        // 忽略
      }
    },
  };
}

/**
 * 打开一条跟随流。返回实际使用的载体（供自检展示）与关闭函数。
 */
export function openFollowStream(
  config: DshRuntimeConfig,
  options: FollowOptions,
): { transport: StreamTransport; close: () => void; error?: string } {
  const streamId = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  let handle: TransportHandle | undefined;
  let closed = false;
  const errors: string[] = [];

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    try {
      handle?.close();
    } catch {
      // 忽略
    }
    options.onClose?.({
      transport: handle?.transport ?? "unavailable",
      reason,
    });
  };

  const onText = (text: string) => {
    if (text === "__worker_open__") {
      // 握手成功 → 发 open 帧
      handle?.send({
        type: "open",
        streamId,
        endpoint: "session/follow",
        payload: {
          args: {
            request: {
              address: { kind: "session", sessionId: options.sessionId },
              assistantStream: options.assistantStream !== false,
            },
          },
        },
      });
      return;
    }
    let frame: FollowFrame;
    try {
      frame = JSON.parse(text) as FollowFrame;
    } catch {
      return; // 非 JSON 帧忽略
    }
    if (frame?.streamId && frame.streamId !== streamId && frame.type !== "item")
      return;
    options.onFrame(frame);
  };

  const onError = (message: string) => {
    errors.push(message);
    options.onFrame({
      type: "transport-error",
      error: { code: "client/ws", message },
    });
  };

  const workerAttempt = connectWithWorker(config, onText, onError, finish);
  if ("transport" in workerAttempt) {
    handle = workerAttempt;
  } else {
    errors.push(workerAttempt.error);
    const mainAttempt = connectWithMainWindow(config, onText, onError, finish);
    if ("transport" in mainAttempt) {
      handle = mainAttempt;
    } else {
      errors.push(mainAttempt.error);
    }
  }

  if (!handle) {
    return {
      transport: "unavailable",
      close: () => undefined,
      error: errors.join("；"),
    };
  }

  // 握手/开场帧超时保护
  const timeoutMs = options.openTimeoutMs ?? 10000;
  const timer = setTimeout(() => {
    if (!closed) finish(`等待开场帧超时（${timeoutMs}ms）`);
  }, timeoutMs);

  return {
    transport: handle.transport,
    close: () => {
      clearTimeout(timer);
      // 先协议层取消，再关连接
      try {
        handle?.send({ type: "cancel", streamId });
      } catch {
        // 忽略
      }
      finish("caller closed");
    },
  };
}
