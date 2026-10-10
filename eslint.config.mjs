// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

/**
 * ESLint 配置。
 *
 * ## 为什么要在这里补 `globals`
 *
 * `@zotero-plugin/eslint-config` 默认按**插件源码**（`src/**`，在 Zotero 沙箱里跑）
 * 设定环境。但本仓库里还有三类文件，它们跑在**完全不同的运行时**里：
 *
 * ```text
 *   src/**                 Zotero 沙箱      —— 默认配置就够
 *   addon/content/*.js     Web Worker / 页面（有自己的全局）
 *   test/unit/**           Node + Mocha
 *   tools/**               Node CLI
 * ```
 *
 * 不声明就会产生成片的 `no-undef`：`console` / `process` 在 Node 下当然是有的，
 * `self` / `WebSocket` 在 worker 里也是有的。**那是配置问题，不是代码问题** ——
 * 但满屏红会让真正的错误被淹没，CI 也永远过不去（开源后第一个 PR 就会撞上）。
 */
export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        "@typescript-eslint/no-unused-vars": "off",
      },
    },

    // ── addon 里的页面与 worker 脚本 ──────────────────────────────
    // 它们不在 Zotero 沙箱里，而是跑在窗口 / worker 环境。
    {
      files: ["addon/**/*.js"],
      languageOptions: {
        globals: {
          self: "readonly",
          location: "readonly",
          head: "readonly",
          WebSocket: "readonly",
          crypto: "readonly",
          TextDecoder: "readonly",
          TextEncoder: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
          setInterval: "readonly",
          clearInterval: "readonly",
          console: "readonly",
        },
      },
    },

    // ── 单元测试（Node + Mocha）──────────────────────────────────
    {
      files: ["test/**/*.{js,mjs,ts}"],
      languageOptions: {
        globals: {
          console: "readonly",
          process: "readonly",
          Buffer: "readonly",
          URL: "readonly",
          Response: "readonly",
          TextDecoder: "readonly",
          TextEncoder: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
          setInterval: "readonly",
          clearInterval: "readonly",
        },
      },
      rules: {
        // 同一个文件里有多个顶层 describe —— 本仓库按"被测模块"分组，
        // 一个模块的测试集中在一个文件里，读起来比拆成多文件更连贯。
        // 这是排版偏好，不影响测试行为。
        "mocha/max-top-level-suites": "off",

        // describe 体内做**纯计算**（例如解析一份固定的工具参数样本）——
        // 目的是让多个 it 共用同一份解析结果，避免重复解析。
        // 规矩本身是防"在 describe 里做有副作用/有顺序依赖的初始化"，
        // 而这里全是**确定性纯函数调用**，没有副作用、也没有顺序依赖。
        "mocha/no-setup-in-describe": "off",
      },
    },

    // ── 开发脚本（Node CLI）─────────────────────────────────────
    {
      files: ["tools/**/*.mjs"],
      languageOptions: {
        globals: {
          console: "readonly",
          process: "readonly",
          Buffer: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
        },
      },
    },
  ],
});
