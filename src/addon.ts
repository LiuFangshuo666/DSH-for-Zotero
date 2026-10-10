import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import type { RuntimeManager } from "./dsh/isolatedRuntime";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
    /**
     * 隔离 dsh 运行时的管理器。
     * 挂在 addon 上而不是模块级变量：配置解析（src/dsh/config.ts）需要在
     * 任意调用点取得"当前是否已有一个在跑的隔离实例"，而它拿不到 hooks 的模块作用域。
     */
    runtime?: RuntimeManager;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
