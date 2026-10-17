/**
 * 会话窗口的逻辑。
 *
 * ## 与插件主世界的接口（设计修正）
 *
 * 页面在 `chrome://` 里跑，拿不到插件的 TS 模块。最初尝试通过 `window.arguments[0]`
 * 直接传 `getHistory` / `ask` 两个异步函数 —— **不可靠**：`openDialog` 的参数要跨越
 * chrome 窗口边界，函数不保证能过去；传不过去时页面只会静默什么都不做，
 * 表现就是"永远停在正在载入…"且没有任何错误。
 *
 * 现在改为：arguments 里只放一个 **handle 字符串**，能力存在
 * `Zotero.DSHForZoteroSessions`（主世界注册的全局注册表）里，页面按 handle 取。
 * 字符串跨边界一定安全。
 *
 * 安全：所有文本用 textContent 写入，不拼 HTML（历史里可能含论文原文与模型输出）。
 */

/* global document, window, Zotero */

(function () {
  "use strict";

  // ── Markdown 渲染 ────────────────────────────────────────
  //
  // 模型的回答是 Markdown，先前一律用 textContent 原样显示，于是界面里满是
  // `###`、`**`、`|---|` 符号。这里把它渲染成 HTML。
  //
  // ## 安全模型（与 src/notes/writeback.ts 的 markdownToHtml 一致，有意为之）
  //
  // **先把整段文本转义，再只插入我们自己生成的标签。**
  // 因此即便论文原文或模型输出里含 `<script>`、`<img onerror=…>`，
  // 最终 HTML 里也不会出现可执行的标签 —— 这是能安全使用 innerHTML 的前提。
  //
  // 链接只允许 http/https，挡掉 `javascript:` 之类的注入。
  //
  // ## 为什么内联一份而不是跨边界调用插件的渲染器
  //
  // 页面与插件分处不同隔间，只能经 `Zotero.DSHForZoteroSessions` 传函数，
  // 而那是**异步**的：每条消息都要等一次往返，流式输出时会明显卡顿。
  // 渲染纯函数内联在这里，同源同步执行，且渲染逻辑与插件那份规则一致。
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** 行内 Markdown → HTML；输入先整体转义 */
  function renderInline(text) {
    var out = escapeHtml(text);
    /**
     * 行内代码优先：内容单独存起来、渲染完再放回（NUL 哨兵占位符），
     * 这样代码里的 `**`、`*`、`_` 不会被后续规则再处理。
     *
     * ⚠️ 这里曾写着「writeback.ts 那份实现有个既有局限：代码内容会被
     * 粗体/斜体规则再处理；这里在放回时再次转义，避免同样的问题」——
     * **那句话是错的**。写共享夹具时实测了两份实现：
     *
     * ```text
     *   输入  a **bold** and `b**c`
     *   两边都得到  a <strong>bold</strong> and <code>b**c</code>
     * ```
     *
     * 两份都用 NUL 哨兵，**都不会**再处理代码内容；差别只在块级包装
     * （笔记那份会包 `<p>`，这一份只产出行内片段）。
     * 实测结论与用例在 `test/unit/markdown.fixtures.mjs`，
     * 两条 `CASES` 会把任何一份的退化变成红灯。
     *
     * 教训：**"另一份实现有局限"这种跨文件的断言，必须实测**。
     * 它读起来像经验，实际只是当时没有验证的猜测，而且会误导后来者去"修"已经好的代码。
     */
    var codes = [];
    out = out.replace(/`([^`]+)`/g, function (_m, code) {
      codes.push(code);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    // 链接：只允许 http/https
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      function (_m, label, href) {
        return (
          '<a href="' +
          href +
          '" target="_blank" rel="noreferrer">' +
          label +
          "</a>"
        );
      },
    );
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // 代码块先被抽出、用 NUL 包裹的占位符替代，渲染完再塞回 —— 否则代码块里的
    // `**`、`#` 会被当作 Markdown 记号。NUL 不会出现在用户输入或论文正文里，
    // 是刻意的哨兵值，故豁免该规则（豁免写在同一行，避免 prettier 排版后失效）。
    out = out.replace(
      /\u0000C(\d+)\u0000/g /* eslint-disable-line no-control-regex */,
      function (_m, i) {
        return "<code>" + escapeHtml(codes[Number(i)]) + "</code>";
      },
    );
    return out;
  }

  /** 表格分隔行，如 `|---|:--:|` */
  function isTableDivider(line) {
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf("-") >= 0;
  }

  function tableCells(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(function (cell) {
        return cell.trim();
      });
  }

  /**
   * 块级 Markdown → HTML。
   * 支持：代码围栏、标题、引用、有序/无序列表、表格、分隔线、段落。
   */
  function renderMarkdown(markdown) {
    var lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
    var html = [];
    var listTag;
    var paragraph = [];

    function closeList() {
      if (listTag) {
        html.push("</" + listTag + ">");
        listTag = undefined;
      }
    }
    function closeParagraph() {
      if (paragraph.length > 0) {
        html.push("<p>" + renderInline(paragraph.join(" ")) + "</p>");
        paragraph = [];
      }
    }
    function openList(tag) {
      if (listTag !== tag) {
        closeList();
        html.push("<" + tag + ">");
        listTag = tag;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // 代码围栏：内容整段转义，不做任何行内替换
      var fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        closeParagraph();
        closeList();
        var body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        html.push(
          '<pre class="dsh-code"' +
            (fence[1] ? ' data-lang="' + escapeHtml(fence[1]) + '"' : "") +
            "><code>" +
            escapeHtml(body.join("\n")) +
            "</code></pre>",
        );
        continue;
      }

      if (!line.trim()) {
        closeParagraph();
        closeList();
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        closeParagraph();
        closeList();
        html.push("<hr/>");
        continue;
      }

      // 标题
      var heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeParagraph();
        closeList();
        var level = heading[1].length;
        html.push(
          "<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">",
        );
        continue;
      }

      // 表格：当前行含 | 且下一行是分隔行
      if (
        line.indexOf("|") >= 0 &&
        i + 1 < lines.length &&
        isTableDivider(lines[i + 1])
      ) {
        closeParagraph();
        closeList();
        var header = tableCells(line);
        i += 2; // 跳过表头与分隔行
        var rows = [];
        while (
          i < lines.length &&
          lines[i].indexOf("|") >= 0 &&
          lines[i].trim()
        ) {
          rows.push(tableCells(lines[i]));
          i++;
        }
        i--; // 外层循环还会 +1
        var table = ['<table class="dsh-table"><thead><tr>'];
        for (var h = 0; h < header.length; h++) {
          table.push("<th>" + renderInline(header[h]) + "</th>");
        }
        table.push("</tr></thead><tbody>");
        for (var r = 0; r < rows.length; r++) {
          table.push("<tr>");
          for (var c = 0; c < rows[r].length; c++) {
            table.push("<td>" + renderInline(rows[r][c]) + "</td>");
          }
          table.push("</tr>");
        }
        table.push("</tbody></table>");
        html.push(table.join(""));
        continue;
      }

      // 引用
      var quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        closeParagraph();
        closeList();
        html.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
        continue;
      }

      // 无序列表
      var bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        closeParagraph();
        openList("ul");
        html.push("<li>" + renderInline(bullet[1]) + "</li>");
        continue;
      }

      // 有序列表
      var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        closeParagraph();
        openList("ol");
        html.push("<li>" + renderInline(ordered[1]) + "</li>");
        continue;
      }

      paragraph.push(line.trim());
    }

    closeParagraph();
    closeList();
    return html.join("");
  }

  // ── 待确认列表的**纯判断**（放在 DOM 分界点之前，便于单测）──────
  //
  // ⚠️ 这几条判断刻意放在文件头部：本文件用 `var` + 函数声明，
  // 头部没有 DOM 依赖，所以测试能用 `vm` **真正执行**它们（见 sessionRender.test.mjs）。
  // 我先前只有"读源码做字符串匹配"的守卫，而那种写法出过**假通过**
  // （断言能匹配两处中的任意一处，改坏其中一处时测试依然是绿的）——
  // 能真正执行并断言行为的测试才靠得住。

  /**
   * 一键确认的进行状态。
   *
   * 放在这里而不是 DOM 区：**重建 DOM 不能让它丢**，而重建本身也会读它。
   * `{ total, done, running, results: [文本], startedAt }`，未开始时为 null。
   */
  var batchConfirm = null;

  /** 取某条待确认项的**稳定标识**（op + key），供批量循环定位 */
  function pendingItemKey(it) {
    if (!it) return "";
    // ⚠️ **优先用插件给的 uid**。
    //
    // 先前这里只算 `op + 第一个 key`，而 `createItem` 没有 key
    // （keys 是空数组）→ 每一条新建都算出同一个
    // `"createItem:"`，而插件发的是另一个值（且它随下标变）。
    // 两边永远不相等 → 批量循环把**每一条新建都跳过**，一条都不建。
    //
    // uid 是登记时分配的、与列表位置无关的身份，两边都用它才能对上。
    // 留着旧算法作为**兼容旧插件**的回退（那时签名里没有 uid）。
    if (typeof it.uid === "string" && it.uid) return it.uid;
    var k = (it.keys && it.keys[0]) || "";
    return (it.op || "") + ":" + k;
  }

  /**
   * 在**当前**列表里按 key 找下标；找不到返回 -1。
   *
   * ## 为什么必须按 key 而不是按下标（真机缺陷）
   *
   * 每确认一条，插件那边就 `splice` 掉一项，**所有后续下标前移一位**。
   * 批量循环若按旧下标推进，第二遍就会点到**别的条目**上 ——
   * 对删除与新建来说，操作错条目远比不操作糟糕。
   *
   * 抽成纯函数是为了能测：它只依赖"一个数组 + 一个 key"。
   */
  function pendingIndexOf(list, key) {
    var arr = list || [];
    for (var i = 0; i < arr.length; i += 1) {
      if (pendingItemKey(arr[i]) === key) return i;
    }
    return -1;
  }

  /**
   * 批次进行中时，是否应当**拒绝**列表上的其它动作（忽略 / 单条确认）。
   *
   * ## ⚠️ 这是我自查时发现的竞态（用户问"列表新写会出 bug 吗"）
   *
   * 批量确认期间列表仍会重画，而"忽略"按钮是**按当时的下标**闭包捕获的
   * （`capability.dismissDeletion(index)`）—— 下标在批次推进中会变，
   * 于是用户点"忽略"很可能忽略掉**另一条**。
   *
   * 与"一键确认点两次"是同一个病：**用会变的下标去指代一项**。
   * 所以批次进行时把这些动作一并挡住，并告诉用户原因，而不是静默做错事。
   */
  function batchBlocksAction() {
    return !!(batchConfirm && batchConfirm.running);
  }

  var messages = document.getElementById("messages");
  var titleEl = document.getElementById("title");
  var metaEl = document.getElementById("meta");
  var input = document.getElementById("input");
  var send = document.getElementById("send");

  function fatal(text) {
    messages.textContent = text;
    messages.style.whiteSpace = "pre-wrap";
    messages.style.color = "#b91c1c";
    if (input) input.disabled = true;
    if (send) send.disabled = true;
  }

  // ── 取能力 ────────────────────────────────────────────────
  //
  // ⚠️ 本窗口**没有 `Zotero` 全局**（实测诊断输出 `Zotero=无`）：它是独立的 chrome
  // 窗口，加载的是插件自己的 chrome:// 页面，不继承主窗口的全局，也没有加载任何
  // 定义 Zotero 的脚本。因此不能把能力挂在 `Zotero` 上让页面来取。
  //
  // 打开方（sessionPane）在 `openDialog` 返回后，把能力**直接绑在窗口对象的属性上**
  // （见 DIALOG_CAPABILITY_KEY）。绑定发生在窗口加载之后，所以这里要轮询等待。
  var CAPABILITY_KEY = "DSHForZoteroSession";
  var capability;
  var waited = 0;

  /** 从 URL 里取会话 id（内置查看器打开时会带 `?session=<id>`） */
  function sessionIdFromUrl() {
    try {
      var match = /[?&]session=([^&#]+)/.exec(window.location.href);
      return match ? decodeURIComponent(match[1]) : undefined;
    } catch {
      // URL 解析失败是正常情况（例如手工打开页面、没有 session 参数），
      // 不需要记日志 —— 用可选 catch 绑定，别留一个没用到的变量。
      return undefined;
    }
  }

  /**
   * 通过 `Zotero.DSHForZoteroSessions` 构造能力对象。
   *
   * 这条路用于**内置查看器**打开的场合（条目附件双击）：Zotero 对 `chrome://` URL
   * 走 `Zotero.openInViewer()`，不会有 openDialog 的属性注入，因此能力改由
   * 「全局入口 + URL 里的会话 id」提供。页面加载了 include.js，所以有 `Zotero`。
   *
   * ⚠️ 名字**不是** `Zotero.DSHForZotero` —— 那个名字归插件实例（含 hooks）。
   */
  function capabilityFromGlobal() {
    var sessionId = sessionIdFromUrl();
    if (!sessionId) return undefined;
    var api;
    try {
      api = typeof Zotero !== "undefined" && Zotero.DSHForZoteroSessions;
    } catch (error) {
      // ⚠️ 这里失败意味着**宿主注入有问题**（不是"正常没有"），必须留下痕迹：
      // 早先这里静默吞掉异常，于是"能力接口不可用"表现为一个没有任何线索的
      // 空状态，排查时只能靠猜。
      console.error("[DSH] 读取 Zotero.DSHForZoteroSessions 失败：", error);
      api = undefined;
    }
    if (!api || typeof api.getHistory !== "function") return undefined;
    return {
      sessionId: sessionId,
      // 标题等靠 describe() 异步补齐
      getHistory: function () {
        return api.getHistory(sessionId);
      },
      listWorkspaceFiles: function () {
        return api.listWorkspaceFiles(sessionId);
      },
      // onDelta 让界面**边生成边显示**：不传的话整段回答只在轮次结束时一次性出现，
      // 而 Agent 中途问"选 A 还是 B"那句话就藏在那段时间里（真机反馈过）。
      // onQuestions 在 ask_user_question 出现时**立刻**给出问题与选项 ——
      // 模型此时正阻塞等待，等轮次结束才显示等于卡住。
      ask: function (text, onDelta, onQuestions) {
        return api.ask(sessionId, text, onDelta, onQuestions);
      },
      describe: function () {
        return api.describe(sessionId);
      },
      // ⚠️ 这里**必须逐个转接**全局 API 的方法。
      // 先前漏掉了 saveReplyAsNote —— 于是按钮拿到的是这个包装对象，
      // 而它上面永远没有该方法，判断必然失败并误报"插件代码是旧版本"。
      // （插件端的全局 API 一直有这个方法是好的，问题只在这层包装。）
      // 参数用**一个对象**：位置参数在页面/插件版本不一致时会静默错位（踩过）。
      saveReplyAsNote: function (question, answer) {
        return api.saveReplyAsNote({
          sessionId: sessionId,
          question: question,
          answer: answer,
        });
      },
      // 向进行中的轮次送入补充内容（回答 Agent 的提问）
      steer: function (text) {
        return api.steer(sessionId, text);
      },
      listPendingDeletions: function () {
        return api.listPendingDeletions();
      },
      confirmDeletion: function (index) {
        return api.confirmDeletion(index);
      },
      dismissDeletion: function (index) {
        return api.dismissDeletion(index);
      },
      // 一键确认全部（条目多时逐条点太麻烦）。
      // 插件侧从后往前处理，因为每次确认都会让后续下标前移。
      confirmAllDeletions: function () {
        return api.confirmAllDeletions();
      },
      /**
       * ⚠️ **逐条确认**用的两个原语（真机缺陷：一键确认会把条目操作两次）
       *
       * 旧做法是调 `confirmAllDeletions()` 让插件一口气跑完，界面只能干等 ——
       * 于是既**无法可靠禁用按钮**（列表每 2 秒重建，设在元素上的 disabled 被冲掉），
       * 也**看不到每项的结果**。现在由界面驱动循环，每步都能更新进度与结果；
       * 按钮的禁用由模块级 `batchConfirm.running` 决定，重建也保得住。
       *
       * `confirmDeletionAt` 多传一个 **key**：批量期间列表会变，
       * 插件据此校验"这个下标是不是我要的那一项"，不符就拒绝执行
       * （总比操作错条目好）。两者都做了**版本探测** —— 老插件没有它们时
       * 自动退回整批版，不会因为版本不匹配而完全不能用。
       */
      confirmAllDeletionsBegin: function () {
        return typeof api.confirmAllDeletionsBegin === "function"
          ? api.confirmAllDeletionsBegin()
          : null;
      },
      confirmDeletionAt: function (index, key) {
        return typeof api.confirmDeletionAt === "function"
          ? api.confirmDeletionAt(index, key)
          : api.confirmDeletion(index);
      },
      refreshWorkspace: function () {
        return api.refreshWorkspace(sessionId);
      },
      cancelTurn: function () {
        return api.cancelTurn(sessionId);
      },
      answerQuestions: function (questions, answers) {
        return api.answerQuestions(sessionId, questions, answers);
      },
      /**
       * 模型目录与"为这个会话选模型"。
       *
       * ## 为什么从设置页搬到这里
       *
       * 设置页只有**一个全局模型**，而实际使用里"这篇要精细推理、那篇只要
       * 概览"很常见。dsh 侧本来就支持逐会话选择（`session/selectModel`，
       * 内部 `selectForNextRequest` —— **对下一次请求生效**），
       * 所以同一个会话里也能逐轮次换。
       *
       * ⚠️ 两个都做**版本探测**：老插件没有这两个方法时，模型条整条不显示
       * （见 `renderModelBar`），而不是弹一个"能力不可用"。
       */
      getModelCatalog: function () {
        return typeof api.getModelCatalog === "function"
          ? api.getModelCatalog(sessionId)
          : null;
      },
      setSessionModel: function (choice) {
        return typeof api.setSessionModel === "function"
          ? api.setSessionModel(sessionId, choice)
          : null;
      },
    };
  }

  function tryGet() {
    try {
      var value = window[CAPABILITY_KEY];
      if (value && typeof value.getHistory === "function") return value;
    } catch {
      // 取不到就走全局入口 —— 这是**预期路径**（标签页/侧栏打开时本来就没有
      // 窗口级注入），不需要日志，也就不该留一个没用到的 error 变量。
    }
    return capabilityFromGlobal();
  }

  capability = tryGet();

  if (!capability) {
    // 轮询等待打开方注入（同源 chrome 窗口的属性赋值，绑定可能晚于脚本执行）
    fatal("正在连接会话…");
    var poll = setInterval(function () {
      waited += 100;
      var found = tryGet();
      if (found) {
        clearInterval(poll);
        capability = found;
        messages.textContent = "";
        messages.style.color = "";
        if (input) input.disabled = false;
        if (send) send.disabled = false;
        start();
        return;
      }
      if (waited >= 10000) {
        clearInterval(poll);
        fatal(
          "无法连接到会话（等待 10 秒仍未完成注入）。\n\n" +
            "请关闭本窗口，在「DSH 会话」面板里重新点一次「窗口」；" +
            "若反复出现，请查看设置里 DSH-for-Zotero 的运行时状态。",
        );
      }
    }, 100);
    return;
  }

  start();

  /** 拿到能力后正式开始 */
  function start() {
    titleEl.textContent = capability.title || "DSH 会话";
    metaEl.textContent = [
      capability.scopeTitle,
      capability.scopeKind === "item" ? "条目会话" : "独立会话",
    ]
      .filter(Boolean)
      .join(" · ");

    // ── 工作区与材料 ─────────────────────────────────────────
    //
    // 官方 dsh web 无法绑定到某条会话（实测 URL 参数被忽略、前端没有任何路由），
    // 所以"这条会话在哪个目录、有哪些材料"只能在这里体现。
    // 这既是给用户的确认，也是 Agent 实际工作目录的凭据。
    var workspacePathEl = document.getElementById("workspace-path");
    var workspaceFilesEl = document.getElementById("workspace-files");
    /** 「补充说明」按钮：生成期间可用，把内容 steer 进当前轮 */
    var steerBtn = document.getElementById("steer");
    if (steerBtn) steerBtn.addEventListener("click", submitSteer);
    /** 待确认删除区（默认隐藏，有请求时才显示） */
    var pendingEl = document.getElementById("pending-deletions");

    /**
     * 「模型 / 推理强度」条。
     *
     * ## 为什么在会话页而不是设置页
     *
     * 设置页只有一个全局值，而"这篇要精细推理、那篇只要概览"很常见。
     * dsh 的 `session/selectModel` 内部是 `selectForNextRequest` ——
     * **对下一次请求生效**，所以这里改完立刻作用于下一轮，不必新建会话。
     *
     * ## 三条实现纪律
     *
     * 1. **老插件整条隐藏**：没有 `getModelCatalog` 就 `display:none`，
     *    而不是显示一个点了报"能力不可用"的控件（真机上那种控件很误导）。
     * 2. **选项只来自宿主目录**：写死的选项会在模型/等级变化后给出宿主
     *    根本不接受的取值，而失败是**静默的**。
     * 3. **改完要说清影响面**：宿主还会把这次选择存成**全局默认**
     *    （`agentDefaultModel.saveSelection`），所以之后新建的会话也用它。
     *    不说清楚，用户会以为"只影响本会话"。
     */
    var modelBarEl = document.getElementById("model-bar");
    var modelSelectEl = document.getElementById("model-select");
    var effortSelectEl = document.getElementById("effort-select");
    var modelNoteEl = document.getElementById("model-note");

    /** 目录里的模型按 `provider/model` 编成一个扁平键，选项值就用它 */
    var modelIndex = {};

    function modelKey(provider, model) {
      return provider + "\u0000" + model;
    }

    function fillEffortSelect(provider, model, wanted) {
      if (!effortSelectEl) return;
      var entry = modelIndex[modelKey(provider, model)];
      var efforts = (entry && entry.reasoning && entry.reasoning.efforts) || [];
      effortSelectEl.textContent = "";
      // 空值 = 用模型默认等级（此时**不传** reasoningEffort 给宿主 ——
      // 传空串会被当成无效的 ReasoningEffortId）
      var def = document.createElement("option");
      def.value = "";
      def.textContent = "默认" + (efforts.length ? "" : "（该模型不支持调整）");
      effortSelectEl.appendChild(def);
      efforts.forEach(function (effort) {
        var opt = document.createElement("option");
        opt.value = effort.id;
        opt.textContent = String(effort.name || effort.id);
        if (effort.description) opt.title = effort.description;
        effortSelectEl.appendChild(opt);
      });
      effortSelectEl.value = wanted || "";
      effortSelectEl.disabled = efforts.length === 0;
    }

    function applyModelChoice() {
      if (!modelSelectEl) return Promise.resolve();
      var raw = modelSelectEl.value;
      var sep = raw.indexOf("\u0000");
      var provider = sep >= 0 ? raw.slice(0, sep) : "";
      var model = sep >= 0 ? raw.slice(sep + 1) : "";
      var effort = effortSelectEl ? effortSelectEl.value : "";
      if (!provider || !model) return Promise.resolve();
      if (modelNoteEl) modelNoteEl.textContent = "正在应用…";
      return Promise.resolve(
        capability.setSessionModel({
          provider: provider,
          model: model,
          reasoningEffort: effort || undefined,
        }),
      )
        .then(function (result) {
          if (modelNoteEl) {
            modelNoteEl.textContent = result
              ? "已生效（下一轮起）"
              : "插件版本较旧，未能应用";
          }
        })
        .catch(function (error) {
          if (modelNoteEl) {
            modelNoteEl.textContent =
              "应用失败：" + String((error && error.message) || error);
          }
        });
    }

    function renderModelBar() {
      if (!modelBarEl || !modelSelectEl) return;
      if (typeof capability.getModelCatalog !== "function") return; // 老插件：保持隐藏
      Promise.resolve(capability.getModelCatalog())
        .then(function (catalog) {
          if (!catalog || !catalog.groups) return; // 拿不到就保持隐藏
          modelIndex = {};
          modelSelectEl.textContent = "";
          catalog.groups.forEach(function (group) {
            (group.models || []).forEach(function (model) {
              modelIndex[modelKey(group.id, model.id)] = model;
              var opt = document.createElement("option");
              opt.value = modelKey(group.id, model.id);
              opt.textContent =
                String(group.name || group.id) +
                " · " +
                String(model.name || model.id);
              modelSelectEl.appendChild(opt);
            });
          });
          if (!modelSelectEl.options.length) return;
          // 预选：会话记录里的选择 → 否则宿主的默认 → 否则第一项
          var chosen = catalog["会话已选"] || {};
          var fallback = catalog.default || {};
          var wantKey =
            chosen.provider && chosen.model
              ? modelKey(chosen.provider, chosen.model)
              : fallback.provider && fallback.model
                ? modelKey(fallback.provider, fallback.model)
                : modelSelectEl.options[0].value;
          modelSelectEl.value = wantKey;
          var sel = modelIndex[wantKey];
          if (sel) {
            var sep = wantKey.indexOf("\u0000");
            fillEffortSelect(
              wantKey.slice(0, sep),
              wantKey.slice(sep + 1),
              chosen.reasoningEffort ||
                (sel.reasoning && sel.reasoning.defaultEffort) ||
                "",
            );
          }
          modelBarEl.style.display = "flex";
          if (modelNoteEl) {
            modelNoteEl.textContent = "改动对下一轮生效";
          }
        })
        .catch(function () {
          // 取不到目录就保持隐藏 —— 这是增强，不是主流程
        });
    }

    if (modelSelectEl) {
      modelSelectEl.addEventListener("change", function () {
        var sep = modelSelectEl.value.indexOf("\u0000");
        var provider = modelSelectEl.value.slice(0, sep);
        var model = modelSelectEl.value.slice(sep + 1);
        var entry = modelIndex[modelSelectEl.value];
        fillEffortSelect(
          provider,
          model,
          (entry && entry.reasoning && entry.reasoning.defaultEffort) || "",
        );
        void applyModelChoice();
      });
    }
    if (effortSelectEl) {
      effortSelectEl.addEventListener("change", function () {
        void applyModelChoice();
      });
    }
    renderModelBar();

    /**
     * ⚠️ **一键确认的进行状态（真机缺陷：按钮提前恢复可点→条目被操作两次）**
     *
     * 用户反馈："一键确认时，因为执行需要时间，按钮会在先前条目
     * 操作完成前恢复可点击；若用户再次点击会**二次操作**条目。"
     *
     * 根因：按钮的 `disabled` 设在**元素**上，而下面那个
     * `setInterval(renderPendingDeletions, 2000)` **每 2 秒重建一次 DOM** ——
     * 重建后是**新的按钮**，可点状态就回来了。
     *
     * 所以状态必须放在**模块级变量**里：重建后从它恢复。
     * 同时把进度与每条结果也存在这里，
     * 所以重建不会把它们抹掉。
     */
    // 状态与纯判断已移到文件头部（便于单测）。

    /**
     * 逐条驱动一键确认（而不是丢给插件一口气跑完）。
     *
     * 为什么由界面驱动：
     *  - 每条完成后能**立刻更新进度与结果**（用户反馈"没看到每项结果"）；
     *  - 禁用状态由 `batchConfirm.running` 决定，重建 DOM 也不会丢；
     *  - 循环**每次重新取列表并按 key 定位**，不依赖会变的下标。
     */
    /**
     * 渲染"一键确认"的进度与**逐条结果**。
     *
     * 真机反馈："这次我没看到每项条目操作的结果" ——
     * 旧做法只在全部跑完后报一句"已确认 N/M 项"，
     * 中间过程与逐条成败都看不到。
     *
     * 现在每条完成都会刷新这一块：
     * 进度在上，每条的结果逐行列在下。
     */
    function renderBatchProgress(target) {
      if (!batchConfirm) return null;
      // 算出哪些是批量开工后才出现的（不在 snapshot 里）。
      // 只在**已结束**时算：运行中直接显示进度就够了，
      // 每条都去拉一次列表只会白增 RPC。
      var extraCount = -1;
      if (!batchConfirm.running && batchConfirm.snapshot) {
        extraCount = (batchConfirm.lastLive || []).filter(function (it) {
          return batchConfirm.snapshot.indexOf(pendingItemKey(it)) < 0;
        }).length;
      }
      var box = document.createElement("div");
      box.style.cssText =
        "margin:6px 0;padding:6px 8px;background:" +
        (batchConfirm.running ? "#fef3c7" : "#ecfdf5") +
        ";border:1px solid " +
        (batchConfirm.running ? "#fcd34d" : "#a7f3d0") +
        ";border-radius:5px;font-size:12px";
      var head = document.createElement("div");
      head.style.cssText = "font-weight:600";
      head.textContent = batchConfirm.running
        ? "正在逐条确认…（" +
          batchConfirm.done +
          "/" +
          batchConfirm.total +
          "）—— 请勿重复点击"
        : "一键确认完成：" +
          batchConfirm.total +
          " 项（成功 " +
          batchConfirm.results.filter(function (r) {
            return r && r.indexOf("失败") !== 0 && r.indexOf("跳过") !== 0;
          }).length +
          "）";
      box.appendChild(head);
      batchConfirm.results.forEach(function (r, i) {
        var line = document.createElement("div");
        line.style.cssText = "margin-top:2px;color:#374151";
        line.textContent = i + 1 + ". " + r;
        box.appendChild(line);
      });
      if (batchConfirm.running) {
        var hint = document.createElement("div");
        hint.style.cssText = "margin-top:4px;color:#92400e";
        hint.textContent =
          "每条完成后立即出现在这里；未完成前按钮不会恢复可点。";
        box.appendChild(hint);
      } else if (extraCount > 0) {
        // ⚠️ 批量开工**之后**才出现的条目不在本次范围内。
        // 必须明说，否则用户会以为"全部确认"漏了它们；
        // 而界面不在这里擅自把它们也确认掉——
        // 用户点的是"全部确认（N 项）"，N 就该是实际处理的数量。
        var extra = document.createElement("div");
        extra.style.cssText = "margin-top:4px;color:#92400e";
        extra.textContent =
          "注意：确认过程中列表里又新出现了 " +
          extraCount +
          " 项（agent 又提交了改动）。" +
          "它们**不在本次范围内**，需单独确认。";
        box.appendChild(extra);
      }
      if (target) target.appendChild(box);
      return box;
    }

    function runBatchConfirm(items) {
      if (batchConfirm && batchConfirm.running) return;
      var wanted = (items || []).map(pendingItemKey);
      // 问插件拿一份**权威的 key 快照**（界面自己算的只能算备用）。
      // 旧插件没有这个方法 → 返回 null → 继续用界面算的，不会因版本不匹配而不能用。
      try {
        var snapshot = capability.confirmAllDeletionsBegin();
        if (snapshot && snapshot["项"] && snapshot["项"].length) {
          wanted = snapshot["项"].map(function (it) {
            return it.key;
          });
        }
      } catch {
        // 拿不到快照就用界面自己算的 key —— 旧版插件没有那个方法时走这里。
        // 用无参 `catch`：带个不用的变量名会被 lint 判为未使用。
      }
      batchConfirm = {
        total: wanted.length,
        done: 0,
        running: true,
        results: [],
        startedAt: Date.now(),
        // 开工时的快照：界面用它算出"哪些是批量开工后**才出现**的"。
        // agent 在确认过程中可以继续往列表里写入，
        // 而那些**不在本次范围内** —— 不标出来，
        // 用户会以为"全部确认"漏了东西。
        snapshot: wanted.slice(),
      };
      renderPendingDeletions();

      var chain = Promise.resolve();
      wanted.forEach(function (want) {
        chain = chain.then(function () {
          return Promise.resolve()
            .then(function () {
              return capability.listPendingDeletions();
            })
            .then(function (live) {
              var idx = pendingIndexOf(live, want);
              if (idx < 0) {
                // 已不在列表里（别人已处理）—— 跳过，绝不猜一个下标
                batchConfirm.results.push("跳过（已不在列表）：" + want);
                return "";
              }
              // 传的是 **uid**（不是从 key 里拆出来的东西）——
              // 旧插件不认它时会忽略，行为与修复前一致。
              return capability.confirmDeletionAt(idx, want);
            })
            .then(function (report) {
              batchConfirm.done += 1;
              batchConfirm.results.push(report || "（无返回）");
              renderPendingDeletions();
            })
            .catch(function (error) {
              batchConfirm.done += 1;
              batchConfirm.results.push(
                "失败：" +
                  (error && error.message ? error.message : String(error)),
              );
              renderPendingDeletions();
            });
        });
      });

      chain.then(function () {
        batchConfirm.running = false;
        // 收尾前再取一次当前列表：用它算出"批量开工后**才出现**的条目"，
        // 好在结果里明确告诉用户它们不在本次范围内（否则看起来像漏做了）。
        Promise.resolve()
          .then(function () {
            return capability.listPendingDeletions();
          })
          .catch(function () {
            return [];
          })
          .then(function (live) {
            batchConfirm.lastLive = live || [];
            renderPendingDeletions();
            renderPendingInto(pendingEl);
          });
      });
    }
    /** 输入区容器：用于把"Agent 在等你"提示固定在输入框上方 */
    var composer = document.getElementById("composer");
    /** 「停止生成」按钮：卡住时的出路 */
    var stopBtn = document.getElementById("stop");
    /** 刷新材料按钮所在容器 */
    var refreshEl = document.getElementById("workspace-refresh");
    /** `ask_user_question` 的选项卡片容器 */
    var askEl = document.getElementById("ask-card");
    /** 顶部角标：有待确认改动时常驻可见 */
    var badgeEl = document.getElementById("pending-badge");
    /** 角标就地展开的内容容器（与主面板共用渲染逻辑） */
    var headerPendingEl = document.getElementById("pending-inline");
    /**
     * 待确认内容的"签名"（条数 + 每条的 op/keys/summary/时间）——
     * 用来判断**内容是否变了**，变了才重渲染就地面板。
     *
     * 为什么需要：就地面板只在点击那一刻渲染过一次，之后新来的请求不会出现，
     * 用户得"收起再展开"才看得到（真机反馈）。详见 `renderPendingInto` 顶部的说明。
     */
    var lastPendingSignature = "";

    /**
     * 从正文里判断 Agent 是不是在**问用户**。
     *
     * 为什么需要：Agent 常常在轮次中途停下来问"选 A 还是 B"，而这时轮次还没结束 ——
     * 用户如果不知道"它在等我"，就会一直等下去（真机反馈的正是这种卡住）。
     * 只做**保守**判断（结尾问号、或结尾是征询式句子），避免误报把人搞糊涂。
     */
    function looksLikeQuestion(text) {
      if (!text) return false;
      var trimmed = String(text).trim();
      // 话说到一半（结尾是冒号/逗号/顿号）→ 明确**不算**在问。
      // 真机反复出现的形态：先写「…会实质影响条目质量：」再逐条列选项；
      // 若在这里就提示"Agent 在等你"、而选项还没出来，用户会看到提示却看不到选项。
      if (/[：:，,、]\s*$/.test(trimmed)) return false;
      return /[？?]\s*$/.test(trimmed);
    }

    /**
     * 根据是否"在问用户"调整提示与按钮状态。
     *
     * 用两态而不是只改颜色：用户需要一眼看出"现在该我说话了"。
     */
    function setAwaitingInput(awaiting) {
      if (!steerBtn) return;
      steerBtn.textContent = awaiting ? "回答它（送入当前轮）" : "补充说明";
      steerBtn.style.fontWeight = awaiting ? "700" : "400";
      steerBtn.style.background = awaiting ? "#dbeafe" : "";
      if (awaiting) {
        // 提示固定在输入框上方 —— 先前塞进消息流里，会随内容滚走、也难以稳定清除
        if (!steerHint) {
          steerHint = document.createElement("div");
          steerHint.id = "steer-hint";
          steerHint.style.cssText =
            "color:#1d4ed8;font-size:12px;padding:4px 0;font-weight:600";
          composer.insertBefore(steerHint, composer.firstChild);
        }
        steerHint.textContent =
          "Agent 在等你回答 —— 在下面输入你的选择，然后点「回答它」";
      } else if (steerHint) {
        steerHint.remove();
        steerHint = null;
      }
    }

    var steerHint = null;

    /**
     * 取消正在进行的轮次，并**把界面恢复到可用状态**。
     *
     * 关键不只是发取消请求，而是让用户重新能操作 ——
     * 真机上"卡住"的表现就是按钮一直禁用、只能关窗口。
     */
    function stopGenerating() {
      var cap = capability;
      if (!cap || typeof cap.cancelTurn !== "function") {
        notice("无法取消：会话能力未就绪。");
        return;
      }
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.textContent = "取消中…";
      }
      Promise.resolve()
        .then(function () {
          return cap.cancelTurn();
        })
        .then(function () {
          notice("已请求取消本轮。");
        })
        .catch(function (error) {
          notice(
            "取消失败：" +
              (error && error.message ? error.message : String(error)),
          );
        })
        .then(function () {
          // 无论取消成功与否，界面都恢复可用：卡住时最要紧的是"能继续操作"
          setBusy(false);
          // 用户刚取消：这一轮已经结束，没必要再探
          stopRunningProbe();
          setAwaitingInput(false);
          // 轮次结束：收起提问卡片。用户已经回答过（或在回答别的）时，
          // 一张旧卡片留在这里只会让人以为还要再答一遍。
          clearAskCard();
          markTurnEnd();
          if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.textContent = "停止生成";
          }
        });
    }

    if (stopBtn) stopBtn.addEventListener("click", stopGenerating);

    /**
     * 生成期间把输入框内容作为**补充说明**送进当前轮。
     *
     * 与普通提问的区别：普通提问（queue）会排到本轮之后，用户会以为"发了没反应"；
     * Agent 中途提问时它其实在**等这一轮的输入**，所以必须用 steer。
     */
    function submitSteer() {
      var text = input.value.trim();
      if (!text) {
        notice("请先在输入框里写下你的选择或补充，再点「补充说明」。");
        return;
      }
      var cap = capability;
      if (!cap || typeof cap.steer !== "function") {
        notice("无法送入补充内容：会话能力未就绪。");
        return;
      }
      input.value = "";
      notice("正在把你的补充送入当前这一轮…");
      Promise.resolve()
        .then(function () {
          return cap.steer(text);
        })
        .then(function () {
          notice("已送入。Agent 会接着你给的选择继续。");
        })
        .catch(function (error) {
          notice(
            "送入失败：" +
              (error && error.message ? error.message : String(error)),
          );
        });
    }

    function renderWorkspace() {
      // 经全局入口打开时（条目附件双击），标题与工作区要用 describe() 补齐。
      // 放在这里而不是 start() 里：必须**先**取到 workspace 再渲染路径。
      if (typeof capability.describe === "function") {
        capability
          .describe()
          .then(function (info) {
            if (!info) {
              fatal(
                "找不到该会话的记录（可能已被删除）。请回到「DSH 会话」面板重新创建。",
              );
              return;
            }
            titleEl.textContent = info.title || titleEl.textContent;
            metaEl.textContent = [
              info.scopeTitle,
              info.scopeKind === "item" ? "条目会话" : "独立会话",
            ]
              .filter(Boolean)
              .join(" · ");
            capability.workspace = info.workspace;
            paintWorkspacePath();
            loadWorkspaceFiles();
          })
          .catch(function (error) {
            notice("读取会话信息失败：" + error);
            paintWorkspacePath();
            loadWorkspaceFiles();
          });
        return;
      }
      paintWorkspacePath();
      loadWorkspaceFiles();
    }

    function paintWorkspacePath() {
      if (!workspacePathEl) return;
      workspacePathEl.textContent = capability.workspace || "（未记录工作区）";
    }

    function loadWorkspaceFiles() {
      // `capability` 在注入完成前是 undefined —— 必须先判空，否则这一句就抛 TypeError
      if (!capability) return;
      if (
        !workspaceFilesEl ||
        typeof capability.listWorkspaceFiles !== "function"
      )
        return;
      workspaceFilesEl.textContent = "读取中…";
      capability
        .listWorkspaceFiles()
        .then(function (files) {
          if (!files || files.length === 0) {
            workspaceFilesEl.textContent =
              "（目录里还没有材料文件 —— 可能是该条目没有全文，或写入失败）";
            return;
          }
          files.sort(function (a, b) {
            return a.name < b.name ? -1 : 1;
          });
          var parts = files.map(function (f) {
            var size =
              f.size >= 1024
                ? Math.round(f.size / 1024) + " KB"
                : f.size + " B";
            return f.name + "（" + size + "）";
          });
          workspaceFilesEl.textContent = parts.join("、");
        })
        .catch(function (error) {
          workspaceFilesEl.textContent = "读取材料清单失败：" + error;
        });
    }

    /**
     * 待确认的删除请求。
     *
     * ## 为什么单独一块、且必须显式确认
     *
     * 用户选择的安全边界是"读+写自由，**仅删除需确认**"。删除不可逆，
     * 而 Agent 可以自主决定"要删什么" —— 所以执行权必须留在用户手里。
     *
     * Agent 提交删除时会拿到 `pending: true`（不是失败），它知道要等你确认。
     */
    function renderPendingDeletions() {
      if (!pendingEl) return;
      // ⚠️ 必须**先判空 capability 本身**。
      //
      // 真机反馈"角标点不开、看不到内容"：这一句原先是
      // `if (typeof capability.listPendingDeletions !== "function") return;` ——
      // 而 `capability` 在注入完成前是 undefined，**这一句自己就抛 TypeError**。
      // 下面的 try/catch 在 `.then()` 里，**管不到这个同步抛错**，
      // 于是每次调用都在这里崩掉、面板永远不渲染，而角标却能正常显示。
      if (!capability) return;
      if (
        typeof capability.listPendingDeletions !== "function" ||
        typeof capability.confirmDeletion !== "function"
      ) {
        return;
      }
      Promise.resolve()
        .then(function () {
          return capability.listPendingDeletions();
        })
        .then(function (items) {
          pendingEl.textContent = "";
          // ── 就地面板（角标展开的那块）也要跟着刷新 ──────────────
          //
          // ⚠️ 真机故障：清空后再有新请求时，角标数字会变、主面板会更新，
          // 但**就地展开的内容还是旧的**（它只在点击那一刻渲染过一次），
          // 用户必须"收起再展开"才能看到新内容。
          //
          // 修法：把当前内容算成一个**签名**（条数 + 每条的 op/key/summary），
          // 签名变了且面板正展开着，就重渲染它。用签名而不是"每次都重渲染"，
          // 是为了避免每秒重建 DOM —— 那会让正在点击的按钮失焦。
          var signature = (items || [])
            .map(function (it) {
              return [
                it.op,
                (it.keys || []).join("+"),
                it.summary || "",
                it.requestedAt || "",
              ].join(":");
            })
            .join("|");
          var expanded =
            headerPendingEl && headerPendingEl.style.display !== "none";
          if (expanded && signature !== lastPendingSignature) {
            renderPendingInto(headerPendingEl);
          }
          lastPendingSignature = signature;

          if (!items || items.length === 0) {
            pendingEl.style.display = "none";
            renderPendingBadge(0);
            return;
          }
          renderPendingBadge(items.length);
          pendingEl.style.display = "";
          // ⚠️ 标题必须按**实际请求**分类，不能写死"删除"。
          // 分类与配色都在 describePendingHead 里 —— 抽出去是因为
          // 就地展开那份原先"照抄一遍"，而抄漏过一次文案（见那里的真机故障）。
          var headInfo = describePendingHead(items);
          var isCreate = headInfo.isCreate;
          var deleteCount = headInfo.deleteCount;
          var headText = headInfo.text;
          head.textContent = headText;
          head.style.color = headInfo.color;
          pendingEl.appendChild(head);

          // ── 一键确认（与就地面板同一功能；条目多时逐条点太麻烦）──
          // 只在两项以上时出现：只有一条时它不比单条确认更省事。
          if (
            items.length > 1 &&
            typeof capability.confirmAllDeletions === "function"
          ) {
            var allRow0 = document.createElement("div");
            allRow0.style.cssText =
              "margin:6px 0 8px;padding:6px 8px;background:#eff6ff;" +
              "border:1px solid #bfdbfe;border-radius:5px";
            var allBtn0 = document.createElement("button");
            allBtn0.type = "button";
            allBtn0.textContent = "全部确认（" + items.length + " 项）";
            allBtn0.style.cssText =
              "font-weight:600;padding:3px 12px;cursor:pointer";
            // ⚠️ 禁用状态**从 batchConfirm 恢复**，不是设在元素上。
            // 这个列表每 2 秒重建一次，设在元素上的 disabled
            // 会随着重建而消失 —— 那正是"按钮提前恢复可点"的成因。
            if (batchConfirm && batchConfirm.running) {
              allBtn0.disabled = true;
              allBtn0.textContent =
                "正在全部确认…（" +
                batchConfirm.done +
                "/" +
                batchConfirm.total +
                "）";
            }
            allBtn0.addEventListener("click", function () {
              if (batchConfirm && batchConfirm.running) return;
              // 批量且含删除时不可逆 —— 必须先让用户明确一次
              if (
                !window.confirm(
                  "将一次性确认全部 " +
                    items.length +
                    " 项改动，其中删除不可撤销。确定继续吗？",
                )
              ) {
                return;
              }
              runBatchConfirm(items);
            });
            allRow0.appendChild(allBtn0);
            var allHint0 = document.createElement("span");
            allHint0.style.cssText =
              "margin-left:8px;color:#6b7280;font-size:12px";
            allHint0.textContent =
              deleteCount > 0
                ? "含删除 —— 确认前请核对上面每一项"
                : "新建类操作，仍会进 Zotero 撤销栈";
            allRow0.appendChild(allHint0);
            pendingEl.appendChild(allRow0);
          }

          items.forEach(function (item, index) {
            var row = document.createElement("div");
            // 每条之间留出分隔：先前四条挤成一坨，用户分不清有几项
            row.style.cssText =
              "margin:6px 0;font-size:12px;padding:4px 0;border-top:1px solid #fecaca";
            var label = document.createElement("div");
            // 新建条目必须显示**将要建什么**（摘要）——
            // 只显示 op 名字，用户根本看不懂自己在确认什么
            var detail = isCreate(item)
              ? "新建：" + item.summary
              : (item.op === "deleteNote" ? "删除笔记：" : "删除条目：") +
                (item.keys || []).join("、");
            label.textContent =
              detail +
              (item.requestedAt
                ? "（" + item.requestedAt.slice(11, 19) + "）"
                : "");
            row.appendChild(label);

            var ok = document.createElement("button");
            ok.type = "button";
            // 按钮文案同样按类型：新建说"确认新建"，删除才说"确认删除"
            ok.textContent = isCreate(item) ? "确认新建" : "确认删除";
            ok.style.marginLeft = "0";
            ok.style.marginTop = "4px";
            ok.style.color = isCreate(item) ? "#1d4ed8" : "#b91c1c";
            ok.addEventListener("click", function () {
              ok.disabled = true;
              ok.textContent = "删除中…";
              Promise.resolve()
                .then(function () {
                  return capability.confirmDeletion(index);
                })
                .then(function (report) {
                  notice(report);
                  renderPendingDeletions();
                })
                .catch(function (error) {
                  ok.disabled = false;
                  ok.textContent = isCreate(item) ? "确认新建" : "确认删除";
                  notice(
                    (isCreate(item) ? "新建失败：" : "删除失败：") +
                      (error && error.message ? error.message : String(error)),
                  );
                });
            });
            // ⚠️ 这一处作用域里没有 `target`（那是 `renderPendingInto` 才有的），
            // 进度块挂在待确认列表里 —— 用 `pendingEl`。
            // 这是我把插入写成正则时的教训：**按缩进猜作用域会猜错**。
            renderBatchProgress(pendingEl);

            var no = document.createElement("button");
            no.type = "button";
            no.textContent = "忽略";
            no.style.marginLeft = "4px";
            no.addEventListener("click", function () {
              // ⚠️ 批次进行中**拒绝**单条操作：这个按钮按**当时的下标**闭包，

              // 而下标在批量推进中会变 —— 点下去很可能忽略掉**另一条**。

              if (batchBlocksAction()) {
                notice("正在逐条确认中，请等它跑完再单条操作。");

                return;
              }

              no.disabled = true;

              Promise.resolve()

                .then(function () {
                  return capability.dismissDeletion(index);
                })
                .then(function (report) {
                  notice(report);
                  renderPendingDeletions();
                })
                .catch(function (error) {
                  no.disabled = false;
                  notice(
                    "取消失败：" +
                      (error && error.message ? error.message : String(error)),
                  );
                });
            });

            row.appendChild(ok);
            row.appendChild(no);
            pendingEl.appendChild(row);
          });
        })
        .catch(function () {
          // 拿不到就静默隐藏，不影响页面其它部分
        });
    }

    /**
     * 「刷新材料」按钮。
     *
     * ## 为什么需要（真机反馈："并没有执行具体的工作"）
     *
     * 工作区的 `README.md` / `collection.md` 是**建会话时写一次**的快照。
     * 插件功能改过之后，老会话里留着的还是**旧说明** ——
     * 真机上表现为 Agent 仍去写早已撤掉的 `tagplan.json`，看起来"没干活"。
     *
     * 点一下就用当前版本重写材料，并把插件产生的过期文件归档到 `_stale/`。
     */
    function renderRefreshButton() {
      if (!refreshEl) return;
      // 同上：先判空 capability
      if (!capability) return;
      if (typeof capability.refreshWorkspace !== "function") return;
      refreshEl.textContent = "";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "刷新材料";
      btn.style.fontSize = "12px";
      btn.title =
        "用当前版本重写工作区里的 README/collection 说明，并归档过期的历史文件";
      var out = document.createElement("div");
      out.style.cssText = "font-size:12px;margin-top:4px;white-space:pre-wrap";

      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.textContent = "刷新中…";
        Promise.resolve()
          .then(function () {
            return capability.refreshWorkspace();
          })
          .then(function (report) {
            btn.textContent = "刷新材料";
            btn.disabled = false;
            out.textContent = report;
            loadWorkspaceFiles();
          })
          .catch(function (error) {
            btn.textContent = "刷新材料";
            btn.disabled = false;
            out.textContent =
              "刷新失败：" +
              (error && error.message ? error.message : String(error));
          });
      });

      refreshEl.appendChild(btn);
      refreshEl.appendChild(out);
    }

    /**
     * 渲染 `ask_user_question` 的**选项卡片**。
     *
     * ## 为什么必须有（真机反复反馈）
     *
     * Agent 的提问不是普通文本，而是**工具调用** `ask_user_question`，
     * 选项在它的参数里（见 dsh 源码 `packages/interaction/tool-ask-user`）。
     * 我们早先只取 `text` 块，于是用户看到"动手前有三件事必须你定："
     * 却**看不到任何选项**，而模型一直阻塞等待 —— 会话看起来就是卡住。
     *
     * ## 交互
     *
     * 单选渲染成 radio、多选渲染成 checkbox，另有一个"其它（自己填）"输入框
     * （dsh 的回答结构里有 `custom` 字段，是官方支持的"自定义答案"）。
     * 提交后用 `answerQuestions` 把选择 steer 进当前轮。
     */
    function renderAskCard(questions) {
      if (!askEl || !questions || !questions.length) return;
      askEl.style.display = "";
      askEl.textContent = "";

      var head = document.createElement("div");
      head.style.cssText = "font-weight:600;color:#1d4ed8;margin-bottom:4px";
      head.textContent = "Agent 在等你选择";
      askEl.appendChild(head);

      var state = {}; // id → { selected: [], custom: "" }

      questions.forEach(function (q) {
        state[q.id] = { selected: [], custom: "" };

        var card = document.createElement("div");
        card.style.cssText =
          "border:1px solid #bfdbfe;border-radius:6px;padding:6px 8px;margin:6px 0;background:#fff";

        if (q.header) {
          var h = document.createElement("div");
          h.style.cssText = "font-size:11px;opacity:.75";
          h.textContent = q.header;
          card.appendChild(h);
        }
        var title = document.createElement("div");
        title.style.cssText = "font-weight:600;margin:2px 0";
        title.textContent = q.question;
        card.appendChild(title);
        if (q.detail) {
          var d = document.createElement("div");
          d.style.cssText =
            "font-size:12px;opacity:.8;white-space:pre-wrap;margin-bottom:4px";
          d.textContent = q.detail;
          card.appendChild(d);
        }

        (q.options || []).forEach(function (opt) {
          var row = document.createElement("label");
          row.style.cssText = "display:block;cursor:pointer;padding:3px 0";
          var input = document.createElement("input");
          input.type = q.multiSelect ? "checkbox" : "radio";
          input.name = "ask-" + q.id;
          input.style.marginRight = "6px";
          input.addEventListener("change", function () {
            var picked = state[q.id].selected;
            if (q.multiSelect) {
              if (input.checked) picked.push(opt.label);
              else {
                var at = picked.indexOf(opt.label);
                if (at >= 0) picked.splice(at, 1);
              }
            } else {
              state[q.id].selected = [opt.label];
            }
          });
          row.appendChild(input);
          var text = document.createElement("span");
          text.textContent = opt.label;
          row.appendChild(text);
          if (opt.description) {
            var desc = document.createElement("span");
            desc.style.cssText = "opacity:.7;font-size:12px;margin-left:6px";
            desc.textContent = "— " + opt.description;
            row.appendChild(desc);
          }
          card.appendChild(row);
        });

        // 「其它」：dsh 的回答结构里 custom 是官方支持的字段
        var customRow = document.createElement("div");
        customRow.style.marginTop = "4px";
        var customInput = document.createElement("input");
        customInput.type = "text";
        customInput.placeholder = (q.options || []).length
          ? "其它（自己填，可留空）"
          : "你的回答";
        customInput.style.cssText =
          "width:100%;font:inherit;padding:3px;box-sizing:border-box";
        customInput.addEventListener("input", function () {
          state[q.id].custom = customInput.value;
        });
        customRow.appendChild(customInput);
        card.appendChild(customRow);

        askEl.appendChild(card);
      });

      var actions = document.createElement("div");
      var submit = document.createElement("button");
      submit.type = "button";
      submit.textContent = "提交选择";
      submit.style.fontWeight = "600";
      var out = document.createElement("div");
      out.style.cssText = "font-size:12px;margin-top:4px;white-space:pre-wrap";

      submit.addEventListener("click", function () {
        if (typeof capability.answerQuestions !== "function") {
          out.textContent = "无法提交：会话能力未就绪。";
          return;
        }
        // 至少要有一个选择或自定义内容，否则提交空回答没有意义
        var any = questions.some(function (q) {
          var s = state[q.id];
          return (
            (s.selected && s.selected.length) || (s.custom && s.custom.trim())
          );
        });
        if (!any) {
          out.textContent = "请先选择一项，或在「其它」里填写内容。";
          return;
        }
        submit.disabled = true;
        submit.textContent = "提交中…";
        Promise.resolve()
          .then(function () {
            return capability.answerQuestions(questions, state);
          })
          .then(function () {
            submit.textContent = "已提交";
            // ⚠️ 提交后**收起卡片**：真机反馈"选择选项后的小界面没有消失，会阻挡会话视线"。
            // 原先是留着并追加一行"已提交"，等于把已经完成的操作永久占着屏幕。
            // 改为短暂显示确认后收起，把视线还给对话。
            notice("已提交你的选择，Agent 会接着继续。");
            setTimeout(clearAskCard, 1500);
          })
          .catch(function (error) {
            submit.disabled = false;
            submit.textContent = "提交选择";
            out.textContent =
              "提交失败：" +
              (error && error.message ? error.message : String(error));
          });
      });

      actions.appendChild(submit);
      askEl.appendChild(actions);
      askEl.appendChild(out);
    }

    /** 结束一轮后收起提问卡片（避免一直挂在那里让人以为还要回答） */
    function clearAskCard() {
      if (!askEl) return;
      askEl.style.display = "none";
      askEl.textContent = "";
    }

    /**
     * 顶部**常驻角标**：有待确认的改动时显示。
     *
     * ## 为什么要有它（真机反馈"我没看到确认界面"）
     *
     * 待确认区在页面下方，用户滚动或分心就会错过 —— 而 Agent 正等着，
     * 条目一直悬着不落地。角标固定在最上方，**只要有事就一定看得见**，
     * 点它还能把待确认区滚动到视野里。
     */
    function renderPendingBadge(count) {
      if (!badgeEl) return;
      if (!count) {
        badgeEl.style.display = "none";
        badgeEl.textContent = "";
        return;
      }
      badgeEl.style.display = "";
      badgeEl.textContent =
        "⚠ 有 " + count + " 项改动等你确认（点这里展开/收起）";
      badgeEl.onclick = function () {
        // ⚠️ 改成就地展开，不再依赖"滚动到某处"。
        //
        // 真机反馈"还是点不开具体内容"：待确认区与消息区是**并列的兄弟节点**，
        // 各自有自己的 overflow，滚动消息区并不会把上面那块带进视野。
        // 角标自己就在 header 里 —— 把内容**直接放在它下面**，点击必然有结果。
        try {
          var open = headerPendingEl.style.display !== "none";
          if (open) {
            headerPendingEl.style.display = "none";
            return;
          }
          // 用与主面板相同的渲染逻辑，只是渲染到这个就地容器里
          renderPendingInto(headerPendingEl);
          headerPendingEl.style.display = "";
        } catch (e) {
          notice(
            "展开待确认内容失败：" +
              (e && e.message ? e.message : String(e)) +
              "。内容也在会话正文上方的红色区域里。",
          );
        }
      };
    }

    /**
     * 把待确认内容渲染到指定容器（角标就地展开与主面板共用）。
     *
     * 抽出来是为了**避免两套渲染逻辑**：先前角标只负责"滚动"，内容渲染在另一处，
     * 结果一边坏了另一边看不出来。现在两者用同一份代码。
     *
     * ## ⚠️ 两个真机故障都出在这个函数上
     *
     * 1. **清空后新增看不到**：就地展开的面板只在"点击那一刻"渲染一次，
     *    之后**从不刷新** —— 而外层 `renderPendingDeletions` 每 2 秒刷新的是
     *    主面板与角标计数。所以用户把列表清空后再有新请求时，角标数字变了，
     *    展开的内容却还是旧的空列表，**必须收起再展开**才看得到。
     *    现在渲染结果会记进 `lastPendingSignature`，外层发现内容变了就重渲染。
     *
     * 2. **标题写死"删除"**：新建条目被显示成"请求删除"（见主面板里的说明）。
     */
    /**
     * ## ⚠️ 待确认列表的**标题与配色**只在这里算一次
     *
     * 真机故障（这条注释原先只写在主面板那一份里，就地展开那份是"照抄一遍"）：
     *
     * > 这一块原本是"删除确认"，后来扩展成"结构性改动确认"，但**标题文案没跟着改** ——
     * > 结果 Agent 请求**新建 4 个网页条目**时，面板显示"请求删除 4 项（删除不可逆）"，
     * > 把用户吓一跳。
     *
     * 现在两处渲染（主面板 / 角标就地展开）都调这个函数，
     * **"两处必须一致"由结构保证，而不是靠两人各自记得**。
     *
     * `createItem` 与带 `summary` 的都算"新建"（summary 只在新建类待确认项上有），
     * 其余算"删除"。配色规则：**新建不加红**（红色代表危险，新建不危险）。
     */
    function describePendingHead(items) {
      var isCreate = pendingItemIsCreate;
      var createCount = items.filter(isCreate).length;
      var deleteCount = items.length - createCount;
      var text;
      if (createCount > 0 && deleteCount === 0) {
        text = "Agent 请求新建 " + createCount + " 个条目 —— 需要你确认";
      } else if (deleteCount > 0 && createCount === 0) {
        text =
          "Agent 请求删除 " + deleteCount + " 项 —— 需要你确认（删除不可逆）";
      } else {
        text =
          "Agent 请求改动 " +
          items.length +
          " 项（新建 " +
          createCount +
          "，删除 " +
          deleteCount +
          "）—— 需要你确认";
      }
      return {
        text: text,
        isCreate: isCreate,
        createCount: createCount,
        deleteCount: deleteCount,
        color: deleteCount > 0 ? "#b91c1c" : "#1d4ed8",
      };
    }

    /**
     * 判断一条待确认项是不是"新建类"。
     *
     * `createItem` 与带 `summary` 的都算新建（`summary` 只在新建类待确认项上有），
     * 其余算删除。**单独抽出来**是因为它被三处用到
     * （标题计数、每项文案、每项配色）—— 先前是各写一遍，
     * 于是"新建不加红"这类规则很容易只改一处。
     */
    function pendingItemIsCreate(it) {
      return it.op === "createItem" || Boolean(it.summary && it.summary.length);
    }

    function renderPendingInto(target) {
      if (!target) return;
      if (
        !capability ||
        typeof capability.listPendingDeletions !== "function"
      ) {
        target.textContent = "会话能力尚未就绪，请稍后重试。";
        return;
      }
      target.textContent = "读取中…";
      Promise.resolve()
        .then(function () {
          return capability.listPendingDeletions();
        })
        .then(function (items) {
          target.textContent = "";
          if (!items || items.length === 0) {
            target.textContent = "（当前没有待确认的改动）";
            return;
          }

          // 标题：与主面板**同一套分类逻辑**（不能写死"删除"）——
          // 分类、配色与计数都在 describePendingHead 里，见那里的真机故障记录
          var headInfo = describePendingHead(items);
          var deleteCount = headInfo.deleteCount;
          var head = document.createElement("div");
          head.style.cssText =
            "font-weight:600;margin-bottom:6px;color:" + headInfo.color;
          head.textContent = headInfo.text;
          target.appendChild(head);

          // ── 一键确认（用户要求：条目一多，逐条点太麻烦）──────
          // 只在**两项以上**时出现：只有一条时它不比"确认"按钮更省事，
          // 反而多一个按钮要读。
          if (
            items.length > 1 &&
            typeof capability.confirmAllDeletions === "function"
          ) {
            var allRow = document.createElement("div");
            allRow.style.cssText =
              "margin:4px 0 8px;padding:6px 8px;background:#eff6ff;" +
              "border:1px solid #bfdbfe;border-radius:5px";
            var allBtn = document.createElement("button");
            allBtn.type = "button";
            allBtn.textContent = "全部确认（" + items.length + " 项）";
            allBtn.style.cssText =
              "font-weight:600;padding:3px 12px;cursor:pointer";
            // 同上：禁用状态从 batchConfirm 恢复，才能抗住 2 秒一次的重建。
            if (batchConfirm && batchConfirm.running) {
              allBtn.disabled = true;
              allBtn.textContent =
                "正在全部确认…（" +
                batchConfirm.done +
                "/" +
                batchConfirm.total +
                "）";
            }
            allBtn.addEventListener("click", function () {
              if (batchConfirm && batchConfirm.running) return;
              // 二次确认：这是**批量不可逆**操作，误点代价大
              if (
                !window.confirm(
                  "将一次性确认全部 " +
                    items.length +
                    " 项改动，其中删除不可撤销。确定继续吗？",
                )
              ) {
                return;
              }
              runBatchConfirm(items);
            });
            allRow.appendChild(allBtn);
            var allHint = document.createElement("span");
            allHint.style.cssText =
              "margin-left:8px;color:#6b7280;font-size:12px";
            allHint.textContent =
              deleteCount > 0
                ? "含删除 —— 确认前请核对上面每一项"
                : "新建类操作，仍会进 Zotero 撤销栈";
            allRow.appendChild(allHint);
            target.appendChild(allRow);
          }

          items.forEach(function (item, index) {
            var row = document.createElement("div");
            row.style.cssText = "padding:4px 0;border-top:1px solid #fcd34d";
            var text = document.createElement("div");
            var isCreate =
              item.op === "createItem" || (item.summary && item.summary.length);
            text.textContent =
              (isCreate
                ? "新建：" + item.summary
                : "删除：" + (item.keys || []).join("、")) +
              (item.requestedAt
                ? "（" + item.requestedAt.slice(11, 19) + "）"
                : "");
            row.appendChild(text);

            var yes = document.createElement("button");
            yes.type = "button";
            yes.textContent = isCreate ? "确认新建" : "确认删除";
            yes.style.marginRight = "4px";
            yes.addEventListener("click", function () {
              // 同上：批次进行中单条确认也按会变的下标操作。

              if (batchBlocksAction()) {
                notice("正在逐条确认中，请等它跑完再单条操作。");

                return;
              }

              yes.disabled = true;
              Promise.resolve()
                .then(function () {
                  return capability.confirmDeletion(index);
                })
                .then(function (report) {
                  notice(report);
                  renderPendingInto(target);
                  renderPendingDeletions();
                })
                .catch(function (error) {
                  yes.disabled = false;
                  notice(
                    "失败：" +
                      (error && error.message ? error.message : String(error)),
                  );
                });
            });
            renderBatchProgress(target);

            var no = document.createElement("button");
            no.type = "button";
            no.textContent = "忽略";
            no.addEventListener("click", function () {
              // ⚠️ 批次进行中**拒绝**单条操作：这个按钮按**当时的下标**闭包，

              // 而下标在批量推进中会变 —— 点下去很可能忽略掉**另一条**。

              if (batchBlocksAction()) {
                notice("正在逐条确认中，请等它跑完再单条操作。");

                return;
              }

              no.disabled = true;

              Promise.resolve()

                .then(function () {
                  return capability.dismissDeletion(index);
                })
                .then(function () {
                  renderPendingInto(target);
                  renderPendingDeletions();
                })
                .catch(function (error) {
                  no.disabled = false;
                  notice(
                    "取消失败：" +
                      (error && error.message ? error.message : String(error)),
                  );
                });
            });

            row.appendChild(yes);
            row.appendChild(no);
            target.appendChild(row);
          });
        })
        .catch(function (error) {
          target.textContent =
            "读取失败：" +
            (error && error.message ? error.message : String(error));
        });
    }

    renderWorkspace();
    renderRefreshButton();
    renderPendingDeletions();
    // ⚠️ 必须**定时刷新**待确认区，不能只在打开页面时跑一次。
    //
    // 真机反馈"确认界面到现在为止触发过吗，我怎么没看到"：Agent 提交删除/新建请求后，
    // 页面不会自动更新 —— 用户得**关掉再重开**才可能看到，等于这个确认机制形同虚设。
    // 轮询间隔取 2 秒：注册请求本来就只发生在 Agent 跑到那一步时，不必更密。
    setInterval(renderPendingDeletions, 2000);

    /**
     * 渲染气泡内容。
     *
     * - 助手回答是 Markdown → 渲染成 HTML（模型输出，安全模型见 renderMarkdown 顶部说明）；
     * - 用户提问是纯文本 → textContent，保持原样（用户输入含 `*` 时不该被当成语法）。
     */
    function paint(box, role, text) {
      if (role === "user") {
        box.style.whiteSpace = "pre-wrap";
        box.textContent = text;
        return;
      }
      box.classList.add("dsh-md");
      // 安全前提：renderMarkdown 先整体转义、只插入自己生成的标签
      box.innerHTML = renderMarkdown(text);
    }

    /**
     * 给回答气泡加「存为笔记」按钮。
     *
     * 落点由插件端按会话类型决定：条目会话 → 该条目下；独立会话 → 该分类下。
     * 这里只负责把 (问题, 回答) 传过去 —— 页面不碰 Zotero 的数据层。
     */
    function addSaveNoteButton(box, question, answer) {
      var bar = document.createElement("div");
      bar.style.marginTop = "6px";
      bar.style.paddingTop = "5px";
      bar.style.borderTop = "1px dashed #e5e7eb";

      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "存为笔记";
      btn.style.fontSize = "12px";
      btn.style.padding = "2px 8px";
      btn.style.cursor = "pointer";

      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        // ⚠️ 用**已经解析好的** capability，不要在这里重新组装。
        //
        // 先前这里调用 `capabilityFromGlobal()` 重新组装了一个对象 ——
        // 而窗口路径的能力是 openDialog **注入**的（带同步的 title/workspace），
        // 重新组装出来的那个与页面实际使用的不是同一个，行为也不一致。
        // 能力对象在页面启动时就已确定，直接用即可。
        var cap = capability;
        if (!cap || typeof cap.saveReplyAsNote !== "function") {
          notice(
            "无法保存：会话能力尚未就绪。请稍等片刻后重试；" +
              "若一直如此，请关闭本窗口重新打开会话。",
          );
          return;
        }
        btn.disabled = true;
        btn.textContent = "保存中…";
        Promise.resolve()
          .then(function () {
            return cap.saveReplyAsNote(question || "", answer);
          })
          .then(function (result) {
            btn.textContent =
              result && result.created === false ? "已追加" : "已存为笔记";
            notice(
              result && result.created === false
                ? "已追加到今天的伴读笔记。"
                : "已存为新笔记。",
            );
          })
          .catch(function (error) {
            btn.disabled = false;
            btn.textContent = "存为笔记";
            notice(
              "保存笔记失败：" +
                (error && error.message ? error.message : String(error)),
            );
          });
      });

      bar.appendChild(btn);
      box.appendChild(bar);
    }

    /** 追加一条气泡；role 决定对齐与配色 */
    /**
     * @param live - 这一轮**是否还在生成中**。
     *
     * ## ⚠️ 为什么需要它（真机反馈：回复还没完就出现"存为笔记"）
     *
     * 用户："发送消息后…回复陆续出现，但是**一直有'存为笔记'样式让人误以为回答结束**。
     * 不过回复结束后确实在气泡下正常显示了'本轮结束'。"
     *
     * 原先的判据只是"**有文字**"：
     *
     * ```js
     *   if (role === "assistant" && text && text !== "…") addSaveNoteButton(…)
     * ```
     *
     * 而持续刷新（每 2.5 秒）会把流式中的**半截回答**也用这个判据画一遍，
     * 于是正文每长一段就多一个"存为笔记" —— 用户合理地读成"答完了"。
     *
     * 现在只有**已完成**的轮次才给按钮；生成中不给，改用"生成中…"提示。
     */
    function bubble(role, text, question, live) {
      var wrap = document.createElement("div");
      wrap.className = "dsh-row";
      wrap.style.display = "flex";
      wrap.style.justifyContent = role === "user" ? "flex-end" : "flex-start";

      var box = document.createElement("div");
      box.style.maxWidth = "85%";
      box.style.padding = "6px 9px";
      box.style.borderRadius = "6px";
      box.style.wordBreak = "break-word";
      box.style.background = role === "user" ? "#dbeafe" : "#ffffff";
      box.style.border =
        "1px solid " + (role === "user" ? "#bfdbfe" : "#e5e7eb");
      paint(box, role, text);
      // 只有**已完成**的真实回答才给"存为笔记"按钮。
      // 用户提问、"…"占位、错误信息、**以及仍在生成中的正文**都不给 ——
      // 生成中给按钮等于告诉用户"答完了"，而它还在写。
      if (role === "assistant" && !live && text && text !== "…") {
        addSaveNoteButton(box, question, text);
      }
      wrap.appendChild(box);
      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
      return box;
    }

    function notice(text) {
      var div = document.createElement("div");
      div.style.opacity = "0.7";
      div.style.fontSize = "12px";
      div.style.textAlign = "center";
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    /**
     * 标出**一轮结束**。
     *
     * 真机反馈："增量回显下我不好判断该轮会话是否结束" ——
     * 逐段出现的文字让人分不清"它在写"还是"它写完了在等我"。
     * 所以每轮结束时插一条分隔提示，给一个**明确的视觉终点**。
     */
    function markTurnEnd() {
      var div = document.createElement("div");
      div.style.cssText =
        "display:flex;align-items:center;gap:8px;color:#9ca3af;font-size:11px;margin:2px 0";
      var line = document.createElement("div");
      line.style.cssText = "flex:1;height:1px;background:#e5e7eb";
      var label = document.createElement("span");
      label.textContent = "本轮结束";
      div.appendChild(line.cloneNode(false));
      div.appendChild(label);
      div.appendChild(line);
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function setBusy(busy) {
      send.disabled = busy;
      send.textContent = busy ? "生成中…" : "发送";
      // Agent 停下来问"选 A 还是 B"时轮次还没结束 —— 此时**不能**当新提问
      // （会排队到本轮之后，用户觉得没反应），而要用 steer 送进当前轮。
      // 所以生成期间额外露出「补充说明」按钮：语义明确，不会误触成新提问。
      if (steerBtn) steerBtn.style.display = busy ? "" : "none";
      // 「停止生成」：真机反馈"会话卡住"时用户唯一的出路是关掉 Zotero ——
      // 多步执行（并行工具、反复验证）时一轮可能跑很久，必须能主动取消。
      if (stopBtn) stopBtn.style.display = busy ? "" : "none";
    }

    /**
     * ⚠️ **进来时先问一次：这一轮是不是还在跑？**（真机反馈）
     *
     * 用户："会话中途退出再回来（本轮仍未结束）不会显示工作状态。"
     *
     * 本页每次打开都是**重新加载**的：`setBusy` 只在"刚发消息 / 刚取消"时调过，
     * 所以退出再回来时界面是全新的、状态是空闲 —— 而 harness 那边**还在干活**。
     * 用户看到一个安静的界面，以为答完了，于是去发下一句。
     *
     * v0.8.0 我给 **reader 侧面板**加过同类探测，但会话页走的是
     * `chrome://` 页面 + 全局 API 这条**另一条路径**，那份修复到不了这里。
     *
     * ## 三态，不是两态
     *
     * `isSessionRunning` 返回 `true` / `false` / `undefined`（问不到）。
     * 问不到时**只提示、不改界面**：既不能谎报"在跑"（那会让用户干等），
     * 也不能谎报"空闲"（那会让他去发下一句）——
     * 所以给一句"状态未知"，并把判断权交回用户。
     */
    function probeSessionRunning() {
      if (!capability || typeof capability.isSessionRunning !== "function") {
        return;
      }
      Promise.resolve()
        .then(function () {
          return capability.isSessionRunning();
        })
        .then(function (running) {
          if (running === true) {
            runningKnown = true;
            setBusy(true);
            runningProbeMisses = 0;
            // ⚠️ 只调一次。这里先前连着调了两次 —— 第二次因为定时器已存在而直接返回，
            // 所以没造成双倍轮询，但读起来像"故意排两次"，是纯噪声。
            scheduleRunningProbe(RUNNING_PROBE_MS);
            // 重绘一次：让"还在生成中…"提示与"存为笔记"按钮按新的运行状态出现
            // （否则要等下一个 2.5 秒周期）
            void refreshHistory(true);
          } else if (running === false) {
            runningKnown = false;
            /**
             * ⚠️ **必须复位界面**（真机缺陷：探测到停了却卡在"生成中"）。
             *
             * 原先这个分支只改 `runningKnown`、重绘一次、停探测 —— **没有 `setBusy(false)`**。
             * 于是：用户在某轮进行中打开会话页 → 探测到 true → `setBusy(true)`
             * （发送按钮禁用、文案变"生成中…"、"停止生成"常驻）→ 该轮结束、探测到 false
             * → 内容重画成已完成，**但按钮仍禁用、停止按钮仍在**，
             * 只能再点一次"停止生成"或关掉重开。
             */
            setBusy(false);
            // 确认停了 → 重绘一次：把"还在生成中…"换成正式回答
            // （否则要等到下一个 2.5 秒周期才更新）
            void refreshHistory(true);
            // ⚠️ **不要在这里停探测**：停了，agent 再次开始跑时界面就永远不知道了
            //（真机缺陷：用户因此没有「停止生成」可点）。详见 keepWatching 的说明。
            keepWatching();
          } else {
            // 问不到：只提示，不动界面
            // 连续问不到才计数（问到 true/false 都会清零），超过上限就暂停
            runningProbeMisses += 1;
            notice(
              "暂时问不到运行状态（网络或宿主繁忙）—— 可稍后再看，或点「停止生成」试试。",
            );
            keepWatching();
          }
        })
        .catch(function () {
          // 探测失败不打扰用户（这是增强，不是主流程），
          // 但**仍要继续看** —— 否则一次拖头就让界面永远不再知道状态
          runningProbeMisses += 1;
          keepWatching();
        });
    }

    /**
     * 探测定时器与"连续问不到"计数。
     *
     * 为什么要计数：`undefined`（问不到）也排下一次探测，
     * 若宿主一直不回答就会**无限轮询**。给一个上限，到点就停并说明。
     * 这与 `askInSession` 里"宁可多等，也不要提前宣布结束"是两回事 ——
     * 那是**取回答**，这是**界面装饰**：装饰不该无限占资源。
     */
    /**
     * 最近一次探测到的运行状态：true / false / **null = 还没问到**。
     *
     * 给 `renderTurns` 用：它要判断"最后一轮是不是还在生成中"，
     * 而那决定了**要不要给"存为笔记"按钮**。
     */
    var runningKnown = null;
    var runningProbeTimer = null;
    var runningProbeMisses = 0;
    /** 在跑时的探测间隔 */
    var RUNNING_PROBE_MS = 5000;
    /** 空闲时的探测间隔（比在跑时疏得多，但**不会停**） */
    var RUNNING_PROBE_IDLE_MS = 30000;
    var RUNNING_PROBE_MAX_MISSES = 24; // ≈2 分钟

    function stopRunningProbe() {
      if (runningProbeTimer) {
        clearTimeout(runningProbeTimer);
        runningProbeTimer = null;
      }
      runningProbeMisses = 0;
    }

    /**
     * 排下一次探测。`delay` 由调用方给 —— 在跑时看密一点，空闲时疏一点。
     *
     * `runningProbeMisses` 只在**问不到**时增长（见 `probeSessionRunning`），
     * 问到 `true`/`false` 都会清零；连续问不到超过上限就暂停，避免宿主长期不可用时无限轮询。
     */
    function scheduleRunningProbe(delay) {
      if (runningProbeTimer) return;
      runningProbeTimer = setTimeout(
        function () {
          runningProbeTimer = null;
          if (runningProbeMisses > RUNNING_PROBE_MAX_MISSES) {
            stopRunningProbe();
            return;
          }
          probeSessionRunning();
        },
        typeof delay === "number" ? delay : RUNNING_PROBE_MS,
      );
    }

    /**
     * ## ⚠️ 探测**永不停止**，只是"在跑时看密一点"（真机缺陷）
     *
     * 用户报告："但我这边没有「停止生成」，因为会话页面已经认为它的回答结束了，
     * 于是我又往里敲了个 `1`，界面又弹出选项，我提交选项后回归显示工作状态。"
     *
     * 复现序列：
     *
     * ```text
     *   打开会话页 → 探测一次 → false（agent 此刻确实没在跑）
     *              → 旧代码 stopRunningProbe()，探测【永久停止】
     *   agent 后来开始跑 → 界面再也不知道 → 显示"不在工作"、没有「停止生成」
     * ```
     *
     * 根因是我把探测当成了**一次性的"补课动作"**（回到页面时问一次就够），
     * 但它描述的是**持续状态** —— agent 随时可能开始或结束一轮。
     * 而唯一会重新启动它的路径是"用户在这个页面发消息"，
     * 恰恰是当时没发生的事（用户以为自己只能等）。
     *
     * 现在的做法：探测**一直跑**，只调间隔：
     *
     * | 状态 | 间隔 | 理由 |
     * | --- | --- | --- |
     * | 在跑 | 5 秒 | 要尽快发现它结束，好让按钮与分隔线及时翻过来 |
     * | 空闲 | 30 秒 | 一次 `session/list` 很便宜，但没必要每 5 秒问一件长期不变的事 |
     */
    function keepWatching() {
      scheduleRunningProbe(
        runningKnown === true ? RUNNING_PROBE_MS : RUNNING_PROBE_IDLE_MS,
      );
    }

    /**
     * ## ⚠️ 本页必须**持续刷新**，否则 Agent 在后台跑时界面永远停在旧内容
     *
     * 真机反馈："还是有提前截断的现象，退出重进会话页面**只是更新一次内容**、
     * 不会恢复显示正在运行、也不会持续更新（必须反复退出重进刷新内容）。"
     *
     * 根因：`loadHistory()` 只在 `start()` 里调**一次**，此后页面没有任何东西
     * 去看进度 —— 唯一会驱动界面的是"用户自己发消息"（那条路径才接流）。
     * 于是 Agent 在后台继续产出时，界面静止；用户只能靠反复退出重进来重新加载。
     *
     * `getHistory` 走的是 `session/page`，**每次都是最新的** ——
     * 这也是"重进就能看到新内容"的原因。所以修法很简单：**定期再取一次**。
     *
     * ## 两条边界
     *
     * 1. **内容没变就不动 DOM**：每次重渲染会清空 `messages.innerHTML`，
     *    那会把用户正在读的位置弹走、也会打断选中文本。只在指纹变化时重建。
     * 2. **保住滚动位置**：重建后按"重建前是否贴着底部"决定是否跟到底部 ——
     *    原来在底部（最常见：刚发完消息）就继续跟；原来在看中间就别动。
     */
    var HISTORY_POLL_MS = 2500;
    var historyTimer = null;
    var historyFingerprint = "";
    var historyPollBusy = false;

    function historySnapshot(turns) {
      var parts = [];
      for (var i = 0; i < turns.length; i++) {
        parts.push(
          (turns[i].prompt || "") + "\u0000" + (turns[i].response || ""),
        );
      }
      return parts.join("\u0001");
    }

    function renderTurns(turns) {
      var atBottom =
        messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
      messages.innerHTML = "";
      if (!turns || turns.length === 0) {
        notice("这条会话还没有内容。在下面输入你的第一个问题。");
        return;
      }
      /**
       * ⚠️ **只有最后一轮可能"还在生成中"**，其余都是历史。
       *
       * 判据（任一成立即为生成中）：
       *  - 最后一轮**有提问但没有回答**（刚发出去、还没写出正文）；
       *  - 或运行状态探测说会话仍在跑。
       *
       * 历史轮次一律给"存为笔记"按钮 —— 它们确实已经完成了。
       */
      var last = turns[turns.length - 1];
      var live =
        (last && last.prompt && !last.response) || runningKnown === true;
      for (var i = 0; i < turns.length; i++) {
        var isLive = live && i === turns.length - 1;
        if (turns[i].prompt) bubble("user", turns[i].prompt);
        // 把问题一起带上：笔记正文需要它，而回答气泡自己不知道问了什么
        if (turns[i].response)
          bubble("assistant", turns[i].response, turns[i].prompt, isLive);
        // 生成中：在气泡下方给一个**持续存在**的提示。
        // 它必须画在这里（而不是只在 submit 里插一个 notice）——
        // 因为每 2.5 秒的重建会把那个 notice 冲掉，
        // 这正是用户反馈"原先的 … 也瞬间消失"的原因。
        if (isLive) {
          notice(last && last.response ? "还在生成中…" : "正在思考…");
        }
      }
      /**
       * ⚠️ "本轮结束"分隔也要画在**这里**，否则它会被下一次刷新冲掉。
       *
       * 用户反馈："回复结束后确实在气泡下正常显示了'本轮结束'" ——
       * 那个标记是 `markTurnEnd()` 直接插进 DOM 的，而每 2.5 秒的重建会把它抹掉。
       * 只给**最后一轮**画：历史轮次不画，否则多轮会话里满地都是分隔线。
       */
      if (!live && last) markTurnEnd();
      if (atBottom) messages.scrollTop = messages.scrollHeight;
    }

    /**
     * 取一次历史并按需重渲染。
     *
     * @param silent - 静默模式：失败不写提示（后台轮询不该刷出错误）
     */
    function refreshHistory(silent) {
      if (historyPollBusy) return Promise.resolve();
      historyPollBusy = true;
      return Promise.resolve()
        .then(function () {
          return capability.getHistory();
        })
        .then(function (turns) {
          var list = turns || [];
          var fp = historySnapshot(list);
          // 内容真变了才重建 DOM（见上面第 1 条边界）
          if (fp !== historyFingerprint) {
            historyFingerprint = fp;
            renderTurns(list);
          }
        })
        .catch(function (error) {
          if (!silent) {
            messages.innerHTML = "";
            notice(
              "载入历史失败：" +
                (error && error.message ? error.message : String(error)),
            );
          }
        })
        .then(function () {
          historyPollBusy = false;
        });
    }

    /** 启动/停止持续刷新（生成中密一点，空闲时疏一点，省 RPC） */
    function stopHistoryPoll() {
      if (historyTimer) {
        clearInterval(historyTimer);
        historyTimer = null;
      }
    }

    function startHistoryPoll() {
      if (historyTimer) return;
      historyTimer = setInterval(function () {
        void refreshHistory(true);
      }, HISTORY_POLL_MS);
    }

    /** 载入历史（首次：带"正在载入"提示与兜底超时） */
    function loadHistory() {
      var loading = notice("正在载入历史…");
      var settled = false;
      // 兜底超时：即使底层请求挂住，界面也要给出可读结果而不是永远"…"
      var guard = setTimeout(function () {
        if (settled) return;
        settled = true;
        loading.textContent =
          "载入历史超时。请检查「编辑 → 设置 → DSH-for-Zotero」里的运行时状态。";
        loading.style.color = "#b45309";
      }, 20000);

      Promise.resolve()
        .then(function () {
          return capability.getHistory();
        })
        .then(function (turns) {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          historyFingerprint = historySnapshot(turns || []);
          renderTurns(turns || []);
          // ⚠️ 首次载入成功后就**持续刷新** —— 这是"Agent 在后台跑时界面也能跟上"的唯一途径
          startHistoryPoll();
        })
        .catch(function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          messages.innerHTML = "";
          notice(
            "载入历史失败：" +
              (error && error.message ? error.message : String(error)),
          );
          // 失败也继续试：网络/宿主可能只是暂时不可用
          startHistoryPoll();
        });
    }

    function submit() {
      var text = input.value.trim();
      if (!text || send.disabled) return;
      bubble("user", text);
      input.value = "";
      setBusy(true);
      /**
       * ⚠️ 告诉渲染器"这一轮正在生成"。
       *
       * 没有这一步，每 2.5 秒的重建会把下面那个
       * `bubble("assistant", "…")` 占位气泡**冲掉**，
       * 而新气泡又带上"存为笔记" ——
       * 这正是用户反馈的"先是看不到任何回复
       * （原先的 … 也瞬间消失）"。
       */
      runningKnown = true;
      var pending = bubble("assistant", "…");

      var settled = false;
      /**
       * ⚠️ **这个 185 秒与传输层的 180 秒是耦合的，改一个必须改另一个。**
       *
       * 传输层 `src/chat/transport.ts` 的 `POLL_MAX_MS = 180_000` 决定
       * "我们愿意盯多久"；这个守卫只是**界面兜底**（底层请求挂住时也要给出可读结果）。
       * 所以它必须**略晚于**传输层 —— 早于它就会出现"界面说超时了、
       * 而插件其实还在正常取回答"的矛盾。
       *
       * 两者分处 TS 与 chrome:// 页面（页面拿不到插件的常量），
       * 无法共享一个值 —— 所以只能靠这条注释维系。
       * 真要改，请两边一起改，并保持"页面 > 传输层"。
       */
      var UI_TIMEOUT_GUARD_MS = 185000; // 对应 transport.ts 的 POLL_MAX_MS = 180_000
      var guard = setTimeout(function () {
        if (settled) return;
        settled = true;
        // 这些是系统提示，不是模型输出：用 textContent，避免被当成 Markdown 解释
        pending.textContent =
          "请求超时（180 秒）。请检查运行时状态，或稍后重试。";
        pending.style.borderColor = "#fca5a5";
        setBusy(false);
      }, UI_TIMEOUT_GUARD_MS);

      Promise.resolve()
        .then(function () {
          // 增量回显：把到目前为止的全文画到占位气泡上，
          // 这样 Agent 中途的提问（"选 A 还是 B"）当场就能看到，而不是等整轮结束。
          return capability.ask(
            text,
            function (partial) {
              if (settled) return;
              paint(pending, "assistant", partial);
              // 边生成边判断它在不在问你 —— 让它一眼看出"该我说话了"
              setAwaitingInput(looksLikeQuestion(partial));
              messages.scrollTop = messages.scrollHeight;
            },
            function (questions) {
              // ⚠️ 这才是"Agent 给了选项"的真实来源：选项在 ask_user_question 的
              // **工具参数**里，不在正文里。立刻渲染成可点选项，别等轮次结束。
              if (settled) return;
              // 空数组 = 本轮没有提问（或提问已过期）→ 收起卡片。
              // 真机反馈"每次发消息，之前已经回答过的选择题又出现"：除了插件侧没重置
              // 本轮状态之外，界面这边也必须在收到空数组时清掉旧卡片。
              if (!questions || questions.length === 0) {
                clearAskCard();
                return;
              }
              renderAskCard(questions);
            },
          );
        })
        .then(function (answer) {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          var finalText = answer || "（模型返回了空回答）";
          paint(pending, "assistant", finalText);
          // 回答是异步补进占位气泡的，按钮在这里补挂（text !== "…" 也符合判断）
          addSaveNoteButton(pending, text, finalText);
        })
        .catch(function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          pending.textContent =
            "请求失败：" +
            (error && error.message ? error.message : String(error));
          pending.style.borderColor = "#fca5a5";
        })
        .then(function () {
          runningKnown = false;
          setBusy(false);
          // 本轮结束：清掉"等待你回答"提示，并给一个**明确的分隔**，
          // 否则增量回显下用户分不清"它在写"还是"写完了在等我"
          setAwaitingInput(false);
          // ⚠️ 不在这里插"本轮结束"：每 2.5 秒的重建会把它冲掉。
          // 现在由 `renderTurns` 统一画（只给最后一轮），才能持续可见。
          void refreshHistory(true);
        });
    }

    send.addEventListener("click", submit);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });

    loadHistory();
    // ⚠️ 进来先问一次：上一次离开时那一轮可能**还在跑**。
    // 没有这一步，界面会显示成空闲，用户以为答完了。
    probeSessionRunning();
    // 关页面时停探测：页面都没了还在问只是白耗 RPC。
    if (window && typeof window.addEventListener === "function") {
      window.addEventListener("unload", function () {
        stopRunningProbe();
        stopHistoryPoll();
      });
    }
    input.focus();
  } // ← start() 结束
})();
