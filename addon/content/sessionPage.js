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
    // 行内代码优先：内容单独存起来，最后原样放回
    // （⚠️ writeback.ts 那份实现有个既有局限：代码内容会被后续粗体/斜体规则再处理；
    //   这里在放回时**再次转义**，避免同样的问题）
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
    var batchConfirm = null; // { total, done, running, results: [文本], startedAt }

    /** 取某条待确认项的稳定标识（op + key），供批量循环定位 */
    function pendingItemKey(it) {
      if (!it) return "";
      var k = (it.keys && it.keys[0]) || "";
      return (it.op || "") + ":" + k;
    }

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
              var idx = -1;
              for (var i = 0; i < (live || []).length; i += 1) {
                if (pendingItemKey(live[i]) === want) {
                  idx = i;
                  break;
                }
              }
              if (idx < 0) {
                // 已不在列表里（别人已处理）—— 跳过，绝不猜一个下标
                batchConfirm.results.push("跳过（已不在列表）：" + want);
                return "";
              }
              return capability.confirmDeletionAt(
                idx,
                want.split(":").slice(1).join(":"),
              );
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
        renderPendingDeletions();
        renderPendingInto(pendingEl);
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
          //
          // 真机故障：这一块原本是"删除确认"，后来扩展成"结构性改动确认"，
          // 但标题文案没跟着改 —— 结果 Agent 请求**新建 4 个网页条目**时，
          // 面板显示"请求删除 4 项（删除不可逆）"，把用户吓一跳。
          var isCreate = function (it) {
            return it.op === "createItem" || (it.summary && it.summary.length);
          };
          var createCount = items.filter(isCreate).length;
          var deleteCount = items.length - createCount;
          var headText;
          if (createCount > 0 && deleteCount === 0) {
            headText =
              "Agent 请求新建 " + createCount + " 个条目 —— 需要你确认";
          } else if (deleteCount > 0 && createCount === 0) {
            headText =
              "Agent 请求删除 " +
              deleteCount +
              " 项 —— 需要你确认（删除不可逆）";
          } else {
            headText =
              "Agent 请求改动 " +
              items.length +
              " 项（新建 " +
              createCount +
              "，删除 " +
              deleteCount +
              "）—— 需要你确认";
          }
          head.textContent = headText;
          // 新建不加红：红色代表危险，新建不是危险操作（删除才是）
          head.style.color = deleteCount > 0 ? "#b91c1c" : "#1d4ed8";
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

          // 标题：与主面板同一套分类逻辑（不能写死"删除"）
          var head = document.createElement("div");
          var createCount = items.filter(function (it) {
            return it.op === "createItem" || (it.summary && it.summary.length);
          }).length;
          var deleteCount = items.length - createCount;
          head.style.cssText =
            "font-weight:600;margin-bottom:6px;color:" +
            (deleteCount > 0 ? "#b91c1c" : "#1d4ed8");
          head.textContent =
            createCount > 0 && deleteCount === 0
              ? "Agent 请求新建 " + createCount + " 个条目 —— 需要你确认"
              : deleteCount > 0 && createCount === 0
                ? "Agent 请求删除 " +
                  deleteCount +
                  " 项 —— 需要你确认（删除不可逆）"
                : "Agent 请求改动 " +
                  items.length +
                  " 项（新建 " +
                  createCount +
                  "，删除 " +
                  deleteCount +
                  "）—— 需要你确认";
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
    function bubble(role, text, question) {
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
      // 只有真实回答才给"存为笔记"按钮（用户提问、"…"占位、错误信息都不给）
      if (role === "assistant" && text && text !== "…") {
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

    /** 载入历史 */
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
          messages.innerHTML = "";
          if (!turns || turns.length === 0) {
            notice("这条会话还没有内容。在下面输入你的第一个问题。");
            return;
          }
          for (var i = 0; i < turns.length; i++) {
            if (turns[i].prompt) bubble("user", turns[i].prompt);
            // 把问题一起带上：笔记正文需要它，而回答气泡自己不知道问了什么
            if (turns[i].response)
              bubble("assistant", turns[i].response, turns[i].prompt);
          }
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
        });
    }

    function submit() {
      var text = input.value.trim();
      if (!text || send.disabled) return;
      bubble("user", text);
      input.value = "";
      setBusy(true);
      var pending = bubble("assistant", "…");

      var settled = false;
      var guard = setTimeout(function () {
        if (settled) return;
        settled = true;
        // 这些是系统提示，不是模型输出：用 textContent，避免被当成 Markdown 解释
        pending.textContent =
          "请求超时（180 秒）。请检查运行时状态，或稍后重试。";
        pending.style.borderColor = "#fca5a5";
        setBusy(false);
      }, 185000);

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
          setBusy(false);
          // 本轮结束：清掉"等待你回答"提示，并给一个**明确的分隔**，
          // 否则增量回显下用户分不清"它在写"还是"写完了在等我"
          setAwaitingInput(false);
          markTurnEnd();
          messages.scrollTop = messages.scrollHeight;
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
    input.focus();
  } // ← start() 结束
})();
