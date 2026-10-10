import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  /**
   * # 自动更新的两个地址（都已实测，不要凭脚手架的默认值想当然）
   *
   * 脚手架把 `updateURL` 原样写进 `manifest.json` 的 `update_url`（见
   * `zotero-plugin-scaffold` 的 `buildManifest`），Zotero 据此**检查更新**；
   * `xpiDownloadLink` 则写进 `update.json` 的 `update_link`，是**下载**地址。
   *
   * ## ⚠️ 脚手架的默认值是 GitHub 的，照抄会得到一个不存在的地址
   *
   * 默认值是 `https://github.com/{{owner}}/{{repo}}/releases/download/release/…`。
   * 本仓库在 Gitee，`{{owner}}/{{repo}}` 会被填成 `laofashi666/dsh-for-zotero` ——
   * 于是拼出一个 GitHub 上并不存在的仓库。
   *
   * ## 实测结论（2026-10，用真实请求验证过）
   *
   * ```text
   *   releases/download/v0.2.1/dsh-for-zotero.xpi   → 200, application/zip, 197135 B
   *                                                   前 4 字节 50 4B 03 04（zip 魔数）✅
   *   releases/download/release/update.json         → 404 ❌
   *   raw/main/update.json（Gitee 原始文件路径）      → 200，匿名可读 ✅
   * ```
   *
   * 结论：
   *  - **`update_link` 用 releases 路径可行**（只要该版本打过 tag 并建了 Release，
   *    附件就匿名可下）—— 所以 `xpiDownloadLink` 保持 releases 形态；
   *  - **`update_url` 不能用 releases 路径**：那要求存在一个**名为 `release` 的
   *    Release** 来托管清单文件，只打版本 tag 是不够的，于是必然 404。
   *    改用 **`raw/main/update.json`** —— 它随仓库同步、匿名可读、
   *    **在版本控制里**（谁都能看出当前对外宣称的版本是哪个），而且
   *    Zotero 中文社区的几个插件用的就是这套写法。
   *
   * ## 因此每次发版多一步
   *
   * 改完 `package.json` 的版本后跑 `npm run update:json`，它按当前版本重写
   * 仓库根目录的 `update.json`（含 `update_hash`），然后与代码一起提交。
   * 忘了跑这一步的后果是**更新检查拿到旧版本号**，用户升不上去 ——
   * 所以 `tools/make-update-json.mjs` 会在版本与 `package.json` 不一致时
   * **主动报错退出**，不给"静默生成一个过时清单"的机会。
   */
  updateURL:
    "https://gitee.com/laofashi666/dsh-for-zotero/raw/main/update.json",
  xpiDownloadLink:
    "https://gitee.com/laofashi666/dsh-for-zotero/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
          // ⚠️ `build.define` 里的 `buildVersion` **不会**进入 bundle ——
          // 脚手架的 `replaceDefine` 只扫 `dist/addon/**`，而且发生在 esbuild
          // 打包**之前**（见 scaffold 的 `prepareAssets` → `replaceDefine` 在
          // `bundleScripts` 之前）。所以在 `src/**` 里写 `__buildVersion__` 会留下
          // 一个**裸标识符**：运行时 `ReferenceError`，而构建与类型检查都不报错
          // （本项目踩过 —— 10 个启动期仿真测试同时炸，才把它暴露出来）。
          //
          // 这里显式给 bundle 也注入一份，名字与 `build.define` 保持一致，
          // 于是 `src/**` 与 `addon/**` 里都写 `__buildVersion__` 即可。
          __buildVersion__: JSON.stringify(pkg.version),
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
