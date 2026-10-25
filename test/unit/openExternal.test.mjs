/**
 * ## 打开外部程序：两个安全/正确性纪律
 *
 * ### ① web 地址里的 **token 绝不能进日志或返回值**
 *
 * dsh web 的地址形如 `http://127.0.0.1:19400/?token=<凭据>`，那个 token 就是
 * 访问凭据。它一旦进了面板日志（用户会把日志发给我排查）或界面文字
 * （会被截图、会被复制），等于把凭据泄露出去。
 *
 * 所以对外只给**打码后**的地址；真要打开时用的是内存里的原地址。
 *
 * ### ② 打开目录用 `launchFile` 而不是 `reveal`
 *
 * - `reveal` = 在文件管理器里**定位**：打开父目录并选中该目录 —— 用户还得再双击。
 * - `launchFile` = 让系统**打开**它：资源管理器直接显示该目录里面的内容。
 *
 * "一键打开工作区"要的是后者。`reveal` 只作平台差异的退路。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const { redactTokenInUrl } = bundle;
const source = readFileSync(
  join(root, "src", "modules", "openExternal.ts"),
  "utf8",
);
/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 位置类判断必须用它：模块顶部的说明里先讲了 `reveal` 再讲 `launchFile`，
 * 直接对原文取下标会把"文档里的顺序"当成"代码里的顺序"。
 * 这个项目里守卫被自己的注释骗到已经发生过好几次了。
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("打开外部程序", function () {
  it("token 必须打码（日志与返回值都不能带真 token）", function () {
    const url = "http://127.0.0.1:19400/?token=abcDEF123-_x";
    const masked = redactTokenInUrl(url);
    assert.equal(masked, "http://127.0.0.1:19400/?token=***");
    assert.ok(!masked.includes("abcDEF123"), "打码后不得残留原 token");
    // 没有 token 的地址原样返回（不能把它弄坏）
    assert.equal(
      redactTokenInUrl("http://127.0.0.1:19400/"),
      "http://127.0.0.1:19400/",
    );
  });

  it("**源码里写日志/返回值时用的必须是打码后的地址**", function () {
    // 守卫判据：凡是把 `url` 交给 appendPanelLog 或放进返回值的地方，
    // 都必须经过 redactTokenInUrl。这里用"出现裸 url 的日志/返回"来判定。
    const dangerous = [
      /appendPanelLog\([^)]*\$\{url\}/,
      /appendPanelLog\([^)]*,\s*url\)/,
      /地址:\s*url\b/,
    ];
    for (const pattern of dangerous) {
      assert.ok(
        !pattern.test(source),
        `openExternal.ts 里出现了未打码的 url（${pattern}）—— token 会泄露到日志或界面`,
      );
    }
    // 正向：至少有一处用了打码函数
    assert.match(
      source,
      /redactTokenInUrl\(url\)/,
      "日志与返回值都应经过 redactTokenInUrl",
    );
  });

  it("打开目录优先 `launchFile`（打开内容），`reveal` 只作退路", function () {
    const launchAt = code.indexOf("Zotero.launchFile(");
    const revealAt = code.indexOf("Zotero.File.reveal(");
    assert.ok(launchAt > 0, "必须用 Zotero.launchFile 直接打开目录");
    assert.ok(revealAt > 0, "平台差异的退路用 Zotero.File.reveal");
    assert.ok(
      launchAt < revealAt,
      "launchFile 必须在 reveal 之前 —— 反过来用户会看到" +
        "「打开父目录并选中」，还得自己再双击进去",
    );
  });

  it("拿不到 token 时**不返回半残链接**，而是报错并说清怎么修", function () {
    assert.match(
      source,
      /拿不到已登录的 web 地址/,
      "没有 token 时必须明确报错（不带 token 的地址只会显示 authentication required）",
    );
    assert.match(
      source,
      /隔离运行时/,
      "错误说明里要指向「运行时没启动」这个真实原因",
    );
  });

  it("文件管理器打不开时要如实说明，不能静默", function () {
    assert.match(source, /无法打开文件管理器/);
    assert.match(source, /已在文件管理器中定位/);
  });
});
