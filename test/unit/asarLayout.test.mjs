/**
 * ## asar 数据区起点必须按 Pickle 的 **4 字节对齐**
 *
 * 真机事故（2026-10-17，用户升级 DSH 后插件完全无法运行）：
 *
 * ```text
 *   Error: Invalid package config ...\@deepseek-ai\dsh-app-boot\package.json
 *   while importing "@deepseek-ai/dsh-app-boot"
 * ```
 *
 * 提取出的运行时里 **255 / 313 个 `package.json` 不是合法 JSON**，
 * 全都以 `;` 或 `}` 或 `>` 开头（多出来的垃圾字节），末尾还少几个字节。
 *
 * 根因：asar 头部是 Electron `Pickle` 编码，字符串 payload 会**补齐到 4 字节边界**：
 *
 * ```text
 *   [16] JSON（jsonLen 字节）
 *   [16+jsonLen ... 16+align4(jsonLen))   ← NUL 填充
 *   [16+align4(jsonLen)) 起才是文件数据
 * ```
 *
 * 代码写的是 `16 + jsonLen`，于是整段数据**错位 padding 字节数**。
 * 那一版 `jsonLen = 4775822`（`%4 = 2`）→ 每个文件错位 2 字节。
 *
 * ## 为什么这个 bug 能潜伏很久
 *
 * 旧版 DSH 的 `jsonLen` 恰好是 4 的倍数 → padding 为 0 → 错算与正确**结果相同**。
 * **"条件成立时看起来正确"的算式最容易长期存活** —— 只有版本变化才暴露。
 *
 * 下面的用例把对齐规则钉住：对齐时不变、未对齐时补齐、且绝不截断。
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
const { asarDataStart, ASAR_LAYOUT_VERSION } = bundle;

describe("asar 数据区起点（Pickle 4 字节对齐）", function () {
  it("**已对齐的 jsonLen 不得被改动**（旧版 DSH 走的就是这类值）", function () {
    // 这解释了 bug 为什么潜伏：这些值下"错算"与"正确"结果相同
    for (const len of [0, 4, 8, 100, 4775824]) {
      assert.equal(
        asarDataStart(len),
        16 + len,
        `jsonLen=${len} 已是 4 的倍数，起点应为 16+${len}`,
      );
    }
  });

  it("**未对齐时必须补到下一个 4 字节边界**（本次事故的 4775822）", function () {
    // 实测值：新 asar 头部声明 jsonLen = 4775822，%4 = 2
    assert.equal(
      asarDataStart(4775822),
      16 + 4775824,
      "少算 padding 会让每个文件错位 2 字节 —— 正是本次事故",
    );
    assert.equal(asarDataStart(1), 16 + 4);
    assert.equal(asarDataStart(2), 16 + 4);
    assert.equal(asarDataStart(3), 16 + 4);
    assert.equal(asarDataStart(5), 16 + 8);
  });

  it("起点永远 **不小于** 16+jsonLen，且差值小于 4", function () {
    // 两个方向都重要：
    //  - 小于 → 读到填充/上一个文件尾部（本次事故）；
    //  - 差值 ≥4 → 说明对齐算错了，会跳过真实数据。
    for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 8, 999, 4775822, 4775823]) {
      const start = asarDataStart(len);
      const delta = start - (16 + len);
      assert.ok(delta >= 0, `jsonLen=${len}：起点不能早于 16+jsonLen`);
      assert.ok(delta < 4, `jsonLen=${len}：补的字节不应达到 4（说明算式错）`);
    }
  });

  it("布局版本戳必须 ≥2（版本 1 是错位的那一代）", function () {
    // 版本戳的用途：提取是增量的（大小一致即跳过），而**写坏的文件大小也是对的** ——
    // 没有戳的话，修好算式后那些坏文件仍被跳过，宿主继续起不来（修了等于没修）。
    assert.ok(
      Number(ASAR_LAYOUT_VERSION) >= 2,
      "ASAR_LAYOUT_VERSION 必须 ≥2：版本 1 的所有产物都是错位的，必须作废",
    );
  });
});
