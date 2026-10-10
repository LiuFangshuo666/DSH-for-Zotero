/**
 * 运行期配置解析：DSH_HOME、端口、认证方式。
 *
 * 设计约束（来自 Zotero 插件沙箱白名单，见 docs/DSH集成与桥接协议.md §7）：
 *  - 可用：IOUtils / PathUtils / Services / ChromeUtils / Zotero / fetch / XHR / crypto / btoa / atob
 *  - 不可用：WebSocket / AbortController / Headers / Request / Response / ReadableStream / Components(Cc,Ci)
 */

import { getPref } from "../utils/prefs";
import { resolveRuntimePaths } from "./isolatedPaths";
import type { RuntimeManager } from "./isolatedRuntime";

export interface DshRuntimeConfig {
  /** DSH_HOME 绝对路径（已去掉尾部反斜杠） */
  dshHome: string;
  /**
   * DSH_HOME 的来源。
   *
   * ⚠️ 这里原是 `"pref" | "env" | "default" | "isolated"` 四值联合——
   * 前三个来自**已删除的共享模式**（那时会依次从设置、
   * 环境变量、平台默认推断 HOME）。现在只能是隔离实例，
   * 所以类型里保留四个取值只会让人以为"还能配外部 dsh"。
   */
  dshHomeSource: "isolated";
  port: number;
  authority: string;
  baseUrl: string;
  wsUrl: string;
  /** 论文工作区根目录：<DSH_HOME>/dsh-for-zotero */
  workspaceRoot: string;
  // ⚠️ 这里原有 `authMode: "auto" | "token"` —— 那是**共享模式**的选项
  // （auto = 读凭据自签；token = 用启动 URL 换）。隔离模式下认证只有一条路
  // （读 `.credentials.yaml` 自签），没有可选项，且**没有任何代码读这个字段**。
  // 留着它会让后来者以为"还能选认证方式"。
  requestTimeoutMs: number;
}

/**
 * 探测用户主目录。
 *
 * ⚠️ 踩坑记录（集成测试抓到的真机崩溃点）：**插件沙箱里没有 `Ci`**
 * （`xpcom/plugins.js:141-156` 的注入清单只有 `Services`、`IOUtils`、`PathUtils` 等，
 * 没有 `Components`/`Cc`/`Ci`）。早先这里写的是 `Services.dirsvc.get("Home", Ci.nsIFile)`，
 * 在真机上会在 `Ci` 处抛 ReferenceError —— 而只有当 DSH_HOME 既没设偏好也没设环境变量时
 * 才会走到这里，所以很容易漏掉。
 *
 * 因此按"最不依赖接口常量"的顺序探测：环境变量 → dirsvc（接口名用字符串）→ 最后退回 `~`
 * （dsh 自己会把 `~/.dsh` 展开，见 packages/util/home-paths）。
 */
export function resolveUserHome(): string | undefined {
  const readEnv = (name: string): string | undefined => {
    try {
      const env = Services.env as unknown as { get?: (key: string) => string };
      const value = typeof env?.get === "function" ? env.get(name) : undefined;
      return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;
    } catch {
      return undefined;
    }
  };

  // 1) 环境变量（Windows 用 USERPROFILE，类 Unix 用 HOME）
  const fromEnv = readEnv("USERPROFILE") ?? readEnv("HOME");
  if (fromEnv) return fromEnv;

  // 2) dirsvc，但接口名传字符串 —— 避免依赖沙箱里不存在的 Ci
  try {
    const dirsvc = (
      Services as unknown as {
        dirsvc?: { get?: (key: string, iface?: string) => { path?: string } };
      }
    ).dirsvc;
    if (typeof dirsvc?.get === "function") {
      for (const iface of ["nsIFile", ""]) {
        try {
          const file = dirsvc.get("Home", iface);
          if (file?.path) return file.path;
        } catch {
          // 换下一种调用方式
        }
      }
      try {
        const file = dirsvc.get("Home");
        if (file?.path) return file.path;
      } catch {
        // 忽略
      }
    }
  } catch {
    // 忽略，走最后的兜底
  }

  // 3) 兜底：交给 dsh 自己展开（它会 resolve `~`）
  return undefined;
}

/** 平台默认的 DSH_HOME：<home>/.dsh；拿不到主目录时返回 "~/.dsh" */
export function defaultDshHome(): string {
  const home = resolveUserHome();
  return home ? PathUtils.join(home, ".dsh") : PathUtils.join("~", ".dsh");
}

// ⚠️ 这里原有：
//  - `resolveDshHome`（设置项 > 环境变量 > 平台默认的优先级解析）
//  - `resolvePort`（端口字符串校验）
//  - `envDshHome`（读环境变量 DSH_HOME）
//  - `stripTrailingSlash`
//  - 常量 `DEFAULT_PORT = 19387`
//
// 它们**只服务于共享模式**（连接本机桌面版 Harness 的 DSH_HOME 与端口）。
// 共享模式已按用户要求删除，隔离实例的 HOME 与端口由运行时管理器给出
// （见 isolatedPaths.ts / isolatedRuntime.ts），这些在生产代码里已无调用点。
// 留着会让下一个人以为"还能配一个外部 dsh"，故一并移除。

/**
 * 解析 DSH 运行期配置。
 *
 * ## 只有隔离模式（用户要求：删除共享模式）
 *
 * 连接插件自己拉起的 dsh 实例：`DSH_HOME` = `<数据目录>/dsh-for-zotero/home`，
 * 端口由运行时管理器给出，凭据与桌面版**完全不同**。
 * 插件的会话、工作区、模型调用因此与用户的桌面版 Harness 互不干扰。
 *
 * 端口与 DSH_HOME **不由设置项决定**，而由运行时管理器给出 ——
 * 否则用户改了设置却与宿主实际监听的端口不一致，会得到难以理解的连接失败。
 *
 * ## ⚠️ 宿主未就绪时**不再回退到桌面版**
 *
 * 早先这里在"隔离已开启但宿主还没起来"时会回退到桌面版 dsh（端口 19387、
 * 读 `~/.dsh`）。那个回退有两个问题：
 *  1. 用户以为在用隔离实例，实际连到了桌面版 —— **凭据与会话都串了**；
 *  2. 它让一堆桌面版设置项看起来"有用"，实际只在那个窗口期生效。
 *
 * 现在明确返回 `undefined`：调用方据此报"运行时未就绪"，
 * 而不是偷偷连到另一个实例上。
 */
export function resolveRuntimeConfig(): DshRuntimeConfig | undefined {
  const isolated = resolveIsolatedEndpoint();
  if (!isolated) return undefined;

  const { dshHome, port } = isolated;
  const authority = `127.0.0.1:${port}`;
  return {
    dshHome,
    dshHomeSource: "isolated",
    port,
    authority,
    baseUrl: `http://${authority}`,
    wsUrl: `ws://${authority}/api/remote.mux`,
    workspaceRoot: PathUtils.join(dshHome, "dsh-for-zotero"),
    requestTimeoutMs: Number(getPref("requestTimeoutMs" as never) ?? 15000),
  };
}

/**
 * 隔离模式下返回 `{ dshHome, port }`；**未就绪时返回 undefined**。
 *
 * ⚠️ 这里**不再有"关闭隔离"的分支** —— 用户要求只允许隔离使用。
 *
 * 未就绪也算 undefined：此时插件还没能拉起宿主，
 * 强行返回一个没人监听的端口只会得到 ECONNREFUSED。
 * 调用方（`resolveRuntimeConfig`）据此报"运行时未就绪"，
 * 而**不再偷偷回退到桌面版**（那会让凭据与会话串到另一个实例上）。
 */
function resolveIsolatedEndpoint():
  | { dshHome: string; port: number }
  | undefined {
  try {
    const paths = resolveRuntimePaths();
    if (!paths) return undefined;
    // 管理器挂在 addon.data.runtime 上（见 src/hooks.ts 的 runtimeManager()）
    const manager = (addon.data as { runtime?: RuntimeManager }).runtime;
    if (!manager) return undefined;
    const status = manager.getStatus();
    if (status.phase !== "running" || !status.port) return undefined;
    return { dshHome: paths.home, port: status.port };
  } catch {
    return undefined;
  }
}

/** 凭据文件绝对路径 */
export function credentialsPath(dshHome: string): string {
  return PathUtils.join(dshHome, ".credentials.yaml");
}

/**
 * 取运行期配置；**未就绪时抛错**。
 *
 * 给"没有配置就无法继续"的调用点用：宁可让操作明确失败，
 * 也不要静默连到别的实例或落到非隔离目录（用户要求只允许隔离使用）。
 */
export function requireRuntimeConfig(): DshRuntimeConfig {
  const config = resolveRuntimeConfig();
  if (!config) {
    throw new Error(
      "隔离运行时尚未就绪，无法继续。请在「设置 → DSH-for-Zotero」查看运行时状态，或等待启动进度完成。",
    );
  }
  return config;
}
