/**
 * 自检的入口与结果展示。
 *
 * ## 为什么从"工具菜单"搬到"设置页"（用户要求）
 *
 * 用户明确要求：**工具菜单里不再插入任何本项目的东西**，自检放进插件设置。
 * 于是这里只保留两件事：
 *
 *  1. `run()` —— 跑自检（核心逻辑仍在 `dsh/selfcheck.ts`）；
 *  2. `renderInto(win)` —— 把结果写进设置页的文本框。
 *
 * 菜单注册、菜单文案、DOM 兜底、菜单自愈那一整套（约 280 行）**全部删除** ——
 * 它们的复杂度来自 `MenuManager` 的行为不透明（不认 `label`、类名是随机 `_key`），
 * 而我们不再需要它。
 *
 * ## 为什么结果写进设置页而不是弹对话框
 *
 * 设置页本来就是一个窗口，自检结果直接显示在**同一个页面**里，
 * 用户不用在窗口之间来回看，也便于复制。结果同时落盘
 * （`dsh-for-zotero-selfcheck.txt`），因为沙箱里的错误在会话外读不到。
 */

import {
  formatResults,
  runSelfCheck,
  type CheckResult,
} from "../dsh/selfcheck";
import {
  describeCookieProbe,
  listCookieCapabilities,
  probeCookieJar,
} from "../dsh/cookieProbe";
import { probeCookieSignature } from "../dsh/cookieSignatureProbe";
import {
  describeSubprocessProbe,
  probeSubprocess,
} from "../dsh/subprocessProbe";
import { requireRuntimeConfig } from "../dsh/config";
import { describeWorkerProbe, probeChromeWorker } from "../dsh/workerProbe";
import { getString } from "../utils/locale";
import { appendPanelLog, SELF_CHECK_FILE } from "../dsh/runLog";

/** 设置页里显示自检结果的元素 id（见 addon/content/preferences.xhtml） */
const REPORT_ID = "dshforzotero-selfcheck-report";
/** 设置页里显示自检概要的元素 id */
const SUMMARY_ID = "dshforzotero-selfcheck-summary";

export class SelfCheck {
  private lastResults: CheckResult[] = [];

  getResults(): CheckResult[] {
    return this.lastResults;
  }

  /**
   * 跑自检并把结果写进设置页。
   *
   * @param win 设置页所在窗口；不传则只落盘、不更新界面。
   */
  async run(options: {
    testStream: boolean;
    win?: Window;
  }): Promise<CheckResult[]> {
    this.writeStatus(options.win, getString("selfcheck-running"));
    try {
      const results = await runSelfCheck({
        testStream: options.testStream,
        trigger: "manual",
        onResult: (result) => {
          // 边跑边更新概要，用户能看到进度而不是干等
          this.writeStatus(options.win, `${result.name}…`);
        },
      });
      this.lastResults = results;
      this.writeStatus(options.win, summarize(results));
      this.writeReport(options.win, formatResults(results));
      // 落盘：手动自检（尤其"含流式实测"那次）的结论必须能离线读取
      void this.persistManualResult(options.testStream, results);
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastResults = [
        { name: "自检异常", status: "fail", detail: message },
      ];
      this.writeStatus(options.win, `自检异常：${message}`);
      this.writeReport(options.win, formatResults(this.lastResults));
      appendPanelLog("runtime", `自检异常：${message}`);
      return this.lastResults;
    }
  }

  /** 把概要写进设置页（没有窗口时忽略） */
  private writeStatus(win: Window | undefined, text: string): void {
    try {
      const el = win?.document?.getElementById(SUMMARY_ID);
      if (el) el.textContent = text;
    } catch {
      // 设置页可能已关闭
    }
  }

  /** 把完整结果写进设置页的只读文本框 */
  private writeReport(win: Window | undefined, text: string): void {
    try {
      const el = win?.document?.getElementById(REPORT_ID) as
        | (HTMLElement & { value?: string })
        | null;
      if (!el) return;
      // textarea 用 value，description 用 textContent
      if ("value" in el && el.tagName === "TEXTAREA") el.value = text;
      else el.textContent = text;
    } catch {
      // 设置页可能已关闭
    }
  }

  /**
   * 把手动自检的结果**追加**到数据目录的自检记录文件。
   *
   * ## ⚠️ 这里原先写的是另一个文件（真机发现的不自洽）
   *
   * 早先这里写 `dsh-for-zotero-selfcheck.txt`，而 `runLog.ts` 的自检记录写
   * `dsh-for-zotero-selfcheck.txt` —— **两个文件、两个名字，只差一个 `last-`**。
   * 更糟的是**所有面向用户的文案**（设置页说明、新手引导、交接文档）指的都是
   * `last-` 那个，于是另一个文件对用户完全隐形：自检跑了、记录写了，用户不知道去哪看。
   *
   * 现在统一到 `dsh-for-zotero-selfcheck.txt`（由 `runLog.ts` 定义），
   * 并且**改成追加**而不是覆盖 —— 覆盖会丢掉"上一次是什么结论"，
   * 而"这次和上次不一样"恰恰是排查时最有用的信息。
   */
  private async persistManualResult(
    testStream: boolean,
    results: CheckResult[],
  ): Promise<void> {
    try {
      const dir = Zotero.DataDirectory?.dir;
      if (!dir) return;
      const path = PathUtils.join(dir, SELF_CHECK_FILE);
      const header = [
        "",
        `${"=".repeat(60)}`,
        `完整自检报告  时间：${new Date().toISOString()}`,
        `触发：设置页；含流式实测：${testStream ? "是" : "否"}`,
        `Zotero ${Zotero.version}；插件 ${addon.data.config.addonID}`,
        `${"=".repeat(60)}`,
        "",
      ];
      await IOUtils.writeUTF8(
        path,
        header.concat(formatResults(results)).join("\n") + "\n",
        // 追加而不是覆盖：保留历史，才能看出"这次和上次哪里不同"
        { mode: "appendOrCreate" },
      );
    } catch {
      // 落盘失败不影响自检
    }
  }

  /**
   * 深度探测（浏览器会话 / 子进程 / ChromeWorker）。
   *
   * 这几项原先挂在"自检（含流式实测）"菜单项上，现在由设置页的「深度探测」按钮触发。
   */
  async deepProbe(win?: Window): Promise<void> {
    this.writeStatus(win, "正在深度探测…");
    const lines: string[] = [`深度探测 ${new Date().toLocaleString()}`, ""];
    const section = (label: string, body: string) => {
      lines.push(`【${label}】`, body, "");
    };

    let config: ReturnType<typeof requireRuntimeConfig> | undefined;
    try {
      config = requireRuntimeConfig();
      lines.push(
        `运行时：${config.baseUrl}（DSH_HOME 来源 ${config.dshHomeSource}）`,
        "",
      );
    } catch (error) {
      lines.push(
        `读取运行时配置失败：${error instanceof Error ? error.message : String(error)}`,
        "",
      );
    }

    // 每一项独立 try/catch：某项探测失败不该让整份报告消失
    try {
      section("浏览器会话能力", listCookieCapabilities().join("\n"));
    } catch (error) {
      section(
        "浏览器会话能力",
        `探测失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if (config)
        section(
          "登录 cookie 探测",
          describeCookieProbe(probeCookieJar(config)),
        );
      else section("登录 cookie 探测", "跳过：运行时配置不可用");
    } catch (error) {
      section(
        "登录 cookie 探测",
        `探测失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // ⚠️ 这一节是**签名内省**：前一个探针穷举了 12 种取值全报 ILLEGAL_VALUE，
    // 说明问题在**类型/个数**而不是取值 —— 继续穷举取值是浪费轮次。
    //
    // ⚠️ 它**不依赖运行时配置**。真机上出现过这种情况：运行时尚未就绪 →
    // `requireRuntimeConfig()` 抛错 → 于是这一节整体被跳过（因为配置是它的前提）。
    // 但它测的是 **cookie 罐接口本身**，与 dsh 是否在跑毫无关系 ——
    // 把它挂在配置后面是错的，会让"运行时刚好没起来"看起来像"探针不可用"。
    // 所以它单独一项、无条件执行。
    try {
      const lines2 = probeCookieSignature().map(
        (line) => `  ${line.label} = ${line.value}`,
      );
      section("cookie 罐写入签名（内省，与运行时无关）", lines2.join("\n"));
    } catch (error) {
      section(
        "cookie 罐写入签名（内省）",
        `探测失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      section("子进程能力", describeSubprocessProbe(probeSubprocess()));
    } catch (error) {
      section(
        "子进程能力",
        `探测失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      // ⚠️ 这个是**异步**的（要等 Worker 回消息）
      const result = await probeChromeWorker(addon.data.config.addonRef);
      section("ChromeWorker", describeWorkerProbe(result));
    } catch (error) {
      section(
        "ChromeWorker",
        `探测失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.writeReport(win, lines.join("\n"));
    this.writeStatus(win, "深度探测完成");
  }
}

function summarize(results: CheckResult[]): string {
  const ok = results.filter((r) => r.status === "ok").length;
  const warn = results.filter((r) => r.status === "warn").length;
  const fail = results.filter((r) => r.status === "fail").length;
  try {
    return getString("selfcheck-summary", {
      args: { ok: String(ok), warn: String(warn), fail: String(fail) },
    });
  } catch {
    return `${ok} passed, ${warn} warnings, ${fail} failed`;
  }
}
