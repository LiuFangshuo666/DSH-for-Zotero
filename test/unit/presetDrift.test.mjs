/**
 * ## 自建 preset 必须与**已安装版本**的 `standard.patch.yml` 对得上
 *
 * ## 真机事故（2026-10-17）
 *
 * 用户升级桌面端 DSH 到 0.2.1-rc.1 后**完全无法新建会话**：
 *
 * ```text
 *   新建会话失败：agent-preset/invalid: tool-subagent (@deepseek-ai/dsh-tool-subagent):
 *   toolFilter is no longer supported; configure persona and tool plugins in an
 *   Agent Preset and select ...
 * ```
 *
 * 根因：新版**移除了 `toolFilter` 配置**，而我的 preset 是从**开发 checkout**
 * 镜像来的（那里还有它）→ preset 非法 → 建会话全败。
 *
 * **教训：镜像的源必须是「实际安装的那个版本」，而不是手边的开发副本。**
 *
 * ## 这条守卫检查什么
 *
 * 以**已安装**的 `standard.patch.yml` 为基准（它是"当前版本接受什么"的唯一权威）：
 *
 *  1. 基准里有的行，我的 preset 也得有（否则我漏了新版本新增的行 ——
 *     `tool-plugin-market` 就是这样漏的）；
 *  2. 同一行的 config 键，我的不能比基准多 —— **除非在白名单里**
 *     （`toolFilter` 就是这样多的，直接导致事故）；
 *  3. 我的 name（包名）必须在基准里出现过（否则引用了新版没有的包 ——
 *     `tool-schedule` 在 0.2.0-rc.2 就是这样）。
 *
 * ⚠️ 找不到已安装的 `standard.patch.yml` 就**跳过**（CI 里没有运行时）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const { buildZoteroPresetPatch } = bundle;

const installedStandard = join(
  process.env.USERPROFILE ?? "",
  "Zotero",
  "dsh-for-zotero",
  "runtime",
  "node_modules",
  "@deepseek-ai",
  "dsh-web-app",
  "presets",
  "standard.patch.yml",
);

const jsTag = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: () => true,
  construct: (value) => ({ js: value }),
});
const parse = (text) =>
  yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) });

/**
 * 我**有意**给某些行加的 config 键（基准里没有）。
 *
 * 每一条都要能说出理由，否则就是在偏离基准：
 *  - `persona.suffix`：工作规则（基准只有 prefix）
 *  - `time-context.timeZone/refreshIntervalMs`：钉时区、缩短刷新（文献相对时间）
 *  - `tool-skill.catalogDescriptionMaxLength`：收紧技能描述预算
 *  - `tool-ask-user.mode/timeout`：timed 模式（本插件回答提问的机制）
 */
const INTENTIONAL_EXTRA_CONFIG = {
  persona: ["suffix"],
  "time-context": ["timeZone", "refreshIntervalMs"],
  "tool-skill": ["catalogDescriptionMaxLength"],
  "tool-ask-user": ["mode", "timeout"],
};

/** 展开组内子插件 */
function flatten(rows) {
  const out = new Map();
  for (const row of rows) {
    if (row?.id) out.set(row.id, row);
    if (Array.isArray(row?.config)) {
      for (const [k, v] of flatten(row.config)) out.set(k, v);
    }
  }
  return out;
}

describe("自建 preset 与已安装版本对齐", function () {
  it("基准里有的行，我的 preset 都要有；config 键不得多出白名单", function () {
    if (!existsSync(installedStandard)) {
      this.skip();
      return;
    }
    const base = parse(readFileSync(installedStandard, "utf8"));
    const baseRows = flatten(base[0].insert[0].config.plugins);

    const mine = parse(buildZoteroPresetPatch());
    const myRows = flatten(mine[0].insert[0].config.plugins);

    // ① 不许漏行
    const missing = [...baseRows.keys()].filter((id) => !myRows.has(id));
    assert.deepEqual(
      missing,
      [],
      "这些行已安装版本里有、我的 preset 里没有 —— 新版新增的能力会被漏掉：" +
        missing.join(", "),
    );

    // ② 不许给某行加基准没有的 config 键（除非白名单）
    const offenders = [];
    for (const [id, baseRow] of baseRows) {
      const myRow = myRows.get(id);
      if (!myRow) continue;
      const baseKeys = Object.keys(baseRow.config ?? {});
      const myKeys = Object.keys(myRow.config ?? {}).filter(
        (k) => !Array.isArray(myRow.config[k]), // 组的 config 是数组，跳过
      );
      const allowed = INTENTIONAL_EXTRA_CONFIG[id] ?? [];
      for (const key of myKeys) {
        if (!baseKeys.includes(key) && !allowed.includes(key)) {
          offenders.push(`${id}.${key}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "这些 config 键在已安装版本里**不存在** —— 新版可能已移除它们，" +
        "写进 preset 会让整份 preset 非法（真机事故：toolFilter 就是这样让会话建不出来的）：\n    " +
        offenders.join("\n    "),
    );
  });

  it("我引用的包必须在已安装版本的 standard 里出现过", function () {
    if (!existsSync(installedStandard)) {
      this.skip();
      return;
    }
    const baseText = readFileSync(installedStandard, "utf8");
    const mine = parse(buildZoteroPresetPatch());
    const myRows = flatten(mine[0].insert[0].config.plugins);

    const strangers = [];
    for (const [id, row] of myRows) {
      const name = typeof row.name === "string" ? row.name : "";
      if (!name.startsWith("@deepseek-ai/")) continue;
      if (!baseText.includes(name)) strangers.push(`${id} (${name})`);
    }
    // 允许的例外：为兼容旧版而保留、且**必须 disabled**
    const bad = strangers.filter((s) => {
      const id = s.split(" ")[0];
      return myRows.get(id)?.disabled !== true;
    });
    assert.deepEqual(
      bad,
      [],
      "这些包在已安装版本的 standard 里没有出现 —— 若确实需要保留，必须 `disabled: true`：" +
        bad.join(", "),
    );
  });
});
