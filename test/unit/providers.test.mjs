/**
 * 自定义模型 provider（GLM / Moonshot / 自建端点…）。
 *
 * ## 这一套为什么需要存在
 *
 * 插件默认挂载的 `llm-deepseek` 只说 **Anthropic Messages** 一种协议、
 * 且模型目录是 DeepSeek 的。所以 GLM 的 `/api/v1`（OpenAI 兼容）
 * **无论地址怎么填都用不了** —— 那是协议问题，不是地址问题。
 *
 * 要接它就得多挂一个适配器（`llm-pi-ai`），而那意味着改写隔离实例的
 * **profile 组合层**（`package.json` 的 bundles 与 `cordis.patch.yml`）。
 * 这一层改错的后果是**宿主起不来** —— 整个插件失效，
 * 而错误发生在启动阶段，与"我第 3 个 provider 的地址写错了"距离很远。
 *
 * 所以这里把"生成什么"逐字钉住。
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
const {
  SUPPORTED_APIS,
  PI_AI_PACKAGE,
  MANAGED_START,
  MANAGED_END,
  credentialRefForRoute,
  validateProvider,
  validateEndpointUrl,
  buildProviderPatch,
  mergeManagedBlock,
  extractManagedBlock,
  ensurePiAiBundle,
  compositionNeedsRestart,
} = bundle;

/** 一个最小可用定义（测试里反复用） */
const glm = {
  route: "glm",
  api: "openai-completions",
  baseURL: "https://open.bigmodel.cn/api/v1",
  apiKey: "sk-test",
  displayName: "智谱 GLM",
  models: [{ id: "glm-4.7", name: "GLM-4.7" }],
};

describe("凭据引用名的转换", function () {
  it("路由名里的连字符必须转成下划线（引用名要 POSIX 标识符）", function () {
    // dsh 的 credentialRef 只接受 [A-Za-z_][A-Za-z0-9_]* ——
    // 直接用 `my-relay` 当引用名会被拒绝，而症状是"key 存不进去"。
    const ref = credentialRefForRoute("my-relay");
    assert.match(ref, /^[A-Za-z_][A-Za-z0-9_]*$/, `不是合法引用名：${ref}`);
    assert.ok(!ref.includes("-"), "引用名里不能有连字符");
  });

  it("不同路由得到不同引用名（否则一个 key 覆盖另一个）", function () {
    assert.notEqual(
      credentialRefForRoute("glm"),
      credentialRefForRoute("glm-cn"),
      "路由名不同就必须是不同的引用名",
    );
  });

  it("与路由名一一对应且稳定（重启后仍指向同一个凭据）", function () {
    assert.equal(credentialRefForRoute("glm"), credentialRefForRoute("glm"));
  });
});

describe("provider 定义校验", function () {
  it("接受一个正常定义", function () {
    assert.equal(validateProvider(glm), undefined);
  });

  it("路由名必须是安全字符（它会成为 provider id 与引用名的一部分）", function () {
    for (const bad of ["GLM", "my relay", "glm.cn", "-glm", "_x", ""]) {
      assert.ok(
        validateProvider({ ...glm, route: bad }),
        `路由名 ${JSON.stringify(bad)} 应被拒绝`,
      );
    }
  });

  it("路由名重复要拒绝（否则两条配置抢同一个 provider id）", function () {
    assert.match(validateProvider(glm, ["glm"]) ?? "", /已被另一个/);
  });

  it("协议必须是 pi-ai 注册的那三种", function () {
    assert.deepEqual(
      [...SUPPORTED_APIS],
      ["openai-completions", "openai-responses", "anthropic-messages"],
      "协议取值必须与 llm-pi-ai/src/provider.ts 的注册表一致",
    );
    assert.ok(validateProvider({ ...glm, api: "openai" }), "瞎写的协议要拒绝");
  });

  it("模型清单不能为空，且 id 不能重复", function () {
    assert.ok(validateProvider({ ...glm, models: [] }), "空模型清单要拒绝");
    assert.ok(
      validateProvider({
        ...glm,
        models: [{ id: "a" }, { id: "a" }],
      }),
      "重复模型 id 要拒绝",
    );
    assert.ok(
      validateProvider({ ...glm, models: [{ id: "  " }] }),
      "空 id 要拒绝",
    );
  });
});

describe("端点地址校验（与 dsh 同源）", function () {
  it("接受 GLM 的两个端点", function () {
    assert.equal(
      validateEndpointUrl("https://open.bigmodel.cn/api/v1"),
      undefined,
      "GLM 的 OpenAI 兼容端点应通过形状校验",
    );
    assert.equal(
      validateEndpointUrl("https://open.bigmodel.cn/api/anthropic"),
      undefined,
    );
  });

  it("拒绝 dsh 也会拒绝的形态（否则失败会出现在轮次里）", function () {
    assert.ok(validateEndpointUrl("https://x.com?a=1"), "查询参数");
    assert.ok(validateEndpointUrl("https://x.com#f"), "# 片段");
    assert.ok(validateEndpointUrl("https://u:p@x.com"), "内嵌凭据");
    assert.ok(validateEndpointUrl("ftp://x.com"), "非 http(s)");
    assert.ok(validateEndpointUrl("x.com"), "缺协议");
  });
});

describe("生成 cordis.patch.yml 的托管区块", function () {
  it("形状与 dsh 的 profile schema 对齐", function () {
    const patch = buildProviderPatch([glm]);
    assert.match(patch, /- id: llm-pi-ai/, "入口 id");
    assert.match(
      patch,
      new RegExp(`name: "${PI_AI_PACKAGE.replace(/[/@.]/g, "\\$&")}"`),
      "包名要与运行时里的包一致",
    );
    assert.match(patch, /^ {4}providers:$/m, "providers 要嵌在 config 下");
    assert.match(patch, /^ {6}glm:$/m, "路由名作为 providers 的键");
    assert.match(patch, /^ {8}api: openai-completions$/m);
    assert.match(
      patch,
      /^ {8}baseURL: https:\/\/open\.bigmodel\.cn\/api\/v1$/m,
    );
    assert.match(patch, /^ {10}- id: glm-4\.7$/m, "模型清单");
  });

  it("写的是**凭据引用名**，不是密钥本身", function () {
    const patch = buildProviderPatch([glm]);
    assert.match(patch, /apiKeyEnv: DSH_PI_AI_GLM/);
    assert.ok(
      !patch.includes("sk-test"),
      "配置文件里绝不能出现密钥 —— 它可能被复制出来贴给别人排查",
    );
  });

  it("关掉 web_search 的条目**总会出现**（与 provider 数量无关）", function () {
    // 这不是"顺带"的配置：它是这个托管区块存在的两个理由之一。
    // 没有它，模型会用 dsh 的 web_search 去找论文 —— 而那走的是**模型服务端**，
    // 看不见用户机构（大学图书馆）的订阅，拿到一堆抓不到全文的网页结果。
    for (const defs of [[], [glm]]) {
      const patch = buildProviderPatch(defs);
      assert.match(
        patch,
        /- id: tool-web/,
        `provider 数=${defs.length} 时缺少 tool-web 条目 —— web_search 就不会被关掉`,
      );
      assert.match(patch, /search: false/, "必须显式关掉 search");
      assert.match(
        patch,
        /fetch: true/,
        "**必须保留 fetch** —— web_fetch 在用户本机发请求，抓 PDF 直链要用它",
      );
    }
  });

  it("没有 provider 时只输出关 web_search 的条目，不写休眠的 llm-pi-ai", function () {
    // 空的 `providers:` 其实是**安全**的（dsh 的 pi-ai config 注释写明
    // "An omitted dict resolves to the empty, dormant route set"），
    // 但没有必要时就不写 —— 补丁越小越好读。
    const patch = buildProviderPatch([]);
    assert.ok(patch.includes("tool-web"), "关 web_search 的条目要在");
    assert.ok(
      !patch.includes("llm-pi-ai"),
      "没有自定义 provider 时不该出现休眠的 llm-pi-ai 条目",
    );
    assert.ok(!/providers:/.test(patch), "也不该出现空的 providers:");
  });

  it("含特殊字符的值会被加引号（否则 YAML 语义会变）", function () {
    const patch = buildProviderPatch([
      { ...glm, displayName: "GLM: 国内 # 主" },
    ]);
    assert.match(
      patch,
      /displayName: "GLM: 国内 # 主"/,
      "含 `: ` 与 ` #` 的值必须加引号 —— 否则会被当成映射或注释",
    );
  });

  it("普通地址**不加**引号（`:` 与 `/` 本身不改变 YAML 语义）", function () {
    // 早先按"含非安全字符就加引号"的粗规则，地址会被引起来 ——
    // 语义没错，但生成结果与预期形状对不上，排查时会误以为写错了。
    const patch = buildProviderPatch([glm]);
    assert.match(
      patch,
      /^ {8}baseURL: https:\/\/open\.bigmodel\.cn\/api\/v1$/m,
      "地址应保持原样",
    );
  });
});

describe("托管区块的并入与替换", function () {
  const base = [
    "# 用户自己的补丁层",
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    "    provider: deepseek-official",
    "",
  ].join("\n");

  it("首次并入时**保留用户已有条目**", function () {
    const merged = mergeManagedBlock(base, buildProviderPatch([glm]));
    assert.match(merged, /agent-default-model/, "用户条目必须原样保留");
    assert.match(merged, /id: llm-pi-ai/, "同时加入我们的条目");
    assert.ok(merged.includes(MANAGED_START) && merged.includes(MANAGED_END));
  });

  it("重复并入**不会累积**（幂等）", function () {
    const once = mergeManagedBlock(base, buildProviderPatch([glm]));
    const twice = mergeManagedBlock(once, buildProviderPatch([glm]));
    assert.equal(twice, once, "第二次并入应与第一次结果相同");
    assert.equal(
      (twice.match(/id: llm-pi-ai/g) ?? []).length,
      1,
      "不能出现两份 llm-pi-ai 条目",
    );
  });

  it("清空 provider 时把区块整个移除", function () {
    const once = mergeManagedBlock(base, buildProviderPatch([glm]));
    const cleared = mergeManagedBlock(once, "");
    assert.ok(!cleared.includes(MANAGED_START), "标记本身也应移除");
    assert.ok(!cleared.includes("llm-pi-ai"), "不能留下孤立的适配器条目");
    assert.match(cleared, /agent-default-model/, "用户条目仍要在");
  });

  it("extractManagedBlock 能取回写进去的内容（判是否已生效时用）", function () {
    const block = buildProviderPatch([glm]);
    const merged = mergeManagedBlock(base, block);
    assert.equal(extractManagedBlock(merged), block.trim());
    assert.equal(extractManagedBlock(base), "", "没有区块时返回空串");
  });
});

describe("profile 的 bundles", function () {
  const pkg = JSON.stringify(
    {
      name: "dsh-profile-plugin",
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
        },
      },
    },
    null,
    2,
  );

  it("需要时加上 pi-ai 包，且不动已有 bundles", function () {
    const { text, changed } = ensurePiAiBundle(pkg, true);
    assert.ok(changed);
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.dsh.profile.bundles, [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      PI_AI_PACKAGE,
    ]);
    assert.equal(parsed.private, true, "其它字段不能丢");
  });

  it("不需要时移除它（回到只挂 DeepSeek 适配器的状态）", function () {
    const withPi = ensurePiAiBundle(pkg, true).text;
    const { text, changed } = ensurePiAiBundle(withPi, false);
    assert.ok(changed);
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.dsh.profile.bundles, [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
    ]);
  });

  it("已经一致时不改动（返回 changed=false，避免无谓写盘）", function () {
    const withPi = ensurePiAiBundle(pkg, true).text;
    assert.equal(ensurePiAiBundle(withPi, true).changed, false);
    assert.equal(ensurePiAiBundle(pkg, false).changed, false);
  });

  it("内容损坏时原样返回（不把用户的 profile 写坏）", function () {
    const { text, changed } = ensurePiAiBundle("{ 不是 json", true);
    assert.equal(changed, false);
    assert.equal(text, "{ 不是 json");
  });
});

describe("判断是否需要重启", function () {
  const pkgWithout = JSON.stringify({
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  });
  const pkgWith = ensurePiAiBundle(pkgWithout, true).text;

  it("定义与磁盘一致时不需要重启", function () {
    const patch = mergeManagedBlock("# x\n", buildProviderPatch([glm]));
    assert.equal(compositionNeedsRestart(pkgWith, patch, [glm]), false);
  });

  it("还没挂上 pi-ai 时需要重启", function () {
    const patch = mergeManagedBlock("# x\n", buildProviderPatch([glm]));
    assert.equal(compositionNeedsRestart(pkgWithout, patch, [glm]), true);
  });

  it("改了 provider（patch 未同步）时需要重启", function () {
    const stale = mergeManagedBlock("# x\n", buildProviderPatch([]));
    assert.equal(compositionNeedsRestart(pkgWith, stale, [glm]), true);
  });

  it("清空 provider 后仍挂着 pi-ai 也需要重启（要把它卸载）", function () {
    const patch = mergeManagedBlock("# x\n", "");
    assert.equal(compositionNeedsRestart(pkgWith, patch, []), true);
  });
});

describe("接线与界面", function () {
  const page = read("addon/content/preferences.xhtml");
  const hooks = read("src/hooks.ts");
  const prefs = read("addon/prefs.js");
  const panel = read("src/modules/modelPanel.ts");
  const runtime = read("src/dsh/isolatedRuntime.ts");

  it("设置页有输入框与两个按钮", function () {
    for (const id of [
      "custom-providers",
      "providers-save",
      "providers-example",
    ]) {
      assert.ok(page.includes(id), `设置页缺少 ${id}`);
    }
  });

  it("事件都在 onPrefsEvent 里分发", function () {
    for (const type of ["providers-save", "providers-example"]) {
      assert.ok(page.includes(`'${type}'`), `设置页没有触发 ${type}`);
      assert.match(hooks, new RegExp(`"${type}"`), `hooks.ts 没有处理 ${type}`);
    }
  });

  it("载入时回填定义并检查是否需要重启", function () {
    assert.match(hooks, /initProvidersSection\(win\)/);
  });

  it("偏好有默认值（否则真机上读到 undefined）", function () {
    assert.match(prefs, /pref\("customProviders"/);
  });

  it("运行时准备阶段会写入 provider 配置（且必须在拉起宿主之前）", function () {
    const at = runtime.indexOf("applyProviders(");
    assert.ok(at > 0, "运行时必须调用 applyProviders");
    const startAt = runtime.indexOf("await " + "this.startHost");
    const spawnAt = runtime.indexOf("spawn(");
    if (startAt > 0 && spawnAt > 0) {
      assert.ok(
        at < spawnAt,
        "必须在拉起宿主之前写入 —— bundles 只在宿主启动时组合，之后再改无效",
      );
    }
  });

  it("保存时会逐条校验，并把**第几条**说清楚", function () {
    const at = panel.indexOf("export async function saveProviders");
    const body = panel.slice(at, at + 2600);
    assert.match(body, /第 \$\{i \+ 1\} 条/, "报错要指明是第几条");
    assert.match(body, /validateProvider/, "必须逐条校验");
  });
});
