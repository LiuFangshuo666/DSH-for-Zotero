/**
 * 内置伴读指令：五条一键动作的提示词与输出结构约定。
 *
 * 为什么单独成模块：这几条指令决定回答质量的上限，也是"产品感"的主要来源，
 * 因此做成**纯函数 + 可单测**，而不是散落在面板事件回调里拼字符串。
 *
 * 设计约束：
 *  - 每条指令都要求结构化输出（AI 学术问答最常见的问题是"正确的废话"）；
 *  - 每条都必须重申"材料里没有就说未提及"，因为 dsh 的 Remote 接口没有
 *    system prompt 字段，约束只能在每次提问里重复（见 docs/DSH集成与桥接协议.md §5.1）。
 */

export interface ReadingCommand {
  id: string;
  /** 按钮文字（面板工具条用） */
  label: string;
  /** 鼠标悬停说明 */
  hint: string;
  /** 结构化输出要求（拼进提示词的【我的问题】段） */
  instruction: string;
}

/** 所有指令都带上的共性约束 */
export const COMMON_CONSTRAINTS = [
  '只依据我提供的材料作答；材料里没有的信息要明确写"论文未提及"，不要推测。',
  "引用原文用引号，并尽量标注页码或所在分块（页码为估算值）。",
  "区分论文的陈述与你的判断，后者要说明依据。",
].join("\n");

export const BUILTIN_COMMANDS: ReadingCommand[] = [
  {
    id: "summary",
    label: "速读摘要",
    hint: "一次性给出结论、问题、方法、结果与边界",
    instruction: [
      "请按下面五节输出这篇论文的速读摘要，每节 2–4 句，不要空话：",
      "① 一句话结论；② 研究问题/动机；③ 方法路线；④ 主要结果（带关键数据）；⑤ 适用边界与前提。",
      "最后单列一行：这篇论文是否值得精读，用一句话给出理由。",
    ].join("\n"),
  },
  {
    id: "method",
    label: "方法与创新点",
    hint: "拆解方法骨架，指出相对已有工作的差异",
    instruction: [
      "请拆解这篇论文的方法：",
      "① 方法骨架（分步骤，每步一句）；② 关键假设；③ 相对已有工作的差异点（创新在哪里）；④ 实现或复现时最容易踩坑的地方。",
      "若论文没有明确说明某一步，请指出该处信息缺失，不要替我补全。",
    ].join("\n"),
  },
  {
    id: "conclusion",
    label: "结论与证据",
    hint: "结论清单 + 支撑证据类型 + 证据弱点",
    instruction: [
      "请评估这篇论文的结论与证据：",
      "① 结论清单；② 每条结论对应的支撑证据类型（实验/仿真/理论推导/案例）；③ 证据的弱点（样本量、基线选择、评测指标、统计显著性等，能指出就指出）；④ 哪些结论属于超出证据的过度推断。",
    ].join("\n"),
  },
  {
    id: "terms",
    label: "术语与背景",
    hint: "术语表：原文术语 → 中文 → 一句话解释",
    instruction: [
      "请按两节输出：",
      "① 术语表（表格，三列：原文术语 / 中文 / 一句话解释），挑 8–15 个最影响理解的概念；",
      "② 研究背景（3–5 句，说明这篇论文所处的位置与它要解决的问题）。",
      "术语只列论文里真正出现的，不要补充论文没用到的相关概念。",
    ].join("\n"),
  },
  {
    id: "limits",
    label: "局限与疑点",
    hint: "作者自述局限 + 读者视角疑点 + 待查证项",
    instruction: [
      "请列出这篇论文的局限与可质疑之处：",
      "① 作者自己承认的局限；② 作者未提但你能看出的疑点（例如方法适用条件、评测覆盖、结论外推）；③ 需要我进一步查证文献才能判断的点。",
      "每条都要给出它出现在论文的哪个部分（摘要/方法/实验/结论），看不到依据就不要写。",
    ].join("\n"),
  },
];

export function findCommand(id: string): ReadingCommand | undefined {
  return BUILTIN_COMMANDS.find((c) => c.id === id);
}

/**
 * 把一条指令组装成送进会话的问题文本。
 * 会附带共性约束，保证任何入口（按钮/划词）都带同一套规矩。
 */
export function buildCommandQuestion(id: string): string | undefined {
  const command = findCommand(id);
  if (!command) return undefined;
  return `${command.instruction}\n\n【约束】\n${COMMON_CONSTRAINTS}`;
}

/** 用户自定义指令（设置项 `customCommands`，JSON 数组）→ 追加到内置之后 */
export function parseCustomCommands(raw: unknown): ReadingCommand[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const commands: ReadingCommand[] = [];
    for (const entry of parsed) {
      const record = entry as {
        id?: unknown;
        label?: unknown;
        instruction?: unknown;
        hint?: unknown;
      };
      const label =
        typeof record?.label === "string" ? record.label.trim() : "";
      const instruction =
        typeof record?.instruction === "string"
          ? record.instruction.trim()
          : "";
      if (!label || !instruction) continue;
      const id =
        typeof record?.id === "string" && record.id.trim()
          ? record.id.trim()
          : label;
      commands.push({
        id: `custom-${id}`,
        label,
        hint:
          typeof record?.hint === "string"
            ? record.hint
            : instruction.slice(0, 60),
        instruction,
      });
    }
    return commands;
  } catch {
    return [];
  }
}
