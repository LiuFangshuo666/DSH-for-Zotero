/**
 * ## 取全文的**超时**：整批确认卡死 7 分钟的根因
 *
 * 真机事故（2026-10-17）：
 *
 * ```text
 *   06:02:54  一键确认开始：共 28 项
 *   …        #1–#6 各自 4–32 秒完成
 *   06:03:56  开始取全文（DOI=10.1016/j.aiopen.2022.10.001）…
 *   06:10:10  ← 6 分 13 秒后仍然没有任何结果
 *   界面：     「正在全部确认…（6/28）」
 * ```
 *
 * 根因：`Zotero.Attachments.addAvailableFile()` 对**需要机构登录**的出版商
 * 会打开隐藏浏览器走登录/代理流程，**可能永远不返回**。
 * 而批量确认是**串行**的 —— 一条挂住，剩下 21 条全部停摆，
 * 且界面显示的是"正在确认"而不是"卡在某一条上"，用户完全看不出原因。
 *
 * 这些用例锁定 `withTimeout` 的语义：**超时返回 undefined，不抛**。
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
const { withTimeout } = bundle;

describe("取全文超时（批量确认卡死的根因）", function () {
  it("按时返回的结果原样透传", async function () {
    const value = await withTimeout(Promise.resolve("ok"), 500, "测试");
    assert.equal(value, "ok");
  });

  it("**超时返回 undefined，而不是抛错**", async function () {
    // 抛错会让"拿不到全文"变成"条目没建" —— 那是倒退。
    // 拿不到 PDF 是常态（没有 OA 版 / 机构未订阅），不该中断流程。
    let resolveLate;
    const neverSettles = new Promise((r) => {
      resolveLate = r;
    });
    const value = await withTimeout(neverSettles, 30, "永不返回的解析器");
    assert.equal(value, undefined, "超时必须是 undefined（调用方据此继续）");
    resolveLate("late"); // 收尾：避免悬挂的 promise 让 mocha 报警
  });

  it("底层稍后 reject 不得变成未处理异常", async function () {
    // addAvailableFile 无法取消：超时后它仍在跑，可能稍后抛错。
    // 那个 rejection 必须被吞掉，否则会打断后续条目的确认。
    const willReject = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("late failure")), 20);
    });
    const value = await withTimeout(willReject, 10, "会迟到的失败");
    assert.equal(value, undefined);
    // 再等一会儿，让那个迟到 rejection 落地 —— 若没被吞掉，mocha 会报
    await new Promise((r) => setTimeout(r, 60));
  });

  it("底层抛错时**照常抛**（不能把真错误也吞成超时）", async function () {
    // 区分很重要：超时是"没等到"，抛错是"出错了"。
    // 把后者也变成 undefined 会让用户以为这篇没有 OA 版。
    await assert.rejects(
      () => withTimeout(Promise.reject(new Error("boom")), 500, "会失败"),
      /boom/,
    );
  });
});
