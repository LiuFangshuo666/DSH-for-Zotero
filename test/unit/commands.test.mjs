/**
 * 内置伴读指令的测试。
 *
 * 这些指令决定回答质量的上限，所以关键性质都要固定下来：
 * 五条齐全、每条都有结构化要求、都带共性约束（不编造/标页码/区分陈述与判断）。
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const commands = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  BUILTIN_COMMANDS,
  buildCommandQuestion,
  findCommand,
  parseCustomCommands,
} = commands;

describe("内置指令集", function () {
  it("恰好五条，且 id 唯一", function () {
    assert.equal(BUILTIN_COMMANDS.length, 5);
    assert.equal(new Set(BUILTIN_COMMANDS.map((c) => c.id)).size, 5);
  });

  it("包含约定的五条：速读/方法/结论/术语/局限", function () {
    assert.deepEqual(
      BUILTIN_COMMANDS.map((c) => c.id),
      ["summary", "method", "conclusion", "terms", "limits"],
    );
  });

  it("每条都有按钮文字、悬停说明与结构化输出要求", function () {
    for (const command of BUILTIN_COMMANDS) {
      assert.ok(command.label.length >= 2, `${command.id} 缺 label`);
      assert.ok(command.hint.length >= 4, `${command.id} 缺 hint`);
      // 结构化：至少出现两个分节标记（① 或 1. 之类）
      const markers = (command.instruction.match(/[①②③④⑤]|^\d\./gm) ?? [])
        .length;
      assert.ok(
        markers >= 2,
        `${command.id} 缺少结构化输出要求（找到 ${markers} 个分节标记）`,
      );
    }
  });

  it("组装后的问题一定带共性约束", function () {
    for (const command of BUILTIN_COMMANDS) {
      const question = buildCommandQuestion(command.id);
      assert.ok(question, `${command.id} 应能组装`);
      assert.match(question, /论文未提及/);
      assert.match(question, /页码/);
      assert.match(question, /区分论文的陈述与你的判断/);
      // 约束段必须与指令本体分开，便于阅读
      assert.match(question, /【约束】/);
    }
  });

  it("未知 id 返回 undefined，不抛错", function () {
    assert.equal(buildCommandQuestion("does-not-exist"), undefined);
    assert.equal(findCommand("does-not-exist"), undefined);
  });

  it("findCommand 能按 id 取回", function () {
    assert.equal(findCommand("terms")?.label, "术语与背景");
  });
});

describe("自定义指令解析", function () {
  it("解析合法 JSON 数组并加 custom- 前缀", function () {
    const parsed = parseCustomCommands(
      JSON.stringify([
        { label: "审稿视角", instruction: "像审稿人一样列出三条主要意见" },
        {
          id: "bib",
          label: "找参考文献",
          instruction: "列出可延伸阅读的方向",
          hint: "延伸阅读",
        },
      ]),
    );
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, "custom-审稿视角");
    assert.equal(parsed[1].id, "custom-bib");
    assert.equal(parsed[1].hint, "延伸阅读");
  });

  it("缺少 label 或 instruction 的条目被丢弃", function () {
    const parsed = parseCustomCommands(
      JSON.stringify([
        { label: "只有标题" },
        { instruction: "只有说明" },
        { label: "完整", instruction: "有说明" },
      ]),
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].label, "完整");
  });

  it("非法输入一律返回空数组，不抛错", function () {
    for (const input of [
      "",
      "   ",
      "not json",
      "{}",
      "[]",
      '{"label":"x"}',
      null,
      undefined,
      42,
    ]) {
      assert.deepEqual(
        parseCustomCommands(input),
        [],
        `input=${String(input)}`,
      );
    }
  });

  it("hint 缺省时用 instruction 前缀兜底", function () {
    const parsed = parseCustomCommands(
      JSON.stringify([
        { label: "L", instruction: "这是一段很长的说明文字用来测试兜底行为" },
      ]),
    );
    assert.ok(parsed[0].hint.length > 0);
    assert.ok(parsed[0].hint.length <= 60);
  });
});
