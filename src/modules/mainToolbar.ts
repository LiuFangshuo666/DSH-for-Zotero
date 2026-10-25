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
 * 工具栏下拉要用的会话动作。
 *
 * 为什么用**注入**而不是直接 import sessionPane：
 * `sessionPane.ts` 反过来依赖这个模块所在的 UI 层，直接互引会绕成循环依赖。
 * 由 `hooks.ts` 把它们接起来（那里本来就持有 `sessionPane()` 单例）。
 */
export interface MainToolbarActions {
  /** 为当前选中的条目新建文献会话 */
  newItemSession: () => Promise<unknown>;
  /** 为当前选中的分类新建独立会话 */
  newCollectionSession: () => Promise<unknown>;
  /**
   * 当前是否有可供该动作操作的对象 —— 用来**置灰**菜单项。
   *
   * 与 Zotero 自带的「新建条目」「添加附件」「新建笔记」一致：
   * 没有选中条目时，那几项是灰的。判断复用 `sessionPane.hasMenuTarget`，
   * 保证右键菜单与工具栏**同源**，不会出现"右键能点、工具栏灰着"。
   */
  canCreate: (kind: "item" | "collection") => boolean;
}

/**
 * 在主窗口工具栏装上下拉。**幂等**：已存在就直接返回 true。
 *
 * @param actions 会话动作（由 hooks 注入）
 * @returns 是否装上了（装不上时日志里会有原因）
 */
export function installMainToolbar(actions: MainToolbarActions): boolean {
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
    /**
     * ⚠️ `wantdropmarker="true"` 是**箭头能不能显示**的关键。
     *
     * Zotero 主工具栏里 3 个 `type="menu"` 的按钮
     * （`zotero-tb-add`、`toolbar-add-attachment`、`zotero-tb-note-add`）
     * **全部**带这个属性 —— 少了它，按钮有下拉、但**右边没有那个小箭头**，
     * 用户看不出这里有菜单（真机反馈"图标右边加个向下的小箭头"）。
     */
    button.setAttribute("wantdropmarker", "true");
    button.setAttribute("class", "zotero-tb-button");
    button.setAttribute("tabindex", "-1");
    button.setAttribute("tooltiptext", "DSH-for-Zotero");
    // ⚠️ 图标必须显式给：Zotero 按 id 配图标，自建 id 不加这句就**看不见**
    //
    // 用**专门生成的蓝色鲸鱼**，不是 addon 的 favicon：
    // favicon 是"圆角白卡片 + 近黑鲸鱼"，放工具条上白底突兀、颜色太抢、尺寸偏大。
    // `tools/make-toolbar-icon.py` 从 favicon 抠出剪影，去掉白底与描边，染成蓝色。
    //
    // ## ⚠️ 必须是**外在尺寸固定**的 SVG，不能是 PNG
    //
    // XUL 的 `list-style-image` 按图片**内在尺寸**绘制，
    // `max-width` / `max-height` 只约束元素盒子、**不缩放标记图**。
    // 先前给的是 96×96 的 PNG，工具条就按 96px 画（被 41px 高的工具条裁掉），
    // 用户反馈"鲸鱼更大了"。
    //
    // ## 为什么工具栏用 context-fill，而侧栏用另一张固定色图
    //
    // 这张图是**亮度蒙版**，颜色由 `fill="context-fill"` 从工具条的
    // `fill` 取 —— 于是深色主题自动浅、浅色主题自动深，不用描边也不会糊。
    // Zotero 自己的图标正是这么配的。
    //
    // 但侧栏的 `header.icon` / `sidenav.icon` 由 Zotero 当**普通图片**渲染，
    // **不会**设置 `-moz-context-properties`，`context-fill` 在那里取不到值 ——
    // 所以侧栏用的是 `whale-blue.svg`（颜色写进图里）。
    // 两份资产由 `tools/make-toolbar-icon.py` 一起生成。
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

    const addItem = (label: string, run: () => void): Element => {
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
      return item;
    };

    /**
     * 两种新建会话放在**最前面**：它们是这个按钮最主要的用途，
     * 和右键菜单里的两个入口一一对应（条目会话 / 独立会话）。
     *
     * 失败时（没选中条目、没有分类）动作会抛错，由 `addItem` 的 catch
     * 用进度窗口告知 —— 不能像右键菜单那样只往日志里写一行，
     * 工具栏上用户不会去翻日志。
     */
    const itemSessionItem = addItem("新建文献会话（当前选中的条目）", () => {
      void actions.newItemSession().then(
        () => notify("DSH-for-Zotero", "已新建文献会话"),
        (error: unknown) => notify("DSH-for-Zotero", describe(error)),
      );
    });
    const collectionSessionItem = addItem(
      "新建独立会话（当前选中的分类）",
      () => {
        void actions.newCollectionSession().then(
          () => notify("DSH-for-Zotero", "已新建独立会话"),
          (error: unknown) => notify("DSH-for-Zotero", describe(error)),
        );
      },
    );

    /**
     * ## 没有可操作对象时把这两项**置灰**
     *
     * Zotero 自带的「新建条目」「添加附件」「新建笔记」都是这么做的：
     * 没选中条目时它们是灰的，用户一眼就知道现在不能点。
     *
     * ⚠️ 时机很关键：必须在**每次弹出菜单时**重新算（`popupshowing`），
     * 不能在挂载时算一次 —— 挂载发生在启动时，那时通常什么都没选中，
     * 一次算死就会永远灰着。而选中状态是随时变的。
     *
     * 只灰掉这两项，**按钮本身保持可点**：网页版/工作区两个动作
     * 与选中状态无关，不该被连坐。
     */
    const syncEnabled = (): void => {
      const setEnabled = (el: Element, enabled: boolean): void => {
        if (enabled) el.removeAttribute("disabled");
        else el.setAttribute("disabled", "true");
      };
      try {
        setEnabled(itemSessionItem, actions.canCreate("item"));
        setEnabled(collectionSessionItem, actions.canCreate("collection"));
      } catch (error) {
        // 取不到选中状态时**保持可点**：让用户点了看到原因，
        // 比让按钮莫名其妙灰着更好排查
        appendPanelLog(
          "session",
          `工具栏菜单项启用状态判断失败（保持可点）：${describe(error)}`,
        );
      }
    };
    popup.addEventListener("popupshowing", syncEnabled);
    syncEnabled();

    const separator = docAny.createXULElement("menuseparator");
    popup.appendChild(separator);

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
          "运行时还没就绪，稍后再试：" + describe(error),
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
 * 把未知的异常转成一句能给用户看的话。
 *
 * 收敛在一处：菜单项的 catch、`actions` 的 reject、配置读取的失败
 * 都要说人话，而不是把 `[object Object]` 丢到进度窗口里。
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
