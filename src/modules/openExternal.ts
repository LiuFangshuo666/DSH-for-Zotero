/**
 * ## 「打开外部程序」：工作区目录、dsh web 界面
 *
 * 两个动作本身很小，但都要**如实说明结果**，因为它们都会在"看起来成功"和
 * "其实什么都没发生"之间含糊。本项目反复栽在这上面，所以这里统一返回
 * `{ ok, 结果, 说明 }`，界面直接显示，不靠布尔值猜。
 */

import { resolveRuntimePaths } from "../dsh/isolatedPaths";
import type { RuntimeManager } from "../dsh/isolatedRuntime";
import { appendPanelLog } from "../dsh/runLog";

export interface OpenResult {
  ok: boolean;
  /** 一句话结论（界面直接显示） */
  结果: string;
  /** 打开的目标（目录绝对路径），失败时可能没有 */
  路径?: string;
  /** 打开的目标（web 地址，**token 已打码**） */
  地址?: string;
  /** 失败原因或补充说明 */
  说明?: string;
}

/** 把 URL 里的 token 打码，避免把凭据写进日志/界面 */
export function redactTokenInUrl(url: string): string {
  return String(url ?? "").replace(/token=[\w-]+/g, "token=***");
}

/**
 * 在系统文件管理器里打开一个目录。
 *
 * ## ⚠️ 用 `launchFile` 而不是 `reveal`（语义差别决定用户体验）
 *
 * - `Zotero.File.reveal(dir)` = 在文件管理器里**定位**它：打开**父目录**并选中该目录。
 *   用户看到的是上级目录里高亮了一行，还得再双击一次。
 * - `Zotero.launchFile(dir)` = 让系统**打开**它：Windows 上走 ShellExecute，
 *   资源管理器直接显示该目录**里面的内容** —— 这才是"一键打开工作区"。
 *
 * 所以主路径用 `launchFile`，`reveal` 只作为平台差异的退路
 * （某些平台上 launchFile 对目录不可靠）。
 */
export async function openWorkspaceInFileManager(
  workspaceDir: string,
): Promise<OpenResult> {
  const dir = String(workspaceDir ?? "").trim();
  if (!dir) {
    return { ok: false, 结果: "失败", 说明: "这条会话没有工作区目录" };
  }
  try {
    if (!(await IOUtils.exists(dir))) {
      return {
        ok: false,
        结果: "失败",
        路径: dir,
        说明: "工作区目录还不存在（这条会话可能还没写过材料），路径：" + dir,
      };
    }
  } catch {
    // 探测失败也继续尝试打开：可能只是权限/竞态问题，真失败会由打开动作报错
  }

  try {
    Zotero.launchFile(dir);
    appendPanelLog("session", `已用文件管理器打开工作区：${dir}`);
    return { ok: true, 结果: "已打开工作区", 路径: dir };
  } catch (error) {
    const first = error instanceof Error ? error.message : String(error);
    try {
      await Zotero.File.reveal(dir);
      appendPanelLog("session", `已在文件管理器中定位工作区：${dir}`);
      return {
        ok: true,
        结果: "已在文件管理器中定位",
        路径: dir,
        说明: `直接打开目录失败（${first}），已改为在文件管理器中定位它`,
      };
    } catch (fallbackError) {
      const second =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      appendPanelLog("session", `打开工作区失败：${first} / ${second}`);
      return {
        ok: false,
        结果: "失败",
        路径: dir,
        说明: `无法打开文件管理器：${second}`,
      };
    }
  }
}

/**
 * dsh web 界面的**已登录**地址。
 *
 * 两个来源，缺一不可：
 *  1. `RuntimeManager.status.launchUrl` —— 本进程刚启动宿主时当场记下的；
 *  2. `launch-url.txt` —— 宿主不是本进程启动的（例如已在运行、或插件重载过），
 *     这时状态里没有，但宿主把带 token 的 URL 写在了文件里。
 *
 * 不带 token 的地址打开会看到 `dsh web authentication required` ——
 * 那不算"能用 web 端打开"，所以拿不到 token 就**如实报错**，不给一个半残的链接。
 */
export async function dshWebUrl(): Promise<string | undefined> {
  try {
    const manager = (addon.data as { runtime?: RuntimeManager }).runtime;
    const direct = manager?.getStatus()?.launchUrl;
    if (typeof direct === "string" && /^https?:\/\//.test(direct))
      return direct;
  } catch {
    // 取状态失败就走文件
  }
  try {
    const paths = resolveRuntimePaths();
    if (!paths) return undefined;
    if (!(await IOUtils.exists(paths.launchUrlFile))) return undefined;
    const text = (await IOUtils.readUTF8(paths.launchUrlFile)).trim();
    const match = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(text);
    return match ? match[0] : undefined;
  } catch {
    return undefined;
  }
}

/** 用默认浏览器打开 dsh web 界面 */
export async function openDshWebUi(): Promise<OpenResult> {
  const url = await dshWebUrl();
  if (!url) {
    return {
      ok: false,
      结果: "失败",
      说明:
        "拿不到已登录的 web 地址。隔离运行时可能没在运行，或它还没打印带 token 的启动行 —— " +
        "请先到「设置 → DSH-for-Zotero → 隔离运行时」启动它，等状态变成 running 后再试。" +
        "（没有 token 的地址打开会显示 authentication required，所以这里不给半残的链接。）",
    };
  }
  try {
    Zotero.launchURL(url);
    appendPanelLog(
      "session",
      `已用浏览器打开 dsh web：${redactTokenInUrl(url)}`,
    );
    return {
      ok: true,
      结果: "已在浏览器中打开 dsh web",
      地址: redactTokenInUrl(url),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendPanelLog("session", `用浏览器打开 dsh web 失败：${message}`);
    return { ok: false, 结果: "失败", 说明: `无法启动浏览器：${message}` };
  }
}
