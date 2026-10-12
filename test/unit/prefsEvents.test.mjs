/**
 * 设置页的接线与元素 —— 专治「按键点了没反应」。
 *
 * ## 为什么单独立一个文件
 *
 * 真机反馈的原话就是"按键点了没反应"。这类故障有一条共同特征：
 * **任何构建、类型、lint 检查都不会失败** —— 界面与代码两边都只是文本：
 *
 * ```xml
 * <button oncommand="…onPrefsEvent('providers-save', { window })" />
 * ```
 *
 * ```ts
 * switch (type) { case "providers-save": … }
 * ```
 *
 * 漏了 `case`、把按钮写成 HTML 元素、把 `onsyncfrompreference` 的 JS 改坏、
 * 状态行没有 `id` —— 后果都不是报错，而是**什么都不发生**。
 * 而用户唯一能给的描述就是"点了没反应"，那是最难定位的一种反馈。
 *
 * ## 这里守的是什么（每一条都对应一次真实故障）
 *
 * | 测试块 | 真实故障 |
 * | --- | --- |
 * | 设置页事件的分发表 | `oncommand` 发的事件没有 `case` |
 * | 控件与偏好的绑定 | 偏好写成短名，Zotero 7+ 只发警告、不绑定 |
 * | hooks 导出对象 | 导出名不对 → 所有按钮静默失效 |
 * | 兜底错误处理 | async 处理函数无 catch → 异常变成静默拒绝 |
 * | XUL 元素 | `html:button` 不发 `command` → 整节按钮全死 |
 * | 看得见的回执 | 状态行在可视区域之外，用户看不到反馈 |
 * | 状态行必须有 id | 没有 id → `getElementById` 永远取不到 |
 * | onsyncfrompreference | 批量改偏好时把 JS 改坏 → 下拉框重进后变空 |
 * | 面板重进时初始化 | 面板被缓存，`load` 不再触发 |
 * | 取不到元素不静默返回 | `if (!el) return` 让失败无声无息 |
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

describe("控件与偏好的绑定（Zotero 7+ 要求**完整偏好键**）", function () {
  it("源文件用 __prefsPrefix__ 占位符，不写短名也不写死前缀", function () {
    const vals = [...page.matchAll(/(?:^|\s)preference="([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(vals.length >= 10, `设置页绑定的偏好太少（${vals.length}）`);
    const bad = vals.filter((v) => !v.startsWith("__prefsPrefix__."));
    assert.deepEqual(
      bad,
      [],
      `这些 preference 取值不是 __prefsPrefix__.<键> 形式：\n    ${bad.join("\n    ")}\n` +
        "  ⚠️ Zotero 7+ 的 preference 属性必须是**完整偏好键**（含前缀）。\n" +
        "  写成短名（如 modelId）时 Zotero 只发一条警告然后**不绑定任何偏好** ——\n" +
        '  表现是改了存不进去、onsyncfrompreference 不触发，整节"看不出效果"。',
    );
  });

  it("**构建产物**里的 preference 都是完整键（这条才是真凭据）", function () {
    // 必须查产物：源文件里是占位符，只有构建后才看得出前缀对不对。
    // 而 Zotero 读的正是产物 —— 这一条正是"整节没效果"的根因所在。
    const built = read(".scaffold/build/addon/content/preferences.xhtml");
    const vals = [...built.matchAll(/(?:^|\s)preference="([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(vals.length >= 10, `产物里绑定的偏好太少（${vals.length}）`);
    const bad = vals.filter((v) => !v.startsWith("extensions.zotero."));
    assert.deepEqual(
      bad,
      [],
      `产物里这些 preference 不是完整偏好键（Zotero 不会绑定它们）：\n    ${bad.join("\n    ")}`,
    );
    const leftovers = vals.filter((v) => v.includes("__"));
    assert.deepEqual(
      leftovers,
      [],
      `占位符没有被替换：${leftovers.join(", ")}`,
    );
    // 前缀必须与 package.json 的 prefsPrefix 一致
    const pkg = JSON.parse(read("package.json"));
    for (const v of vals) {
      assert.ok(
        v.startsWith(`${pkg.config.prefsPrefix}.`),
        `${v} 与 package.json 的 prefsPrefix（${pkg.config.prefsPrefix}）不一致`,
      );
    }
  });
});

describe("hooks 导出对象（oncommand 就是通过它调用的）", function () {
  it("默认导出里必须有 onPrefsEvent", function () {
    // 设置页的每个按钮都是 `Zotero.<addonInstance>.hooks.onPrefsEvent(...)`。
    // 只要这个**导出名**不对（改名、漏掉、写成别的名字），
    // **所有**按钮都会静默失败 —— 表现就是"按键点了没反应"，
    // 而且构建、类型、lint 全都不会报警。
    const at = hooks.indexOf("export default {");
    assert.ok(at > 0, "找不到 hooks 的默认导出");
    const body = hooks.slice(at, hooks.indexOf("}", at));
    assert.match(
      body,
      /^\s*onPrefsEvent,\s*$/m,
      "默认导出里必须有 onPrefsEvent（否则设置页按钮全部无效）",
    );
  });

  it("onPrefsEvent 是以函数声明定义的（会被提升，导出不会拿到 undefined）", function () {
    assert.match(hooks, /async function onPrefsEvent\(/);
  });

  it("XHTML 用占位符引用实例名，不写死", function () {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.config.addonInstance, "package.json 缺少 addonInstance");
    const used = [...page.matchAll(/Zotero\.__addonInstance__\./g)].length;
    assert.ok(used > 0, "设置页应通过占位符引用实例名");
    assert.ok(
      !page.includes("Zotero.DSHForZotero."),
      "源文件里应使用 __addonInstance__ 占位符（由构建替换）",
    );
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

describe("oncommand 只能挂在 XUL 元素上（html:button 不发 command 事件）", function () {
  /**
   * 真机故障（最难查的一次）：设置页里「隔离运行时」的按钮有反应，
   * 「模型」一节的按钮**完全没反应**。
   *
   * 差别只在元素类型：
   *
   * ```xml
   * <button oncommand="…">          ← XUL 按钮，发送 command 事件 ✅
   * <html:button oncommand="…">     ← HTML 按钮，发送的是 click 事件 ❌
   * ```
   *
   * `oncommand` 在 HTML `<button>` 上**永远不会触发** ——
   * 不报错、不警告、界面与代码都"看着对"，只是点了什么都不发生。
   *
   * Zotero 自己的设置面板可以作证：那些 `oncommand` 全部挂在
   * XUL 的 `<button>` / `<checkbox>` / `<key>` 上，`onclick` 只出现 1 次。
   */
  it("设置页里没有 html:button（它收不到 command）", function () {
    assert.ok(
      !/<html:button\b/.test(page),
      "设置页里有 html:button —— 它不发送 command 事件，oncommand 永不触发。\n" +
        '  改用 XUL 的 <button data-l10n-id="…" oncommand="…" />（与 Zotero 自己的面板一致）。',
    );
    const built = read(".scaffold/build/addon/content/preferences.xhtml");
    assert.ok(!/<html:button\b/.test(built), "产物里仍有 html:button");
  });

  it("每个 oncommand 都挂在 XUL button / checkbox / key 上", function () {
    const built = read(".scaffold/build/addon/content/preferences.xhtml");
    const lines = built.split("\n");
    const bad = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("oncommand")) continue;
      for (let k = i; k >= Math.max(0, i - 8); k--) {
        const m = lines[k].match(/<([a-zA-Z:]+)/);
        if (!m) continue;
        if (
          !["button", "checkbox", "key", "menuitem", "toolbarbutton"].includes(
            m[1],
          )
        ) {
          bad.push(`行 ${k + 1}: <${m[1]}>`);
        }
        break;
      }
    }
    assert.deepEqual(
      bad,
      [],
      `这些 oncommand 挂在了不发 command 事件的元素上：\n    ${bad.join("\n    ")}`,
    );
  });

  it("XUL 按钮的文案必须有 .label（XUL 套的是 label 属性）", function () {
    // XUL `<button data-l10n-id="x">` 取的是 FTL 里的 `x.label`。
    // 若文案只写成 `x = 保存`（没有 .label），按钮会**显示为空**。
    const built = read(".scaffold/build/addon/content/preferences.xhtml");
    const ids = [...built.matchAll(/<button[^>]*data-l10n-id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(ids.length >= 4, `带文案的 XUL 按钮太少（${ids.length}）`);
    for (const locale of ["zh-CN", "en-US"]) {
      const ftl = read(`addon/locale/${locale}/preferences.ftl`);
      for (const id of ids) {
        const short = id.replace(/^dshforzotero-/, "");
        const re = new RegExp(
          `^${short}\\s*=[\\s\\S]{0,120}?\\.label\\s*=`,
          "m",
        );
        assert.match(
          ftl,
          re,
          `${locale} 的 ${short} 缺少 .label —— XUL 按钮会显示为空`,
        );
      }
    }
  });
});

describe("按键的反馈一律走设置页内的状态行（**不弹窗**）", function () {
  it("设置页事件**不**弹通知 —— 弹窗会把主窗口抢到前台", function () {
    // 真机反馈：弹窗导致「页面跳到设置页前面」—— 点一个按钮就被抢一次焦点。
    // 我原先加弹窗是为了解决"状态行在可视区域之外"，但那是拿一个更严重的问题
    // 换一个更轻的问题。现在反馈只走设置页内的状态行（它们已有 id 与时间戳）。
    const at = hooks.indexOf("async function onPrefsEvent");
    assert.ok(at > 0, "找不到 onPrefsEvent");
    const body = hooks.slice(at, hooks.indexOf("/** 按事件类型把错误", at));
    assert.ok(
      !/ProgressWindow/.test(body) && !/notifyPrefs/.test(body),
      "设置页事件的处理路径里不得再弹通知 —— 它会抢焦点、把主窗口带到设置页前面",
    );
  });

  it("失败时写到**对应那一节**的状态行（这是失败的唯一反馈通道）", function () {
    const at = hooks.indexOf("function writePrefsError");
    assert.ok(at > 0, "找不到 writePrefsError");
    const body = hooks.slice(at, at + 1400);
    // 三节各有各的状态行，不能全塞到运行时那一行
    assert.match(body, /model-status/, "模型一节的失败要写到模型那一行");
    assert.match(body, /providers-status/, "provider 一节同理");
    assert.match(body, /runtime-status/, "其余落到运行时那一行");
    // 失败也必须能被看见 —— 所以要走设置页元素
    assert.match(body, /getElementById/, "必须真的写到界面上");
    assert.match(body, /textContent/, "必须真的写进去");
  });

  it("启动时的后台准备仍然用进度窗口（那是耗时任务，不是按键回执）", function () {
    // ⚠️ 别把这一处也当成"冗余弹窗"删掉：首次要提取约 330 MB（10–30 秒），
    // 没有进度窗口用户不知道还要等多久 —— 它与"按键点了没反应"是两回事。
    //
    // 注意区分：`runtime-prepare` **按钮**只写状态行（那是一次点击的回执）；
    // 进度窗口在 `onStartup` 的后台准备里（`safeRegister("隔离运行时（后台准备）")`）。
    const at = hooks.indexOf('safeRegister("隔离运行时（后台准备）"');
    assert.ok(at > 0, "找不到后台准备的注册");
    assert.match(
      hooks.slice(at, at + 2000),
      /ProgressWindow/,
      "启动时的后台准备应保留进度窗口（否则用户不知道还要等多久）",
    );
  });

  it("三个状态行都会带上时间戳（让「变了没有」一眼可辨）", function () {
    // 两段文字很像时，用户无法判断它到底有没有更新 —— 于是仍然报"没反应"。
    // 时间戳是最便宜的"它活着"的证据。
    const panel = read("src/modules/modelPanel.ts");
    for (const fn of ["function setStatus", "function setProvidersStatus"]) {
      const at = panel.indexOf(fn);
      assert.ok(at > 0, `找不到 ${fn}`);
      assert.match(
        panel.slice(at, at + 500),
        /toLocaleTimeString/,
        `${fn} 应给文字加时间戳`,
      );
    }
    const err = hooks.slice(hooks.indexOf("function writePrefsError"));
    assert.match(
      err.slice(0, 1400),
      /toLocaleTimeString/,
      "writePrefsError 也要加时间戳，与另两个状态行一致",
    );
  });
});

describe("状态行必须有 id（否则它就是「没反应」的一部分）", function () {
  /**
   * 代码要写入的状态行。
   *
   * 真机故障：`<label data-l10n-id="pref-model-status"></label>` **没有 id**，
   * 于是 `getElementById("dshforzotero-model-status")` 永远返回 null，
   * `setStatus()` 静默什么都不做 —— 用户点了按钮，界面上**一个字都不出现**。
   *
   * 这条缺陷的表现与"代码没跑"完全一样，而诊断文件其实早已打印出
   * "控件缺失：model-status, providers-status"，只是没去追问为什么。
   * 所以现在用测试钉死：文案元素可以有 data-l10n-id，但**要写入的必须有 id**。
   */
  const STATUS_IDS = ["model-status", "providers-status", "runtime-status"];

  it("每个状态行元素都有 __addonRef__-<名字> 形式的 id", function () {
    for (const name of STATUS_IDS) {
      const marker = `id="__addonRef__-${name}"`;
      assert.ok(
        page.includes(marker),
        `设置页里没有 ${marker} —— setStatus 会静默失效，用户看不到任何文字`,
      );
    }
  });

  it("构建产物里这些 id 被替换成真实前缀", function () {
    const built = read(".scaffold/build/addon/content/preferences.xhtml");
    for (const name of STATUS_IDS) {
      assert.ok(
        built.includes(`id="dshforzotero-${name}"`),
        `产物里缺少 id="dshforzotero-${name}"`,
      );
    }
  });

  it("代码里要写入的**状态行**都能在产物里找到", function () {
    // 反过来查：代码里凡是用前缀拼出的**状态行**名字，产物里都得有对应 id。
    //
    // ⚠️ 判据只取以 `-status` 结尾的名字。早先不设后缀，把
    // `addonRef}-preferences`（面板 id）与 `addonRef}/content`（路径）
    // 也当成了元素 id —— 误报会让检查被无视，比没有检查更糟。
    const built = read(".scaffold/build/addon/content/preferences.xhtml");
    const used = new Set();
    for (const text of [hooks, read("src/modules/modelPanel.ts")]) {
      for (const m of text.matchAll(/addonRef\}-([a-z][a-z-]*status)\b/g))
        used.add(m[1]);
      for (const m of text.matchAll(/REF\}-([a-z][a-z-]*status)\b/g))
        used.add(m[1]);
    }
    assert.ok(used.size >= 3, `识别到的状态行太少（${[...used].join(", ")}）`);
    const missing = [...used].filter(
      (name) => !built.includes(`id="dshforzotero-${name}"`),
    );
    assert.deepEqual(
      missing,
      [],
      `代码要写入这些状态行，但产物里没有它们的 id（点了不会有任何文字）：\n    ` +
        missing.join("\n    "),
    );
  });
});

describe("onsyncfrompreference 不能被当成 preference 改写", function () {
  it("源文件里的 onsyncfrompreference 是**可执行代码**，不带偏好键前缀", function () {
    // 真机故障：一个"给 preference 补前缀"的脚本用了 /preference="…"/，
    // 而 `onsyncfrompreference="…"` **也含这个子串** —— 于是前缀被加到了
    // JavaScript 代码前面，得到
    //   onsyncfrompreference="extensions.zotero.dshforzotero.Zotero.DSHForZotero…"
    // 每次面板同步都抛错，下拉框因此**重进后变空**。
    const hits = [...page.matchAll(/onsyncfrompreference="([^"]*)"/g)];
    assert.ok(hits.length >= 2, `onsyncfrompreference 太少（${hits.length}）`);
    for (const m of hits) {
      assert.ok(
        m[1].trim().startsWith("Zotero."),
        `onsyncfrompreference 应是可执行代码（以 Zotero. 开头），实际：${m[1].slice(0, 80)}`,
      );
      assert.ok(
        !m[1].includes("extensions.zotero"),
        `onsyncfrompreference 里混进了偏好键，会被当成 JS 执行并抛错：${m[1].slice(0, 80)}`,
      );
    }
  });

  it("构建产物里也没有被改坏", function () {
    const built = read(".scaffold/build/addon/content/preferences.xhtml");
    assert.ok(
      !/onsyncfrompreference="extensions\./.test(built),
      "产物里 onsyncfrompreference 被加上了偏好键前缀 —— 下拉框会重进后变空",
    );
  });
});

describe("面板重进时也要初始化（load 只在首次插入时触发）", function () {
  it("根元素同时挂 onload 与 onshowing", function () {
    // Zotero 把面板内容缓存在 DOM 里：切走只是隐藏，切回来 `load` 不再触发。
    // Zotero 在显示时会派发 `showing`（preferences.js 的 _showPane），
    // 所以必须也处理它，否则"退出重进后下拉框变空"。
    assert.match(page, /onload="[^"]*onPrefsEvent\('load'/);
    assert.match(page, /onshowing="[^"]*onPrefsEvent\('showing'/);
  });

  it("showing 与 load 走同一条初始化路径", function () {
    const at = hooks.indexOf('case "load":');
    assert.ok(at > 0, "找不到 load 分支");
    const body = hooks.slice(at, at + 200);
    assert.match(
      body,
      /case "showing":/,
      "showing 应与 load 共用分支（否则两侧初始化逻辑会分叉）",
    );
  });

  it("showing 已登记进分发表（否则会被当成死代码）", function () {
    assert.ok(
      declaredEventTypes().includes("showing"),
      "PREFS_EVENT_TYPES 里要登记 showing",
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
