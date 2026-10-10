/**
 * DSH remote.mux WebSocket 客户端（跑在 ChromeWorker 里）。
 *
 * 为什么在 worker 里：Zotero 插件沙箱的注入白名单**没有 WebSocket**
 * （xpcom/plugins.js:141-156），但同一份名单**注入了 ChromeWorker**
 * （plugins.js:167），worker 全局有完整 Web API。详见 docs/DSH集成与桥接协议.md §7.2。
 *
 * 协议（docs §6.1）：
 *   客户端 → {"type":"open","streamId","endpoint","payload":{"args":{…}}}
 *            {"type":"cancel","streamId"} / {"type":"end","streamId"} / {"type":"item",…}
 *   服务端 → {"type":"item","streamId","value"} / {"type":"error",…} / {"type":"end","streamId"}
 * 仅文本帧；Host 每 2s 发 WebSocket ping（协议层自动回 pong，无需应用代码）。
 *
 * 本文件是纯 JS（不经打包器改写），通过 chrome://<addonRef>/content/dshSocketWorker.js 加载。
 */

/** @type {WebSocket | null} */
let socket = null;

self.onmessage = (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  switch (data.type) {
    case "connect": {
      closeSocket();
      try {
        socket = new WebSocket(data.url);
      } catch (error) {
        post({
          type: "error",
          message: `WebSocket 构造失败：${String(error)}`,
        });
        return;
      }
      socket.onopen = () => post({ type: "open" });
      socket.onmessage = (messageEvent) => {
        // 原样透传文本帧，由主线程解析（避免 worker 里做协议解释）
        post({ type: "message", data: String(messageEvent.data) });
      };
      socket.onerror = () =>
        post({ type: "error", message: "WebSocket 连接错误" });
      socket.onclose = (closeEvent) =>
        post({
          type: "close",
          code: closeEvent.code,
          reason: closeEvent.reason,
        });
      break;
    }
    case "send": {
      if (!socket || socket.readyState !== 1) {
        post({ type: "error", message: "socket 未就绪，无法发送" });
        return;
      }
      socket.send(String(data.data));
      break;
    }
    case "close": {
      closeSocket();
      post({ type: "closed" });
      break;
    }
    default:
      break;
  }
};

function closeSocket() {
  if (!socket) return;
  try {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  } catch {
    // 忽略
  }
  socket = null;
}

function post(message) {
  try {
    self.postMessage(message);
  } catch (error) {
    // 主线程可能已卸载
    void error;
  }
}
