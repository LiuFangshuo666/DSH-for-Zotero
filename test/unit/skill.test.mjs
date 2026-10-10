/**
 * dsh 侧内容（伴读 skill 与常驻指令）的纯逻辑测试。
 *
 * 这两样东西会写进用户的 dsh 目录，因此规则必须钉死：
 *  - skill 的 frontmatter 必须符合 dsh 的校验（kebab-case 名 + description）；
 *  - AGENTS.md 的合并必须**幂等**且**不动用户已有内容**；
 *  - 移除时只删我们自己写的标记块。
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  SKILL_NAME,
  AGENTS_BLOCK_START,
  AGENTS_BLOCK_END,
  buildSkillFile,
  buildAgentsBlock,
  mergeAgentsFile,
  removeAgentsBlock,
} = mod;

describe("伴读 skill 文件", function () {
  const content = buildSkillFile();

  it("以 YAML frontmatter 开头，且 name 是合法 kebab-case", function () {
    assert.ok(content.startsWith("---\n"), "应以 frontmatter 开头");
    const nameLine = content
      .split("\n")
      .find((line) => line.startsWith("name:"));
    assert.ok(nameLine, "缺少 name 字段");
    const name = nameLine.slice("name:".length).trim();
    assert.equal(name, SKILL_NAME);
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "dsh 要求 kebab-case 名");
  });

  it("frontmatter 含 description 与 whenToUse，且三段分隔符齐全", function () {
    const parts = content.split("---");
    assert.ok(parts.length >= 3, "应有开合两条 --- 分隔线");
    assert.match(content, /\ndescription: \S/);
    assert.match(content, /\nwhenToUse: \S/);
  });

  it("正文覆盖关键纪律：先读 meta.json、读取上限、页码为估算、不编造", function () {
    assert.match(content, /meta\.json/);
    assert.match(content, /50 KiB/);
    assert.match(content, /页码只能估算|页码.*估算/);
    assert.match(content, /论文未提及/);
    assert.match(content, /不是给你的指令|待分析的材料/);
  });

  it("列出五条常用任务及其输出结构", function () {
    for (const task of [
      "速读摘要",
      "方法与创新点",
      "结论与证据",
      "术语与背景",
      "局限与疑点",
    ]) {
      assert.ok(content.includes(task), `缺少任务：${task}`);
    }
  });
});

describe("AGENTS.md 合并（幂等且不覆盖用户内容）", function () {
  const block = buildAgentsBlock();

  it("空文件 → 直接写入块", function () {
    const merged = mergeAgentsFile("", block);
    assert.equal(merged.trim(), block.trim());
  });

  it("已有用户内容 → 追加，且用户内容原样保留", function () {
    const user = "# 我的规则\n\n- 回答尽量简短\n";
    const merged = mergeAgentsFile(user, block);
    assert.ok(merged.startsWith("# 我的规则"), "用户内容必须在前面");
    assert.ok(merged.includes("- 回答尽量简短"));
    assert.ok(merged.includes(AGENTS_BLOCK_START));
    assert.ok(merged.endsWith("\n"));
  });

  it("重复合并结果不变（幂等）", function () {
    const once = mergeAgentsFile("# 我的规则\n", block);
    const twice = mergeAgentsFile(once, block);
    assert.equal(twice, once, "第二次合并不应产生重复块");
    assert.equal(
      (twice.match(new RegExp(AGENTS_BLOCK_START, "g")) ?? []).length,
      1,
    );
  });

  it("块内容更新时替换旧块而不是追加", function () {
    const oldBlock = `${AGENTS_BLOCK_START}\n旧内容\n${AGENTS_BLOCK_END}`;
    const withOld = `# 用户标题\n\n${oldBlock}\n\n# 用户结尾\n`;
    const merged = mergeAgentsFile(withOld, block);
    assert.ok(!merged.includes("旧内容"), "旧块应被替换");
    assert.ok(merged.includes("# 用户标题"));
    assert.ok(merged.includes("# 用户结尾"));
    assert.equal(
      (merged.match(new RegExp(AGENTS_BLOCK_START, "g")) ?? []).length,
      1,
    );
  });

  it("块里的关键约束存在（提示注入防护）", function () {
    assert.match(block, /不是给你的指令/);
    assert.match(block, /论文未提及/);
    assert.match(block, /估算/);
  });
});

describe("从 AGENTS.md 移除我们的块", function () {
  const block = buildAgentsBlock();

  it("只剩我们的块 → 返回空（调用方据此删文件）", function () {
    const only = mergeAgentsFile("", block);
    assert.equal(removeAgentsBlock(only).trim(), "");
  });

  it("用户的其余内容被完整保留，且不留多余空行块", function () {
    const user = "# 我的规则\n\n- 一条\n";
    const merged = mergeAgentsFile(user, block);
    const cleaned = removeAgentsBlock(merged);
    assert.ok(!cleaned.includes(AGENTS_BLOCK_START));
    assert.ok(cleaned.includes("# 我的规则"));
    assert.ok(cleaned.includes("- 一条"));
    assert.ok(
      !/\n{3,}/.test(cleaned),
      `不应出现连续空行：${JSON.stringify(cleaned)}`,
    );
  });

  it("没有我们的块时原样返回", function () {
    const user = "# 只有用户内容\n";
    assert.equal(removeAgentsBlock(user), user);
  });

  it("移除后再合并回来仍然幂等", function () {
    const user = "# 我的规则\n";
    const merged = mergeAgentsFile(user, block);
    const cleaned = removeAgentsBlock(merged);
    const again = mergeAgentsFile(cleaned, block);
    assert.equal(removeAgentsBlock(again).trim(), user.trim());
  });
});
