/**
 * 阅读器侧栏面板：DSH 伴读的主界面。
 *
 * 结构：
 *   ① 状态条（连接/会话/生成中 + 停止按钮）
 *   ② 对话流（用户消息 / 助手消息 / 提示）
 *   ③ 输入区（多行输入 + 发送）
 *
 * ## ⚠️ 先弄清它和"会话页"的分工（真机上混淆过）
 *
 * 本插件有**两套界面**，它们服务于不同的东西，互不复用：
 *
 * | | 本文件（阅读器侧栏） | `addon/content/sessionPage.js`（会话页） |
 * | --- | --- | --- |
 * | 宿主 | 阅读器侧栏 | 独立窗口 / 标签页（由附件打开） |
 * | 会话归属 | **临时**（面板销毁即释放） | **持久**（挂在文献库里的附件） |
 * | 一次性任务按钮 | **有**（速读摘要等五条） | **没有** —— 用户得自己打字 |
 *
 * 由此产生一条容易搞错的规则：**设置页「阅读器侧栏面板」那一节的选项
 * （回答语言、首次发送确认、分块大小、高亮色、自定义指令）只对本文件生效**，
 * 会话页**完全不读**它们（`sessionPane.ts` 里 `answerLanguage` 出现 0 次）。
 * 设置页文案已按这个事实分节，改代码时别把两者混起来。
 *
 * 另外：五条"一键任务"的提示词由 `src/chat/commands.ts` 与 `papers/workspace.ts`
 * 的 `buildPrompt` 组装，**只有本文件调用它们**。
 *
 * ## 设计约束（依据 docs/DSH集成与桥接协议.md §7）
 *  - 面板注册用官方 `Zotero.ItemPaneManager.registerSection`；
 *  - 所有文本一律 `textContent` 写入，绝不 `innerHTML`（论文与模型输出都可能含标记）；
 *  - 生成期间禁用发送、显示"停止"，避免并发请求；
 *  - 面板销毁时必须释放流与轮询（`transport.dispose()`）。
 */

import {
  canSend,
  isTurnActive,
  initialState,
  reduce,
  statusLine,
  toView,
  type ChatState,
} from "../chat/state";
import { ChatTransport, registerSelectionSink } from "../chat/transport";
import {
  BUILTIN_COMMANDS,
  buildCommandQuestion,
  parseCustomCommands,
  type ReadingCommand,
} from "../chat/commands";
import {
  copyAnswerToClipboard,
  saveAnswerAsHighlight,
  saveAnswerAsNote,
  type AnswerPayload,
} from "../notes/writeback";
import { appendPanelLog } from "../dsh/runLog";
import { requireRuntimeConfig, resolveRuntimeConfig } from "../dsh/config";
import { workspaceFor } from "../dsh/session";
import {
  buildMetadataText,
  buildPrompt,
  writePaperWorkspace,
  type PaperFiles,
  type PaperItemRef,
} from "../papers/workspace";
import { getPref } from "../utils/prefs";

/**
 * harness 说"还在跑"之后的复查间隔。
 *
 * 取 20 秒的理由：这只是给"回到面板"场景兜底，
 * 正常轮询路径由传输层的 `pollOnce` 负责（它自己会问 `running`）。
 * 间隔太短只会白抢 RPC，太长则让"仍在运行"多挂一会儿。
 */
const HARNESS_RECHECK_MS = 20_000;

const PANE_ID = "dshforzotero-reader";

interface SessionStore {
  [itemKey: string]: string;
}

let sessionStoreCache: SessionStore | undefined;

export class ReaderPanel {
  private readonly paneID: string;
  private registered = false;

  /** 每个面板（每个窗口）一份 DOM 与状态 */
  private panels = new WeakMap<HTMLElement, PanelInstance>();

  constructor() {
    this.paneID = PANE_ID;
  }

  register(): void {
    if (this.registered) return;
    const result = Zotero.ItemPaneManager.registerSection({
      paneID: this.paneID,
      pluginID: addon.data.config.addonID,
      header: {
        l10nID: `${addon.data.config.addonRef}-reader-section-head`,
        icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`,
      },
      sidenav: {
        l10nID: `${addon.data.config.addonRef}-reader-section-sidenav`,
        icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`,
      },
      onItemChange: ({ item, setEnabled, tabType }) => {
        // 只在阅读器标签页启用，且该条目必须能定位到文献
        const enabled = tabType === "reader" && !!item;
        setEnabled(enabled);
        return true;
      },
      onRender: ({ body, item, doc }) => {
        const instance =
          this.panels.get(body) ?? this.createInstance(body, doc);
        this.panels.set(body, instance);
        instance.attach(item ?? undefined);
      },
      onDestroy: ({ body }) => {
        const instance = this.panels.get(body);
        instance?.dispose();
        this.panels.delete(body);
      },
    });
    this.registered = result !== false;
    if (!this.registered) {
      ztoolkit.log("[DSH] 阅读器面板注册失败（paneID 冲突？）", this.paneID);
    }
  }

  unregister(): void {
    if (!this.registered) return;
    try {
      Zotero.ItemPaneManager.unregisterSection(this.paneID);
    } catch (error) {
      ztoolkit.log("[DSH] 注销阅读器面板失败", error);
    }
    this.registered = false;
  }

  private createInstance(body: HTMLElement, doc: Document): PanelInstance {
    return new PanelInstance(body, doc);
  }
}

// ── 单个面板实例 ────────────────────────────────────────────

class PanelInstance {
  private readonly body: HTMLElement;
  private readonly doc: Document;
  private readonly transport: ChatTransport;

  private state: ChatState = initialState();
  private item?: Zotero.Item;
  private itemKey?: string;
  private paperFiles?: PaperFiles;
  private lastMetadataText = "";

  private statusEl!: HTMLElement;
  private logEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private commandButtons: HTMLButtonElement[] = [];
  private newSessionButton!: HTMLButtonElement;
  private historySelect!: HTMLSelectElement;
  private regenerateButton!: HTMLButtonElement;
  private saveNoteButton!: HTMLButtonElement;
  private saveHighlightButton!: HTMLButtonElement;
  private copyButton!: HTMLButtonElement;
  /** 上一次提问的原文，用于"重新生成" */
  private lastQuestion?: string;
  /** 最近一次划选的原文与页码（存高亮时需要） */
  private lastSelection?: {
    text: string;
    pageIndex?: number;
    rects?: number[][];
  };
  /** 会话映射从磁盘加载完成的信号；`prepare()` 会等它，否则"恢复上次会话"永远不生效 */
  private readonly mappingReady: Promise<void>;
  /** 注销划词入口的注册 */
  private unregisterSelectionSink?: () => void;
  /**
   * 复查 harness 运行状态的定时器。
   *
   * ## 为什么需要"复查"而不只是"挂载时问一次"
   *
   * 挂载时问一次能解决"回来发现它还在跑"，但接下来**它跑完了界面不会知道** ——
   * 那条"仍在运行"会一直挂着，直到用户再切一次界面。那是另一种形式的谎报。
   *
   * 所以：仍在跑时按 `HARNESS_RECHECK_MS` 复查一次，一旦 harness 说停了
   * 就更新状态、**清掉**提示并恢复输入。
   */
  private harnessTimer?: number;

  constructor(body: HTMLElement, doc: Document) {
    this.body = body;
    this.doc = doc;
    this.transport = new ChatTransport({
      emit: (event) => this.applyEvent(event),
      log: (message) => {
        ztoolkit.log(`[DSH] ${message}`);
        // 面板的日志与故障只显示在界面上，外部无法诊断（实测踩过：面板出错时
        // 我只能靠猜）。统一落盘一份，便于事后定位。
        appendPanelLog("log", message);
      },
      getSessionId: (itemKey) => this.readSessionMap()[itemKey],
      rememberSession: (itemKey, sessionId) =>
        this.writeSessionMap(itemKey, sessionId),
      workspaceDir: (itemKey) => this.workspaceDirFor(itemKey),
    });

    this.render();
    this.transport.onStatus((status) => {
      if (status.error && !this.state.lastFault) {
        this.applyEvent({
          kind: "fault",
          code: "client/transport",
          message: status.error,
        });
      }
    });
    this.mappingReady = this.loadSessionMap();
  }

  // ── DOM ───────────────────────────────────────────────

  private render(): void {
    const doc = this.doc;
    this.body.replaceChildren();

    const root = doc.createElement("div");
    root.className = "dsh-panel";
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.height = "100%";
    root.style.minHeight = "260px";
    root.style.fontSize = "13px";

    // ① 状态条
    const statusBar = doc.createElement("div");
    statusBar.style.display = "flex";
    statusBar.style.alignItems = "center";
    statusBar.style.gap = "6px";
    statusBar.style.padding = "4px 6px";
    statusBar.style.borderBottom = "1px solid var(--fill-quaternary, #ddd)";

    this.statusEl = doc.createElement("span");
    this.statusEl.style.flex = "1";
    this.statusEl.style.overflow = "hidden";
    this.statusEl.style.textOverflow = "ellipsis";
    this.statusEl.style.whiteSpace = "nowrap";
    this.statusEl.style.opacity = "0.8";

    this.stopButton = doc.createElement("button");
    this.stopButton.textContent = "停止";
    this.stopButton.addEventListener("click", () => {
      void this.transport.stop();
    });

    statusBar.append(this.statusEl, this.stopButton);

    // ② 对话流
    this.logEl = doc.createElement("div");
    this.logEl.style.flex = "1";
    this.logEl.style.overflowY = "auto";
    this.logEl.style.padding = "6px";
    this.logEl.style.display = "flex";
    this.logEl.style.flexDirection = "column";
    this.logEl.style.gap = "8px";

    // ③ 输入区
    const inputRow = doc.createElement("div");
    inputRow.style.display = "flex";
    inputRow.style.gap = "6px";
    inputRow.style.padding = "6px";
    inputRow.style.borderTop = "1px solid var(--fill-quaternary, #ddd)";

    this.inputEl = doc.createElement("textarea");
    this.inputEl.rows = 2;
    this.inputEl.placeholder =
      "问这篇文献的问题（Enter 发送，Shift+Enter 换行）";
    this.inputEl.style.flex = "1";
    this.inputEl.style.resize = "vertical";
    this.inputEl.style.minHeight = "42px";
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });

    this.sendButton = doc.createElement("button");
    this.sendButton.textContent = "发送";
    this.sendButton.addEventListener("click", () => {
      void this.send();
    });

    inputRow.append(this.inputEl, this.sendButton);

    // ④ 指令工具条（M3：五条一键动作 + 会话操作）
    const toolbar = doc.createElement("div");
    toolbar.style.display = "flex";
    toolbar.style.flexWrap = "wrap";
    toolbar.style.gap = "4px";
    toolbar.style.padding = "6px 6px 0";
    this.commandButtons = [];
    for (const command of this.allCommands()) {
      const button = doc.createElement("button");
      button.textContent = command.label;
      button.title = command.hint;
      button.style.fontSize = "12px";
      button.addEventListener("click", () => {
        void this.runCommand(command.id);
      });
      this.commandButtons.push(button);
      toolbar.append(button);
    }

    const separator = doc.createElement("div");
    separator.style.flexBasis = "100%";
    separator.style.height = "2px";
    toolbar.append(separator);

    this.newSessionButton = doc.createElement("button");
    this.newSessionButton.textContent = "新建对话";
    this.newSessionButton.title = "为这篇文献开一条全新的 dsh 会话";
    this.newSessionButton.style.fontSize = "12px";
    this.newSessionButton.addEventListener("click", () => {
      void this.newSession();
    });

    this.historySelect = doc.createElement("select");
    this.historySelect.title = "切换到这篇文献的历史会话";
    this.historySelect.style.maxWidth = "180px";
    this.historySelect.style.fontSize = "12px";
    this.historySelect.addEventListener("change", () => {
      const sessionId = this.historySelect.value;
      if (sessionId && sessionId !== this.state.sessionId)
        void this.switchSession(sessionId);
    });

    this.regenerateButton = doc.createElement("button");
    this.regenerateButton.textContent = "重新生成";
    this.regenerateButton.title = "重发上一条问题";
    this.regenerateButton.style.fontSize = "12px";
    this.regenerateButton.addEventListener("click", () => {
      void this.regenerate();
    });

    // M4：结果回写
    this.saveNoteButton = doc.createElement("button");
    this.saveNoteButton.textContent = "存为笔记";
    this.saveNoteButton.title =
      "把最后一条回答保存为该文献的子笔记（同一天追加到同一条）";
    this.saveNoteButton.style.fontSize = "12px";
    this.saveNoteButton.addEventListener("click", () => {
      void this.saveLastAnswerAsNote();
    });

    this.saveHighlightButton = doc.createElement("button");
    this.saveHighlightButton.textContent = "存为高亮";
    this.saveHighlightButton.title =
      "把回答作为评论写入 PDF 高亮（需要先在阅读器里划选文字）";
    this.saveHighlightButton.style.fontSize = "12px";
    this.saveHighlightButton.addEventListener("click", () => {
      void this.saveLastAnswerAsHighlight();
    });

    this.copyButton = doc.createElement("button");
    this.copyButton.textContent = "复制";
    this.copyButton.title = "以 Markdown 复制最后一条回答";
    this.copyButton.style.fontSize = "12px";
    this.copyButton.addEventListener("click", () => {
      this.copyLastAnswer();
    });

    toolbar.append(
      this.newSessionButton,
      this.historySelect,
      this.regenerateButton,
      this.saveNoteButton,
      this.saveHighlightButton,
      this.copyButton,
    );

    root.append(statusBar, this.logEl, toolbar, inputRow);
    this.body.append(root);
    this.paint();
  }

  /** 内置 + 用户自定义指令 */
  private allCommands(): ReadingCommand[] {
    try {
      return [
        ...BUILTIN_COMMANDS,
        ...parseCustomCommands(getPref("customCommands" as never)),
      ];
    } catch {
      return BUILTIN_COMMANDS;
    }
  }

  /** 依据状态重画状态条与按钮可用性 */
  private paint(): void {
    const port = (() => {
      try {
        return requireRuntimeConfig().port;
      } catch {
        return 0;
      }
    })();
    this.statusEl.textContent = statusLine(this.state, port);
    this.statusEl.title = this.state.lastFault?.message ?? "";
    this.sendButton.disabled = !canSend(this.state);
    // ⚠️ "这一轮是否还在进行"要看 `isTurnActive`（= generating 或**问出来的**
    // harnessRunning），不能只看 `generating`：
    // 退出会话页再回来时 generating 是初始的 false，而 harness 可能还在跑。
    // 只看 generating 会让停止按钮变灰 —— 用户想停也停不了。
    const turnActive = isTurnActive(this.state);
    this.stopButton.disabled = !turnActive || this.state.cancelPending;
    this.inputEl.disabled = this.state.cancelPending;

    const busy =
      turnActive || this.state.cancelPending || !this.state.connected;
    for (const button of this.commandButtons) button.disabled = busy;
    this.newSessionButton.disabled = busy;
    this.historySelect.disabled = busy;
    this.regenerateButton.disabled = busy || !this.lastQuestion;

    const hasAnswer = this.lastAnswerText().length > 0;
    const hasAttachment = !!this.pdfAttachmentID();
    this.saveNoteButton.disabled = busy || !hasAnswer;
    this.copyButton.disabled = !hasAnswer;
    // 高亮需要选区几何信息，缺一不可（否则 Zotero 无法定位注释）
    const hasRects = !!this.lastSelection?.rects?.length;
    this.saveHighlightButton.disabled =
      busy || !hasAnswer || !hasAttachment || !hasRects;
    this.saveHighlightButton.title = !hasRects
      ? "需要先在阅读器里划选文字（高亮位置来自选区）"
      : !hasAttachment
        ? "该条目没有 PDF 附件"
        : "把回答作为评论写入 PDF 高亮";
  }

  // ── M4：结果回写 ────────────────────────────────────────

  /** 取最后一条非空的助手回答文本 */
  private lastAnswerText(): string {
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const message = this.state.messages[i];
      if (message.role !== "assistant") continue;
      const text = message.blocks
        .filter((b) => b.blockType !== "reasoning")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return "";
  }

  private pdfAttachmentID(): number | undefined {
    const item = this.item;
    if (!item) return undefined;
    if (item.isPDFAttachment?.()) return item.id;
    const parentID = (item as unknown as { parentItemID?: number | false })
      .parentItemID;
    const owner = parentID ? (Zotero.Items.get(parentID) ?? item) : item;
    for (const id of owner.getAttachments?.() ?? []) {
      const candidate = Zotero.Items.get(id);
      if (candidate?.isPDFAttachment?.()) return candidate.id;
    }
    return undefined;
  }

  private buildAnswerPayload(): AnswerPayload | undefined {
    const answer = this.lastAnswerText();
    if (!answer) return undefined;
    const question = this.lastQuestion ?? "（未记录问题）";
    return {
      // 面板上显示的是"问题"部分；指令类提问会带结构化说明，原样保留更有用
      question,
      answer,
      selection: this.lastSelection?.text,
      pageLabel:
        this.lastSelection?.pageIndex !== undefined
          ? `第 ${this.lastSelection.pageIndex + 1} 页`
          : undefined,
    };
  }

  private async saveLastAnswerAsNote(): Promise<void> {
    const item = this.item;
    const payload = this.buildAnswerPayload();
    if (!item || !payload) return;
    const parentID = (item as unknown as { parentItemID?: number | false })
      .parentItemID;
    const owner = parentID ? (Zotero.Items.get(parentID) ?? item) : item;
    try {
      const result = await saveAnswerAsNote(payload, { parent: owner });
      this.appendLocalNotice(
        result.created ? "已保存为新笔记。" : "已追加到今天的伴读笔记。",
        "info",
      );
      this.paint();
    } catch (error) {
      this.appendLocalNotice(
        `保存笔记失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  private async saveLastAnswerAsHighlight(): Promise<void> {
    const payload = this.buildAnswerPayload();
    const attachmentID = this.pdfAttachmentID();
    const selection = this.lastSelection;
    if (!payload || !attachmentID || !selection?.rects?.length) return;
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment) return;
    try {
      await saveAnswerAsHighlight(
        attachment,
        payload,
        { pageIndex: selection.pageIndex ?? 0, rects: selection.rects },
        { color: String(getPref("highlightColor" as never) ?? "#ffd400") },
      );
      this.appendLocalNotice("已保存为 PDF 高亮（评论为 AI 回答）。", "info");
    } catch (error) {
      this.appendLocalNotice(
        `保存高亮失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  private copyLastAnswer(): void {
    const payload = this.buildAnswerPayload();
    if (!payload) return;
    this.appendLocalNotice(
      copyAnswerToClipboard(payload)
        ? "已复制为 Markdown。"
        : "复制失败，见日志。",
      "info",
    );
  }

  /** 重画对话流（消息条数有限，整体重画足够快） */
  private paintMessages(): void {
    const cells = toView(this.state);
    const doc = this.doc;
    const nodes: HTMLElement[] = [];
    for (const cell of cells) {
      const bubble = doc.createElement("div");
      bubble.style.whiteSpace = "pre-wrap";
      bubble.style.wordBreak = "break-word";
      bubble.style.padding = "6px 8px";
      bubble.style.borderRadius = "6px";
      bubble.textContent = cell.text + (cell.streaming ? " ▌" : "");

      if (cell.kind === "user") {
        bubble.style.background = "var(--fill-quinary, #eef)";
        bubble.setAttribute("data-role", "user");
      } else if (cell.kind === "notice") {
        bubble.style.opacity = "0.8";
        bubble.style.fontStyle = "italic";
        bubble.setAttribute("data-role", "notice");
      } else {
        bubble.style.background = "var(--material-background, #fafafa)";
        bubble.setAttribute("data-role", "assistant");
      }
      nodes.push(bubble);
    }
    this.logEl.replaceChildren(...nodes);
    // 滚到底部，便于看逐字输出
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ── 状态与事件 ─────────────────────────────────────────

  private applyEvent(event: Parameters<typeof reduce>[1]): void {
    this.state = reduce(this.state, event);
    // 故障落盘：面板状态条外部读不到，出错时只能靠猜（实测踩过）。
    if (event.kind === "fault") {
      appendPanelLog("fault", `${event.code}: ${event.message}`);
    }
    this.paint();
    this.paintMessages();
  }

  /**
   * 回填该文献已有的对话历史。
   * 只在"当前还没有任何消息"时载入，避免覆盖正在进行的对话。
   */
  private async loadHistory(itemKey: string): Promise<void> {
    try {
      await this.mappingReady;
      if (this.itemKey !== itemKey) return; // 期间切走了
      if (this.state.messages.length > 0) return;
      const turns = await this.transport.loadHistory(itemKey);
      if (turns.length === 0) return;
      if (this.itemKey !== itemKey || this.state.messages.length > 0) return;
      this.applyEvent({ kind: "history", turns });
      appendPanelLog("log", `已回填 ${turns.length} 轮历史对话（${itemKey}）`);
    } catch (error) {
      appendPanelLog(
        "log",
        `回填历史失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 面板挂到某个条目上：切换文献时重置并准备上下文 */
  attach(item?: Zotero.Item): void {
    const nextKey = item?.key;
    if (nextKey === this.itemKey) return;

    // 取消上一个文献的划词入口
    this.unregisterSelectionSink?.();
    this.unregisterSelectionSink = undefined;
    // ⚠️ 也要停掉上一个文献的 harness 复查定时器：它闭包捕获的是**旧的 itemKey**，
    // 留着会继续按旧 key 查状态，既浪费 RPC 又可能把新文献的界面改错。
    this.clearHarnessRecheck();

    this.item = item;
    this.itemKey = nextKey;
    this.paperFiles = undefined;
    this.lastMetadataText = "";
    this.state = initialState();
    this.paint();
    this.paintMessages();

    if (!item) {
      this.appendLocalNotice("此标签页没有可用的文献条目。", "warn");
      return;
    }

    // 注册划词入口：让官方选区弹窗能把文本送进这个面板
    if (nextKey) {
      this.unregisterSelectionSink = registerSelectionSink({
        itemKey: nextKey,
        askWithSelection: (text, pageIndex, preset) =>
          this.askWithSelection(text, pageIndex, preset),
      });
      // 回填历史对话：切走再切回来时不应像"记录丢了"（真机反馈）
      void this.loadHistory(nextKey);
      // ⚠️ 必须**同时**问一次 harness 的运行状态（真机反馈的缺口）：
      // 用户退出会话页再回来时，`state.generating` 是新实例的初始值 `false`，
      // 界面会显示成空闲 —— 而 harness 那边上一轮可能**还在跑**。
      // 用户以为答完了就追问一句，于是轮次错乱。
      void this.probeRunning(nextKey);
    }

    void this.prepare();
  }

  /**
   * 问一次 harness：这个文献的会话是否**仍在运行**，并把结果交给界面。
   *
   * 与 `loadHistory` 一样是"回到面板时"的补课动作。区别在于它回答的是
   * **"现在还在跑吗"**，而不是"以前聊过什么"。
   *
   * ## ⚠️ 三态必须**真的**传出去（这里曾经静默说谎）
   *
   * 本方法的文档一直写着三者要区分，但代码是：
   *
   * ```js
   *   running: runningSession ? true : undefined    // ← false 永不发出
   * ```
   *
   * 于是 reducer 每次都觉得"问不到"，状态行**永远显示「运行状态未知」**——
   * 而那本该是"一切正常、已空闲"的**最常见**情况。
   * 用户看到的是一个恒定的警告，久了就学会忽略它，于是真出问题时也看不见。
   *
   * 现在 `probeWorkspaceRunning()` 返回可区分的三态，这里如实映射：
   *  - `runningSessionId` 有值 → `true`，状态行显示"仍在运行（自 HH:MM 起）"
   *  - `{}`（确定空闲）        → **`false`**
   *  - `undefined`（问不到）   → `undefined`，显示"运行状态未知"
   *
   * `undefined` **不能**显示成空闲 —— 那会诱导用户追问一个其实还在跑的会话。
   */
  private async probeRunning(itemKey: string): Promise<void> {
    try {
      await this.mappingReady;
      if (this.itemKey !== itemKey) return; // 期间切走了
      const found = await this.transport.probeWorkspaceRunning(itemKey);
      if (this.itemKey !== itemKey) return;
      const runningSession = found?.runningSessionId;
      this.applyEvent({
        kind: "harness",
        // ⚠️ 三态如实映射：`found === undefined` 才是"问不到"，
        // 而 `found === {}` 是**确定空闲**。先前两者被压成了同一个值。
        running: found === undefined ? undefined : Boolean(runningSession),
      });
      if (runningSession) {
        appendPanelLog(
          "log",
          `检测到该文献的会话仍在运行（${runningSession}）—— 界面已标注，` +
            `避免被误判为"这一轮已结束"`,
        );
        this.scheduleHarnessRecheck(itemKey);
      } else {
        this.clearHarnessRecheck();
      }
    } catch (error) {
      appendPanelLog(
        "log",
        `查询 harness 运行状态失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * harness 说"还在跑"之后，隔一段时间**复查**一次。
   *
   * 没有这一步，"仍在运行"会一直挂到用户下次切界面 —— 而它可能早就跑完了，
   * 那是另一种谎报。这里用**较长**的间隔（`HARNESS_RECHECK_MS`）：
   * 这只是给"回到面板"场景兜底的，正常轮询路径由传输层的 `pollOnce` 负责，
   * 不需要这里频繁问。
   */
  private scheduleHarnessRecheck(itemKey: string): void {
    this.clearHarnessRecheck();
    this.harnessTimer = setTimeout(() => {
      this.harnessTimer = undefined;
      void this.probeRunning(itemKey);
    }, HARNESS_RECHECK_MS) as unknown as number;
  }

  private clearHarnessRecheck(): void {
    if (this.harnessTimer !== undefined) {
      clearTimeout(this.harnessTimer);
      this.harnessTimer = undefined;
    }
  }

  /**
   * 划词提问：把选中原文与预设指令组装成一次普通提问。
   * 由官方 `renderTextSelectionPopup` 事件（见 src/modules/selectionToolbar.ts）触发。
   */
  async askWithSelection(
    text: string,
    pageIndex?: number,
    preset?: string,
    rects?: number[][],
  ): Promise<void> {
    // 记下选区，供"存为高亮"使用（高亮必须要有位置信息）
    this.lastSelection = { text, pageIndex, rects };
    const question = preset?.trim()
      ? preset.trim()
      : "请解释这段原文，并说明它在全文中的作用。";
    await this.askQuestion(question, { text, pageIndex });
    this.paint();
  }

  /**
   * 统一的提问入口：所有入口（输入框、五条指令、重新生成、划词）都走这里，
   * 保证提示词组装与上下文供给只有一份实现。
   */
  private async askQuestion(
    question: string,
    selection?: { text: string; pageIndex?: number },
  ): Promise<void> {
    const item = this.item;
    if (!item) return;
    const ref = this.resolveRef(item);
    if (!ref) {
      this.appendLocalNotice("没有可用的文献条目，无法提问。", "error");
      return;
    }

    await this.mappingReady;
    const files = await this.ensureFiles(item, ref);
    if (!files) return;

    const prompt = buildPrompt({
      metadataText: this.lastMetadataText || buildMetadataText(item),
      files,
      question,
      selection,
      answerLanguage: String(getPref("answerLanguage" as never) ?? "zh-CN"),
    });

    this.lastQuestion = question;
    this.paint();
    await this.transport.ask({ itemKey: ref.key, prompt });
  }

  /**
   * 确保论文工作区文件已就绪（失败时给可读提示并返回 undefined）。
   *
   * ## 与会话模型共用同一个工作区（去冗余）
   *
   * 此前阅读器面板写 `<workspaceRoot>/<libraryID>-<itemKey>`，而会话模型写
   * `<workspaceRoot>/item-<itemKey>` —— **同一篇文献被提取两遍、缓存两份**，
   * 两边的 Agent 还可能看到不一致的材料。
   *
   * 现在统一走 `workspaceFor(..., "item", itemKey)`：面板与条目会话看到的是
   * **同一个目录、同一份 paper.txt 与 meta.json**。
   */
  private async ensureFiles(
    item: Zotero.Item,
    ref: PaperItemRef,
  ): Promise<PaperFiles | undefined> {
    if (this.paperFiles) return this.paperFiles;
    try {
      const config = resolveRuntimeConfig();
      if (!config) {
        // 运行时未就绪：明确告知，不再回退到桌面版 dsh（用户要求只允许隔离）
        throw new Error("隔离运行时尚未就绪，无法准备论文工作区。请稍候重试。");
      }
      this.lastMetadataText = this.lastMetadataText || buildMetadataText(item);
      const targetDir = workspaceFor(config.workspaceRoot, "item", ref.key);
      await IOUtils.makeDirectory(targetDir, { ignoreExisting: true });
      this.paperFiles = await writePaperWorkspace({
        config,
        ref,
        item,
        chunkBytes: Number(getPref("chunkBytes" as never) ?? 40960),
        targetDir,
      });
      return this.paperFiles;
    } catch (error) {
      this.appendLocalNotice(
        `准备上下文失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return undefined;
    }
  }

  /** 五条内置指令（M3）：一键提问 */
  private async runCommand(commandID: string): Promise<void> {
    if (!canSend(this.state)) return;
    const question = buildCommandQuestion(commandID);
    if (!question) {
      this.appendLocalNotice(`未知指令：${commandID}`, "warn");
      return;
    }
    await this.askQuestion(question);
  }

  /** 重新发送上一条问题 */
  private async regenerate(): Promise<void> {
    if (!this.lastQuestion || !canSend(this.state)) return;
    await this.askQuestion(this.lastQuestion);
  }

  /** 为同一文献开一条新会话，并清空面板对话 */
  private async newSession(): Promise<void> {
    const item = this.item;
    if (!item) return;
    const question = this.lastQuestion;
    this.state = initialState();
    this.paint();
    this.paintMessages();
    await this.transport.startNewSession(item.key);
    await this.refreshHistory();
    this.lastQuestion = question;
    this.paint();
  }

  /** 切换到历史会话 */
  private async switchSession(sessionId: string): Promise<void> {
    const item = this.item;
    if (!item) return;
    await this.transport.openSession(item.key, sessionId);
    await this.refreshHistory();
  }

  /** 刷新历史会话下拉框 */
  private async refreshHistory(): Promise<void> {
    const item = this.item;
    if (!item) return;
    const sessions = await this.transport.listWorkspaceSessions(item.key);
    const doc = this.doc;
    const options: HTMLOptionElement[] = [];
    const current = doc.createElement("option");
    current.value = this.state.sessionId ?? "";
    current.textContent = this.state.sessionId
      ? `当前 ${this.state.sessionId.slice(0, 12)}…`
      : "当前会话";
    options.push(current);
    for (const session of sessions) {
      if (session.sessionId === this.state.sessionId) continue;
      const option = doc.createElement("option");
      option.value = session.sessionId;
      const when = session.updatedAt
        ? new Date(session.updatedAt).toLocaleString()
        : "";
      option.textContent = `${session.running ? "● " : ""}${session.sessionId.slice(0, 12)}… ${when}`;
      options.push(option);
    }
    this.historySelect.replaceChildren(...options);
  }

  /** 准备论文工作区并确保会话就绪 */
  private async prepare(): Promise<void> {
    const item = this.item;
    if (!item) return;
    // 等会话映射加载完，否则会把已有会话当成新会话
    await this.mappingReady;
    const ref = this.resolveRef(item);
    if (!ref) {
      this.appendLocalNotice(
        "未能定位到文献父条目（可能是独立附件），将仅使用元数据对话。",
        "warn",
      );
      return;
    }

    this.lastMetadataText = buildMetadataText(item);
    const files = await this.ensureFiles(item, ref);
    if (files?.noTextLayer) {
      this.appendLocalNotice(
        "该 PDF 没有可提取的文字层（可能是扫描件），将只用元数据与摘要对话。",
        "warn",
      );
    }
    await this.transport.ensureSession(ref.key);
    await this.refreshHistory();
  }

  private async send(): Promise<void> {
    const question = this.inputEl.value.trim();
    if (!question || !canSend(this.state)) return;
    if (!this.item) return;

    // 首次发送前确认（隐私开关）
    if (getPref("confirmFirstSend" as never) && !this.firstSendConfirmed) {
      this.firstSendConfirmed = true;
      const ok = this.confirm(
        "将把该文献的元数据与全文（写入本机 dsh 工作区）交给本机运行的 dsh Agent 处理。\n内容不会离开本机。是否继续？",
      );
      if (!ok) {
        this.firstSendConfirmed = false;
        return;
      }
    }

    this.inputEl.value = "";
    await this.askQuestion(question);
  }

  private firstSendConfirmed = false;

  private confirm(message: string): boolean {
    try {
      const win = Zotero.getMainWindow() as unknown as {
        confirm?: (m: string) => boolean;
      };
      if (typeof win?.confirm === "function") return win.confirm(message);
    } catch {
      // 退回默认同意（失败时不应阻断使用，但会在日志里留痕）
    }
    ztoolkit.log("[DSH] 无法弹出确认框，按同意处理");
    return true;
  }

  private appendLocalNotice(
    text: string,
    level: "info" | "warn" | "error",
  ): void {
    // 本地提示（不经过传输层）：直接塞进状态机的消息列表
    this.state = {
      ...this.state,
      messages: [
        ...this.state.messages,
        {
          id: `local-${this.state.messages.length}-${text.length}`,
          role: "notice",
          blocks: [{ index: 0, blockType: "text", text, done: true }],
          level,
          createdAt: Date.now(),
        },
      ],
    };
    this.paintMessages();
  }

  dispose(): void {
    this.unregisterSelectionSink?.();
    this.unregisterSelectionSink = undefined;
    // ⚠️ 必须停掉 harness 复查定时器：面板销毁后它还会触发，
    // 那时既没有人要这个结果，回调里还会去碰已经拆掉的 DOM。
    this.clearHarnessRecheck();
    this.transport.dispose();
    this.body.replaceChildren();
  }

  // ── 条目解析与会话映射 ─────────────────────────────────

  private resolveRef(item: Zotero.Item): PaperItemRef | undefined {
    const libraryID = item.libraryID;
    // 附件 → 父条目
    const parentID = (item as unknown as { parentItemID?: number | false })
      .parentItemID;
    const owner = parentID ? Zotero.Items.get(parentID) : item;
    if (!owner) return undefined;
    return {
      itemID: owner.id,
      libraryID,
      key: owner.key,
      attachmentID: item.isPDFAttachment?.() ? item.id : undefined,
    };
  }

  private workspaceDirFor(_itemKey: string): string {
    try {
      return requireRuntimeConfig().workspaceRoot;
    } catch {
      return "";
    }
  }

  private sessionMapPath(): string {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "dsh-for-zotero",
      "sessions.json",
    );
  }

  private readSessionMap(): SessionStore {
    if (sessionStoreCache) return sessionStoreCache;
    sessionStoreCache = {};
    return sessionStoreCache;
  }

  /**
   * 从磁盘加载一次映射（异步，失败则用空表）。
   * 注意：`readSessionMap()` 是同步读取，必须等这里完成后才有数据；
   * `prepare()` 会 `await mappingReady`。
   */
  async loadSessionMap(): Promise<void> {
    try {
      const path = this.sessionMapPath();
      if (await IOUtils.exists(path)) {
        const text = await IOUtils.readUTF8(path);
        const parsed = JSON.parse(text) as SessionStore;
        if (parsed && typeof parsed === "object") sessionStoreCache = parsed;
      }
    } catch (error) {
      ztoolkit.log("[DSH] 读取会话映射失败，将重建", error);
    }
  }

  private writeSessionMap(itemKey: string, sessionId: string): void {
    const map = this.readSessionMap();
    map[itemKey] = sessionId;
    void this.persistSessionMap();
  }

  private async persistSessionMap(): Promise<void> {
    try {
      const path = this.sessionMapPath();
      const parent = PathUtils.parent(path);
      if (!parent) throw new Error(`无法确定目录：${path}`);
      await IOUtils.makeDirectory(parent, {
        ignoreExisting: true,
        createAncestors: true,
      });
      // ⚠️ 不要用"临时文件 + `IOUtils.move`"。
      //
      // 本项目已**实测 `IOUtils.move` 会抛 `NotFoundError: Could not move`**
      // （见 sessionPane.ts 的 writeToolResult 说明：那处失败导致 Agent 永远等不到
      // 工具返回值、会话表现为卡住）。同一台机器上这里也一样会失败 ——
      // 而失败被下面的 catch 吞掉，表现为**会话映射静默保存不上**。
      //
      // 直接覆盖写：单次 writeUTF8 在实践中足够，而且"写不进去"的代价远大于
      // "理论上可能读到半截"。
      await IOUtils.writeUTF8(
        path,
        JSON.stringify(this.readSessionMap(), null, 2),
      );
    } catch (error) {
      ztoolkit.log("[DSH] 保存会话映射失败", error);
    }
  }
}
