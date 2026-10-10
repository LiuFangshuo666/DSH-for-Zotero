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
