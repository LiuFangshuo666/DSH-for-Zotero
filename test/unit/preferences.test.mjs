/**
 * 设置页与代码的一致性。
 *
 * ## 为什么需要（真机反馈"设置里有很多版本迭代留下的无意义内容"）
 *
 * 清理时发现的几类残留，**都不是代码 bug，而是页面与实现脱节**：
 *
 *  1. **失效的分节**：删掉的功能（批量处理）留下的文案键，或改过名的分节
 *     （「上下文」「行为」）不再被引用；
 *  2. **半成品**：`requestTimeoutMs` 代码在读、设置页却没有 ——
 *     用户既看不到也改不了，等于写死；
 *  3. **范围误导**：只对阅读器面板生效的项散在泛泛的「行为」节里，
 *     用户以为改了能影响全局；
 *  4. **在隔离模式下永远不生效的项**（桌面版端口 / DSH_HOME / 启动 URL）
 *     与「隔离运行时」并列显示。
 *
 * 这些问题的共同点是**没有测试会失败** —— 页面照常渲染，只是内容无意义。
 * 所以这里把三件事钉住：文案键必须与页面一一对应、每个 bound 偏好都被代码读过、
 * 以及设置页不得出现"声明了却没人用"的偏好。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs|xhtml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const page = readFileSync(
  join(root, "addon", "content", "preferences.xhtml"),
  "utf8",
);
const prefsJs = readFileSync(join(root, "addon", "prefs.js"), "utf8");
const codeFiles = [
  ...walk(join(root, "src")),
  ...walk(join(root, "addon")),
].filter((f) => !f.includes(".scaffold"));
const codeTexts = codeFiles.map((f) => [f, readFileSync(f, "utf8")]);

/**
 * 取出设置页里绑定的**偏好名**。
 *
 * ⚠️ 不能直接用 /preference="([^"]+)"/ —— 它会把
 * `onsyncfrompreference="…"` 的**尾巴**也当成一个偏好名
 * （因为 `…preference="` 本身就含那个子串），
 * 于是报出一堆根本不存在的“偏好”。本项目刚因此
 * 假报了三条失败。用词边界只匹配独立的属性名。
 */
function boundPreferences() {
  const names = [...page.matchAll(/(?:^|\s)preference="([^"]+)"/g)].map((m) =>
    // 源文件用的是 __prefsPrefix__ 占位符（构建时替换成完整键）。
    // 这里剥掉前缀，取出**键名本身**用于与 prefs.js 的默认值对照。
    m[1].replace(/^__prefsPrefix__\./, ""),
  );
  assert.ok(names.length > 0, "设置页应当绑定偏好");
  return names;
}

describe("设置页与代码的一致性", function () {
  it("页面用到的每个文案键都有定义，且没有未使用的文案", function () {
    const used = new Set(
      [...page.matchAll(/data-l10n-id="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((k) => k.startsWith("pref-")),
    );
    for (const locale of ["zh-CN", "en-US"]) {
      const ftl = readFileSync(
        join(root, "addon", "locale", locale, "preferences.ftl"),
        "utf8",
      );
      const defined = new Set(
        [...ftl.matchAll(/^(pref-[A-Za-z0-9-]+)\s*=/gm)].map((m) => m[1]),
      );
      for (const key of used) {
        assert.ok(defined.has(key), `${locale} 缺少文案：${key}`);
      }
      for (const key of defined) {
        assert.ok(
          used.has(key),
          `${locale} 的文案 ${key} 已无人使用 —— 功能删掉后文案要一起清理`,
        );
      }
    }
  });

  it("设置页绑定的每个偏好都被代码读过（没有摆设开关）", function () {
    for (const name of boundPreferences()) {
      const read = codeTexts.some(
        ([file, text]) =>
          !file.endsWith("preferences.xhtml") &&
          !file.endsWith("prefs.js") &&
          new RegExp(`\\b${name}\\b`).test(text),
      );
      assert.ok(read, `偏好 ${name} 在设置页可改，但代码从不读取 —— 这是摆设`);
    }
  });

  it("每个绑定只出现一次（避免重复控件改同一个偏好）", function () {
    const bound = boundPreferences();
    const dup = bound.filter((n, i) => bound.indexOf(n) !== i);
    assert.deepEqual(dup, [], `同一偏好被绑定多次：${dup.join(", ")}`);
  });

  it("代码里读取的偏好都要有默认值声明（否则读到 undefined）", function () {
    // 只检查"通过 getPref 读取"的那些名字，避免把无关标识符算进来
    const readNames = new Set(
      codeTexts.flatMap(([, text]) =>
        [...text.matchAll(/getPref\(\s*"([A-Za-z][A-Za-z0-9]*)"/g)].map(
          (m) => m[1],
        ),
      ),
    );
    const declared = new Set(
      [...prefsJs.matchAll(/pref\("([^"]+)"/g)].map((m) => m[1]),
    );
    for (const name of readNames) {
      assert.ok(
        declared.has(name),
        `代码读了偏好 ${name}，但 prefs.js 没有声明默认值`,
      );
    }
  });
});
