/**
 * 在 Zotero 插件沙箱里启动子进程。
 *
 * ## 为什么是这条途径（实测结论，不是推断）
 *
 * `xpcom/plugins.js:141-156` 的 `wantGlobalProperties` 白名单里**没有** `Subprocess`，
 * 163-183 行额外注入的也只有 `Zotero/ChromeWorker/IOUtils/Localization/PathUtils/Services/Worker/XMLSerializer`。
 * 因此本项目写了探针逐个实测，真实结果（写入诊断文件）：
 *
 *   ❌ Cc['@mozilla.org/process/util;1']            —— 构造器不存在
 *   ❌ Components.classes[nsIProcess]               —— 构造器不存在
 *   ✅ ChromeUtils.importESModule(Subprocess.sys.mjs) —— 可解析，Subprocess.call 可用
 *   ❌ Cu.import                                    —— 沙箱里没有
 *   ✅ Services.appinfo                             —— name=Zotero（XPC 旁证）
 *
 * 所以**唯一可用途径是 `Subprocess.sys.mjs`**（Zotero 自身启动外部程序也用它）。
 *
 * ## 用法约束
 *
 * - `Subprocess.call` 返回的 `proc` 必须**持有引用**，被 GC 回收会连带结束子进程；
 *   本模块让调用方把句柄存起来（RuntimeManager 持有）。
 * - 子进程的标准输出用 `proc.stdout.readString()` 读取（Gecko 实现）。
 * - 退出码用 `proc.wait()`。
 */

export interface SpawnOptions {
  /** 可执行文件绝对路径 */
  command: string;
  /** 参数列表 */
  args: string[];
  /** 额外环境变量（会与当前环境合并） */
  env?: Record<string, string>;
  /** 工作目录 */
  workdir?: string;
}

export interface SpawnedProcess {
  /** 平台进程号（可能为 undefined） */
  pid?: number;
  /** 等待退出并返回退出码 */
  wait: () => Promise<number>;
  /** 读取全部 stdout（进程结束前调用可能只拿到已产出的部分） */
  readStdout: () => Promise<string>;
  /** 读取全部 stderr */
  readStderr: () => Promise<string>;
  /** 非阻塞地读一次当前可用的输出（用于长驻进程的日志抓取） */
  drainStdout: () => Promise<string>;
  /** 非阻塞地读一次当前可用的错误输出 */
  drainStderr: () => Promise<string>;
  /** 强制结束 */
  kill: () => void;
  /** 底层句柄，必须由调用方持有以免被 GC 回收 */
  raw: unknown;
}

interface GeckoSubprocessModule {
  Subprocess: {
    call: (options: Record<string, unknown>) => Promise<GeckoProcess>;
  };
}

interface GeckoProcess {
  pid?: number;
  wait: () => Promise<{ exitCode: number }>;
  kill: () => void;
  stdout?: { readString?: () => Promise<string> } | null;
  stderr?: { readString?: () => Promise<string> } | null;
}

/**
 * 非阻塞地读一次管道内容。
 *
 * `readString()` 在管道关闭前会一直挂起，因此长驻进程不能直接 await。
 * 这里用"竞速 + 超时"实现：超时就返回空串，不阻塞调用方。
 */
async function drain(
  stream: { readString?: () => Promise<string> } | null | undefined,
  timeoutMs = 400,
): Promise<string> {
  if (typeof stream?.readString !== "function") return "";
  try {
    const raced = await Promise.race([
      stream.readString().catch(() => ""),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(""), timeoutMs),
      ),
    ]);
    return raced ?? "";
  } catch {
    return "";
  }
}

let cachedModule: GeckoSubprocessModule | undefined;

/** 解析 Subprocess 模块（缓存，避免重复 importESModule） */
function loadSubprocess(): GeckoSubprocessModule {
  if (cachedModule) return cachedModule;
  const ChromeUtils = (
    globalThis as unknown as {
      ChromeUtils?: { importESModule?: (uri: string) => unknown };
    }
  ).ChromeUtils;
  if (typeof ChromeUtils?.importESModule !== "function") {
    throw new Error("沙箱里没有 ChromeUtils.importESModule，无法启动子进程");
  }
  const mod = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  ) as GeckoSubprocessModule | undefined;
  if (!mod?.Subprocess || typeof mod.Subprocess.call !== "function") {
    throw new Error("Subprocess.sys.mjs 里没有可用的 Subprocess.call");
  }
  cachedModule = mod;
  return mod;
}

/**
 * 启动一个子进程并返回句柄。
 * 失败时抛错，错误信息里带上可执行路径，便于定位"路径不对"与"权限不足"。
 */
export async function spawn(options: SpawnOptions): Promise<SpawnedProcess> {
  const { Subprocess } = loadSubprocess();
  const launch: Record<string, unknown> = {
    command: options.command,
    arguments: options.args,
    // ⚠️ 必须显式指定 pipe，否则 stdout/stderr 拿不到任何东西 ——
    // 这曾让"子进程为什么没起来"完全无法诊断（readStderr 永远返回空串）。
    // Zotero 自身的用法见 xpcom/utilities_internal.js:750-754（`stderr: 'pipe'`）。
    stdout: "pipe",
    stderr: "pipe",
  };
  if (options.workdir) launch.workdir = options.workdir;
  if (options.env) {
    // ⚠️ 参数名与语义（Gecko `Subprocess.sys.mjs:119-124`，实测踩坑）：
    //   if (!options.environment || options.environmentAppend) environment = this.getEnvironment();
    //   if (options.environment) Object.assign(environment, options.environment);
    // 即 **变量对象要放在 `environment`**，而 `environmentAppend` 只是一个布尔开关
    // （表示"是否在继承的环境之上追加/覆盖"）。
    //
    // 先前这里写成 `environmentAppend: {…}`，于是：
    //  - `environment` 缺失 → 走"取当前环境"分支；
    //  - `Object.assign(environment, undefined)` 什么也不做；
    //  - 结果 DSH_HOME 与 DSH_FOR_ZOTERO_PORT **一个都没传进去**，
    //    宿主退回写死端口 19387，与桌面版 Harness 冲突 → 子进程退出码 1。
    launch.environment = options.env;
    launch.environmentAppend = true;
  }

  let proc: GeckoProcess;
  try {
    proc = await Subprocess.call(launch);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`启动子进程失败（${options.command}）：${detail}`);
  }

  return {
    pid: proc.pid,
    raw: proc,
    wait: async () => {
      const result = await proc.wait();
      return result?.exitCode ?? -1;
    },
    readStdout: async () => {
      try {
        return (await proc.stdout?.readString?.()) ?? "";
      } catch {
        return "";
      }
    },
    readStderr: async () => {
      try {
        return (await proc.stderr?.readString?.()) ?? "";
      } catch {
        return "";
      }
    },
    // readString() 在管道关闭前会**阻塞**，因此长驻进程不能直接 await 它。
    // 这里用带超时的竞速实现"能读多少读多少"，用于边跑边抓日志。
    drainStdout: async () => drain(proc.stdout),
    drainStderr: async () => drain(proc.stderr),
    kill: () => {
      try {
        proc.kill();
      } catch {
        // 已退出
      }
    },
  };
}

/**
 * 跑一个"执行完就退出"的子进程，返回退出码与输出。
 * 注意：会等待 `stdout.readString()` 完成，因此**不要**用它启动长驻进程
 * （长驻进程请用 `spawn` 并自行持有句柄）。
 */
export async function runToCompletion(
  options: SpawnOptions,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = await spawn(options);
  const timer = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const finished = (async () => {
    const exitCode = await child.wait();
    const [stdout, stderr] = await Promise.all([
      child.readStdout(),
      child.readStderr(),
    ]);
    return { exitCode, stdout, stderr };
  })();

  const raced = await Promise.race([finished, timer]);
  if (raced === "timeout") {
    child.kill();
    throw new Error(
      `子进程超时（${Math.round(timeoutMs / 1000)}s）：${options.command}`,
    );
  }
  return raced;
}
