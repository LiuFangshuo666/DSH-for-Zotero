/**
 * 会话页与插件之间的**能力对象必须完整**。
 *
 * ## 为什么专门测这个（一次静默失败）
 *
 * 页面按钮调用能力对象上的 `saveReplyAsNote`，而能力对象是**逐个方法手工列出**的：
 *  - 内置查看器路径：`sessionPage.js` 的 `capabilityFromGlobal()` 组装包装对象；
 *  - 窗口路径：`sessionPane.ts` 的 `openInDialog()` 注入对象。
 *
 * 我在插件端全局 API 上加了 `saveReplyAsNote`，却**两处包装都漏了它** ——
 * 表现是按钮点击后报"能力不可用"，而提示文案还把方向指向"插件代码是旧版本"，
 * 于是排查跑偏了好几轮。手工枚举的清单必须有测试守着。
 *
 * ## 契约（按页面实际使用方式确定，不是"三个对象方法名相同"）
 *
 *  - **必需**：页面**直接调用**、且没有守卫的方法 —— `getHistory`、`listWorkspaceFiles`、
 *    `ask`、`saveReplyAsNote`。缺任何一个都会在使用时失败。
 *  - **可选**：页面有守卫或回退的 —— `describe`（`typeof … === "function"` 判断后调用）、
 *    `title` / `scopeTitle` / `scopeKind` / `workspace`（带 `|| 默认值`）。
 *    注入路径直接给这些**同步数据**，所以它不需要 `describe`；两条路径职责不同。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// 按**语法边界**取源码片段，而不是按字符数 ——
// 固定窗口在这个文件里误报过三次，详见 sourceSlices.mjs 顶部。
import { methodBody } from "./sourceSlices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const pageSource = readFileSync(
  join(root, "addon", "content", "sessionPage.js"),
  "utf8",
);
const paneSource = readFileSync(
  join(root, "src", "modules", "sessionPane.ts"),
  "utf8",
);

/** 页面无守卫直接调用的方法：两条路径都必须提供 */
const REQUIRED_METHODS = ["getHistory", "ask", "saveReplyAsNote"];

/** 页面有守卫（`typeof … === "function"`）后调用的可选方法 */
const OPTIONAL_METHODS = [
  "describe",
  "listWorkspaceFiles",
  // 补充说明（steer）与删除确认：同样有守卫 ——
  // 旧版插件缺这些方法时，按钮不显示而不是点了报错。
  "steer",
  "listPendingDeletions",
  "confirmDeletion",
  "dismissDeletion",
  // 一键确认全部待确认项（条目多时逐条点太麻烦，用户要求）
  "confirmAllDeletions",
  // ⚠️ 逐条版的一键确认（真机缺陷：整批版让按钮提前恢复可点 → 条目被操作两次）
  //
  // 整批版一口气跑完才返回，界面既无法可靠禁用按钮（列表每 2 秒重建，
  // 设在元素上的 disabled 被冲掉），也看不到每项结果。
  // 现在由界面驱动循环，这两个是它需要的原语。
  // 两者都做了**版本探测**（老插件没有时退回整批版），所以归在可选方法。
  "confirmAllDeletionsBegin",
  "confirmDeletionAt",
  // 刷新工作区材料：老会话里可能留着已被撤掉的旧说明
  "refreshWorkspace",
  // 取消正在进行的轮次（卡住时的出路）
  "cancelTurn",
  // ⚠️ 该会话是否仍在运行（真机：退出再回来不显示工作状态）
  //
  // 会话页每次打开都是重新加载的，而 setBusy 先前只在
  // "刚发消息 / 刚取消"时调过 —— 于是重新打开时界面是空闲的，
  // 而 harness 还在干活。有了它才能在进来时恢复状态。
  // 有守卫（旧插件没有它时不探测），所以归可选。
  "isSessionRunning",
  // 回答 ask_user_question 的提问（选项在工具参数里，必须回传）
  "answerQuestions",
];

describe("会话能力对象的完整性", function () {
  it("页面调用的每个能力方法都登记在清单里（新增功能时强制同步）", function () {
    // 页面里可能通过局部变量调用（如 `var cap = …; cap.saveReplyAsNote(…)`），
    // 所以名字要同时扫 `capability.x(` 与 `cap.x(` 两种写法。
    const called = new Set();
    for (const m of pageSource.matchAll(
      /\b(?:capability|cap)\.([A-Za-z_$][\w$]*)\s*\(/g,
    )) {
      called.add(m[1]);
    }
    for (const name of called) {
      assert.ok(
        REQUIRED_METHODS.includes(name) || OPTIONAL_METHODS.includes(name),
        `页面调用了能力方法 ${name}()，但它不在任何清单里 —— ` +
          `请加入 REQUIRED_METHODS（无守卫）或 OPTIONAL_METHODS（有守卫），` +
          `并确认相应路径提供了它`,
      );
    }
  });

  it("平台实际提供的必需方法都有守卫，或确实被调用（契约自洽）", function () {
    // 反向检查：必需清单里的每一项都应在页面里被调用过，
    // 否则清单会变成"空头承诺"（写了却没人用，改坏了也发现不了）
    for (const name of REQUIRED_METHODS) {
      assert.ok(
        new RegExp(`\\b(?:capability|cap)\\.${name}\\s*\\(`).test(pageSource),
        `REQUIRED_METHODS 里的 ${name} 在页面里找不到直接调用点 —— ` +
          `它可能已被加上守卫（应移入 OPTIONAL_METHODS）或已不再使用`,
      );
    }
  });

  it("内置查看器路径（capabilityFromGlobal）提供全部必需方法", function () {
    const start = pageSource.indexOf("function capabilityFromGlobal()");
    assert.ok(start > 0, "找不到 capabilityFromGlobal");
    const end = pageSource.indexOf("\n  function tryGet()", start);
    const body = pageSource.slice(start, end > 0 ? end : start + 3000);

    for (const name of REQUIRED_METHODS) {
      assert.match(
        body,
        new RegExp(`\\b${name}\\s*:`),
        `capabilityFromGlobal 组装的对象缺 ${name} —— ` +
          `页面调用它会失败，而报错信息可能指向错误的方向`,
      );
    }
  });

  /**
   * ## ⚠️ 真正的守卫：**页面调用什么，两条路径就得有什么**
   *
   * 上面那三条只校验 `REQUIRED_METHODS`（3 个），而 `isSessionRunning`、
   * `confirmAllDeletionsBegin`、`confirmDeletionAt` 都在 `OPTIONAL_METHODS` 里 ——
   * "有守卫"被当成了"有提供"。两次独立审计都从这个缝里查出了真缺陷：
   *
   *  - **全局 API 缺 `confirmAllDeletionsBegin` / `confirmDeletionAt`**：
   *    页面侧的包装有版本探测，方法不存在就**退回整批版** ——
   *    于是"逐条驱动、防二次操作、显示每条结果"在**唯一**的挂载路径上完全没生效；
   *    更糟的是 `confirmDeletionAt(idx, uid)` 拿不到时 `expectUid` 为 `undefined`，
   *    "下标错位就拒绝"那道保险**从不执行**。
   *
   * 这类漏项的表现是**功能静默变回旧版**，不报错、不写日志 —— 所以必须由守卫抓。
   */
  it("页面读取的每个 capability.xxx 都必须在两条路径上提供", function () {
    // 页面实际读取的能力名（`capability.x` 与 `cap.x`）
    const used = new Set();
    for (const m of pageSource.matchAll(/\b(?:capability|cap)\.(\w+)/g)) {
      used.add(m[1]);
    }
    /**
     * 数据字段不是方法，全局路径下本来就给不出（页面用 `|| "DSH 会话"` 兜底）。
     * 把它们显式列出，而不是靠"名字看起来像数据"来猜。
     */
    const DATA_FIELDS = new Set([
      "title",
      "scopeKind",
      "scopeTitle",
      "workspace",
      "sessionId",
    ]);
    const need = [...used].filter((n) => !DATA_FIELDS.has(n)).sort();
    assert.ok(
      need.length >= 8,
      "页面读取的能力太少，抽取逻辑可能失效：" + need.join(", "),
    );

    // 路径一：全局注册表（`const api = { … }`）
    const gi = paneSource.indexOf("const api = {");
    assert.ok(gi > 0, "找不到 registerGlobalApi 里的 api 对象");
    const gEnd = paneSource.indexOf("\n  };", gi);
    const globalBody = paneSource.slice(gi, gEnd > 0 ? gEnd : gi + 4200);
    const globalKeys = new Set(
      [...globalBody.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]),
    );

    // 路径二：窗口注入（`const capability = { … }`）
    const wi = paneSource.indexOf("const capability = {");
    assert.ok(wi > 0, "找不到 openInDialog 注入的 capability 对象");
    const wEnd = paneSource.indexOf("\n    };", wi);
    const winBody = paneSource.slice(wi, wEnd > 0 ? wEnd : wi + 4200);
    const winKeys = new Set(
      [...winBody.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]),
    );

    const missingGlobal = need.filter((n) => !globalKeys.has(n));
    const missingWin = need.filter((n) => !winKeys.has(n));
    assert.deepEqual(
      missingGlobal,
      [],
      "全局注册表路径缺这些能力：" +
        missingGlobal.join(", ") +
        " —— 页面会静默退回旧实现（不报错，所以必须靠这条守）",
    );
    assert.deepEqual(
      missingWin,
      [],
      "窗口注入路径缺这些能力：" + missingWin.join(", "),
    );
  });

  it("窗口路径（openInDialog 注入）提供全部必需方法", function () {
    const start = paneSource.indexOf("const capability = {");
    assert.ok(start > 0, "找不到 openInDialog 里的 capability 对象");
    const end = paneSource.indexOf("};", start);
    const body = paneSource.slice(start, end > 0 ? end : start + 2000);

    for (const name of REQUIRED_METHODS) {
      assert.match(
        body,
        new RegExp(`\\b${name}\\s*:`),
        `openInDialog 注入的能力对象缺 ${name}`,
      );
    }
    // 标签方案三项也必须在注入对象上：会话也可能在**窗口**里打开，
    // 而窗口路径不经过 capabilityFromGlobal —— 漏了就会"按钮不出现"。
    // steer 与删除确认同理（窗口路径少了它们，Agent 提问就没法回答）。
    for (const name of [
      "steer",
      "listPendingDeletions",
      "confirmDeletion",
      "dismissDeletion",
      "refreshWorkspace",
      "cancelTurn",
      "answerQuestions",
    ]) {
      assert.match(
        body,
        new RegExp(`\\b${name}\\s*:`),
        `openInDialog 注入的能力对象缺 ${name}（窗口路径下该功能会不可用）`,
      );
    }
    // 它还必须给同步展示数据（页面 start() 直接读，不经过 describe）
    for (const field of ["title", "scopeTitle", "scopeKind", "workspace"]) {
      assert.match(
        body,
        new RegExp(`\\b${field}\\s*:`),
        `注入对象应带同步数据 ${field}（页面直接读它渲染标题/工作区）`,
      );
    }
  });

  it("插件端全局 API 暴露页面需要的方法", function () {
    const start = paneSource.indexOf("const api = {");
    assert.ok(start > 0, "找不到 registerGlobalApi 里的 api 对象");
    // ⚠️ 窗口要开得够大：`describe` 的解析器有十几行，用 2000 字符会把后面的
    //    `ask` 截在窗口外（第一版就是这么误报"全局 API 缺 ask"的）。
    const end = paneSource.indexOf("\n  };", start);
    const body = paneSource.slice(start, end > 0 ? end : start + 4000);

    // 全局 API 的命名与页面包装层不同（它提供 describe，由包装层改名/补数据），
    // 所以这里只要求"页面要用到的能力在全局 API 上确实存在"。
    for (const name of [
      "ask",
      "listWorkspaceFiles",
      "saveReplyAsNote",
      "describe",
    ]) {
      assert.match(body, new RegExp(`\\b${name}\\s*:`), `全局 API 缺 ${name}`);
    }
  });
});

/**
 * `saveReplyAsNote` 的**参数约定**必须两边一致。
 *
 * ## 为什么必须钉住（真机产生过内容错乱的笔记）
 *
 * 页面脚本每次从磁盘重载，插件 bundle 只在 Zotero 启动时载入一次 ——
 * 升级后很容易出现"页面是新的、插件是旧的"。当时旧签名是
 * `saveReplyAsNote(question, answer)`，而新页面按
 * `saveReplyAsNote(sessionId, question, answer)` 调用，**参数整体右移一位**：
 * 笔记标题成了会话 id、正文成了用户提问，而 **DSH 的回答直接丢失** ——
 * 全程没有任何报错，只是静默写出错误数据。
 *
 * 现在两边统一用**一个对象**传参。这样即使版本不一致，
 * 也只会得到 `undefined` 字段并抛出可读错误，而不是写出一条错乱的笔记。
 */
describe("saveReplyAsNote 的参数约定", function () {
  it("插件端（全局 API 与注入对象）都接收一个对象参数", function () {
    // 全局 API：saveReplyAsNote: async (input: { sessionId; question; answer }) => …
    const apiStart = paneSource.indexOf("const api = {");
    const apiEnd = paneSource.indexOf("\n  };", apiStart);
    const apiBody = paneSource.slice(
      apiStart,
      apiEnd > 0 ? apiEnd : apiStart + 4000,
    );
    assert.match(
      apiBody,
      /saveReplyAsNote:\s*async\s*\(\s*input:\s*\{/,
      "全局 API 的 saveReplyAsNote 必须接收一个对象参数（位置参数在版本不一致时会静默错位）",
    );

    // 注入对象同理
    const capStart = paneSource.indexOf("const capability = {");
    const capEnd = paneSource.indexOf("};", capStart);
    const capBody = paneSource.slice(
      capStart,
      capEnd > 0 ? capEnd : capStart + 2000,
    );
    assert.match(
      capBody,
      /saveReplyAsNote:\s*\(\s*input:\s*\{/,
      "注入对象的 saveReplyAsNote 也必须接收一个对象参数",
    );

    // 方法本身的签名
    assert.match(
      paneSource,
      /async saveReplyAsNote\(input:\s*\{\s*sessionId: string;\s*question: string;\s*answer: string;\s*\}\)/,
      "saveReplyAsNote 的实现必须接收 { sessionId, question, answer }",
    );
    // 必须做参数校验：缺字段时抛可读错误，而不是写出错乱数据
    assert.match(
      paneSource,
      /typeof answer !== "string"/,
      "必须有参数完整性校验（缺字段时抛错，避免静默写出错误内容）",
    );
  });

  it("页面调用全局 API 时传的是对象，且含 sessionId", function () {
    // capabilityFromGlobal 里的转接
    const start = pageSource.indexOf("saveReplyAsNote: function");
    assert.ok(start > 0, "找不到页面的 saveReplyAsNote 转接");
    const body = pageSource.slice(start, start + 300);
    assert.match(
      body,
      /api\.saveReplyAsNote\(\s*\{/,
      "页面必须用对象调用全局 API（与插件端约定一致）",
    );
    assert.match(body, /sessionId:\s*sessionId/, "对象里必须带上 sessionId");
    assert.match(body, /question:\s*question/, "对象里必须带 question");
    assert.match(body, /answer:\s*answer/, "对象里必须带 answer");
  });
});

/**
 * 工具轮询器必须**按工作区目录**去重。
 *
 * ## 为什么（真机故障链）
 *
 * 多个会话可以共用同一个工作区（同一分类建多个会话就是这样，真机上那 9 个
 * 分类会话全指向 `collection-VZVXRZ6D`）。早先按 `sessionId` 去重，于是
 * **每个会话各起一个轮询器、全都盯着同一个 `call.json`**：
 *
 *  - 它们同时处理同一次调用，都往同一个临时文件写、都去 `move`；
 *  - 先到的成功，后到的抛 `NotFoundError`（日志里同一毫秒 12 条）；
 *  - **结果写不出去 → Agent 永远等不到返回值 → 双方干等**，
 *    用户看到的是"会话卡住"。
 *
 * 这条断言防的是"以后有人觉得按 sessionId 更直观、又改回去"。
 */
/**
 * ## 用户"拒绝"也必须写回执（真机：Agent 无法直观地知道）
 *
 * 用户实测："我确认完条目后，Agent 貌似无法直观地知道。"
 *
 * 查下来两个缺陷：
 *  1. 回执**每次覆盖写** → 一键确认 10 条只剩最后 1 条（真机实测确实只有 1 条）；
 *  2. `dismissPendingDeletion` **完全不写回执** → 无论用户确认还是拒绝，
 *     Agent 都**永远等不到答复**，只能反复追问或重复提交。
 *
 * 修法：追加式 `confirm-log.json`（确认与拒绝都记）+ 老的覆盖写文件继续保留。
 */
describe("确认回执", function () {
  it("回执必须是**追加式**的，不能每次覆盖", function () {
    const start = paneSource.indexOf("private async appendConfirmLog");
    assert.ok(start > 0, "找不到 appendConfirmLog");
    const body = paneSource.slice(start, start + 2600);
    assert.match(
      body,
      /CONFIRM_LOG_FILE/,
      "必须写追加式历史文件 —— 覆盖写会让\u201c确认 10 条\u201d只剩最后 1 条",
    );
    assert.match(body, /history\.push\(/, "必须往历史里**追加**，而不是替换");
    assert.match(
      body,
      /待确认剩余/,
      "必须带\u201c待确认剩余\u201d —— 这是 Agent 区分\u201c还没决定\u201d与\u201c决定了\u201d的唯一依据",
    );
  });

  it("**用户拒绝时也要写回执**（这是它先前永远等不到答复的原因）", function () {
    const start = paneSource.indexOf("dismissPendingDeletion(index: number)");
    assert.ok(start > 0, "找不到 dismissPendingDeletion");
    const body = paneSource.slice(start, start + 1200);
    assert.match(
      body,
      /appendConfirmLog\(/,
      "拒绝必须留痕：否则 Agent 提交后无论用户确认还是拒绝都收不到任何答复",
    );
    assert.match(
      body,
      /"已拒绝"/,
      "决定要标明是\u201c已拒绝\u201d，Agent 才知道是用户否掉了而不是还在等",
    );
  });

  it("向后兼容：老的 deletion-result.json 仍要写", function () {
    const start = paneSource.indexOf("private async appendConfirmLog");
    const body = paneSource.slice(start, start + 2600);
    assert.match(
      body,
      /deletion-result\.json/,
      "已有会话的 Agent 可能还在读旧文件，改版不能让它失灵",
    );
  });
});

/**
 * ## 每个 `pending: true` 的返回值都必须说清**去哪儿看用户决定**
 *
 * 真机反馈："我确认完条目后，Agent 貌似无法直观地知道。"
 *
 * 光在 `describeOps()` 里写不算数 —— Agent 提交时逐字读到的是**这个返回值**，
 * 它决定了下一步是"**去读回执**"还是"**再提交一次试探**"（后者会让确认区出现重复项）。
 *
 * 现有三个待确认操作：`createItem` / `attachPdf` / 删除类兜底分支。
 * 将来新增任何一个，都必须同时带上这个字段 —— 所以钉在守卫里。
 */
describe("待确认返回值必须指引回执位置", function () {
  it("每个 `pending: true` 分支都要有\u201c确认结果在哪\u201d", function () {
    const src = readFileSync(
      join(here, "..", "..", "src", "modules", "sessionPane.ts"),
      "utf8",
    );
    // 只数真正返回的（排除文档注释里的那一处）
    const pendingReturns = (src.match(/^\s+pending: true,\s*$/gm) || []).length;
    const hints = (src.match(/确认结果在哪:/g) || []).length;
    assert.ok(
      pendingReturns >= 3,
      "应至少有三个待确认分支，实际 " + pendingReturns,
    );
    assert.equal(
      hints,
      pendingReturns,
      "每个返回 pending 的分支都要带\u201c确认结果在哪\u201d（含 confirm-log.json 与待确认剩余），" +
        "否则 Agent 只能靠重复提交试探",
    );
  });
});

describe("工具轮询器的去重键", function () {
  /**
   * ## ⚠️ 这里踩过**三个**坑，所以最终交给共享助手
   *
   * 1. **固定字符窗口**（`slice(start, start + 2600)`）：`toolPollers.set(dir`
   *    在函数末尾，给函数加一段守卫后它被推到 `+3765` —— 测试立刻误报
   *    "注册时也必须用 dir 当键"，而代码完全正确。
   * 2. **只搜方法名**：`indexOf("private startToolPoller(")` 命中过
   *    **注释里提到这个名字**的地方，切出 660 字符，13 个操作全报"缺失"。
   * 3. **按关键字找下一个方法**（`search(/\n {2}(private|async) /)`）：
   *    守卫自己的注释里就含 `async`，切片在**函数体中间**断掉。
   *
   * 现在用 `sourceSlices.methodBody()` —— 按**配平的大括号**取，
   * 不随函数变长、也不受注释里出现什么词影响。
   * 详见 `test/unit/sourceSlices.mjs` 顶部的说明。
   */
  const toolPollerBody = () => {
    const body = methodBody(paneSource, "startToolPoller");
    assert.ok(body, "找不到 startToolPoller 的方法定义");
    return body;
  };

  it("按工作区目录去重（不是 sessionId）", function () {
    const body = toolPollerBody();
    assert.match(
      body,
      /toolPollers\.has\(dir\)/,
      "startToolPoller 必须按 dir 去重 —— 按 sessionId 会让共用工作区的多个会话互相抢 call.json",
    );
    assert.ok(
      !/toolPollers\.has\(key\)/.test(body),
      "不得按 sessionId（key）去重",
    );
    assert.match(body, /toolPollers\.set\(dir/, "注册时也必须用 dir 当键");
  });

  it("**重启后不得重跑已回过结果的调用**（真机：确认过的 10 条又被要求确认一次）", function () {
    // 用户实测："我在你修 bug 的时候已经一键确认了这 10 个条目（附件都加上了），
    // 怎么我重启打开了还要我确认？"
    //
    // 日志铁证：
    //   15:34:01  补全文待确认：10 条（55DESKT6, …）      ← 提交
    //   15:40:40  补全文结果：…已挂为附件 ×10              ← 用户确认，全成功
    //   16:22:50  插件启动于 v0.11.1
    //   16:22:51  补全文待确认：10 条（55DESKT6, …）      ← 启动后 1.1 秒，同一批又来了
    //
    // 根因两条缺一不可：
    //  ① 去重只靠 `lastId`，而它是**局部变量** —— 重启即丢，
    //     于是磁盘上那个旧 `call.json` 被当成新请求**再执行一次**；
    //  ② **待确认队列只在内存里** —— 重启即空，
    //     于是"再执行"把它**重新登记为新的一项待确认**（它其实早就成功过了）。
    const body = toolPollerBody();
    assert.match(
      body,
      /TOOL_RESULT_FILE/,
      "轮询必须读 result.json 判重 —— 只靠内存里的 lastId，重启后会把旧调用重跑一遍",
    );
    assert.match(
      body,
      /prev\.id === parsed\.call\.id/,
      "必须按 id 比对：id 相同即表示这次调用已经回过结果，应跳过",
    );
  });

  it("写工具结果**不用**临时文件 + move（那个 move 在真机上抛 NotFoundError）", function () {
    const start = paneSource.indexOf("private async writeToolResult(");
    assert.ok(start > 0, "找不到 writeToolResult");
    const body = paneSource.slice(start, start + 1400);
    assert.ok(
      !/IOUtils\.move\(/.test(body),
      "不得用临时文件 + move：多个轮询器抢同一个 .tmp 会让 move 失败，结果写不出去、Agent 永远等",
    );
    assert.match(body, /IOUtils\.writeUTF8\(target/, "应直接写 result.json");
  });
});
