import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeSeparators } from "./.build/unit-entry.mjs";

/**
 * ## Gecko 只接受**全反斜杠**路径（真机实测）
 *
 * 作者在运行中的 Gecko 里让 `PathUtils.join` 试了三种写法：
 *
 * ```text
 *   混合分隔符  C:\…\dsh-for-zotero/collection-VZVXRZ6D  → 抛 NS_ERROR_FILE_UNRECOGNIZED_PATH
 *   全反斜杠    C:\…\collection-VZVXRZ6D                 → ✅ 正常
 *   全正斜杠    C:/…/collection-VZVXRZ6D                  → 抛 NS_ERROR_FILE_UNRECOGNIZED_PATH
 * ```
 *
 * 这不是"路径难看"的问题：记录里的混合路径让 `startToolPoller` 抛错，
 * 而那行在 `maintain()` 的循环里没有 try —— **全库所有会话的工具桥一起失效**，
 * Agent 那边表现为"插件停了"。
 *
 * ⚠️ **Node 对混写路径是宽容的**（`path.join` 会自己纠正），
 * 所以这些用例不是"模拟 Gecko"，而是**锁住我们产出的路径形态**：
 * 只要产出的是全反斜杠，Gecko 就不会抛错。
 */
describe("路径分隔符归一化", function () {
  it("把混合分隔符变成全反斜杠（这就是那个 bug 的形态）", function () {
    const mixed =
      "C:\\Users\\Administrator\\Zotero\\dsh-for-zotero\\home\\dsh-for-zotero/collection-VZVXRZ6D";
    assert.equal(
      nativeSeparators(mixed),
      "C:\\Users\\Administrator\\Zotero\\dsh-for-zotero\\home\\dsh-for-zotero\\collection-VZVXRZ6D",
    );
  });

  it("全正斜杠也转成全反斜杠（实测同样抛错）", function () {
    assert.equal(
      nativeSeparators("C:/Users/x/dsh-for-zotero/collection-A"),
      "C:\\Users\\x\\dsh-for-zotero\\collection-A",
    );
  });

  it("已经是全反斜杠时原样返回", function () {
    const ok = "C:\\Users\\x\\collection-A";
    assert.equal(nativeSeparators(ok), ok);
  });

  it("非 Windows 路径不动（POSIX 上正斜杠才是对的）", function () {
    assert.equal(nativeSeparators("/home/u/ws"), "/home/u/ws");
    assert.equal(nativeSeparators("relative/path"), "relative/path");
  });

  it("空值安全", function () {
    assert.equal(nativeSeparators(""), "");
  });
});
