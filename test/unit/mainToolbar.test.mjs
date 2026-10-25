/**
 * ## 主窗口工具栏的下拉：两个真实会翻车的点
 *
 * ### ① 按钮"存在但看不见"
 *
 * Zotero 的 `.zotero-tb-button` 图标是**按 id 逐条配 CSS** 的：
 *
 * ```css
 *   #zotero-tb-add { list-style-image: url("chrome://zotero/skin/…") }
 * ```
 *
 * 自建的 id 不匹配任何规则 → 按钮在 DOM 里、但**没有图标也看不见**。
 * 这种"加了等于没加"最难排查，所以必须显式设置 `list-style-image`。
 *
 * ### ② 升级后变成两个按钮
 *
 * 按钮是我们**自己插进去的 DOM**，Zotero 不会替我们清理。
 * 若停用/升级时不收走，重新加载就会再插一个 —— 用户看到两个一模一样的图标。
 *
 * ### ③ 挂载点的 id 必须来自实测
 *
 * 用 Zotero 10.0.6 自带 `chrome/content/zotero/zoteroPane.xhtml` 核对过：
 * `#zotero-items-toolbar` 是条目列表工具条（内含 `zotero-tb-add`、`zotero-tb-lookup`）。
 * 猜 id 的后果是"按钮不出现"且没有任何报错。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const src = readFileSync(
  join(root, "src", "modules", "mainToolbar.ts"),
  "utf8",
);
/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 所有"代码里有没有 X"的判断都必须用它。这个模块的注释里就写着
 * 「为什么不用 `alert()`」——直接扫原文会把**说明文字**当成违规，
 * 本项目已经因此误报过六次。
 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const hooks = readFileSync(join(root, "src", "hooks.ts"), "utf8");

describe("主窗口工具栏下拉", function () {
  it("挂载点用的是实测过的 Zotero 真实 id", function () {
    // 这些 id 来自 zoteroPane.xhtml，不是记忆
    for (const id of ["zotero-items-toolbar", "zotero-collections-toolbar"]) {
      assert.ok(
        src.includes(id),
        `必须包含实测过的挂载点 ${id}（找不到时应按候选顺序退让）`,
      );
    }
    assert.match(
      src,
      /TOOLBAR_CANDIDATES/,
      "必须有候选顺序，而不是只认一个 id —— 换 Zotero 版本时才能退让",
    );
  });

  it("**必须显式设置图标**（否则按钮在 DOM 里但看不见）", function () {
    // ⚠️ 必须用剥注释后的 code：模块注释里写着 `list-style-image` 这个词，
    // 用原文判断会永远通过 —— 这条守卫第一次写出来就是"永远绿"的假守卫，
    // 是"破坏代码看它是否变红"的验证把它抓出来的。
    assert.match(
      code,
      /list-style-image/,
      "Zotero 按 id 配图标，自建 id 不设 list-style-image 会得到一个看不见的按钮",
    );
    assert.match(
      code,
      /chrome:\/\/\$\{addonRef\}\/content\//,
      "图标要用插件自己的 chrome:// 资源",
    );
  });

  it("**装不上时必须留下日志**（否则只是「按钮没出现」）", function () {
    assert.match(
      src,
      /找不到挂载点/,
      "找不到挂载点要记日志并列出试过的 id，否则无从判断",
    );
  });

  it("插件关闭时必须**收走按钮**（否则升级后变两个）", function () {
    assert.match(
      hooks,
      /uninstallMainToolbar\(\)/,
      "onShutdown 里必须调用 uninstallMainToolbar —— 自插的 DOM 要自己清理",
    );
  });

  it("挂载是幂等的（已存在就不重复插）", function () {
    assert.match(
      src,
      /getElementById\(BUTTON_ID\)\) return true/,
      "重复调用不能插出第二个按钮",
    );
  });

  it("按钮 id 带插件前缀，避免和 Zotero 或别的插件撞名", function () {
    assert.match(src, /dsh-for-zotero-toolbar-menu/);
  });

  it("动作结果用 Zotero 进度窗口告知，不用阻塞式 alert", function () {
    assert.match(code, /ProgressWindow/);
    assert.ok(
      !/\balert\s*\(/.test(code),
      "不要用 alert（会打断用户），用 Zotero 的 ProgressWindow",
    );
  });
});
