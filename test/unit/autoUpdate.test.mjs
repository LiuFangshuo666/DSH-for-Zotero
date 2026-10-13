/**
 * 自动更新的配置一致性。
 *
 * ## 为什么需要单独守
 *
 * 自动更新有**四处必须互相对上**，而任何一处错了都不会让构建、类型检查、
 * 单元测试或产物核验失败 —— 用户侧只是一直收不到更新（或下载到 404），
 * 发布者那边完全看不出异常。
 *
 * ```text
 *   manifest.json 的 update_url    →  指向仓库里的 update.json（Gitee raw 路径）
 *   update.json 的 update_link     →  指向 Release 附件（releases/download/…）
 *   update.json 的 update_hash     →  与实际 xpi 的 sha512 相符
 *   update.json 的版本             →  与 package.json 一致
 * ```
 *
 * 这里的断言分两类：
 *  - **纯静态**（可离线跑）：地址形态、版本一致性、`addonID` 对齐；
 *  - **依赖构建产物**：哈希是否真的对得上 —— 没有产物时跳过，
 *    所以先 `npm run build` 的 CI 顺序下它才真正生效。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

describe("自动更新配置", function () {
  const pkg = readJson("package.json");
  const update = readJson("update.json");
  const addonID = pkg.config.addonID;
  const entry = update?.addons?.[addonID]?.updates?.slice(-1)[0];

  it("update.json 里必须有本插件的更新条目", function () {
    assert.ok(
      entry,
      `update.json 里没有 ${addonID} —— Zotero 会认为"没有可用更新"`,
    );
  });

  it("清单版本与 package.json 一致（否则用户永远收不到新版）", function () {
    assert.equal(
      entry.version,
      pkg.version,
      `清单里是 ${entry.version}、package.json 是 ${pkg.version}。` +
        `跑 npm run update:json 重新发布（它会在不一致时报错）。`,
    );
  });

  it("update_link 指向 Gitee 而不是脚手架的 GitHub 默认值", function () {
    assert.match(
      entry.update_link,
      /^https:\/\/gitee\.com\/[^/]+\/[^/]+\/releases\/download\//,
      `update_link 必须是 Gitee 的 Release 下载地址：${entry.update_link}`,
    );
    assert.ok(
      !/github\.com/.test(entry.update_link),
      `update_link 里出现了 github.com —— 那是 zotero-plugin.config.ts 的默认值没改`,
    );
  });

  it("清单版本与下载地址互相吻合（路径里的 tag 要等于版本号）", function () {
    // 地址形如 …/releases/download/v0.2.1/dsh-for-zotero.xpi
    assert.match(
      entry.update_link,
      new RegExp(`/download/v${entry.version.replace(/\./g, "\\.")}/`),
      `下载地址里的 tag 与清单版本不一致：${entry.update_link}`,
    );
  });

  it("update_hash 是 sha512 的形状", function () {
    assert.match(
      entry.update_hash,
      /^sha512:[0-9a-f]{128}$/,
      `update_hash 形状不对：${entry.update_hash}`,
    );
  });

  it("声明了 Zotero 版本范围", function () {
    const zotero = entry?.applications?.zotero;
    assert.ok(zotero?.strict_min_version, `必须声明 strict_min_version`);
    assert.ok(zotero?.strict_max_version, `必须声明 strict_max_version`);
  });
});

/**
 * ## ⚠️ 这里**不**断言"清单哈希 == 当前产物哈希"（那在非可重现构建下必然假失败）
 *
 * 实测：本项目的构建**不可重现** —— 产物嵌入了构建时间，两次连续构建的 xpi
 * SHA256 就不同。而 `npm run verify` 里含一次构建，所以"跑完 verify 再跑测试"
 * 时清单哈希**必然**过期。第一版断言正是这么写的，于是每次 verify 之后都失败。
 *
 * 哈希是否真的对得上，只能在**发布那一刻**判断：
 * `tools/make-update-json.mjs` 会把 xpi 读一遍算 sha512 再比对，
 * 不一致就报错退出、不发布。那才是唯一能保证一致的时机。
 *
 * 所以这里只守两件事：形状正确、以及"发布脚本确实做了那项校验"。
 */
describe("自动更新清单的哈希", function () {
  const pkg = readJson("package.json");
  const entry =
    readJson("update.json")?.addons?.[pkg.config.addonID]?.updates?.slice(
      -1,
    )[0];
  const xpi = join(root, ".scaffold", "build", `${pkg.config.addonName}.xpi`);

  it("清单里有哈希（Zotero 靠它校验下载到的 xpi）", function () {
    assert.match(
      entry.update_hash,
      /^sha512:[0-9a-f]{128}$/,
      `哈希形状不对：${entry.update_hash}`,
    );
  });

  it("发布脚本会在写入前真的校验哈希（非可重现构建下的唯一保障）", function () {
    const script = readFileSync(
      join(root, "tools", "make-update-json.mjs"),
      "utf8",
    );
    assert.match(
      script,
      /hashOf\(xpiPath\)/,
      `发布脚本必须真的把 xpi 读一遍算哈希，而不是直接把产物清单拷过来`,
    );
    assert.match(
      script,
      /actual === update\.update_hash/,
      `哈希不一致时必须报错退出`,
    );
  });

  it("产物比清单新时（verify 刚重建过）跳过一致性比对，而不是假失败", function () {
    // 这条断言的价值是**把顺序陷阱变成一条会说话的规则**：
    // 清单必须在最后一次构建之后生成。产物更新 → 哈希必然过期 → 属正常。
    if (!existsSync(xpi) || !existsSync(join(root, "update.json"))) return;
    const stale =
      statSync(xpi).mtimeMs > statSync(join(root, "update.json")).mtimeMs;
    if (stale) return; // 正常情况，不是失败

    const actual = `sha512:${createHash("sha512")
      .update(readFileSync(xpi))
      .digest("hex")}`;
    assert.equal(
      actual,
      entry.update_hash,
      `清单比产物新，但哈希仍然对不上 —— 说明清单是用另一份产物生成的。` +
        `跑 npm run update:json 重新发布。`,
    );
  });
});

describe("更新地址生效值", function () {
  const config = readFileSync(join(root, "zotero-plugin.config.ts"), "utf8");
  const builtManifest = join(
    root,
    ".scaffold",
    "build",
    "addon",
    "manifest.json",
  );

  /**
   * ⚠️ 这里测的是**产物 manifest 里的实际值**，不是配置文件里的字面量。
   *
   * 两个理由：
   *  1. `update_url` 是脚手架从 `updateURL` **注入**的（见它的 `buildManifest`）——
   *     真正生效的是产物里的值；
   *  2. 在源码里查 `github.com` 会被**注释里解释“为什么不用它”**误伤
   *     （这个项目的注释就是这么写的），第一版断言正是被自己的说明拦下的。
   */
  it("产物 manifest 的 update_url 指向 Gitee raw 路径下的 update.json", function () {
    if (!existsSync(builtManifest)) return; // 没构建过就跳过
    const url = readJson(".scaffold/build/addon/manifest.json")?.applications
      ?.zotero?.update_url;
    assert.ok(url, `产物 manifest 里没有 update_url`);
    assert.match(
      url,
      /^https:\/\/gitee\.com\/[^/]+\/[^/]+\/raw\/[^/]+\/update(-beta)?\.json$/,
      `update_url 必须是 Gitee raw 路径下的清单：${url}`,
    );
    assert.ok(
      !/github\.com/.test(url),
      `update_url 指向了 github.com —— 本仓库在 Gitee`,
    );
  });

  /**
   * ⚠️ 不能用 `indexOf("关键字")` 取行：这份配置的**注释里也写了这些名字**
   * （解释它们各自干什么），于是命中的是注释而不是赋值行 —— 这个坑我踩了两次。
   * 直接用正则匹配**赋值形式**。
   */
  it("配置里 xpiDownloadLink 用 releases 路径（实测可匿名下载）", function () {
    assert.match(
      config,
      /xpiDownloadLink:\s*\n?\s*"[^"]*releases\/download\/v\{\{version\}\}/,
      `xpiDownloadLink 应指向 Release 附件`,
    );
  });

  it("配置里 updateURL 用 raw 路径（不是 releases 路径）", function () {
    assert.match(
      config,
      /updateURL:\s*\n?\s*"[^"]*raw\/main\/update\.json"/,
      `updateURL 必须用 raw 路径 —— releases/download/release/… 实测是 404`,
    );
  });
});

/**
 * ## CI 工作流必须与本地 `verify` 链**逐步一致**
 *
 * ### 真机失败（CI 第一次跑就红）
 *
 * `.scaffold/` 是构建产物、**不在仓库里**，所以 CI 检出后没有它；
 * 而 `npm run build` 每次都生成**字节不同**的 xpi（构建时间戳内嵌在产物里）。
 * 于是：
 *
 * ```text
 *   仓库里的 update.json  →  记录上一次提交时那份产物的 sha512
 *   CI 刚构建出的 xpi     →  哈希必然不同
 *   verify-bundle 的核对  →  **每次必失败**
 * ```
 *
 * 本地能过是因为 `npm run verify` 的顺序里有 `update:json` 把清单同步到
 * 刚构建的产物上。CI 漏了中间那步 → 一个**永远红**的检查。
 *
 * ⚠️ 永远红的检查比没有检查更糟：它训练所有人忽略 CI。
 * 而这类缺陷**不会让任何测试失败** —— 所以必须专门钉住。
 */
describe("CI 工作流与 verify 链同步", function () {
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const scripts = readJson("package.json").scripts;
  /** 取 `run:` 后面真正执行的命令，按出现顺序 */
  const runSteps = [...ci.matchAll(/^\s+run:\s*(.+)$/gm)].map((m) =>
    m[1].trim(),
  );

  it("CI 必须依次跑 build → update:json → test:unit → 产物核验", function () {
    // 顺序**就是**语义：update:json 必须在 build 之后、核验之前。
    // 缺了它，核验里的哈希比对永远失败（见上面文件头的推导）。
    const want = [
      "npm run build",
      "npm run update:json",
      "npm run test:unit",
      "node tools/verify-bundle.mjs",
    ];
    const missing = want.filter((cmd) => !runSteps.includes(cmd));
    assert.deepEqual(
      missing,
      [],
      `CI 缺少这些步骤：${missing.join("、")}\n` +
        `  它们必须与 package.json 的 verify 链一致，否则 CI 会红在\n` +
        `  「检出时没有 .scaffold/ → 构建出的 xpi 与仓库清单哈希必然不同」上。`,
    );

    const idx = want.map((cmd) => runSteps.indexOf(cmd));
    assert.deepEqual(
      idx,
      [...idx].sort((a, b) => a - b),
      "CI 里这四步的**顺序**不对 —— update:json 必须在 build 之后、核验之前",
    );
  });

  it("CI 必须与 package.json 的 verify 链保持一致（不能各写一套）", function () {
    // 用 verify 脚本本身作为"正确答案"，而不是再抄一份清单 ——
    // 抄一份就等于又多了一处会分叉的地方。
    const verify = scripts.verify;
    assert.ok(verify, "package.json 里应当有 verify 脚本");
    const chain = verify
      .split("&&")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const cmd of chain) {
      assert.ok(
        runSteps.includes(cmd),
        `verify 链里有 \`${cmd}\`，而 CI 没跑它 —— 两边必须一致`,
      );
    }
  });

  it("GitHub Actions 的版本号必须写具体数字（不能猜、不能用 latest）", function () {
    // 真机教训：我为了消掉 "Node.js 20 is deprecated" 提示，
    // 顺手把 v4 改成了 **v5** —— 而当时 checkout 已经是 v7、
    // setup-node 也是 v7。写一个**不存在的版本**会让工作流整体报错，
    // 症状比原先那条提示严重得多。
    // 所以：版本号要写，且必须是对着 GitHub Releases 查过的。
    const uses = [...ci.matchAll(/uses:\s*(actions\/[\w-]+)@([\w.]+)/g)];
    assert.ok(uses.length >= 2, "CI 里应当有 actions/* 的调用");
    for (const [, name, version] of uses) {
      assert.match(
        version,
        /^v\d+$/,
        `${name} 的版本应写成 \`vN\`（如 v7），实际是 "${version}" —— ` +
          `改动版本号前请先查 GitHub Releases 确认它存在`,
      );
    }
  });

  it("runner 固定版本，不跟随 ubuntu-latest", function () {
    // GitHub 已公告 latest 将于 2026-10-19 迁移到 Ubuntu 26，
    // 那会让构建环境在**我们没改任何东西**的情况下变化。
    // 固定版本让升级成为有意识的动作。
    assert.match(
      ci,
      /runs-on:\s*ubuntu-\d+\.\d+/,
      "CI 应固定 `ubuntu-24.04` 这样的具体版本，而不是 `ubuntu-latest`",
    );
    assert.ok(
      !/runs-on:\s*ubuntu-latest/.test(ci),
      "不要用 ubuntu-latest —— 它会在未通知的情况下换基础镜像",
    );
  });
});
