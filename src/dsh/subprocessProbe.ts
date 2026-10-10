/**
 * 启动子进程的能力探针。
 *
 * 为什么需要：新设计要求"DSH-for-Zotero 的运行环境与本机 DeepSeek Harness 隔离"，
 * 实现方式是**插件自己拉起一个专属 dsh 宿主进程**。但 Zotero 插件的沙箱**不是**完整
 * Gecko 作用域 —— `xpcom/plugins.js:141-156` 的 `wantGlobalProperties` 白名单里
 * **没有 `Subprocess`、也没有 `nsIProcess`**，只额外注入了
 * `Zotero / ChromeWorker / IOUtils / Localization / PathUtils / Services / Worker / XMLSerializer`。
 *
 * 因此"能不能启动子进程"必须**实测**，不能推断（本项目已有多次推断错误的教训）。
 * 这里逐个探测所有可能的途径并把结果如实上报，由真实环境给出答案。
 */

export interface SubprocessProbeEntry {
  /** 探测途径 */
  path: string;
  /** 是否可用 */
  ok: boolean;
  /** 失败原因或补充说明 */
  detail: string;
}

export interface SubprocessProbeResult {
  entries: SubprocessProbeEntry[];
  /** 是否至少有一条可用途径 */
  anyAvailable: boolean;
}

/** 安全取全局，避免沙箱里未定义时抛错 */
function safeGet(name: string): unknown {
  try {
    return (globalThis as unknown as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/** 探测：能否用给定构造器创建进程对象 */
function tryCreateProcess(
  ctor: unknown,
  label: string,
  out: SubprocessProbeEntry[],
): void {
  if (typeof ctor !== "function") {
    out.push({ path: label, ok: false, detail: "构造器不存在" });
    return;
  }
  try {
    const instance = new (ctor as new () => unknown)();
    const hasInit = typeof (instance as { init?: unknown }).init === "function";
    const hasRun =
      typeof (instance as { runAsync?: unknown }).runAsync === "function";
    out.push({
      path: label,
      ok: hasInit && hasRun,
      detail:
        hasInit && hasRun
          ? "可创建，具备 init/runAsync"
          : `可创建，但缺 init(${hasInit})/runAsync(${hasRun})`,
    });
  } catch (error) {
    out.push({
      path: label,
      ok: false,
      detail: `创建失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * 探测所有可能的子进程启动途径。
 * 每一项都真实执行（创建对象 / 解析模块），失败原因一并带回。
 */
export function probeSubprocess(): SubprocessProbeResult {
  const entries: SubprocessProbeEntry[] = [];

  // ① Components.classes 直接取 nsIProcess（沙箱里 Cc/Ci/Cu 实测存在）
  const Cc = safeGet("Cc") as { __lookupGetter__?: unknown } | undefined;
  const classes = Cc as unknown as Record<string, unknown> | undefined;
  const nsIProcessCID = "@mozilla.org/process/util;1";
  if (classes && typeof classes === "object") {
    try {
      const ctor = (classes as { [k: string]: unknown })[nsIProcessCID];
      tryCreateProcess(ctor, "Cc['@mozilla.org/process/util;1']", entries);
    } catch (error) {
      entries.push({
        path: "Cc['@mozilla.org/process/util;1']",
        ok: false,
        detail: `取值失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    entries.push({ path: "Cc", ok: false, detail: "沙箱里没有 Cc" });
  }

  // ② Components.classes（与 Cc 同源，但可能一个是代理）
  const Components = safeGet("Components") as { classes?: unknown } | undefined;
  if (Components?.classes) {
    try {
      const ctor = (Components.classes as { [k: string]: unknown })[
        nsIProcessCID
      ];
      tryCreateProcess(ctor, "Components.classes[nsIProcess]", entries);
    } catch (error) {
      entries.push({
        path: "Components.classes[nsIProcess]",
        ok: false,
        detail: `取值失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    entries.push({
      path: "Components.classes",
      ok: false,
      detail: "沙箱里没有 Components.classes",
    });
  }

  // ③ ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs")
  const ChromeUtils = safeGet("ChromeUtils") as
    | { importESModule?: (uri: string) => unknown }
    | undefined;
  if (typeof ChromeUtils?.importESModule === "function") {
    try {
      const mod = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      ) as { Subprocess?: unknown } | undefined;
      const subprocess = mod?.Subprocess as { call?: unknown } | undefined;
      entries.push({
        path: "ChromeUtils.importESModule(Subprocess.sys.mjs)",
        ok: typeof subprocess?.call === "function",
        detail:
          typeof subprocess?.call === "function"
            ? "可解析，Subprocess.call 可用"
            : `可解析但 Subprocess.call 为 ${typeof subprocess?.call}`,
      });
    } catch (error) {
      entries.push({
        path: "ChromeUtils.importESModule(Subprocess.sys.mjs)",
        ok: false,
        detail: `解析失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    entries.push({
      path: "ChromeUtils.importESModule",
      ok: false,
      detail: "沙箱里没有 ChromeUtils.importESModule",
    });
  }

  // ④ Cu.import（老式，fx140 已移除，但沙箱垫片可能仍提供）
  const Cu = safeGet("Cu") as { import?: unknown } | undefined;
  entries.push({
    path: "Cu.import(Subprocess.jsm)",
    ok: typeof Cu?.import === "function",
    detail:
      typeof Cu?.import === "function"
        ? "存在（但 fx140 已移除该 API，调用可能抛错）"
        : "沙箱里没有 Cu.import",
  });

  // ⑤ Services.appinfo 等旁证：确认沙箱确实拿到了 XPC 能力
  const Services = safeGet("Services") as
    | { appinfo?: { name?: unknown } }
    | undefined;
  entries.push({
    path: "Services.appinfo（XPC 旁证）",
    ok: typeof Services?.appinfo?.name === "string",
    detail:
      typeof Services?.appinfo?.name === "string"
        ? `name=${Services.appinfo.name}`
        : "拿不到 Services.appinfo",
  });

  return { entries, anyAvailable: entries.some((e) => e.ok) };
}

/** 格式化成诊断文件里可读的多行文本 */
export function describeSubprocessProbe(result: SubprocessProbeResult): string {
  const lines = [
    `启动子进程能力：${result.anyAvailable ? "有可用途径 ✅" : "全部不可用 ❌"}`,
  ];
  for (const entry of result.entries) {
    lines.push(`  ${entry.ok ? "✅" : "❌"} ${entry.path} —— ${entry.detail}`);
  }
  return lines.join("\n");
}
