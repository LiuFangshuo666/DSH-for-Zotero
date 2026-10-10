/**
 * ChromeWorker 可用性探测。
 *
 * 为什么需要独立探针：自检里的流式实测要人工点菜单才能跑，而且它把 worker 的
 * 加载期失败和握手期失败混在一起报（实测只得到一句 "worker 错误：unknown"）。
 * 这里做一个**不依赖网络**的最小探测，结果写进启动诊断文件 —— 这样
 * "worker 到底能不能加载" 这件事可以离线判定，不必每次都占据一轮实机验证。
 *
 * 判定思路：
 *  - `new ChromeWorker(url)` 能构造，只说明构造器在；
 *  - 让它 echo 一条消息，能收到回复才说明**脚本真的加载并执行了**；
 *  - 全程 500ms 超时，超时视为"构造成功但脚本没跑起来"。
 */

export interface WorkerProbeResult {
  /** 沙箱里是否有 ChromeWorker 构造器 */
  available: boolean;
  /** 构造是否成功 */
  constructed: boolean;
  /** 是否收到 worker 的回复（说明脚本已加载并执行） */
  responsive: boolean;
  /** worker 用的 URL（便于发现 chrome:// 注册问题） */
  url: string;
  /** 失败原因（人类可读） */
  error?: string;
  /** 耗时的粗略分档，便于识别超时 */
  elapsedMs: number;
  /** worker 内部的能力清单（含 WebSocket 是否可构造） */
  workerCapabilities?: {
    hasWebSocket?: boolean;
    hasFetch?: boolean;
    hasCrypto?: boolean;
    hasLocation?: boolean;
    constructed?: boolean;
    constructError?: string | null;
  };
}

/** 与 dshSocketWorker.js 同目录的探针脚本，走同一个 chrome:// 资源前缀 */
const PROBE_SCRIPT = "dshWorkerProbe.js";

export function workerProbeUrl(addonRef: string): string {
  return `chrome://${addonRef}/content/${PROBE_SCRIPT}`;
}

/**
 * 探测 ChromeWorker 能否加载并执行脚本。
 * 任何异常都被吞掉并转成结果对象 —— 这是诊断代码，不该让插件崩。
 */
export async function probeChromeWorker(
  addonRef: string,
  timeoutMs = 500,
): Promise<WorkerProbeResult> {
  const url = workerProbeUrl(addonRef);
  const started = Date.now();
  const result: WorkerProbeResult = {
    available: false,
    constructed: false,
    responsive: false,
    url,
    elapsedMs: 0,
  };

  const WorkerCtor = (
    globalThis as unknown as { ChromeWorker?: new (url: string) => Worker }
  ).ChromeWorker;
  if (typeof WorkerCtor !== "function") {
    result.error = "沙箱里没有 ChromeWorker 构造器";
    result.elapsedMs = Date.now() - started;
    return result;
  }
  result.available = true;

  let worker: Worker | undefined;
  try {
    worker = new WorkerCtor(url);
    result.constructed = true;
  } catch (error) {
    result.error = `构造失败：${error instanceof Error ? error.message : String(error)}`;
    result.elapsedMs = Date.now() - started;
    return result;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      result.error =
        result.error ?? `worker 未在 ${timeoutMs}ms 内回复（脚本可能没执行）`;
      finish();
    }, timeoutMs);

    worker!.onmessage = (event: Event) => {
      const data = (
        event as unknown as { data?: { type?: string; echo?: unknown } }
      ).data;
      if (data?.type === "probe-ok") {
        result.responsive = true;
        result.error = undefined;
        result.workerCapabilities = (data.echo ??
          undefined) as WorkerProbeResult["workerCapabilities"];
        finish();
      }
    };
    worker!.onerror = (event: Event) => {
      const info = event as unknown as {
        message?: string;
        filename?: string;
        lineno?: number;
        colno?: number;
      };
      result.error = [
        info.message || "worker 错误（无 message）",
        info.filename ? `@ ${info.filename}` : "",
        typeof info.lineno === "number"
          ? `:${info.lineno}:${info.colno ?? 0}`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      finish();
    };

    try {
      worker!.postMessage({ type: "probe", url: "ws://127.0.0.1:1/probe" });
    } catch (error) {
      result.error = `postMessage 失败：${error instanceof Error ? error.message : String(error)}`;
      finish();
    }
  });

  try {
    worker.terminate();
  } catch {
    // 忽略
  }
  result.elapsedMs = Date.now() - started;
  return result;
}

/** 供诊断文件使用的单行摘要 */
export function describeWorkerProbe(result: WorkerProbeResult): string {
  const parts = [
    `构造器=${result.available ? "有" : "无"}`,
    `构造=${result.constructed ? "成功" : "失败"}`,
    `脚本执行=${result.responsive ? "成功" : "失败"}`,
    `${result.elapsedMs}ms`,
  ];
  const caps = result.workerCapabilities;
  if (caps) {
    parts.push(
      `worker 内 WebSocket=${caps.hasWebSocket ? "有" : "无"}`,
      `可构造=${caps.constructed ? "是" : "否"}`,
    );
    if (caps.constructError) parts.push(`构造错误=${caps.constructError}`);
    parts.push(`location=${caps.hasLocation ? "有" : "无"}`);
  }
  if (result.error) parts.push(`原因：${result.error}`);
  return parts.join("；");
}
