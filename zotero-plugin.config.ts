import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  /**
   * ⚠️ 这两项**默认值是 GitHub 的**，而本仓库托管在 Gitee —— 不改的话会生成
   * `https://github.com/<owner>/<repo>/...` 这样的地址，而那个仓库并不存在。
   *
   * 脚手架会把这个值原样写进 `manifest.json` 的 `update_url`（见
   * `zotero-plugin-scaffold` 的 `buildManifest`），Zotero 据此检查更新。
   * 指向不存在的地址不会让插件坏掉，但会让更新检查一直失败，
   * 而且**给人一种"有自动更新"的错觉**。
   *
   * 现状：本项目**尚未开通自动更新**（需要把 `update.json` 传到发布页，
   * 且它由 GitHub Actions 的 release 工作流生成 —— 见 .github/workflows/release.yml）。
   * 如果将来在 Gitee 上做这件事，把下面两行换成真实的发布地址即可。
   */
  updateURL: `https://gitee.com/laofashi666/dsh-for-zotero/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
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
