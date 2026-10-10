#!/usr/bin/env node
/**
 * 把自动更新清单发布到仓库根目录的 `update.json`。
 *
 * # 自动更新靠什么（Zotero 用的是 Firefox 的扩展更新格式）
 *
 * ```text
 *   manifest.json 的 update_url   →  Zotero 定期取这个 JSON，比对版本号
 *   update.json 的 update_link    →  有新版时下载这个 xpi
 *   update.json 的 update_hash    →  下载后校验，防止下到坏文件
 * ```
 *
 * # 为什么是"搬运 + 校验"而不是自己拼一份
 *
 * 脚手架的 `npm run build` **已经**在 `.scaffold/build/update.json` 生成了一份内容
 * 完全正确的清单（版本、下载地址、sha512、Zotero 版本范围都由它从配置推导）。
 * 自己再算一遍哈希、再拼一次地址，只会多出一处可能与它不一致的地方 ——
 * 而这类不一致的后果是**用户升不上去，且没有报错**。
 *
 * 所以这个脚本只做两件事：
 *   1. **校验**产物里那份清单（版本与 `package.json` 一致、地址不是 GitHub 默认值、
 *      哈希形如 `sha512:<hex>`、`update_link` 指向的 xpi 真的存在且哈希相符）；
 *   2. 校验通过后**复制**到仓库根目录，供 Gitee 的 raw 路径对外提供。
 *
 * # ⚠️ 为什么放在仓库根目录
 *
 * `manifest.json` 的 `update_url` 指向
 * `https://gitee.com/laofashi666/dsh-for-zotero/raw/main/update.json`。
 * 放在仓库里而不是某个 Release 附件里，原因是**实测**：
 *
 * ```text
 *   releases/download/release/update.json   →  404
 *     （要它可用，得有一个叫 release 的 Release 专门托管清单文件；
 *       只打版本 tag 是不够的）
 *   raw/main/update.json                    →  200，匿名可读 ✅
 * ```
 *
 * 附带好处：清单**在版本控制里**，谁都能看出当前对外宣称的版本是哪个。
 *
 * # 用法
 *
 * ```powershell
 * npm run build          # 先生成产物（清单在产物里）
 * npm run update:json    # 校验并发布到仓库根目录
 * ```
 */

import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT = join(root, ".scaffold", "build");
const GITEE = "https://gitee.com/laofashi666/dsh-for-zotero";

/** 收集所有问题，最后一起报出来（一次跑完就知道要改几处） */
const problems = [];

function check(condition, message) {
  if (!condition) problems.push(message);
  return condition;
}

/** 与脚手架同格式的哈希：`sha512:<hex>` */
async function hashOf(file, algorithm = "sha512") {
  const bytes = await readFile(file);
  return `${algorithm}:${createHash(algorithm).update(bytes).digest("hex")}`;
}

async function main() {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { addonID } = pkg.config;
  const version = pkg.version;
  const isPreRelease = version.includes("-");

  // 预发布走 update-beta.json：正式用户不该被推上 beta
  const entryName = isPreRelease ? "update-beta.json" : "update.json";
  const builtPath = join(BUILT, entryName);
  const outPath = join(root, entryName);

  try {
    await stat(builtPath);
  } catch {
    console.error(
      `产物里没有 ${entryName}：${builtPath}\n` +
        `先跑 \`npm run build\`（它由脚手架生成），再运行本脚本。`,
    );
    process.exit(1);
  }

  const data = JSON.parse(await readFile(builtPath, "utf8"));
  const update = data?.addons?.[addonID]?.updates?.slice(-1)[0];

  if (!check(update, `清单里没有 addon ${addonID} 的更新条目`)) {
    return report();
  }

  // ── 校验 ────────────────────────────────────────────────
  check(
    update.version === version,
    `清单里的版本是 ${update.version}，而 package.json 是 ${version} —— ` +
      `两者必须一致，否则用户收不到新版本。`,
  );

  check(
    typeof update.update_link === "string" &&
      update.update_link.startsWith(`${GITEE}/`),
    `update_link 不是本仓库的 Gitee 地址：${update.update_link}\n` +
      `  很可能是 zotero-plugin.config.ts 里漏改了脚手架的 GitHub 默认值。`,
  );

  check(
    typeof update.update_hash === "string" &&
      /^sha512:[0-9a-f]{128}$/.test(update.update_hash),
    `update_hash 形状不对：${update.update_hash}`,
  );

  // update_link 指向的文件必须真实存在、且哈希相符 —— 这是最实质的一条：
  // 地址能与内容对上，Zotero 下载后才不会校验失败。
  const xpiName = update.update_link?.split("/").pop();
  const xpiPath = join(BUILT, xpiName ?? "");
  let xpiOk = false;
  try {
    await stat(xpiPath);
    xpiOk = true;
  } catch {
    check(false, `update_link 指向的 xpi 在产物里不存在：${xpiName}`);
  }
  if (xpiOk) {
    const actual = await hashOf(xpiPath);
    check(
      actual === update.update_hash,
      `哈希对不上：\n    清单 ${update.update_hash}\n    实际 ${actual}\n` +
        `  （清单多半是旧产物留下的，重新 \`npm run build\` 再试）`,
    );
  }

  // 本地已发布的那份：版本相同就提醒（避免"忘了改版本号"被当成一次发布）
  let previousVersion;
  try {
    const prev = JSON.parse(await readFile(outPath, "utf8"));
    previousVersion = prev?.addons?.[addonID]?.updates?.slice(-1)[0]?.version;
  } catch {
    previousVersion = undefined;
  }

  if (problems.length > 0) return report();

  // ── 发布 ────────────────────────────────────────────────
  await copyFile(builtPath, outPath);
  // 复制后原样写回一次，保证以 LF 与结尾换行落盘（Windows 上 copyFile 不转换）
  await writeFile(outPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  console.log(`已发布 ${entryName}`);
  console.log(`  版本      ${version}${isPreRelease ? "（预发布）" : ""}`);
  console.log(`  下载地址  ${update.update_link}`);
  console.log(`  哈希      ${String(update.update_hash).slice(0, 30)}…`);
  if (previousVersion && previousVersion !== version) {
    console.log(`  （仓库里原来是 ${previousVersion}）`);
  } else if (previousVersion === version) {
    console.log(
      `  ⚠️ 仓库里已经是 ${version}。若你刚改了功能准备发版，` +
        `请先提升版本号：\n     npm version <新版本> --no-git-tag-version`,
    );
  }
  console.log("");
  console.log("发版还差这些步骤（缺一步用户就升不上去）：");
  console.log(
    `  1. git add ${entryName} package.json package-lock.json && git commit`,
  );
  console.log(`  2. git tag -a v${version} -m "${version}"`);
  console.log(`  3. git push gitee main && git push gitee v${version}`);
  console.log(
    `  4. 在 Gitee 上为 v${version} 建 Release，并上传产物 xpi\n` +
      `     （update_link 指向的就是那个附件，没有附件用户会下载到 404）`,
  );
}

function report() {
  console.error("update.json 未发布，有下面这些必须先解决的问题：\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

await main();
