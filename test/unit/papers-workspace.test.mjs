/**
 * 论文上下文供给的测试：分块策略与提示词组装。
 *
 * 这两件事直接决定 Agent 能不能拿到正确的材料、会不会被误导，
 * 也是本项目"上下文供给是技术核心"这一判断的落点。
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const papers = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const { baseName, buildPrompt, splitIntoChunks, workspaceDirName } = papers;

describe("路径取尾段", function () {
  it("同时支持 Windows 与 POSIX 分隔符", function () {
    assert.equal(baseName("C:\\a\\b\\paper.txt"), "paper.txt");
    assert.equal(baseName("/a/b/paper.txt"), "paper.txt");
    assert.equal(baseName("paper.txt"), "paper.txt");
    assert.equal(baseName("C:\\a\\b\\"), "b");
  });
});

describe("工作区目录命名", function () {
  it("使用 libraryID-itemKey，且过滤非法字符", function () {
    assert.equal(
      workspaceDirName({ itemID: 1, libraryID: 1, key: "ABCD1234" }),
      "1-ABCD1234",
    );
    assert.equal(
      workspaceDirName({ itemID: 2, libraryID: 3, key: "ab/cd:ef" }),
      "3-ab_cd_ef",
    );
  });

  it("超长 key 被截断到安全长度", function () {
    const name = workspaceDirName({
      itemID: 1,
      libraryID: 1,
      key: "x".repeat(200),
    });
    assert.ok(name.length <= 84, `实际 ${name.length}`);
  });
});

describe("全文分块", function () {
  it("按行边界切分，不丢内容", function () {
    const lines = Array.from({ length: 200 }, (_, i) => `第 ${i} 行的内容`);
    const text = lines.join("\n");
    const chunks = splitIntoChunks(text, 200);
    assert.ok(chunks.length > 1, "应切成多块");
    // 拼回去应与原文一致（行数相同）
    const joined = chunks.join("");
    assert.equal(joined.split("\n").filter((l) => l.length > 0).length, 200);
  });

  it("每块不超过阈值（允许单行超阈值）", function () {
    const text = Array.from(
      { length: 500 },
      (_, i) => `line-${i}-${"a".repeat(30)}`,
    ).join("\n");
    const chunks = splitIntoChunks(text, 500);
    for (const chunk of chunks) {
      // ⚠️ 必须按**字节**量，不能按 `chunk.length` —— 后者是 UTF-16 码元数。
      // 这条断言原先就是 `chunk.length <= 500 + 40`，于是**永远发现不了**
      // "中文被低估 3 倍"这个 bug（ASCII 用例下两者恰好接近）。
      assert.ok(
        new TextEncoder().encode(chunk).byteLength <= 500 + 40,
        `块字节数超出预期：${new TextEncoder().encode(chunk).byteLength}`,
      );
    }
  });

  it("**中文全文**的分块也不得超过阈值字节数（真机 bug 的回归）", function () {
    // 真机 bug：早先按 `line.length` 当字节数，对中文低估约 3 倍 ——
    // 配置 40 KiB 却产出 ~120 KiB 的分块，而 dsh 的 `read` 单次上限是
    // **51200 字节（50 KiB）**，于是**一个分块一次读不完**，
    // 而分块的全部意义正是"每次读一块刚好读得完"。
    const line = "这是第 N 行中文内容，用于验证分块按 UTF-8 字节计算。";
    const text = Array.from({ length: 2000 }, (_, i) =>
      line.replace("N", String(i)),
    ).join("\n");
    const limit = 40960; // prefs.js 的 chunkBytes 默认值
    const chunks = splitIntoChunks(text, limit);
    assert.ok(chunks.length > 1, "中文长文应切成多块");
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(chunk).byteLength;
      assert.ok(bytes <= limit, `中文块 ${bytes} 字节超过阈值 ${limit}`);
      // 这才是真正要守的：不能超过 dsh read 的硬上限
      assert.ok(
        bytes <= 51200,
        `中文块 ${bytes} 字节超过 read 的 51200 上限 —— Agent 读不完`,
      );
    }
  });

  it("空文本返回单块而不是空数组", function () {
    assert.deepEqual(splitIntoChunks("", 100), [""]);
    assert.equal(splitIntoChunks("short", 100).length, 1);
  });

  it("单个超长行不会造成死循环，且被单独成块", function () {
    const hugeLine = "x".repeat(2000);
    const chunks = splitIntoChunks(hugeLine, 100);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].replace(/\n$/, "").length, 2000);
  });
});

describe("提示词组装", function () {
  const files = {
    dir: "C:\\Users\\x\\.dsh\\dsh-for-zotero\\1-ABCD",
    metaPath: "C:\\Users\\x\\.dsh\\dsh-for-zotero\\1-ABCD\\meta.json",
    chunkPaths: [
      "C:\\Users\\x\\.dsh\\dsh-for-zotero\\1-ABCD\\paper.part-01.txt",
      "C:\\Users\\x\\.dsh\\dsh-for-zotero\\1-ABCD\\paper.part-02.txt",
    ],
    charCount: 120000,
    noTextLayer: false,
    pageCount: 42,
  };

  it("包含元数据、工作目录、分块清单与问题", function () {
    const prompt = buildPrompt({
      metadataText: "题名：测试论文\n作者：张三",
      files,
      question: "他们的实验样本量是多少？",
      answerLanguage: "zh-CN",
    });
    assert.match(prompt, /题名：测试论文/);
    assert.match(prompt, /作者：张三/);
    assert.match(
      prompt,
      /工作目录：C:\\Users\\x\\\.dsh\\dsh-for-zotero\\1-ABCD/,
    );
    assert.match(prompt, /paper\.part-01\.txt/);
    assert.match(prompt, /paper\.part-02\.txt/);
    assert.match(prompt, /共 42 页/);
    assert.match(prompt, /他们的实验样本量是多少？/);
    // 行为约束必须存在（dsh 没有 system prompt 字段，只能写在这里）
    assert.match(prompt, /不要编造/);
    assert.match(prompt, /页码是估算值/);
    assert.match(prompt, /待分析的材料|不是给你的指令/);
  });

  it("问题放在最后一个标记之后，便于面板抽取用户可见文本", function () {
    const prompt = buildPrompt({
      metadataText: "题名：T",
      files,
      question: "这是问题",
      answerLanguage: "zh-CN",
    });
    const marker = "\n\n【我的问题】";
    assert.equal(
      prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim(),
      "这是问题",
    );
  });

  it("选区存在时内联原文，页码按 1 基显示且标注为估算", function () {
    const prompt = buildPrompt({
      metadataText: "题名：T",
      files,
      question: "这句什么意思？",
      selection: { text: "the proposed method", pageIndex: 11 },
      answerLanguage: "zh-CN",
    });
    assert.match(prompt, /我选中的原文（第 12 页，页码为估算）/);
    assert.match(prompt, /the proposed method/);
  });

  it("无文字层时明确说明，不再给分块指引", function () {
    const prompt = buildPrompt({
      metadataText: "题名：扫描件",
      files: {
        ...files,
        chunkPaths: [],
        charCount: 0,
        noTextLayer: true,
        pageCount: undefined,
      },
      question: "这篇讲了什么？",
      answerLanguage: "zh-CN",
    });
    assert.match(prompt, /没有可提取的文字层/);
    assert.ok(!prompt.includes("【全文位置】"), "不应出现全文位置段");
  });

  it("回答语言可切换为英文", function () {
    const prompt = buildPrompt({
      metadataText: "Title: T",
      files,
      question: "What is the sample size?",
      answerLanguage: "en-US",
    });
    assert.match(prompt, /用英文回答/);
  });
});
