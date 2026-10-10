import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

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
