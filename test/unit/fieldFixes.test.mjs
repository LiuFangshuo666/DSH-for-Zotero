/**
 * 本轮真机反馈的六项修复：守住每一条**不会让构建失败**的回归。
 *
 * 这些问题有共同点：编译通过、单元测试通过、产物核验通过 ——
 * 但在真机上就是不能用。所以只能靠针对性的断言守。
 *
 * ## 写法约定（踩过的坑）
 *
 * 断言说明里要引用时，一律用**反引号包住整段**。
 * 不要写成外层英文引号、内层又夹引号的形态 ——
 * 本项目在测试文件上因此写出过语法错误，而且靠正则修补越修越乱。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

describe("确认列表的可用性（用户反馈）", function () {
  const pane = read("src/modules/sessionPane.ts");
  const page = read("addon/content/sessionPage.js");

  it("有「一键确认」的插件实现，且从后往前处理", function () {
    assert.match(
      pane,
      /async confirmAllPendingDeletions/,
      `必须有批量确认（条目一多，逐条点太麻烦）`,
    );
    // 这是本功能唯一容易写错的地方：confirmPendingDeletion 会 splice，
    // 正向遍历会漏项。断言必须钉住遍历方向。
    const body = pane.slice(pane.indexOf("async confirmAllPendingDeletions"));
    const loop = body.slice(0, body.indexOf("const succeeded"));
    assert.match(
      loop,
      /for\s*\(\s*let\s+index\s*=\s*total\s*-\s*1\s*;\s*index\s*>=\s*0\s*;\s*index\s*-=\s*1/,
      `必须倒序遍历 —— 每次确认都会 splice，正序会让下标错位、漏掉一项`,
    );
  });

  it("两条会话路径都暴露了 confirmAllDeletions", function () {
    assert.match(
      pane,
      /confirmAllDeletions:\s*async/,
      `静态页面 API 缺 confirmAllDeletions（附件形态走这条）`,
    );
    assert.match(
      pane,
      /confirmAllDeletions:\s*\(\)\s*=>\s*this\.confirmAllPendingDeletions\(\)/,
      `窗口形态的能力缺 confirmAllDeletions`,
    );
    assert.match(
      page,
      /confirmAllDeletions: function/,
      `页面没有把它接到 capability 上`,
    );
  });

  it("列表清空后新增的内容会自动出现（不必收起再展开）", function () {
    // 真机反馈：清空后再有新请求时，角标数字变了，但就地展开的内容还是旧的。
    assert.match(
      page,
      /lastPendingSignature/,
      `就地展开的面板必须按内容签名刷新，否则新项不可见`,
    );
    assert.match(
      page,
      /signature\s*!==\s*lastPendingSignature/,
      `必须比较签名后才重渲染（每轮无条件重建 DOM 会让按钮失焦）`,
    );
  });
});

describe("跨设备同步（用户反馈：路径不匹配）", function () {
  const session = read("src/dsh/session.ts");
  const pane = read("src/modules/sessionPane.ts");
  const transport = read("src/chat/transport.ts");

  it("工作区按当前机器推导，不直接用记录里的绝对路径", function () {
    assert.match(
      session,
      /export function resolveWorkspace/,
      `必须能按当前根目录重算工作区（记录里的路径属于创建它的机器）`,
    );
    assert.match(
      session,
      /export async function ensureWorkspaceDir/,
      `必须能在使用前解析并补建目录（cwd 目录不存在时宿主的 shell 工具会直接失败）`,
    );
    assert.match(
      session,
      /\.map\(withResolvedWorkspace\)/,
      `list() 必须解析 workspace，否则调用方拿到的还是旧路径`,
    );
    assert.match(
      session,
      /withResolvedWorkspace\(found\)/,
      `get() 必须解析 workspace`,
    );
  });

  it("旧机器的同名目录会被搬过来，而不是丢下材料", function () {
    assert.match(session, /ioMoveChildren/, `必须有搬移旧目录内容的实现`);
    assert.match(
      session,
      /workspaceNameOf\(legacy\)\s*===\s*name/,
      `只搬同名目录（目录名以 item-/collection- 开头，跨机器稳定）`,
    );
  });

  it("跨设备导致的 cwd 冲突会被处理，而不是让用户发不出消息", function () {
    assert.match(
      transport,
      /session\/conflict/,
      `必须识别 cwd 冲突（dsh 的 ApiSessionCwdConflict 映射成这个错误码）`,
    );
    assert.match(
      transport,
      /onWorkspaceMigrated/,
      `重建后要回调，让界面能告诉用户原历史留在原机器`,
    );
    assert.match(pane, /pendingNotice/, `提示必须真的能到达用户眼前`);
  });

  it("会话页 URL 不含机器相关路径（跨设备仍然可用）", function () {
    const at = pane.indexOf("export function sessionViewerUrl");
    // ⚠️ 不能按第一个 `}` 截断：函数签名里 `record: SessionRecord` 后面紧跟 `)`，
    // 而返回的模板串本身不含 `}`；但先前按 `indexOf("}")` 抽到的是**参数对象**
    // 那一处，导致断言看到的是残缺片段。直接按函数体里的 return 行取。
    const body = pane.slice(at, at + 400);
    assert.match(body, /sessionId/, `URL 应只依赖 sessionId`);
    assert.ok(
      !/workspace|dshHome/.test(body),
      `会话页 URL 不得含任何机器相关路径（否则换机器就打不开）`,
    );
  });
});

describe("harness 状态监测（用户反馈：被误判为一轮结束）", function () {
  const transport = read("src/chat/transport.ts");
  const state = read("src/chat/state.ts");

  it("超时前先问 harness 还在不在跑，而不是直接宣布结束", function () {
    assert.match(
      transport,
      /harnessRunning/,
      `必须用 session/list 的 running 字段判断真实状态`,
    );
    const poll = transport.slice(transport.indexOf("private async pollOnce"));
    const head = poll.slice(0, poll.indexOf("try {"));
    assert.match(
      head,
      /harnessRunning/,
      `POLL_MAX_MS 到点后必须先查 harness 状态`,
    );
    assert.ok(
      !/outcome:\s*"abandoned"/.test(head),
      `不再用 abandoned 表示等够了 —— 那会让用户以为这一轮结束了`,
    );
  });

  it("问不到状态时保守处理为仍在跑", function () {
    assert.match(
      transport,
      /state === false/,
      `只有 harness 明确说不在跑，才认为这一轮结束`,
    );
    assert.match(
      transport,
      /extendPollingDeadline/,
      `仍在跑时要延长盯守而不是放弃`,
    );
  });

  it("会发一条仍在生成的说明，且每轮只发一次", function () {
    assert.match(state, /assistant-note/, `必须有这个事件类型`);
    assert.match(
      transport,
      /longRunNoticeSent/,
      `提示只发一次（每轮都发会把提示区刷满）`,
    );
    assert.match(
      transport,
      /this\.longRunNoticeSent = false;/,
      `每轮开始时必须重置，否则第二轮不再提醒`,
    );
  });

  it("abandoned 的文案不再说已放弃（那会被理解为这一轮结束了）", function () {
    assert.ok(
      !/本次生成未完成（已放弃）/.test(state),
      `旧文案误导：它说的只是插件停止等待，不是 harness 停了`,
    );
    assert.match(state, /harness 那边可能仍在继续生成/, `新文案要说明真实情况`);
  });
});

describe("collection.md 实时更新（用户反馈：多轮对话被误判）", function () {
  const pane = read("src/modules/sessionPane.ts");

  it("写操作之后会重写分类清单", function () {
    assert.match(
      pane,
      /refreshWorkspaceMaterialsAfterWrite/,
      `写操作后必须刷新材料，否则 Agent 读到的永远是建会话时的快照`,
    );
    assert.match(
      pane,
      // ⚠️ 不能要求单行：prettier 会把参数换行。
      // 断言应只看行为（调用发生了、参数对不对），不该被排版左右。
      /await this\.refreshWorkspaceMaterialsAfterWrite\(\s*record,\s*parsed\.call\.op,?\s*\)/,
      `必须在工具执行后调用`,
    );
  });

  it("只有会改变清单的写操作才刷新（读操作白刷是浪费）", function () {
    const fn = pane.slice(
      pane.indexOf("private async refreshWorkspaceMaterialsAfterWrite"),
    );
    const guard = fn.slice(0, fn.indexOf("const records"));
    assert.match(guard, /op !== "setTags"/, `setTags 要刷新`);
    assert.match(guard, /op !== "addToCollection"/, `addToCollection 要刷新`);
    assert.ok(
      !/getFullText|search|listItems/.test(guard),
      `读操作不该触发刷新`,
    );
  });

  it("同一工作区的所有会话都要刷新（它们共用一份 collection.md）", function () {
    const fn = pane.slice(
      pane.indexOf("private async refreshWorkspaceMaterialsAfterWrite"),
    );
    assert.match(
      fn,
      /r\.workspace === record\.workspace/,
      `真机上有 9 个会话共用同一工作区，只刷发起调用的那个会让另一个继续看旧数据`,
    );
  });

  it("清单里带生成时间，Agent 能看出它是实时的", function () {
    const fn = pane.slice(
      pane.indexOf("async function writeCollectionListing"),
    );
    assert.match(fn, /每次写操作后自动重写/, `要写明这份清单是实时的`);
  });
});

describe("新手引导页（用户反馈：整页露出代码）", function () {
  const src = read("addon/content/onboarding.xhtml");

  it("是合法 XML：有 XML 声明、无 HTML5 doctype", function () {
    // 真机故障：整页显示为纯文本（连 style 与 script 的注释都可见），
    // 说明它没有被当作文档解析。对照本项目里确实能渲染的两个页面：
    // 它们都没有 HTML5 doctype，而 Zotero 自己的 xhtml 对话框全都有 XML 声明。
    assert.match(src, /^<\?xml version="1\.0"/, `首行必须是 XML 声明`);
    // ⚠️ 必须剥掉注释再查：**注释里会解释"为什么删掉了那个 doctype"**，
    // 因而必然包含这段文字。第一版没剥，被自己的说明拦下。
    const withoutComments = src.replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(
      !/<!DOCTYPE/i.test(withoutComments),
      `正文里不得有 doctype —— 它由 openDialog 按 XML 解析，HTML5 的 doctype 名指的不是 XHTML 的 DTD`,
    );
    assert.match(
      withoutComments,
      /<html[^>]*xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/,
      `必须声明 XHTML 命名空间`,
    );
  });

  it("不再声称结构照搬 session.xhtml（两者加载方式不同）", function () {
    assert.ok(
      !/结构照搬 `session\.xhtml`/.test(src),
      `那句在修复后已不成立 —— 注释必须反映真实现状`,
    );
  });
});
