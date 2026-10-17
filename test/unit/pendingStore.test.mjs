/**
 * ## 待确认项必须**持久化**（真机事故：重启丢掉 22 条）
 *
 * 2026-10-17：批量确认 28 条新条目，卡在第 7 条的 PDF 下载（约 8 分钟没返回）。
 * 用户重启 Zotero 解卡 —— 然后发现**剩下 22 条待确认全部消失**。
 *
 * 根因：`pendingDeletions` 只是进程内数组，没有任何落盘。
 * 而那 22 条是 Agent 花 10 分钟查好的 DOI / 字段 / 作者 / 分类，
 * 重建成本是一次完整检索。**用户已经批准的意图不该因为重启蒸发。**
 *
 * 修法是把"增删"收口成 `addPending` / `dropPending`，落盘写在里面。
 * 下面两条守卫分别盯住：
 *
 *  1. **不许绕过收口** —— 直接 `pendingDeletions.push/splice` 会跳过落盘；
 *  2. **收口方法本身真的在落盘** —— 否则收口只是个空壳。
 *
 * ⚠️ 这里用的是源码文本断言（那些方法在 Zotero 沙箱里跑，单测起不来）。
 * 本项目已经因为"文本守卫是弱判据"误报过三次，所以判据尽量窄：
 * 只匹配**这个数组名**上的直接增删，不猜别的形状。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const paneSource = readFileSync(
  join(root, "src", "modules", "sessionPane.ts"),
  "utf8",
);
const storeSource = readFileSync(
  join(root, "src", "dsh", "pendingStore.ts"),
  "utf8",
);

describe("待确认项持久化", function () {
  /**
   * 允许直接改动的**三个方法**（其余一律不许）：
   *
   * - `addPending` / `dropPending` —— 它们**就是**收口，落盘写在里面；
   * - `restorePending` —— 启动时批量灌入，此刻还不需要写回
   *   （下一处真实改动会落盘）。
   *
   * 早先的第一版判据把这三处也抓了，还把注释里那句"不要直接 push/splice"
   * 当成违规 —— **守卫把自己的文档当成违规**是最典型的弱判据误报。
   */
  const allowed = ["addPending", "dropPending", "restorePending"];

  /** 取某个方法体的行号区间（用下一个方法声明作边界） */
  function methodRange(source, name) {
    const lines = source.split("\n");
    // ⚠️ 必须容忍 `private async name(` —— 只写 `private name(` 会漏掉
    // `restorePending`，于是它体内的批量 push 被误判成违规。
    const start = lines.findIndex((l) =>
      new RegExp(`private\\s+(async\\s+)?${name}\\s*\\(`).test(l),
    );
    if (start < 0) return undefined;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s{2}(private |async |public |protected )/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return { start, end };
  }

  const ranges = allowed.map((n) => methodRange(paneSource, n)).filter(Boolean);

  it("**不得**绕过收口直接增删 pendingDeletions", function () {
    const offenders = [];
    paneSource.split("\n").forEach((line, i) => {
      // 注释行不算 —— 文档里写"不要直接 push"是**说明**，不是违规
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // 三个允许的方法体内部不算（那正是收口与批量恢复）
      if (ranges.some((r) => i >= r.start && i < r.end)) return;
      // 只认"改动"形状；`pendingDeletions[index]` 是读取，不算
      if (/this\.pendingDeletions\.(push|splice|length\s*=)/.test(line)) {
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(
      offenders,
      [],
      "这些地方直接改动了 pendingDeletions —— 会绕过落盘，重启后丢失：\n    " +
        offenders.join("\n    ") +
        "\n  改用 addPending() / dropPending()。",
    );
  });

  it("收口方法本身必须真的落盘", function () {
    for (const [name, why] of [
      ["addPending", "新增后不落盘 → 重启后新登记的项丢失"],
      [
        "dropPending",
        "删除后不落盘 → 重启后已处理的项又冒出来，用户会重复确认",
      ],
    ]) {
      const at = paneSource.indexOf(`private ${name}(`);
      assert.ok(at > 0, `找不到 ${name}`);
      // 取到下一个方法声明为止（粗切，够用且不会误伤）
      const rest = paneSource.slice(at);
      const next = rest.indexOf("\n  private ", 10);
      const body = next > 0 ? rest.slice(0, next) : rest.slice(0, 1200);
      assert.match(
        body,
        /persistPending\(/,
        `${name} 必须调用 persistPending()：${why}`,
      );
    }
  });

  it("启动时必须恢复，且恢复不校验会话是否还在", function () {
    assert.match(
      paneSource,
      /await this\.restorePending\(\)/,
      "maintain() 里必须调用 restorePending()，否则落盘的文件永远不会被读回来",
    );
    assert.match(
      paneSource,
      /pendingStore\(\)\.load\(\)/,
      "restorePending 必须真的从 store 读",
    );
    // 不按会话存在性过滤：会话可能被删，但那是用户真实表达过的意图。
    // 让它出现在列表里（可确认可忽略）比静默丢弃好。
    assert.ok(
      !/restorePending\(\)[\s\S]{0,400}?filter\([\s\S]{0,80}?sessionStore/.test(
        paneSource,
      ),
      "恢复时不要按会话存在性过滤 —— 会话删了也应保留用户已表达的意图",
    );
  });

  it("存储层对损坏的文件必须**从空开始**，不能抛", function () {
    // 这份文件就在用户数据目录里，谁都能打开改。一条畸形项混进来
    // 会让确认流程在半小时后崩在意料之外的地方 —— 那时已很难联想到这里。
    assert.match(
      storeSource,
      /parsed\.items\.filter\(validItem\)/,
      "必须逐条校验，不能 `as PendingItem` 硬转",
    );
    assert.match(
      storeSource,
      /schema !== "dsh-for-zotero\/pending\/v1"/,
      "必须校验 schema 版本",
    );
    // 两处 catch 都要回退空集合（读失败 / 写失败），而不是让调用方失败
    const catches = (storeSource.match(/catch \(error\)/g) || []).length;
    assert.ok(catches >= 2, "读与写都要有自己的 catch");
  });

  it("写失败不得让调用方失败（可用性优先于恢复能力）", function () {
    const at = storeSource.indexOf("async save(");
    assert.ok(at > 0);
    const body = storeSource.slice(at, at + 1600);
    assert.match(body, /catch \(error\)/, "save 必须自己吞掉写失败");
    assert.ok(
      !/throw /.test(body),
      "save 不能 throw —— 落不了盘是可惜，但'确认按钮点了没反应'更糟",
    );
  });
});
