/**
 * 新手引导：首次启动时弹一次说明，之后不再自动弹出。
 *
 * ## 为什么需要（用户要求）
 *
 * 这个插件的第一次使用体验是**反直觉**的：装完重启后它什么界面都不出现，
 * 而是先在后台静默提取一份约 330 MB 的运行时（10–30 秒）。用户此时看到的
 * 只有 Zotero 正常启动的样子 —— 很容易得出"插件没生效"的结论，
 * 然后去翻扩展列表、反复重启。真机上发生过多次类似的排查。
 *
 * 所以首次启动必须主动说明三件事（见 `addon/content/onboarding.xhtml`）：
 * 现在在准备什么、之后从哪里开始、以及**它能改文献库、但危险操作需要确认**。
 *
 * ## 为什么不用 `alert()`
 *
 * 三段内容用三个 `alert()` 会打断、无法回看、也没法再做入口。
 * 用一个独立 xhtml 页面则：可滚动、可重开（设置页有按钮）、样式可控。
 * 页面本身**纯静态**（只有一个"知道了"按钮），不需要与插件通信 ——
 * 没有要注入的能力，就不引入任何会坏的握手机制。
 *
 * ## 状态放在哪
 *
 * `onboardingPending` 偏好（默认 `true`）。看完或关掉后置 `false`。
 * 不复用 `state.json`：那个文件描述**运行时**状态，与"用户看没看过引导"无关，
 * 混在一起会让"重置运行时"意外地重放引导。
 */

import { getPref, setPref } from "../utils/prefs";
import { appendPanelLog } from "../dsh/runLog";

/** 「还没看过引导」的偏好名（见 addon/prefs.js） */
const ONBOARDING_PENDING = "onboardingPending";

/**
 * 首次启动时是否该弹引导。
 *
 * 只看偏好值。**不带任何"是否已就绪"之类的附加条件** ——
 * 用户要的是"第一次启动时告诉我发生了什么"，而"正在准备运行时"恰恰是
 * 最需要说明的时刻。
 */
export function shouldShowOnboarding(): boolean {
  try {
    return getPref(ONBOARDING_PENDING as never) !== false;
  } catch {
    // 读不到偏好时不弹：宁可少弹一次，也不要在异常状态下反复弹
    return false;
  }
}

/** 标记"已看过"，之后不再自动弹出 */
export function markOnboardingSeen(): void {
  try {
    setPref(ONBOARDING_PENDING as never, false as never);
  } catch {
    // 写不进去最多下次再弹一次，不影响功能
  }
}

/**
 * 打开引导页。返回是否成功打开。
 *
 * 关闭方式：用户点「知道了」→ 页面 `window.close()`；或直接关窗口。
 * 两种都用 `onunload` 之外的时机标记 —— 所以这里**在打开成功时就标记**，
 * 而不是等它关闭：用户已经看到内容了，即使直接关掉也不该再弹。
 */
export function showOnboarding(): boolean {
  try {
    const win = Zotero.getMainWindow() as unknown as {
      openDialog?: (
        url: string,
        name: string,
        features: string,
      ) => Record<string, unknown> | undefined;
    };
    if (typeof win?.openDialog !== "function") {
      appendPanelLog("onboarding", "当前窗口没有 openDialog，无法显示新手引导");
      return false;
    }
    const ref = addon.data.config.addonRef;
    const url = `chrome://${ref}/content/onboarding.xhtml`;
    const dialog = win.openDialog(
      url,
      "dshforzotero-onboarding",
      "chrome,centerscreen,resizable,width=720,height=640",
    );
    if (!dialog) {
      appendPanelLog("onboarding", "openDialog 没有返回窗口对象，引导未显示");
      return false;
    }
    markOnboardingSeen();
    appendPanelLog("onboarding", "已显示新手引导");
    return true;
  } catch (error) {
    appendPanelLog(
      "onboarding",
      `显示新手引导失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * 设置页按钮：重新显示引导**并重置标记**。
 *
 * 与 `showOnboarding` 分开是因为语义不同：这里用户是主动要求看的，
 * 即使打开失败也不该把标记清掉（否则下次启动会莫名其妙地弹）。
 */
export function reopenOnboarding(): boolean {
  const opened = showOnboarding();
  if (opened) {
    try {
      setPref(ONBOARDING_PENDING as never, false as never);
    } catch {
      // 同上
    }
  }
  return opened;
}
