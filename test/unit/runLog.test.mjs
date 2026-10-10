/**
 * 面板日志的写入可靠性。
 *
 * ## 为什么专门测这个（一次代价很大的教训）
 *
 * 早先的实现是"读整个文件 → 拼上新行 → 整体写回"，而调用方是**即发即忘**的。
 * 启动时几十次并发写各自读到同一份旧快照，后写的那次把先写的**整段覆盖** ——
 * 日志行被静默抹掉，文件看起来"从没出现过那些记录"。
 *
 * 后果远超"少几行日志"：我据"日志里没有某行"判断"那段代码没执行"，
 * **连续几轮排查都建立在错误前提上**。诊断工具本身不可靠时，排查会一路跑偏。
 *
 * 所以这里钉住两件事：
 *  1. **并发调用不丢行**（核心）；
 *  2. 写入用的是**追加语义**，而不是读-改-写。
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

/**
 * 装一个有**真实追加语义**的假 IOUtils。
 *
 * 必须显式设置 `Zotero`：`appendPanelLog` 在**调用时**读 `Zotero.DataDirectory.dir`，
 * 拿不到就静默 return（第一版测试就因为这个而"写入 0 行"，暴露了这个约束）。
 */
function installFakeIO() {
  const files = new Map();
  const writeCalls = [];

  globalThis.Zotero = {
    ...(globalThis.Zotero ?? {}),
    DataDirectory: { dir: "/fake/data" },
  };
  globalThis.PathUtils = { join: (...parts) => parts.join("/") };
  globalThis.IOUtils = {
    async exists(path) {
      return files.has(path);
    },
    async readUTF8(path) {
      return files.get(path) ?? "";
    },
    async writeUTF8(path, text, options) {
      writeCalls.push({ path, text, options });
      const mode = options?.mode;
      if (mode === "appendOrCreate" || mode === "append") {
        // 追加语义：**不依赖任何先前的读**，这正是修好丢行的关键
        files.set(path, (files.get(path) ?? "") + text);
        return text.length;
      }
      files.set(path, text);
      return text.length;
    },
  };
  return { files, writeCalls };
}

const PANEL = "/fake/data/dsh-for-zotero-panel.txt";

describe("面板日志写入", function () {
  it("并发写 N 行后，N 行**全部**在文件里（不丢行）", async function () {
    const { files } = installFakeIO();

    // 模拟真实的启动突发：几十次即发即忘的调用几乎同时发生
    const TOTAL = 60;
    for (let i = 0; i < TOTAL; i++) {
      bundle.appendPanelLog("runtime", `第 ${i} 行`);
    }
    // 队列是 Promise 链，等它排空
    await new Promise((resolve) => setTimeout(resolve, 80));

    const text = files.get(PANEL) ?? "";
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    // 关键断言：一行都不能少。
    // 旧实现（读-改-写）在这里会显著少于 TOTAL —— 这正是它会误导排查的原因。
    assert.equal(
      lines.length,
      TOTAL,
      `并发写入丢了行：写 ${TOTAL} 行，文件里只有 ${lines.length} 行`,
    );
    for (let i = 0; i < TOTAL; i++) {
      assert.ok(
        lines.some((l) => l.includes(`第 ${i} 行`)),
        `第 ${i} 行丢失`,
      );
    }
  });

  it("写入使用追加语义，而不是整体覆盖", async function () {
    const { writeCalls } = installFakeIO();
    bundle.appendPanelLog("session", "x");
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(writeCalls.length >= 1, "应当发生写入");
    assert.equal(
      writeCalls[0].options?.mode,
      "appendOrCreate",
      "必须用 appendOrCreate：没有它就只能靠'读全文再写回'，并发时必然丢行",
    );
  });

  it("拿不到数据目录时安全退出（不抛错、不写入）", async function () {
    const { writeCalls } = installFakeIO();
    globalThis.Zotero = { DataDirectory: undefined };
    assert.doesNotThrow(() => bundle.appendPanelLog("session", "x"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(writeCalls.length, 0, "没有数据目录时不应写入");
  });
});
