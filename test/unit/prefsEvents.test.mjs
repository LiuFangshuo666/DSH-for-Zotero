/**
 * 设置页的事件接线 —— 专治"按键点了没反应"。
 *
 * ## 为什么单独立一个文件
 *
 * 真机反馈的原话就是"按键点了没反应"。这类故障有一条共同特征：
 * **任何构建、类型、lint 检查都不会失败**。设置页的 `oncommand` 是一个字符串，
 * 它调用哪个事件、代码里有没有人接，两边都只是文本：
 *
 * ```xml
 * <html:button oncommand="…onPrefsEvent('providers-save', { window })" />
 * ```
 *
 * ```ts
 * switch (type) { case "providers-save": … }
 * ```
 *
 * 漏了 `case` 的后果不是报错，而是**什么都不发生**。若要用户去猜，
 * 他只能描述成"点了没反应" —— 这正是最难定位的一种反馈。
 *
 * 所以这里做两件事：
 *  1. 把设置页发的每个事件与代码里的分发表**逐一比对**；
 *  2. 守住那个**必需的兜底 catch** —— 没有它，处理函数里的任何异常
 *     都会变成无人处理的 Promise 拒绝，界面同样毫无反应。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const page = read("addon/content/preferences.xhtml");
const hooks = read("src/hooks.ts");

/** 设置页里所有 `onPrefsEvent('xxx'` 的事件名 */
function pageEventTypes() {
  return [...page.matchAll(/onPrefsEvent\(\s*'([^']+)'/g)].map((m) => m[1]);
}

/** 代码里声明的分发表 */
function declaredEventTypes() {
  const at = hooks.indexOf("export const PREFS_EVENT_TYPES");
  assert.ok(at > 0, "hooks.ts 必须导出 PREFS_EVENT_TYPES（测试靠它比对）");
  const block = hooks.slice(at, hooks.indexOf("] as const", at));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("设置页事件的分发表", function () {
  it("设置页确实发了事件（否则本文件失去意义）", function () {
    const types = pageEventTypes();
    assert.ok(
      types.length >= 8,
      `设置页只发了 ${types.length} 个事件，似乎不对`,
    );
  });

  it("**设置页发的每个事件都有人接**（漏一个就是「点了没反应」）", function () {
    const declared = new Set(declaredEventTypes());
    const missing = pageEventTypes().filter((t) => !declared.has(t));
    assert.deepEqual(
      missing,
      [],
      `设置页会发出这些事件，但 PREFS_EVENT_TYPES 里没有（按钮会毫无反应）：\n    ` +
        missing.join("\n    ") +
        `\n  修法：在 hooks.ts 的 dispatchPrefsEvent 里加 case，并补进 PREFS_EVENT_TYPES。`,
    );
  });

  it("分发表里的每一项都在 switch 里有对应 case", function () {
    const at = hooks.indexOf("async function dispatchPrefsEvent");
    const end = hooks.indexOf("export const PREFS_EVENT_TYPES", at);
    assert.ok(at > 0 && end > at, "找不到 dispatchPrefsEvent");
    const body = hooks.slice(at, end);
    const missing = declaredEventTypes().filter(
      (t) => !body.includes(`case "${t}"`),
    );
    assert.deepEqual(
      missing,
      [],
      `这些事件在分发表里登记了，但 switch 里没有 case：\n    ${missing.join("\n    ")}`,
    );
  });

  it("分发表里没有多余项（登记了却没人发 = 死代码）", function () {
    const onPage = new Set(pageEventTypes());
    const extra = declaredEventTypes().filter(
      (t) => !onPage.has(t) && t !== "load",
    );
    assert.deepEqual(
      extra,
      [],
      `这些事件在分发表里，但设置页从不发（可能是改名后漏改）：\n    ${extra.join("\n    ")}`,
    );
  });

  it("分发表里没有重复项（重复会让比较失真）", function () {
    const types = declaredEventTypes();
    const dup = types.filter((t, i) => types.indexOf(t) !== i);
    assert.deepEqual(dup, [], `重复登记：${dup.join(", ")}`);
  });
});

describe("设置页事件的兜底错误处理", function () {
  it("onPrefsEvent 必须有 try/catch 兜底", function () {
    // 没有它：处理函数里的任何抛出都会变成**无人处理的 Promise 拒绝** ——
    // `oncommand` 调用的是 async 函数，界面既不报错也不显示任何东西。
    const at = hooks.indexOf("async function onPrefsEvent");
    assert.ok(at > 0, "找不到 onPrefsEvent");
    const body = hooks.slice(
      at,
      hooks.indexOf("async function dispatchPrefsEvent", at),
    );
    assert.match(body, /try\s*\{/, "必须有 try");
    assert.match(body, /catch\s*\(/, "必须有 catch");
    assert.match(
      body,
      /writePrefsError\(/,
      "catch 里必须把错误**显示到设置页上** —— 只写日志用户看不到",
    );
  });

  it("错误会写到对应那一节的状态行（用户正看着的地方）", function () {
    const at = hooks.indexOf("function writePrefsError");
    assert.ok(at > 0, "找不到 writePrefsError");
    const body = hooks.slice(at, at + 1400);
    assert.match(body, /model-status/, "模型一节的错误要写到模型那一行");
    assert.match(body, /providers-status/, "provider 一节同理");
    assert.match(body, /runtime-status/, "其余事件落到运行时状态行");
  });

  it("未处理的事件类型会记日志，而不是静默返回", function () {
    const at = hooks.indexOf("async function dispatchPrefsEvent");
    const body = hooks.slice(
      at,
      hooks.indexOf("export const PREFS_EVENT_TYPES", at),
    );
    const defaultAt = body.indexOf("default:");
    assert.ok(defaultAt > 0, "switch 必须有 default");
    const defaultBody = body.slice(defaultAt, defaultAt + 700);
    assert.match(
      defaultBody,
      /appendPanelLog\(/,
      "default 分支必须记一条 —— 静默 return 会让「点了没反应」完全无从排查",
    );
  });
});

describe("取不到界面元素时不能静默返回", function () {
  const panel = read("src/modules/modelPanel.ts");

  it("saveApiKey / saveProviders 在找不到输入框时会说出来", function () {
    for (const fn of ["saveApiKey", "saveProviders"]) {
      const at = panel.indexOf(`export async function ${fn}`);
      assert.ok(at > 0, `找不到 ${fn}`);
      const body = panel.slice(at, at + 900);
      const guard = body.indexOf("if (!");
      assert.ok(guard > 0, `${fn} 应有取不到元素的判断`);
      const after = body.slice(guard, guard + 600);
      assert.ok(
        /appendPanelLog\(/.test(after) &&
          /setStatus|setProvidersStatus/.test(after),
        `${fn} 取不到元素时必须**记日志并写到状态行**，不能 \`return\` 了事 —— ` +
          `那正是"按键点了没反应"`,
      );
    }
  });
});
