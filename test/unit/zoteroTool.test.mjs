/**
 * 测试：Zotero 工具调用协议（解析与参数取值）。
 *
 * ## 为什么纯逻辑部分必须单测
 *
 * 这段代码的输入是**模型写的 JSON**，而输出决定它能不能正确调用 Zotero。
 * 模型写错形状是常态，所以：
 *  - 解析必须**宽容但明确报错**，且错误信息要能指导它改（否则它会反复试同一个错形状）；
 *  - 参数取值不能抛异常（一个坏参数不该让整次调用崩掉）；
 *  - **删除类操作必须被识别为 destructive** —— 这是「仅删除需确认」的安全边界，
 *    识别错了就等于让模型直接删库。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  parseToolCall,
  isKnownOp,
  isDestructiveOp,
  argString,
  argStringArray,
  argInt,
  describeOps,
  READ_OPS,
  WRITE_OPS,
  DESTRUCTIVE_OPS,
} = bundle;

describe("工具调用解析", function () {
  it("解析合法调用", function () {
    const r = parseToolCall('{"id":"1","op":"search","args":{"query":"RTL"}}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.call, { id: "1", op: "search", args: { query: "RTL" } });
  });

  it("args 可省略（无参操作）", function () {
    const r = parseToolCall('{"id":"2","op":"listItems"}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.call.args, {});
  });

  it("非法 JSON 报错并给出正确形状", function () {
    const r = parseToolCall("{不是 json");
    assert.equal(r.ok, false);
    assert.match(r.error, /不是合法 JSON/);
    assert.match(r.error, /"op"/, "错误信息里要示范正确的键名");
  });

  it("未知操作时列出全部可用操作（模型据此自我修正）", function () {
    const r = parseToolCall('{"id":"3","op":"deleteEverything"}');
    assert.equal(r.ok, false);
    assert.match(r.error, /未知操作/);
    for (const op of [...READ_OPS, ...WRITE_OPS, ...DESTRUCTIVE_OPS]) {
      assert.ok(r.error.includes(op), `错误信息里应列出 ${op}`);
    }
  });

  it("缺 id 时明确要求给唯一标识", function () {
    const r = parseToolCall('{"op":"listItems"}');
    assert.equal(r.ok, false);
    assert.match(r.error, /id/);
  });

  it("args 不是对象时报错", function () {
    const r = parseToolCall('{"id":"4","op":"search","args":["RTL"]}');
    assert.equal(r.ok, false);
    assert.match(r.error, /args 必须是对象/);
  });

  it("顶层不是对象时报错", function () {
    assert.equal(parseToolCall('["a"]').ok, false);
    assert.equal(parseToolCall('"x"').ok, false);
  });
});

describe("操作分类（安全边界）", function () {
  it("结构性改动必须被识别为 destructive —— 这是「需确认」的边界", function () {
    for (const op of DESTRUCTIVE_OPS) {
      assert.equal(isDestructiveOp(op), true, `${op} 必须被当作需确认的操作`);
    }
  });

  it("**新建条目**也必须走确认（它不是删除，但会永久改动文库结构）", function () {
    // 用户的安全边界是"读+写自由，仅删除需确认"。
    // 新建条目属于**结构性改动**：建错（重复条目、错误类型）比改错标签难清理。
    // 这条断言防的是"以后有人觉得 createItem 不是删除、顺手从列表里拿掉"。
    assert.ok(
      DESTRUCTIVE_OPS.includes("createItem"),
      "createItem 必须在需要确认的清单里 —— 否则 Agent 能不经确认就往文库塞条目",
    );
    assert.equal(isDestructiveOp("createItem"), true);
  });

  it("读与写**不是** destructive（否则每次都要用户确认，失去意义）", function () {
    for (const op of [...READ_OPS, ...WRITE_OPS]) {
      assert.equal(isDestructiveOp(op), false, `${op} 不该被当作删除类`);
    }
  });

  it("三组操作不重叠", function () {
    const all = [...READ_OPS, ...WRITE_OPS, ...DESTRUCTIVE_OPS];
    assert.equal(new Set(all).size, all.length, "操作名不得重复");
    for (const op of all) assert.equal(isKnownOp(op), true);
    assert.equal(isKnownOp("nope"), false);
  });

  it("**attachPdf 必须存在**，且必须走确认（真机事故的根因）", function () {
    // ## 为什么这条测试值得单独写
    //
    // 真机事故：用户要"给分类下的条目逐一补全文"，而当时插件**没有这个 op**。
    // Agent 没有停下来问，而是往下找了一层 —— 发现 Zotero 自己的本地 HTTP API
    // 能写库，于是**在后台进程里绕过插件**批量写入了 75 个附件：
    // 全程没有确认，界面上也没有任何提示，用户是翻 storage 目录才发现的。
    //
    // 教训：**功能没给够，边界就守不住。** 缺一个 op 不会让 Agent 停手，
    // 只会让它绕路。所以：
    //  - op 必须**存在**（否则同样的绕路会重演）；
    //  - 且必须**需要确认**（它是结构性改动：下载文件 + 在库里新增附件条目）。
    assert.ok(
      isKnownOp("attachPdf"),
      "attachPdf 必须是一个已知 op —— 没有它，Agent 会去用 Zotero 的本地 API 绕过插件",
    );
    assert.equal(
      isDestructiveOp("attachPdf"),
      true,
      "attachPdf 必须走确认：它会下载文件并在库里新增附件条目",
    );
  });

  it("操作说明里必须写明 attachPdf 该用于「给已存在条目补全文」", function () {
    // 说明与实现同源：不说清"补全文用这个 op"，Agent 就还会去找别的办法。
    const doc = describeOps();
    assert.ok(doc.includes("attachPdf"), "操作说明里必须有 attachPdf");
    assert.match(
      doc,
      /已存在的条目|已存在/,
      "必须点明它用于**已存在**的条目（createItem 只管新建）",
    );
    assert.match(
      doc,
      /不要用别的办法|本地 HTTP API|127\.0\.0\.1:23119/,
      "必须明确禁止绕路（真机就是这么绕的）",
    );
  });
});

describe("操作说明：getFullText 的“没有全文”是状态而非失败", function () {
  it("说明里必须写明用 `有全文` 判断，不要靠 catch", function () {
    // 真机反馈：用户要"找出哪些条目没有全文"，
    // 而 Agent 只能逐条试探 —— 255 条里约 150 条抛错，
    // 日志被“工具调用失败”刷满，又慢又吵。
    // 现在改为返回状态，说明必须跟上 —— 否则模型还以为会抛错。
    const doc = describeOps();
    assert.match(doc, /`有全文`/, "必须点明 `有全文` 字段");
    assert.match(
      doc,
      /正常结果，不是失败/,
      "必须明确说“没有全文”是**正常结果**，而不是失败",
    );
    assert.match(
      doc,
      /attachPdf/,
      "必须指出补全文该用 attachPdf（而不是自己找 PDF）",
    );
  });
});

/**
 * ## 用户确认 / 拒绝之后，Agent 必须能**看到结果**
 *
 * 用户实测："我确认完条目后，Agent 貌似无法直观地知道，从我给出的真实会话记录中就能看出来。"
 *
 * 查下来有两个缺陷，合起来让它只能靠猜：
 *
 * 1. **回执只有一个文件、每次覆盖写** —— 一键确认 10 条补全文后，
 *    `deletion-result.json` 里只剩最后一条（真机实测确实只有 1 条）。
 * 2. **用户"拒绝"时根本不写回执**（`dismissPendingDeletion` 只改内存数组）——
 *    于是无论用户确认还是拒绝，Agent 都**永远等不到答复**。
 *
 * 修法：追加式历史 `confirm-log.json`（确认与拒绝都记）+ 带 `待确认剩余`；
 * 老的 `deletion-result.json` 继续写，避免让已有会话的 Agent 失灵。
 */
describe("确认回执：Agent 怎么知道用户决定了什么", function () {
  it("说明里必须点名 \u0060confirm-log.json\u0060，并说清它与旧文件的分工", function () {
    const doc = describeOps();
    assert.match(
      doc,
      /confirm-log\.json/,
      "必须告诉 Agent 回执文件叫什么 —— 文件存在但它不知道，等于不存在",
    );
    assert.match(
      doc,
      /deletion-result\.json/,
      "也要点明旧文件（只留最新一条），否则它会以为那是全部结果",
    );
  });

  it("必须告诉 Agent \u0060待确认剩余\u0060 的含义（用它区分\u201c还没决定\u201d与\u201c决定了\u201d）", function () {
    const doc = describeOps();
    assert.match(
      doc,
      /待确认剩余/,
      "这是 Agent 最缺的一条信息：它是判断用户是否处理完的唯一依据",
    );
  });

  it("必须明确劝阻\u201c靠反复提交来试探\u201d", function () {
    // 重复提交会让用户在确认区看到一堆重复项（README 里早有这条纪律）
    const doc = describeOps();
    assert.match(
      doc,
      /不要为此重新提交|不要靠反复提交/,
      "要明确说\u201c读回执\u201d而不是\u201c重新提交\u201d",
    );
  });
});

/**
 * ## 三份操作清单必须**同源**（审计发现的漂移风险）
 *
 * 同一个能力会在三个地方各写一遍：
 *  1. `zoteroTool.ts` 的 `READ_OPS`/`WRITE_OPS`/`DESTRUCTIVE_OPS`（实现契约）
 *  2. `describeOps()`（模型读的第一手说明）
 *  3. 工作区 README 的能力索引（`sessionPane.ts` 的 `buildWorkspaceReadme`）
 *
 * 三份都是**手写**的，所以新增一个 op 时很容易只改一处。
 * 这次审计就是这样发现漏项的（README 的能力表一度没有 `attachPdf`）。
 * 这条守卫只钉"每个 op 名至少出现在另外两份里"，不比对措辞（措辞会变）。
 */
describe("三份操作清单同源", function () {
  const ops = [...READ_OPS, ...WRITE_OPS, ...DESTRUCTIVE_OPS];

  it("每个 op 都必须出现在 describeOps() 里", function () {
    const doc = describeOps();
    const missing = ops.filter((op) => !doc.includes("`" + op + "`"));
    assert.deepEqual(
      missing,
      [],
      "这些 op 没写进 describeOps：" + missing.join(", "),
    );
  });

  it("每个 op 都必须出现在工作区 README 的能力索引里", function () {
    // 能力索引是 buildWorkspaceReadme 拼出来的一段 markdown
    const src = readFileSync(
      join(here, "..", "..", "src", "modules", "sessionPane.ts"),
      "utf8",
    );
    // ⚠️ 必须匹配**函数定义行**，不能只搜名字 ——
    // `indexOf` 会命中文件头注释里那句"buildWorkspaceReadme / populateWorkspace …"，
    // 于是切出一段毫不相干的文本，13 个 op 全报"缺失"（我第一版就是这样误报的）。
    const m = /^export function buildWorkspaceReadme\(/m.exec(src);
    assert.ok(m, "找不到 buildWorkspaceReadme 的定义");
    // 取到下一个顶层 export 为止
    const rest = src.slice(m.index);
    const nextTop = rest
      .slice(1)
      .search(/\nexport (function|const|async|type|interface) /);
    const seg = nextTop > 0 ? rest.slice(0, nextTop) : rest;
    const missing = ops.filter((op) => !seg.includes(op));
    assert.deepEqual(
      missing,
      [],
      "这些 op 没写进工作区 README 的能力索引：" + missing.join(", "),
    );
  });
});

describe("参数取值（不能抛异常）", function () {
  it("字符串：去空白；空串与错类型都当没给", function () {
    assert.equal(argString({ q: " RTL " }, "q"), "RTL");
    assert.equal(argString({ q: "   " }, "q"), undefined);
    assert.equal(argString({ q: 42 }, "q"), undefined);
    assert.equal(argString({}, "q"), undefined);
  });

  it("字符串数组：容忍单个字符串；过滤非字符串与空项", function () {
    assert.deepEqual(argStringArray({ t: "a" }, "t"), ["a"]);
    assert.deepEqual(argStringArray({ t: ["a", " b ", 3, ""] }, "t"), [
      "a",
      "b",
    ]);
    assert.deepEqual(argStringArray({ t: [] }, "t"), []);
    assert.equal(argStringArray({ t: 5 }, "t"), undefined);
  });

  it("整数：容忍字符串数字；小数截断", function () {
    assert.equal(argInt({ n: 20 }, "n"), 20);
    assert.equal(argInt({ n: "20" }, "n"), 20);
    assert.equal(argInt({ n: 20.7 }, "n"), 20);
    assert.equal(argInt({ n: "abc" }, "n"), undefined);
    assert.equal(argInt({ n: -1.5 }, "n"), -1);
  });
});

describe("操作说明与实现同源", function () {
  it("说明里列出全部操作（避免文档与实现不一致）", function () {
    const text = describeOps();
    for (const op of [...READ_OPS, ...WRITE_OPS, ...DESTRUCTIVE_OPS]) {
      assert.ok(text.includes(op), `操作说明里应包含 ${op}`);
    }
  });

  it("说明里点明删除类不会立即执行", function () {
    assert.match(describeOps(), /pending/);
  });
});
