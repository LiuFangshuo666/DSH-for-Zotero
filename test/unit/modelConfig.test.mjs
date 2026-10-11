/**
 * 在 Zotero 里配置模型（API Key 与推理等级）。
 *
 * ## 这里守的是什么
 *
 * 这两项补的是一个**真实的可用性缺口**：隔离实例的凭据一律从桌面版 Harness 复制，
 * 所以没配过桌面版的用户**完全用不了插件** —— 而失败藏在 `turn/end` 的 reason 里。
 *
 * 缺陷形态也很特别：写错了**不会让任何检查失败**，只表现为
 * "我在插件里填了 key，它还是说没有 key"。所以逐条钉住。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const { setCredentialRef, hasCredentialRef, API_KEY_REF, validateBaseUrl } =
  bundle;

describe("第三方端点地址的校验（与 dsh 侧规则逐条对齐）", function () {
  it("接受正常的 http(s) 根地址", function () {
    for (const ok of [
      "https://api.deepseek.com",
      "http://127.0.0.1:8000",
      "https://relay.example.com/v1",
      "https://gateway.corp.cn/deepseek/",
    ]) {
      assert.equal(validateBaseUrl(ok), undefined, `应接受 ${ok}`);
    }
  });

  it("拒绝非 http(s) 协议", function () {
    assert.ok(validateBaseUrl("ftp://x.com"), "ftp 应被拒");
    assert.ok(validateBaseUrl("file:///etc/passwd"), "file 应被拒");
  });

  it("拒绝带用户名密码的地址（凭据应填在 API Key 那一栏）", function () {
    assert.match(
      validateBaseUrl("https://user:pass@api.example.com") ?? "",
      /用户名/,
    );
  });

  it("拒绝查询参数与片段（dsh 侧同样拒绝）", function () {
    assert.ok(validateBaseUrl("https://api.example.com?key=1"));
    assert.ok(validateBaseUrl("https://api.example.com#frag"));
  });

  it("拒绝不是 URL 的输入", function () {
    assert.ok(validateBaseUrl("随便写的"));
    assert.ok(validateBaseUrl("api.deepseek.com"), "缺协议也应被拒");
  });

  it("规则与 dsh 的判定**同源**（不能只靠印象放宽）", function () {
    const src = read("src/dsh/modelConfig.ts");
    const at = src.indexOf("export function validateBaseUrl");
    const body = src.slice(at, at + 1200);
    // dsh 的判据：protocol ∈ {http,https}、无 username/password、无 search、无 hash
    for (const token of [
      "http:",
      "https:",
      "username",
      "password",
      "search",
      "hash",
    ]) {
      assert.ok(
        body.includes(token),
        `校验里缺少 "${token}" —— dsh 侧是会拒绝的，插件不先拦就会变成"问答失败"`,
      );
    }
  });
});

describe("端点地址写进宿主设置", function () {
  const src = read("src/dsh/modelConfig.ts");

  it("用 settings/update 的**合并**语义，而不是 replace", function () {
    // replace 会整段覆盖，把用户在 dsh 网页里配过的其它字段一起抹掉。
    const at = src.indexOf("export async function syncBaseUrlToHost");
    const body = src.slice(at, at + 2000);
    assert.ok(body.includes('"settings/update"'), "必须用 settings/update");
    assert.ok(
      !body.includes('"settings/replace"'),
      "不得用 settings/replace —— 那会抹掉用户其它设置",
    );
  });

  it("先 describe 确认命名空间存在，再写（否则失败无法解释）", function () {
    const at = src.indexOf("export async function syncBaseUrlToHost");
    const body = src.slice(at, at + 2000);
    const describeAt = body.indexOf('"settings/describe"');
    const updateAt = body.indexOf('"settings/update"');
    assert.ok(describeAt > 0, "必须先读");
    assert.ok(describeAt < updateAt, "读要在写之前");
  });

  it("命名空间与 dsh 的派生规则一致（插件的 options.id）", function () {
    assert.match(
      src,
      /LLM_SETTINGS_NS = "llm-deepseek-api-key"/,
      "命名空间就是那个适配器插件的 id",
    );
    assert.match(src, /BASE_URL_FIELD = "baseURL"/, "字段名要与适配器一致");
  });

  it("地址非法时**不写进宿主**，也不假装成功", function () {
    const at = src.indexOf("export async function syncBaseUrlToHost");
    const body = src.slice(at, at + 1200);
    const invalidAt = body.indexOf("validateBaseUrl(url)");
    const describeAt = body.indexOf('"settings/describe"');
    assert.ok(invalidAt > 0 && invalidAt < describeAt, "校验要在写入之前");
  });
});

describe("端点地址在设置页的接线", function () {
  const page = read("addon/content/preferences.xhtml");
  const prefs = read("addon/prefs.js");
  const panel = read("src/modules/modelPanel.ts");

  it("有输入框，且是 text 类型（地址不是秘密）", function () {
    const at = page.indexOf('id="__addonRef__-model-base-url"');
    assert.ok(at > 0, "设置页缺少端点输入框");
    const open = page.lastIndexOf("<html:input", at);
    const element = page.slice(open, page.indexOf(">", at) + 1);
    assert.match(element, /type="text"/);
  });

  it("有默认值声明，且载入时回填", function () {
    assert.match(prefs, /pref\("modelBaseUrl"/, "prefs.js 缺少默认值");
    assert.match(panel, /userBaseUrl\(\)/, "载入时应回填已保存的值");
  });

  it("保存时与 API Key 一起提交（换中转站两者通常同时改）", function () {
    const at = panel.indexOf("export async function saveApiKey");
    const body = panel.slice(at, at + 2500);
    assert.match(body, /setUserBaseUrl\(urlValue\)/, "保存时要写入端点偏好");
    assert.match(body, /syncBaseUrlToHost/, "并要真的应用它");
  });

  it("地址非法时提前返回（不产生“保存成功但问答失败”的状态）", function () {
    const at = panel.indexOf("export async function saveApiKey");
    const body = panel.slice(at, at + 2500);
    const invalidAt = body.indexOf("if (urlInvalid)");
    const syncAt = body.indexOf("syncBaseUrlToHost");
    assert.ok(invalidAt > 0 && invalidAt < syncAt, "校验失败必须提前返回");
  });
});

describe("凭据文件的 refs 操作（纯文本）", function () {
  const base = [
    "version: 1",
    "records:",
    "  client-connection/browser-session:",
    "    kind: session",
    "refs:",
    "  OTHER_KEY: keep-me",
    "",
  ].join("\n");

  it("已存在该引用时**替换**值，而不是追加一行", function () {
    const before = base + "  DEEPSEEK_API_KEY: old\n";
    const after = setCredentialRef(before, API_KEY_REF, "sk-new");
    assert.match(after, /DEEPSEEK_API_KEY: sk-new/);
    assert.ok(!after.includes("old"), "旧值必须被替换掉");
    assert.ok(
      after.includes("OTHER_KEY: keep-me"),
      "不得动其它引用 —— 那是别的用途的凭据",
    );
  });

  it("不存在该引用时插入到 refs 段内（缩进必须对）", function () {
    const after = setCredentialRef(base, API_KEY_REF, "sk-new");
    const lines = after.split("\n");
    const refsAt = lines.indexOf("refs:");
    const inserted = lines.findIndex((l) => l.includes("DEEPSEEK_API_KEY"));
    assert.ok(inserted > refsAt, "必须插在 refs 段之内（否则层级错了）");
    assert.match(lines[inserted], /^\s{2}DEEPSEEK_API_KEY: sk-new$/);
  });

  it("**绝不**越出 refs 段：records 段里的同名键不能被当成目标", function () {
    // 构造一个诱饵：records 段里也有个 DEEPSEEK_API_KEY
    const decoy = [
      "version: 1",
      "records:",
      "  some-record:",
      "    DEEPSEEK_API_KEY: decoy",
      "refs:",
      "  DEEPSEEK_API_KEY: real",
      "",
    ].join("\n");
    const after = setCredentialRef(decoy, API_KEY_REF, "sk-x");
    assert.match(after, /DEEPSEEK_API_KEY: real|DEEPSEEK_API_KEY: sk-x/);
    assert.match(
      after,
      /DEEPSEEK_API_KEY: decoy/,
      "records 段里的诱饵必须原样保留（那是记录内容，不是凭据引用）",
    );
  });

  it("没有 refs 段时返回 undefined（让调用方放弃写入，而不是硬塞）", function () {
    const noRefs = "version: 1\nrecords:\n  a:\n    b: c\n";
    assert.equal(
      setCredentialRef(noRefs, API_KEY_REF, "sk-x"),
      undefined,
      "硬塞一行会写出层级错误的 YAML，宿主读不了 —— 症状是 key 没生效",
    );
  });

  it("hasCredentialRef 能区分'有值'与'空值'", function () {
    assert.equal(
      hasCredentialRef("refs:\n  DEEPSEEK_API_KEY: sk-abc\n", API_KEY_REF),
      true,
    );
    assert.equal(
      hasCredentialRef('refs:\n  DEEPSEEK_API_KEY: ""\n', API_KEY_REF),
      false,
      "空值等于没有 key",
    );
    assert.equal(hasCredentialRef("refs:\n", API_KEY_REF), false);
  });

  it("自检用的检查只返回布尔值（避免把密钥写进日志）", function () {
    const src = read("src/dsh/modelConfig.ts");
    const at = src.indexOf("export function hasCredentialRef");
    const body = src.slice(at, src.indexOf("\n}", at));
    // 它只该返回布尔判定，**不得**把读到的值本身交出去
    // （那样日志里就会出现密钥）。用"是否存在把值直接 return"来判断，
    // 而不是要求字面量 true/false —— 后者会把 `return value.length > 0`
    // 这种正常写法误判为违规（第一版就是这么假失败的）。
    assert.ok(
      !/return\s+m\[1\]/.test(body) && !/return\s+value\s*;/.test(body),
      "hasCredentialRef 不得返回密钥内容",
    );
    assert.match(body, /return value\.length > 0/, "应返回布尔判定");
  });
});

describe("API Key 的优先级（用户填的 > 桌面版复制来的）", function () {
  const merge = read("src/dsh/credentialMerge.ts");

  it("用户填过 key 时**覆盖**从桌面版复制来的值", function () {
    // 顺序与分支都要对：先前只做"没有才搬运"，于是用户填了也不生效。
    const at = merge.indexOf("const userKey = userApiKey();");
    assert.ok(at > 0, "必须检查用户填的 key");
    const branch = merge.slice(at, at + 700);
    assert.match(branch, /setCredentialRef\(updated, API_KEY_REF, userKey\)/);
    assert.ok(
      branch.indexOf("userKey") < branch.indexOf("extractRefLine"),
      "用户填的分支必须**排在**沿用桌面版的分支之前",
    );
  });

  it("没填时沿用桌面版的（不打扰已配好的用户）", function () {
    assert.match(
      merge,
      /refs\.DEEPSEEK_API_KEY（沿用桌面版）/,
      "沿用路径也要记进结果，便于自检显示当前来源",
    );
  });

  it("取值时去掉首尾空白（粘贴常带换行，key 不对多半就是这个）", function () {
    const cfg = read("src/dsh/modelConfig.ts");
    const at = cfg.indexOf("export function userApiKey");
    const body = cfg.slice(at, at + 500);
    assert.match(
      body,
      /\.trim\(\)/,
      "必须 trim —— 不可见的换行会让服务端拒绝认证",
    );
  });
});

describe("推理等级：候选值必须动态取，不能写死", function () {
  const panel = read("src/modules/modelPanel.ts");
  const rpc = read("src/dsh/rpc.ts");

  it("用 session/modelCatalog 取模型与等级", function () {
    assert.match(
      rpc,
      /"session\/modelCatalog"/,
      "必须用宿主提供的目录（模型自己声明有哪些等级）",
    );
    assert.match(panel, /fetchModelCatalog/, "设置页必须真的去取目录");
  });

  it("用 session/selectModel 装选择，且方法名与 dsh 的 @Remote 一致", function () {
    assert.match(
      rpc,
      /"session\/selectModel"/,
      "dsh 侧的远程名是 selectModel（驼峰）",
    );
    assert.match(
      rpc,
      /provider: string;\s*\n\s*model: string;/,
      "selectModel 需要 provider 与 model 两个值",
    );
  });

  it("等级为空时**不传**该字段（空串会被当成无效的 ReasoningEffortId）", function () {
    const transport = read("src/chat/transport.ts");
    const at = transport.indexOf("private async applyModelSelection");
    const body = transport.slice(at, at + 1200);
    assert.match(
      body,
      /choice\.reasoningEffort\s*\?\s*\{\s*reasoningEffort/,
      "必须先判空再展开字段",
    );
  });

  it("没选模型时什么都不做（不替用户做决定）", function () {
    const transport = read("src/chat/transport.ts");
    const at = transport.indexOf("private async applyModelSelection");
    const body = transport.slice(at, at + 400);
    assert.match(body, /if \(!choice\) return;/, "未选择时应直接返回");
  });

  it("选定模型失败不该让建会话失败（否则用户只看到会话建不出来）", function () {
    const transport = read("src/chat/transport.ts");
    const at = transport.indexOf("private async applyModelSelection");
    const body = transport.slice(at, at + 1600);
    assert.match(body, /catch \(error\)/, "必须有 catch");
    assert.ok(
      !/throw/.test(body),
      "applyModelSelection 必须吞掉错误并只记日志 —— 模型选择失败不该阻断建会话",
    );
  });

  it("取不到目录时**不显示任何候选项**，并说明原因", function () {
    const at = panel.indexOf("async function fillModelList");
    const body = panel.slice(at, at + 1400);
    assert.match(body, /if \(!result\.ok\)/, "必须有失败分支");
    assert.match(
      body,
      /setStatus\(win, result\.reason\)/,
      "失败时要如实说明，而不是给一份猜的清单（那会让用户选到无效值）",
    );
  });
});

describe("设置页的接线", function () {
  const page = read("addon/content/preferences.xhtml");
  const hooks = read("src/hooks.ts");
  const prefs = read("addon/prefs.js");

  it("模型一节有 API Key、模型、等级三个控件", function () {
    for (const id of ["model-api-key", "model-id", "model-effort"]) {
      assert.ok(page.includes(id), `设置页缺少控件 ${id}`);
    }
  });

  it("API Key 用 password 类型（不该在截图/肩窥下直接暴露）", function () {
    // ⚠️ 两个坑都要避开：
    //  1. 不能只搜 `model-api-key` —— 会先命中前面的
    //     `<html:label for="…-model-api-key">`，断言看的是 label 不是输入框；
    //  2. 不能假设 `type` 写在 `id` **之前** —— prettier 会重排属性，
    //     实测 `type="password"` 在 id 之前，而从 id 往后切就会漏掉它。
    // 所以取**整个元素**（从它自己的开标签到 `>`）再判断。
    const at = page.indexOf('id="__addonRef__-model-api-key"');
    assert.ok(at > 0, "设置页里找不到 API Key 输入框");
    const open = page.lastIndexOf("<html:input", at);
    assert.ok(open > 0, "该 id 不在一个 <html:input> 元素上");
    const element = page.slice(open, page.indexOf(">", at) + 1);
    assert.match(
      element,
      /type="password"/,
      `API Key 输入框应为 password 类型，实际元素：${element}`,
    );
  });

  it("两个下拉框绑定了偏好，且用 onsyncfrompreference 动态填充", function () {
    assert.match(page, /preference="modelId"/);
    assert.match(page, /preference="modelReasoningEffort"/);
    const sync = page.match(/onsyncfrompreference=/g) ?? [];
    assert.ok(
      sync.length >= 2,
      `两个下拉框都要走 onsyncfrompreference（当前 ${sync.length} 个）`,
    );
  });

  it("三个事件都在 onPrefsEvent 里分发了", function () {
    for (const type of ["model-sync", "model-refresh", "model-save-key"]) {
      assert.ok(
        page.includes(`'${type}'`),
        `设置页没有触发 ${type} —— 控件会点了没反应`,
      );
      assert.match(hooks, new RegExp(`"${type}"`), `hooks.ts 没有处理 ${type}`);
    }
  });

  it("四项偏好都有默认值声明（否则真机上读到 undefined）", function () {
    for (const key of [
      "modelApiKey",
      "modelProvider",
      "modelId",
      "modelReasoningEffort",
    ]) {
      assert.match(
        prefs,
        new RegExp(`pref\\("${key}"`),
        `prefs.js 缺少 ${key} 的默认值`,
      );
    }
  });

  it("设置页载入时会回填已保存的 Key 并尝试填充列表", function () {
    assert.match(hooks, /initModelSection\(win\)/, "load 分支必须调用它");
  });
});
