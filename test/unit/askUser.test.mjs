/**
 * `ask_user_question` 的解析与回答格式化。
 *
 * ## 为什么必须单测（这个 bug 的性质）
 *
 * 用户反复反馈"Agent 给了选项但我看不到"。根因**不是渲染不好看**，而是
 * 选项根本**没有被解析**：它们不在 `text` 块里，而在 `tool-call` 块的参数里，
 * 而取文只认 `text`。所以问题出在**数据层**，必须用测试钉住解析行为。
 *
 * 参数来自模型，形状不可全信：缺 `id`、`options` 不是数组、`multi_select` 拼错、
 * 参数是 JSON 字符串而不是对象 —— 这些都得容忍，且不能静默出错。
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
const { ASK_USER_TOOL, parseAskUserQuestions, formatAnswersForSteer } = bundle;

/** dsh 源码里 tool-ask-user 的真实参数形状 */
const REAL_ARGS = {
  questions: [
    {
      id: "scope",
      question: "标签体系按什么维度组织？",
      header: "选择模式",
      options: [
        {
          label: "阶段主导（推荐）",
          description: "按研发阶段聚类，检索时更直观",
        },
        { label: "主题主导", description: "按研究主题聚类，跨阶段可比" },
      ],
      multi_select: false,
    },
    {
      id: "apply",
      question: "确认后是否直接写入 Zotero？",
      options: [{ label: "直接写入" }, { label: "先给我看一遍" }],
    },
    { id: "free", question: "还有别的补充吗？" },
  ],
};

describe("ask_user_question 解析", function () {
  it("解析出问题、选项与多选标记", function () {
    const qs = parseAskUserQuestions(ASK_USER_TOOL, REAL_ARGS);
    assert.ok(qs, "应解析成功");
    assert.equal(qs.length, 3);
    assert.equal(qs[0].id, "scope");
    assert.equal(qs[0].header, "选择模式");
    assert.equal(qs[0].options.length, 2);
    assert.equal(qs[0].options[0].label, "阶段主导（推荐）");
    assert.equal(qs[0].options[0].description, "按研发阶段聚类，检索时更直观");
    assert.equal(qs[0].multiSelect, false);
    // 没有 options 的问题（纯自由回答）也要保留
    assert.equal(qs[2].options.length, 0);
  });

  it("**不是该工具**时返回 undefined（不能把所有工具调用都当提问）", function () {
    assert.equal(parseAskUserQuestions("read_file", REAL_ARGS), undefined);
    assert.equal(parseAskUserQuestions(undefined, REAL_ARGS), undefined);
  });

  it("容忍参数是 JSON 字符串（两种形态 dsh 都出现过）", function () {
    const qs = parseAskUserQuestions(ASK_USER_TOOL, JSON.stringify(REAL_ARGS));
    assert.equal(qs.length, 3);
  });

  it("JSON 坏掉时返回 undefined，而不是抛异常", function () {
    assert.equal(parseAskUserQuestions(ASK_USER_TOOL, "{不是 json"), undefined);
    assert.equal(parseAskUserQuestions(ASK_USER_TOOL, 42), undefined);
    assert.equal(
      parseAskUserQuestions(ASK_USER_TOOL, { questions: "不是数组" }),
      undefined,
    );
    assert.equal(
      parseAskUserQuestions(ASK_USER_TOOL, { questions: [] }),
      undefined,
    );
  });

  it("缺 question 的条目跳过，缺 id 的补序号（答案要靠 id 对应）", function () {
    const qs = parseAskUserQuestions(ASK_USER_TOOL, {
      questions: [
        { id: "有", question: "有效问题" },
        { question: "   " }, // 空白问题 → 跳过
        { question: "缺 id 但有效" },
      ],
    });
    assert.equal(qs.length, 2);
    assert.equal(qs[0].id, "有");
    assert.ok(qs[1].id, "缺 id 时要补一个，否则答案无法对应");
  });

  it("选项里缺 label 的跳过，非数组 options 视为无选项", function () {
    const qs = parseAskUserQuestions(ASK_USER_TOOL, {
      questions: [
        {
          id: "a",
          question: "Q",
          options: [{ description: "没有 label" }, { label: "好" }],
        },
        { id: "b", question: "Q2", options: "不是数组" },
      ],
    });
    assert.equal(qs[0].options.length, 1);
    assert.equal(qs[0].options[0].label, "好");
    assert.equal(qs[1].options.length, 0);
  });

  it("`multi_select` 与 `multiSelect` 两种拼写都认", function () {
    const snake = parseAskUserQuestions(ASK_USER_TOOL, {
      questions: [{ id: "a", question: "Q", multi_select: true }],
    });
    const camel = parseAskUserQuestions(ASK_USER_TOOL, {
      questions: [{ id: "a", question: "Q", multiSelect: true }],
    });
    assert.equal(snake[0].multiSelect, true);
    assert.equal(camel[0].multiSelect, true);
  });
});

describe("回答格式化", function () {
  const qs = parseAskUserQuestions(ASK_USER_TOOL, REAL_ARGS);

  it("给出可读摘要与结构化 JSON（模型两种都能读懂）", function () {
    const text = formatAnswersForSteer(qs, {
      scope: { selected: ["阶段主导（推荐）"] },
      free: { selected: [], custom: "顺便把年份也归一化" },
    });
    // 摘要：人一眼看懂选了什么
    assert.match(text, /标签体系按什么维度组织？/);
    assert.match(text, /阶段主导（推荐）/);
    assert.match(text, /顺便把年份也归一化/);
    // JSON：模型能精确对应 id
    assert.match(text, /"id":"scope"/);
    assert.match(text, /"selected":\["阶段主导（推荐）"\]/);
    assert.match(text, /"custom":"顺便把年份也归一化"/);
  });

  it("没回答的问题不出现在结果里（保证 answers 与已答项一一对应）", function () {
    const text = formatAnswersForSteer(qs, {
      scope: { selected: ["主题主导"] },
    });
    assert.ok(!text.includes('"id":"apply"'), "未回答的问题不应出现");
    const json = JSON.parse(text.split("\n").pop());
    assert.equal(json.answers.length, 1);
  });

  it("空选择也不崩（structured answer 里 selected 允许为空数组）", function () {
    const text = formatAnswersForSteer(qs, { scope: { selected: [] } });
    assert.match(text, /"selected":\[\]/);
  });
});
