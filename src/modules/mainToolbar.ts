/**
 * ## Zotero **主窗口工具栏**上的「DSH」下拉
 *
 * 与条目面板里那个「更多 ▾」不同：这里不受某条会话/某篇文献限制，
 * 所以只放**全局**动作：
 *
 *  1. 在网页版打开 dsh（用默认浏览器打开已登录的 dsh web 界面）
 *  2. 打开工作区根目录（所有文献的材料都在这个父目录下）
 *
 * ## DOM 契约来自实测，不是记忆
 *
 * 用 Zotero 10.0.6 自带的 `chrome/content/zotero/zoteroPane.xhtml` 核对过：
 *
 * ```xml
 * <toolbar id="zotero-toolbar-item-tree" class="zotero-toolbar toolbar-primary">
 *   <hbox id="zotero-items-toolbar" align="center" flex="1">
 *     <toolbarbutton id="zotero-tb-add"   type="menu" class="zotero-tb-button">…</toolbarbutton>
 *     <toolbarbutton id="zotero-tb-lookup" type="panel" class="zotero-tb-button"/>
 * ```
 *
 * 所以挂在 `#zotero-items-toolbar` 里、`#zotero-tb-lookup` 之后 —— 相当于排在
 * Zotero 自己的动作按钮后面。找不到就**按候选顺序退让**并记日志，
 * 绝不让"没出现"变成一个查不出的谜。
 *
 * ## ⚠️ 图标必须自己给
 *
 * Zotero 的 `.zotero-tb-button` 图标是**按 id 逐条配 CSS** 的
 * （`#zotero-tb-add { list-style-image: … }`）。自建的 id 不匹配任何规则，
 * 结果是**按钮存在但看不见** —— 这种"加了等于没加"最难排查。
 * 所以用插件自带的 favicon 显式设置 `list-style-image`。
 */

import { requireRuntimeConfig } from "../dsh/config";
import { appendPanelLog } from "../dsh/runLog";
import { openDshWebUi, openWorkspaceInFileManager } from "./openExternal";

const BUTTON_ID = "dsh-for-zotero-toolbar-menu";

/** 挂载点的候选顺序：从最贴合"条目列表工具条"到最顶层 */
const TOOLBAR_CANDIDATES = [
  "zotero-items-toolbar",
  "zotero-collections-toolbar",
  "zotero-tabs-toolbar",
];

/** 插入锚点：排在它后面的 Zotero 自有按钮之后 */
const ANCHOR_CANDIDATES = ["zotero-tb-lookup", "zotero-tb-add"];

interface MainWindowLike {
  document: Document;
}

/**
 * 在主窗口工具栏装上下拉。**幂等**：已存在就直接返回 true。
 *
 * @returns 是否装上了（装不上时日志里会有原因）
 */
export function installMainToolbar(): boolean {
  try {
    const win = (
      Zotero as unknown as { getMainWindow?: () => MainWindowLike | undefined }
    ).getMainWindow?.();
    const doc = win?.document;
    if (!doc) {
      appendPanelLog("session", "主窗口工具栏：取不到主窗口，暂不挂载");
      return false;
    }
    if (doc.getElementById(BUTTON_ID)) return true; // 幂等

    const toolbar = findFirst(doc, TOOLBAR_CANDIDATES);
    if (!toolbar) {
      // 把"试过哪些 id"写进日志：否则表现只是"按钮没出现"，无从判断
      appendPanelLog(
        "session",
        `主窗口工具栏：找不到挂载点（试过 ${TOOLBAR_CANDIDATES.join("、")}）；` +
          "插件按钮将不可见。",
      );
      return false;
    }

    const docAny = doc as unknown as {
      createXULElement: (name: string) => Element;
    };
    const button = docAny.createXULElement("toolbarbutton");
    button.id = BUTTON_ID;
    button.setAttribute("type", "menu");
    button.setAttribute("class", "zotero-tb-button");
    button.setAttribute("tabindex", "-1");
    button.setAttribute("tooltiptext", "DSH-for-Zotero");
    // ⚠️ 图标必须显式给：Zotero 按 id 配图标，自建 id 不加这句就**看不见**
    //
    // 用**专门为工具条生成的**图标，不是 addon 的 favicon：
    // favicon 是"圆角白卡片 + 近黑鲸鱼"，放工具条上白底突兀、颜色太抢、尺寸偏大。
    // `tools/make-toolbar-icon.py` 从 favicon 抠出鲸鱼剪影，去掉白底与描边。
    //
    // ## ⚠️ 必须是**外在尺寸固定**的 SVG，不能是 PNG
    //
    // XUL 的 `list-style-image` 按图片**内在尺寸**绘制，
    // `max-width` / `max-height` 只约束元素盒子、**不缩放标记图**。
    // 先前给的是 96×96 的 PNG，工具条就按 96px 画（被 41px 高的工具条裁掉），
    // 用户反馈"鲸鱼更大了"。
    //
    // ## ⚠️ 必须带 `-moz-context-properties: fill` + `fill: currentColor`
    //
    // SVG 里的鲸鱼是**亮度蒙版**，颜色由 `fill="context-fill"` 决定 ——
    // 也就是跟随工具条的**前景色**：深色主题自动变浅、浅色主题自动变深。
    //
    // 少了这两行，`context-fill` 取不到上下文，图标会用默认的黑色，
    // 在深色主题下**完全看不见**。Zotero 自己的图标正是这么配的：
    //
    // ```css
    //   list-style-image: url("chrome://zotero/skin/16/universal/*.svg");
    //   fill: currentColor;
    //   -moz-context-properties: fill, fill-opacity;
    // ```
    //
    // 这样也**不再需要描边** —— 描边本来是为了让深灰本体在深色背景上分得开，
    // 而颜色自适应之后那个问题不存在了。
    const addonRef = String(
      (addon.data as { config?: { addonRef?: string } }).config?.addonRef ?? "",
    );
    if (addonRef) {
      button.setAttribute(
        "style",
        `list-style-image: url("chrome://${addonRef}/content/icons/toolbar-dsh.svg");` +
          "fill: currentColor;" +
          "-moz-context-properties: fill;",
      );
    }

    const popup = docAny.createXULElement("menupopup");
    popup.setAttribute("id", `${BUTTON_ID}-popup`);
    button.appendChild(popup);

    const addItem = (label: string, run: () => void): void => {
      const item = docAny.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", () => {
        try {
          run();
        } catch (error) {
          notify(
            "DSH-for-Zotero",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      popup.appendChild(item);
    };

    addItem("在网页版打开 dsh", () => {
      void openDshWebUi().then((result) => notifyResult(result));
    });
    addItem("打开工作区根目录", () => {
      let root = "";
      try {
        root = requireRuntimeConfig().workspaceRoot;
      } catch (error) {
        notify(
          "DSH-for-Zotero",
          "运行时还没就绪，稍后再试：" +
            (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      void openWorkspaceInFileManager(root).then((result) =>
        notifyResult(result),
      );
    });

    // 插到 Zotero 自己的动作按钮之后；找不到锚点就放到工具条末尾
    const anchor = findFirst(doc, ANCHOR_CANDIDATES);
    if (anchor && anchor.parentNode === toolbar) {
      toolbar.insertBefore(button, anchor.nextSibling);
    } else {
      toolbar.appendChild(button);
    }

    appendPanelLog(
      "session",
      `主窗口工具栏已挂载 DSH 下拉（挂在 #${toolbar.id}）`,
    );
    return true;
  } catch (error) {
    appendPanelLog(
      "session",
      `主窗口工具栏挂载失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** 卸载（插件停用/升级时调用）。不存在就什么都不做。 */
export function uninstallMainToolbar(): void {
  try {
    const win = (
      Zotero as unknown as { getMainWindow?: () => MainWindowLike | undefined }
    ).getMainWindow?.();
    const el = win?.document?.getElementById(BUTTON_ID);
    el?.remove();
  } catch {
    // 窗口可能已销毁 —— 那就没什么要清的
  }
}

/**
 * 按候选顺序找第一个存在的元素。
 *
 * 返回 `Element` 而不是 `HTMLElement`：主窗口是 XUL 文档，
 * `#zotero-items-toolbar` 这类是 XUL 元素，**不是** HTML 元素。
 */
function findFirst(doc: Document, ids: string[]): Element | undefined {
  for (const id of ids) {
    const found = doc.getElementById(id);
    if (found) return found;
  }
  return undefined;
}

/**
 * 用 Zotero 自己的进度窗口报结果。
 *
 * 为什么不用 `alert()`：那是**阻塞**对话框，会打断用户正在做的事；
 * 而这两个动作的结果大多是"成功"，不值得挡一次。
 */
function notify(headline: string, message: string): void {
  try {
    const ProgressWindow = (
      Zotero as unknown as {
        ProgressWindow?: new (options?: Record<string, unknown>) => {
          changeHeadline?: (text: string) => void;
          addDescription?: (text: string) => void;
          show?: () => void;
          startCloseTimer?: (ms: number) => void;
        };
      }
    ).ProgressWindow;
    if (!ProgressWindow) return;
    const pw = new ProgressWindow({ closeOnClick: true });
    pw.changeHeadline?.(headline);
    pw.addDescription?.(message);
    pw.show?.();
    pw.startCloseTimer?.(4000);
  } catch {
    // 通知失败不影响动作本身
  }
}

function notifyResult(result: {
  ok: boolean;
  结果: string;
  路径?: string;
  地址?: string;
  说明?: string;
}): void {
  const detail = result.路径 ?? result.地址 ?? "";
  appendPanelLog(
    "session",
    `主窗口工具栏动作：${result.结果}${detail ? " " + detail : ""}` +
      (result.说明 ? `（${result.说明}）` : ""),
  );
  notify(
    "DSH-for-Zotero",
    result.结果 +
      (detail ? "\n" + detail : "") +
      (result.说明 ? "\n" + result.说明 : ""),
  );
}
