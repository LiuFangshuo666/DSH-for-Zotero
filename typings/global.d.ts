declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

/**
 * 构建时注入的版本号与构建时间。
 *
 * ⚠️ 标识符名是 **`__buildVersion__` / `__buildTime__`（双下划线）**。
 *
 * `zotero-plugin.config.ts` 的 `build.define` 里的键是 `buildVersion` / `buildTime`，
 * 而脚手架的替换实现是 `new RegExp("__" + key + "__")` —— 也就是说：
 *
 *  - 在 `addon/**` 资产（xhtml 等）里，写 `__buildVersion__` 会被替换（manifest 同理）；
 *  - 在 **bundle（`src/**`）里必须用裸标识符 `__buildVersion__`**，由同一替换步骤
 *    在打包**之后**扫 dist 完成 —— 名字写成 `buildVersion` 不会被替换，
 *    结果是一个**运行时** `ReferenceError`（构建与类型检查都不报错，只有真机/仿真跑到才炸）。
 *
 * 本项目踩过这个坑，所以这里把规则写清楚。
 */
declare const __buildVersion__: string;

/** 构建时间（同上） */
declare const __buildTime__: string;
