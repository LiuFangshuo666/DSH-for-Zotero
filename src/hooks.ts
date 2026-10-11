/**
 * 插件生命周期与事件分发。
 *
 * 约定：hooks 只做分发与注册，不写业务逻辑（业务在 src/dsh/ 与 src/modules/ 里）。
 * M0 阶段只注册"DSH 自检"入口；阅读器面板在 M1 加入。
 */

import { SelfCheck } from "./modules/selfCheck";
import { ReaderPanel } from "./modules/readerPanel";
import { SelectionToolbar } from "./modules/selectionToolbar";
import { SessionPane } from "./modules/sessionPane";
import { handleModelPrefsEvent, initModelSection } from "./modules/modelPanel";
import { RuntimeManager, describeRuntime } from "./dsh/isolatedRuntime";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { appendPanelLog } from "./dsh/runLog";
import {
  reopenOnboarding,
  shouldShowOnboarding,
  showOnboarding,
} from "./modules/onboarding";

const selfCheck = new SelfCheck();
const readerPanel = new ReaderPanel();

/**
 * 启动标记：**版本号**（构建时由 `zotero-plugin.config.ts` 的 define 注入）。
 *
 * ## 为什么改成版本号（真机教训）
 *
 * 这里原先是写死的 `"feature: session-note-button"`，注释还要求"每次需要重启的改动
 * 都手动改这一行"。实际上它**从来没被改过** —— 于是永远输出同一个字符串，一旦加载
 * 成功就不再提供任何信息；而真正想回答的问题"用户机器上跑的是哪一版"反而答不上来。
 *
 * 现在注入真实版本号：日志里 `插件启动于 <时间>（v<版本>）` 与 xpi 的修改时间一对照，
 * 就能判断加载的是不是刚部署的那一版。本项目为此浪费过好几轮排查
 * （"已部署"不等于"已加载"）。
 */
const FEATURE_STAMP = `v${__buildVersion__}`;

/**
 * 会话面板（独立会话 / 条目会话的列表与新建入口）。
 * 同样惰性创建：构造期需要 `addon.data.config.addonID`。
 */
let sessionPaneInstance: SessionPane | undefined;
function sessionPane(): SessionPane {
  sessionPaneInstance ??= new SessionPane(addon.data.config.addonID);
  return sessionPaneInstance;
}

/**
 * 隔离运行时管理器（单例）。
 *
 * ⚠️ 与 `selectionToolbar` 同样的理由**必须惰性创建**：模块顶层不能碰 `addon`。
 * 这里的构造本身不读 `addon`，但保持一致的惰性风格可以避免以后有人往里加。
 */
let runtimeManagerInstance: RuntimeManager | undefined;
export function runtimeManager(): RuntimeManager {
  if (!runtimeManagerInstance) {
    runtimeManagerInstance = new RuntimeManager();
    // 同时挂到 addon 上：配置解析需要在任意调用点找到它
    addon.data.runtime = runtimeManagerInstance;
  }
  return runtimeManagerInstance;
}

/**
 * ⚠️ 划词工具条必须**惰性创建**（真机实测踩坑，2026-10-02）。
 *
 * 原因：它在模块加载期需要 `addon.data.config.addonID`，而打包产物里
 * `_globalThis.addon = new Addon()` 的赋值发生在**本模块求值之后**
 * （esbuild 把 `hooks` 排在 `index.ts` 之前）。于是模块加载期引用 `addon`
 * 会抛 `ReferenceError: addon is not defined`，直接导致
 * `Zotero.<addonInstance> = addon` 永不执行 —— 插件在 extensions.json 里
 * 仍显示 `active: true`，界面上却静默失效（Zotero 的 _callMethod 吞异常）。
 *
 * 因此这里只保留一个取值函数，`SelectionToolbar` 在首次注册时才构造；
 * 此时 `addon` 早已就绪。改动本文件时请勿在顶层引用 `addon` / `ztoolkit`。
 */
let selectionToolbarInstance: SelectionToolbar | undefined;
function selectionToolbar(): SelectionToolbar {
  if (!selectionToolbarInstance) {
    selectionToolbarInstance = new SelectionToolbar(addon.data.config.addonID);
  }
  return selectionToolbarInstance;
}

/**
 * 把设置页注册进 Zotero 的「编辑 → 设置」窗口。
 *
 * 官方 API（`xpcom/preferencePanes.js:134`）：
 *   `Zotero.PreferencePanes.register({ pluginID, src, id, label, image, scripts, stylesheets, helpURL })`
 * 关键约束（都来自该文件与实测）：
 *  - `pluginID` 与 `src` **必填**，缺一个就抛 `pluginID and src must be provided`；
 *  - `src` 是 **XHTML 片段**（默认命名空间为 XUL，HTML 标签要写 `html:`），
 *    与我们的 preferences.xhtml 写法一致；
 *  - 相对 URI 会经 `Zotero.Plugins.resolveURI(pluginID, uri)` 解析，但这里直接给绝对
 *    `rootURI` 更直观，也避免依赖解析规则；
 *  - 注册是 **async**，必须 await，否则失败会静默（本项目在菜单上踩过同类坑）；
 *  - 插件关闭时 Zotero 会**自动注销**该面板，无需手工清理。
 *
 * 真机反馈的教训：此前只写了 preferences.xhtml 与文案，**从未调用注册** ——
 * 于是文件永远不显示，"设置里看不到 DSH-for-Zotero"。
 */
async function registerPreferencePane(): Promise<void> {
  const panes = (
    Zotero as unknown as {
      PreferencePanes?: {
        register?: (options: Record<string, unknown>) => Promise<string>;
      };
    }
  ).PreferencePanes;
  if (typeof panes?.register !== "function") {
    ztoolkit.log(
      "[DSH] 本版 Zotero 没有 Zotero.PreferencePanes.register，设置页不可用",
    );
    return;
  }
  // 用 chrome:// 形式：与 dshSocketWorker.js 的取法一致（src/dsh/stream.ts 的 workerCandidates），
  // 已验证该命名空间可用；`rootURI` 是 bootstrap 提供的全局，不在 addon.data.config 上。
  const src = `chrome://${addon.data.config.addonRef}/content/preferences.xhtml`;
  try {
    const paneID = await panes.register({
      pluginID: addon.data.config.addonID,
      src,
      id: `${addon.data.config.addonRef}-preferences`,
      label: addon.data.config.addonName,
    });
    ztoolkit.log(`[DSH] 设置页已注册：${paneID}`);
  } catch (error) {
    ztoolkit.log(
      `[DSH] 设置页注册失败（src=${src}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 启动时逐步注册，**每步独立 try/catch**。
 *
 * 为什么不能一把梭：如果某一步抛错（例如某个 Zotero API 在某版本上不存在），
 * 后面的注册就全都不会执行 —— 表现是"面板、划词、菜单一起消失"。
 * 分步隔离后，坏掉的功能只在日志里报错，其余功能照常可用。
 */
function safeRegister(label: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    // 同时落盘：先前只写 ztoolkit.log（= Zotero 调试输出），
    // 于是"注册静默失败"在会话外完全看不到 —— 真机排查"右键菜单没有字样"时，
    // 日志里一条菜单记录都没有，无从判断是"没注册"还是"报错了"。
    const detail =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error);
    ztoolkit.log(`[DSH] ${label} 注册失败：${detail}`);
    try {
      appendPanelLog("session", `${label} 注册失败：${detail}`);
    } catch {
      // 日志本身失败就算了
    }
  }
}

async function onStartup() {
  // ⚠️ 启动第一件事：把**启动时刻 + 特性标记**落盘。
  //
  // 为什么必须做：这个项目反复卡在"改了代码、用户说没生效"上，而**插件的 JS bundle
  // 只在 Zotero 启动时载入一次**，页面的脚本却每次打开都从磁盘重载 ——
  // 于是会出现"页面是新的、能力是旧的"这种半新半旧状态，肉眼无法分辨。
  //
  // 用法：把这一行的时间与 **xpi 文件的修改时间**对比 ——
  // 启动时刻早于 xpi 时间，就说明跑的是旧代码，需要重启。
  //
  // （构建器没有把 `buildTime` 注入 bundle：`addon.data.config` 只含 package.json 里
  //   `config` 段的原始字段，实测产物里查不到 buildTime，所以这里用运行时时间。）
  try {
    appendPanelLog(
      "runtime",
      `插件启动于 ${new Date().toISOString()}（${FEATURE_STAMP}）`,
    );
  } catch {
    // 日志失败不影响启动
  }

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  safeRegister("本地化初始化", () => initLocale());
  safeRegister("注册 FTL 资源", () => registerLocaleResources());

  // 设置页（「编辑 → 设置」里的 DSH-for-Zotero）
  // 单独 try/catch + await：注册失败必须留下日志，否则表现是"设置里没有这一项"，
  // 而用户与开发者都无从判断是没注册还是注册失败。
  try {
    await registerPreferencePane();
  } catch (error) {
    ztoolkit.log(
      `[DSH] 设置页注册异常：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 隔离运行时：**后台准备**，绝不阻塞启动。
  // 首次要提取约 330 MB（10 秒量级），若同步等待会让 Zotero 启动明显变慢；
  // 而且用户可能根本不用伴读功能，没必要付出这个代价。
  //
  // ## 为什么要弹进度窗口（真机反馈"每次重启都要等 dsh 启动，却看不到进度"）
  //
  // 后台准备意味着**用户看不到任何反馈**：打开 Zotero 后如果马上去用会话，
  // 会遇到"运行时未就绪"，却不知道还要等多久。所以用一个**进度窗口**把
  // 当前阶段与结果如实显示出来 —— 它是非阻塞的，不挡操作，完成后自动关闭。
  safeRegister("隔离运行时（后台准备）", () => {
    const manager = runtimeManager();
    void (async () => {
      let progress:
        | {
            changeLine: (o: Record<string, unknown>) => void;
            startCloseTimer?: (ms: number) => void;
            close?: () => void;
          }
        | undefined;
      try {
        // 进度窗口只在**需要准备**时才出现：已就绪的后续启动不该再弹窗打扰
        const before = manager.getStatus();
        if (before.phase !== "running") {
          progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
            closeOnClick: true,
            closeTime: -1,
          })
            .createLine({
              text: "正在准备 DSH 运行时…",
              type: "default",
              progress: 0,
            })
            .show() as unknown as typeof progress;
        }
        const prepared = await manager.prepare((text) => {
          appendPanelLog("runtime", text);
          try {
            progress?.changeLine({ text, progress: 50 });
          } catch {
            // 进度窗口可能已被用户关掉
          }
        });
        appendPanelLog(
          "runtime",
          `准备结果：${prepared.phase} —— ${prepared.message}`,
        );
        if (prepared.phase === "ready") {
          try {
            progress?.changeLine({ text: "正在启动 DSH…", progress: 80 });
          } catch {
            // 同上
          }
          const started = await manager.start();
          appendPanelLog(
            "runtime",
            `启动结果：${started.phase} —— ${started.message}`,
          );
          try {
            progress?.changeLine({
              text:
                started.phase === "running"
                  ? `DSH 已就绪（端口 ${started.port ?? "?"}）`
                  : `DSH 启动未完成：${started.message}`,
              type: started.phase === "running" ? "success" : "fail",
              progress: 100,
            });
            progress?.startCloseTimer?.(3000);
          } catch {
            // 同上
          }
        } else {
          try {
            progress?.changeLine({
              text: `DSH 准备未完成：${prepared.message}`,
              type: "fail",
              progress: 100,
            });
            progress?.startCloseTimer?.(5000);
          } catch {
            // 同上
          }
        }
      } catch (error) {
        appendPanelLog(
          "runtime",
          `后台准备异常：${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          progress?.changeLine({
            text: `DSH 准备异常：${error instanceof Error ? error.message : String(error)}`,
            type: "fail",
            progress: 100,
          });
          progress?.startCloseTimer?.(6000);
        } catch {
          // 同上
        }
      }
    })();
  });

  // 阅读器侧栏面板（M1）与划词工具条（M2）
  safeRegister("阅读器面板", () => readerPanel.register());
  safeRegister("划词工具条", () => selectionToolbar().register());
  // 会话右键菜单（条目 / 分类）：新建条目会话与独立会话
  safeRegister("会话菜单", () => sessionPane().register());

  for (const win of Zotero.getMainWindows() ?? []) {
    try {
      await onMainWindowLoad(win);
    } catch (error) {
      ztoolkit.log(
        `[DSH] 主窗口初始化失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
  try {
    ztoolkit.log(`[DSH] ${getString("startup-finish")}`);
  } catch {
    ztoolkit.log("[DSH] 启动完成");
  }
}

/**
 * 让 Zotero 的 Fluent 知道我们的文案文件。
 *
 * 为什么必须做：`Zotero.MenuManager` 是通过给菜单元素设 `data-l10n-id` 来显示文字的
 * （menuManager.js:453），**消息 ID 在已注册的 FTL 里解析不到时条目会不渲染** ——
 * 实测表现为"工具菜单里看不到 DSH 自检"。这里把 addon.ftl 注册进 Zotero 的同步
 * Fluent 实例（intl.js:83 起，注释里明确写了插件用 `Zotero.ftl.addResourceIds`）。
 */
function registerLocaleResources(): void {
  const ftlId = `${addon.data.config.addonRef}-addon.ftl`;
  try {
    // `Zotero.ftl` 不在 zotero-types 里（它是 intl.js:93 挂上去的运行时属性）
    const ftl = (
      Zotero as unknown as {
        ftl?: { addResourceIds?: (ids: string[]) => void };
      }
    ).ftl;
    ftl?.addResourceIds?.([ftlId]);
  } catch (error) {
    ztoolkit.log("[DSH] Zotero.ftl.addResourceIds 失败", error);
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  // 主窗口也要知道插件的 FTL（菜单与面板文案都从 addon.ftl 取）
  try {
    win.MozXULElement?.insertFTLIfNeeded?.(
      `${addon.data.config.addonRef}-addon.ftl`,
    );
  } catch (error) {
    ztoolkit.log("[DSH] insertFTLIfNeeded 失败", error);
  }

  // 自检已改为**设置页入口**（用户要求工具菜单里不再插入本项目的项），
  // 所以这里不再注册任何菜单。

  // 会话维护：补齐历史会话的空工作区、刷新已挂载附件的 URL。
  // 侧栏面板取消后这里没有别的时机做这件事，而它修的是**历史遗留状态**，
  // 与有没有面板无关 —— 不跑的话用户升级后旧会话仍然是坏的。
  safeRegister("会话维护", () => {
    void sessionPane().maintain();
  });

  // 右键菜单：菜单是**逐窗口**的，所以每个新窗口都要插一遍。
  // 用自插 DOM 而不是 MenuManager —— 原因见 sessionPane.register() 的失败链条说明。
  safeRegister("右键菜单", () => sessionPane().installContextMenus());

  // 新手引导：**只在首次启动弹一次**（标记见 onboarding.ts）。
  //
  // 放在 `onMainWindowLoad` 而不是 `onStartup`：`openDialog` 需要主窗口存在，
  // 而 `onStartup` 时主窗口可能还没建好（真机上 openDialog 会拿不到）。
  //
  // 为什么首次启动必须主动说明：装完重启后插件**什么界面都不出现**，
  // 而是先在后台提取约 330 MB 运行时 —— 用户很容易判定"插件没生效"。
  safeRegister("新手引导", () => {
    if (shouldShowOnboarding()) showOnboarding();
  });
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  // 先停掉隔离宿主：它是我们拉起的子进程，留着会占端口并让下次启动以为"已在运行"。
  // 这里用 fire-and-forget —— onShutdown 是同步的，等待会拖慢 Zotero 退出，
  // 而 kill 请求已经发出，进程不会长期残留。
  safeRegister("停止隔离运行时", () => {
    void runtimeManager().stop();
  });

  readerPanel.unregister();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Notify 事件分发（M1 起用于跟踪阅读器标签切换）。
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * 设置面板事件。
 *
 * 隔离运行时的三个按钮直接在这里处理：准备/启动都是耗时操作，
 * 因此**立即返回并在后台推进**，进度写进诊断日志（设置页不便持续刷新）。
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  const win = data?.window as Window | undefined;
  const setStatusText = (text: string) => {
    try {
      const el = win?.document?.getElementById(
        `${addon.data.config.addonRef}-runtime-status`,
      );
      if (el) el.textContent = text;
    } catch {
      // 设置页可能已关闭
    }
  };

  switch (type) {
    case "load": {
      // 载入时把当前状态显示出来，用户才知道现在是什么情况
      const manager = runtimeManager();
      setStatusText(describeRuntime(manager.getStatus()));
      manager.onStatus((status) => setStatusText(describeRuntime(status)));
      // 模型一节：回填已保存的 API Key，并尝试填充模型/等级下拉框。
      // 取不到目录时会**如实说明原因**（而不是给一份猜的清单）——
      // 见 modelPanel.ts 顶部关于"为什么候选值必须动态取"的说明。
      initModelSection(win);
      break;
    }

    case "runtime-prepare": {
      const manager = runtimeManager();
      setStatusText("正在准备（首次约 10–30 秒）…");
      void manager
        .prepare((text) => {
          setStatusText(text);
          appendPanelLog("runtime", text);
        })
        .then((status) => {
          setStatusText(describeRuntime(status));
          appendPanelLog(
            "runtime",
            `手动准备：${status.phase} —— ${status.message}`,
          );
        });
      break;
    }

    case "runtime-start": {
      const manager = runtimeManager();
      setStatusText("正在启动…");
      void manager.start().then((status) => {
        setStatusText(describeRuntime(status));
        appendPanelLog(
          "runtime",
          `手动启动：${status.phase} —— ${status.message}`,
        );
      });
      break;
    }

    case "runtime-stop": {
      void runtimeManager()
        .stop()
        .then((status) => setStatusText(describeRuntime(status)));
      break;
    }

    // ── 自检（用户要求：从工具菜单搬进设置页）──────────────
    case "selfcheck": {
      void selfCheck.run({ testStream: false, win });
      break;
    }

    case "selfcheck-stream": {
      void selfCheck.run({ testStream: true, win });
      break;
    }

    case "deep-probe": {
      void selfCheck.deepProbe(win);
      break;
    }

    // ── 模型（API Key 与推理等级）──────────────────────────
    //
    // 三个事件交给 `modelPanel` 处理：下拉框同步（model-sync）、刷新列表
    // （model-refresh）、保存 Key（model-save-key）。放在一个入口里分发，
    // 是为了让设置页的 xhtml 里只出现一处 `onPrefsEvent` 调用形态。
    case "model-sync":
    case "model-refresh":
    case "model-save-key": {
      void handleModelPrefsEvent(type, { window: win, target: data?.target });
      break;
    }

    // ── 新手引导（设置页的「重新显示」）────────────────────
    case "onboarding": {
      const opened = reopenOnboarding();
      if (!opened) {
        // 打开失败要说出来，否则用户点了按钮"什么都没发生"
        appendPanelLog(
          "onboarding",
          "设置页点了「重新显示新手引导」，但窗口未能打开",
        );
      }
      break;
    }

    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
