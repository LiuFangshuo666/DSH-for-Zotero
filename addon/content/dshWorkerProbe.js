/**
 * ChromeWorker 探针脚本（跑在 worker 里，不经打包器改写）。
 *
 * 存在的唯一目的：让主线程能区分"worker 构造成功"与"worker 脚本真的加载并执行了"。
 * 实测中 Zotero 只给出 `worker 错误：unknown`，无法判断是 chrome:// 资源没注册上，
 * 还是 WebSocket 握手被拒 —— 这个探针把这两件事分开。
 *
 * 2026-10-02 补充：真实流式失败被标注为"阶段：加载期"，即**脚本加载**就失败了，
 * 而本探针（同目录、同为 chrome:// 资源）却能执行 —— 差别只在于本探针原本不碰 WebSocket。
 * 因此现在**额外报告 worker 里的 WebSocket 能力**，把"worker 环境是否支持 WebSocket"
 * 这件事直接问出来，而不是靠排除法猜。
 *
 * 通过 chrome://<addonRef>/content/dshWorkerProbe.js 加载。
 */

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== "probe") return;

  const report = {
    hasWebSocket: typeof WebSocket === "function",
    hasFetch: typeof fetch === "function",
    hasCrypto: typeof crypto === "object" && crypto !== null,
    hasLocation: typeof location === "object" && location !== null,
    // 试着真的构造一个 WebSocket 到回环地址：能构造说明 API 可用，
    // 抛错则把错误类型带回去（这正是"加载期失败"最可能的原因）
    constructError: null,
    constructed: false,
  };

  if (report.hasWebSocket) {
    try {
      const ws = new WebSocket(data.url || "ws://127.0.0.1:1/probe");
      report.constructed = true;
      // 立刻关掉，避免留下连接
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    } catch (error) {
      report.constructError = `${error && error.name ? error.name + ": " : ""}${String(error)}`;
    }
  }

  try {
    self.postMessage({ type: "probe-ok", echo: report });
  } catch (error) {
    self.postMessage({ type: "probe-error", message: String(error) });
  }
};
