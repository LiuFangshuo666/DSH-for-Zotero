/**
 * ## 会话归档：跨设备可读的那一半
 *
 * Zotero 的同步只带**文献库对象**，不带插件的会话记录与工作区文件。所以换台机器
 * 打开同一篇文献，会话是空的 —— 而用户的心智模型是"库都同步了，对话也该在"。
 *
 * 归档把对话写成 **Zotero 笔记**放进库，让 Zotero 自己的同步带走。
 *
 * ## 为什么是笔记而不是附件（这条是设计决定，不是实现细节）
 *
 * 附件是**文件**：没开 Zotero 文件同步（或 Storage 配额满）时，
 * 设备 A 归档成功，设备 B 只收到元数据、文件不在，双击报"找不到文件"。
 * 那是一种**看起来成功了**的失败 —— 本项目最怕这种。
 * 笔记是**数据**，随条目一起同步，永远会到。
 *
 * ## 这组用例守什么
 *
 * 1. **绝不静默截断**：长会话切成多篇，但每一轮的正文都必须完整出现在某一篇里。
 *    截断会造成"归档成功但内容是残的"，而用户不会逐字校对。
 * 2. **必须写明"只读快照"**：不写的话，用户会以为能在另一台机器上接着原会话聊。
 * 3. **HTML 必须转义**：笔记是 XHTML，未转义的 `<` 会让整篇结构坏掉。
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
const { escapeHtml, buildArchiveParts, archiveNoteTitle, NOTE_CHAR_BUDGET } =
  bundle;

const meta = {
  sessionId: "session-abc",
  scopeTitle: "某篇论文",
  title: "关于注意力的讨论",
  archivedAt: 1760000000000,
  timeZone: "Asia/Shanghai",
};

describe("会话归档的笔记生成", function () {
  it("HTML 转义必须覆盖五个字符（笔记是 XHTML）", function () {
    assert.equal(
      escapeHtml(`<b>&"'`),
      "&lt;b&gt;&amp;&quot;&#39;",
      "未转义的 < 会破坏整篇笔记结构",
    );
  });

  it("一轮问答生成一篇，标题含会话名", function () {
    const parts = buildArchiveParts(meta, [
      { prompt: "问题一", response: "回答一" },
    ]);
    assert.equal(parts.length, 1);
    assert.match(parts[0], /<h1>/, "笔记标题用 h1（Zotero 从首行取标题）");
    assert.ok(parts[0].includes("关于注意力的讨论"));
    assert.ok(parts[0].includes("问题一"));
    assert.ok(parts[0].includes("回答一"));
  });

  it("**必须写明这是只读快照**（否则用户以为能跨机器续写）", function () {
    const parts = buildArchiveParts(meta, [{ prompt: "q", response: "a" }]);
    assert.match(
      parts.join(""),
      /只读/,
      "不写清楚，用户会以为能在另一台机器接着原会话聊 —— " +
        "而 dsh 会话的工作目录创建时固定，跨机器无法接续",
    );
  });

  it("模型标签有就写、没有就不留空壳", function () {
    const withModel = buildArchiveParts(
      {
        ...meta,
        modelLabel: "deepseek-official/deepseek-flash（推理强度 high）",
      },
      [{ prompt: "q", response: "a" }],
    ).join("");
    assert.ok(withModel.includes("deepseek-official/deepseek-flash"));

    const without = buildArchiveParts(meta, [
      { prompt: "q", response: "a" },
    ]).join("");
    assert.ok(
      !without.includes("<strong>模型</strong>"),
      "没选过模型时不该有这一行",
    );
  });

  it("空回答不留空白（写一句说明，而不是空段落）", function () {
    const parts = buildArchiveParts(meta, [{ prompt: "q", response: "" }]);
    assert.match(parts.join(""), /没有文字回答/);
  });

  it("**分篇不丢内容**：每一轮的正文都必须完整出现在某一篇里", function () {
    // 构造超过预算的会话：每轮 ~4 万字符 × 10 轮
    const filler = "字".repeat(40000);
    const turns = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push({
        prompt: `【问题${i}】${filler}`,
        response: `【回答${i}】${filler}`,
      });
    }
    const parts = buildArchiveParts(meta, turns);
    assert.ok(
      parts.length > 1,
      "超过预算时应分篇（否则一篇笔记会大到卡住编辑器）",
    );

    const all = parts.join("");
    for (let i = 0; i < 10; i += 1) {
      assert.ok(all.includes(`【问题${i}】`), `第 ${i} 轮的问题丢了`);
      assert.ok(all.includes(`【回答${i}】`), `第 ${i} 轮的回答丢了`);
    }
    // 分篇编号要出现
    assert.match(all, /第 1 \/ \d+ 篇/);
  });

  it("每篇都不超出预算太多（单轮超预算时允许独占一篇）", function () {
    const filler = "字".repeat(40000);
    const turns = Array.from({ length: 10 }, (_, i) => ({
      prompt: `q${i}`,
      response: `${i}` + filler,
    }));
    const parts = buildArchiveParts(meta, turns);
    for (const part of parts) {
      assert.ok(
        part.length < NOTE_CHAR_BUDGET * 1.2,
        `有一篇 ${part.length} 字符，远超预算 ${NOTE_CHAR_BUDGET}`,
      );
    }
  });

  it("空会话也给出一篇（由调用方决定要不要建，不能崩）", function () {
    const parts = buildArchiveParts(meta, []);
    assert.equal(parts.length, 1);
    assert.match(parts[0], /<h1>/);
  });

  it("标题在多篇时带编号", function () {
    assert.equal(
      archiveNoteTitle(meta, 1, 3),
      "DSH 会话归档：关于注意力的讨论（1/3）",
    );
    assert.equal(
      archiveNoteTitle(meta, 1, 1),
      "DSH 会话归档：关于注意力的讨论",
    );
  });

  it("会话没有标题时退回范围标题，不留空标题", function () {
    const title = archiveNoteTitle(
      { ...meta, title: "", scopeTitle: "某篇论文" },
      1,
      1,
    );
    assert.ok(title.includes("某篇论文"));
  });
});
