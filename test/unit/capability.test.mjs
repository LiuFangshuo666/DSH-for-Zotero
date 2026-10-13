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
describe("工具轮询器的去重键", function () {
  it("按工作区目录去重（不是 sessionId）", function () {
    const start = paneSource.indexOf("private startToolPoller(");
    assert.ok(start > 0, "找不到 startToolPoller");
    // 窗口要够大：`toolPollers.set` 在函数末尾，900 字符截不到（第一版就是这么误报的）
    const body = paneSource.slice(start, start + 2600);
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
