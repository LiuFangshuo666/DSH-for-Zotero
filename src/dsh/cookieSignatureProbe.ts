/**
 * cookie 罐写入的**签名内省**探针 —— 回答"到底该传什么"。
 *
 * ## 为什么还要再做一个（前面已有 cookieProbe）
 *
 * 前一版探针试了 12 种参数取值组合，全部 `NS_ERROR_ILLEGAL_VALUE`，连
 * "传一个 `nsICookie` 实例"也失败。这说明**问题不在取值，而在类型** ——
 * 继续穷举取值是浪费轮次。
 *
 * 本探针改从**能观察到的真相**出发，一次拿到三个决定性事实：
 *
 *  1. **`add` 的真实签名**：`Function.prototype.toString()` 在 XPCOM 方法上
 *     通常给出 `function add(...)` 或带实参名的文本；`inspect`（若可用）更直接。
 *     拿到形参个数与名字，"个数不足/值非法"就有了明确方向。
 *  2. **罐里已有 cookie 的形态**：读一个**真实存在**的 cookie，看它是不是
 *     `nsICookie`（有 `QueryInterface`），以及 `originAttributes` 的真实结构。
 *     这比猜 `{}` 靠谱得多 —— 我们把同一结构喂给 `add`。
 *  3. **`Components.classes` 能否构造 `nsICookie`**：深度探测说
 *     `Cc['@mozilla.org/cookie;1']` 构造器不存在，但 `Ci.nsICookie` 是否存在还没试。
 *
 * ## 输出
 *
 * 全部写进 `dsh-for-zotero-cookie-probe.txt`（append，带时间戳），
 * 便于离线判读。**不修改任何 cookie**：只读、只试 `add`（取名带 `probe` 前缀，
 * 成功后立刻删除）。
 */

/** 探针结果的一行（供报告拼装） */
export interface SignatureProbeLine {
  label: string;
  value: string;
}

/**
 * 收集签名内省信息。**只读**，不修改用户的 cookie 罐。
 */
export function probeCookieSignature(): SignatureProbeLine[] {
  const out: SignatureProbeLine[] = [];
  const push = (label: string, value: unknown) => {
    out.push({ label, value: format(value) });
  };

  const services = Services as unknown as { cookies?: Record<string, unknown> };
  const cookies = services.cookies;
  if (!cookies) {
    push("Services.cookies", "不可用");
    return out;
  }

  // ── 1. add 的签名 ────────────────────────────────────────
  const add = cookies.add as ((...a: unknown[]) => unknown) | undefined;
  push("typeof add", typeof add);
  if (typeof add === "function") {
    // ⚠️ 如实说明这个数字的含义：它是 `add` 的**形参个数**，是我们目前
    // 关于"该传几个参数"的**最强证据**（比任何猜测都硬），但它**不能证明**
    // 参数顺序与语义 —— 顺序仍然要按 nsiCookieManager 的公开签名来推。
    push("add.length（形参个数 —— 只说明个数，不说明顺序/语义）", add.length);
    push("add.toString()", safeToString(add));
    // 有些 XPCOM 包装提供 `inspect`
    const inspect = (add as unknown as { inspect?: () => string }).inspect;
    if (typeof inspect === "function") {
      try {
        push("add.inspect()", inspect.call(add));
      } catch (error) {
        push("add.inspect() 抛错", error);
      }
    }
  }

  // ── 2. 罐里已有 cookie 的真实形态 ─────────────────────────
  const list = cookies.cookies as unknown[] | undefined;
  push("cookies.cookies 是数组", Array.isArray(list));
  if (Array.isArray(list)) {
    push("罐内 cookie 总数", list.length);
    const first = list[0] as Record<string, unknown> | undefined;
    if (first) {
      push("首个 cookie 的键", Object.keys(first).join(","));
      push("首个 cookie.name", first.name);
      push("首个 cookie.host", first.host);
      push("首个 cookie.path", first.path);
      push("有 QueryInterface", typeof first.QueryInterface);
      push(
        "首个 cookie.originAttributes 形态",
        first.originAttributes === undefined
          ? "undefined"
          : format(first.originAttributes),
      );
      // nsICookie 的 schemeMap / isPartitioned 等新字段
      for (const key of [
        "schemeMap",
        "isPartitioned",
        "isHttpOnly",
        "isSecure",
        "isSession",
      ]) {
        push(`首个 cookie.${key}`, first[key]);
      }
    }
  }

  // ── 3. 能否造出接口对象 ───────────────────────────────────
  const g = globalThis as unknown as {
    Cc?: Record<string, (...a: unknown[]) => unknown>;
    Ci?: Record<string, unknown>;
    Components?: { classes?: Record<string, (...a: unknown[]) => unknown> };
  };
  push("Cc 可用", typeof g.Cc);
  push("Ci 可用", typeof g.Ci);
  push("Components.classes 可用", typeof g.Components?.classes);
  push("Ci.nsICookie", typeof g.Ci?.nsICookie);
  push("Ci.nsIOriginAttributes", typeof g.Ci?.nsIOriginAttributes);
  push("Ci.nsICookieManager", typeof g.Ci?.nsICookieManager);

  // 试造 nsICookie：若成功，把它的 originAttributes 结构也读出来
  for (const [label, contract] of [
    ["Cc['@mozilla.org/cookie;1']", "@mozilla.org/cookie;1"],
    ["Cc['@mozilla.org/cookie-service;1']", "@mozilla.org/cookie-service;1"],
  ] as const) {
    try {
      const factory = g.Cc?.[contract];
      if (typeof factory !== "function") {
        push(label, "构造器不存在");
        continue;
      }
      const instance = factory() as Record<string, unknown>;
      push(
        label,
        `构造成功；键=${Object.keys(instance).slice(0, 8).join(",")}`,
      );
      push(`${label}.originAttributes`, format(instance.originAttributes));
    } catch (error) {
      push(label, `构造失败：${format(error)}`);
    }
  }

  // ── 4. 用"同结构"再试一次 add ─────────────────────────────
  //
  // 思路：如果罐里已有 cookie 带 originAttributes，就把**同一个对象**喂给 add。
  // 若这样能成功，说明问题一直是"我们自造的 originAttributes 不被认"。
  const sample = Array.isArray(list)
    ? (list.find(
        (c) =>
          (c as { originAttributes?: unknown }).originAttributes !== undefined,
      ) as Record<string, unknown> | undefined)
    : undefined;
  if (sample) {
    const host = String(sample.host ?? "127.0.0.1");
    const name = "dsh-probe-signature";
    const value = "v1";
    const expiry = Math.floor(Date.now() / 1000) + 600;
    // ⚠️ 真机结论：`add.length` = **12**，而我们历史上一直传 11 个。
    //    这解释了错误码的分界（10 参 → "个数不足"；11 参 → 个数对了但**还差一个**，
    //    于是引擎在校验阶段就报 ILLEGAL_VALUE）。所以这里**从 12 参开始试**。
    //
    // 尾部两个参数（isPartitioned / schemeMap）是较新版本新增的：
    //  - `isPartitioned`：与 `originAttributes.partitionKey` 配套的布尔量；
    //  - `schemeMap`：位图，罐里已有 cookie 显示 `schemeMap = 2`。
    //    本机目标是 `http://127.0.0.1`，所以先试 2 再试 1，两个都试不到结论也没损失。
    const attempts: Array<{ label: string; args: unknown[] }> = [
      {
        label: "借用真实 originAttributes（12 参，schemeMap=2）",
        args: [
          sample.originAttributes,
          host,
          "/",
          name,
          value,
          false,
          true,
          false,
          expiry,
          2,
          false,
          2,
        ],
      },
      {
        label: "借用真实 originAttributes（12 参，schemeMap=1）",
        args: [
          sample.originAttributes,
          host,
          "/",
          name,
          value,
          false,
          true,
          false,
          expiry,
          2,
          false,
          1,
        ],
      },
      {
        label: "借用真实 originAttributes（11 参，对照）",
        args: [
          sample.originAttributes,
          host,
          "/",
          name,
          value,
          false,
          true,
          false,
          expiry,
          2,
          null,
        ],
      },
      {
        label: "借用真实 originAttributes（10 参，对照）",
        args: [
          sample.originAttributes,
          host,
          "/",
          name,
          value,
          false,
          true,
          false,
          expiry,
          2,
        ],
      },
    ];
    for (const attempt of attempts) {
      try {
        (add as (...a: unknown[]) => unknown).apply(cookies, attempt.args);
        push(attempt.label, "✅ 成功");
        try {
          (cookies.remove as (...a: unknown[]) => unknown).call(
            cookies,
            host,
            name,
            "/",
            {},
          );
        } catch {
          // 清不掉不影响结论
        }
      } catch (error) {
        push(attempt.label, `❌ ${format(error)}`);
      }
    }
  } else {
    push(
      "借用真实 originAttributes",
      "跳过：罐里没有带 originAttributes 的 cookie",
    );
  }

  return out;
}

/**
 * 把任意值格式化成一行（截断，避免诊断文件被单个对象撑爆）。
 *
 * ## ⚠️ XPCOM 异常的坑（真机踩到）
 *
 * 这里最初只判断 `value instanceof Error`，然后走 `JSON.stringify`。
 * 结果真机上探测结果显示 **`❌ {}`** —— 真正的错误信息**全丢了**：
 *
 *  - XPCOM 抛出的异常（`NS_ERROR_ILLEGAL_VALUE` 那类）**不是 `Error` 的实例**，
 *    所以第一个分支不命中；
 *  - 它的属性（`message` / `result` / `name`）**不可枚举**，
 *    于是 `JSON.stringify` 得到一个空对象 `{}`。
 *
 * 一条"探测失败：{}"的报告等于没有报告，还会让人以为探针坏了。
 * 现在按"**先取能读到的文字**"的顺序来：`String()` → `message` → `result`/`name` → JSON。
 */
function format(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string")
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);

  // 1) 标准 Error
  if (value instanceof Error) {
    const extra = readText(value, ["result", "code"]);
    return `${value.name}: ${value.message}${extra ? ` (${extra})` : ""}`;
  }

  // 2) XPCOM 异常（不是 Error，属性不可枚举）—— 这才是真机上遇到的那种
  if (typeof value === "object") {
    const message = readText(value, [
      "message",
      "result",
      "name",
      "code",
      "description",
    ]);
    if (message) return message;
    // 3) 普通对象：JSON
    try {
      const text = JSON.stringify(
        value,
        Object.keys(value as object).slice(0, 12),
      );
      if (text && text !== "{}")
        return text.length > 240 ? `${text.slice(0, 240)}…` : text;
    } catch {
      // 落到下面的 String()
    }
  }

  // 4) 最后兜底：多数 XPCOM 异常在这里会给出 "NS_ERROR_xxx" 之类的文字
  try {
    const text = String(value);
    if (text && text !== "[object Object]") {
      return text.length > 240 ? `${text.slice(0, 240)}…` : text;
    }
  } catch {
    // 忽略
  }
  return "(无法格式化)";
}

/** 从对象上按顺序读第一个非空文本属性（兼容不可枚举属性） */
function readText(source: object, keys: string[]): string | undefined {
  for (const key of keys) {
    try {
      const raw = (source as Record<string, unknown>)[key];
      if (typeof raw === "string" && raw.trim()) return raw.trim();
      if (typeof raw === "number") return String(raw);
    } catch {
      // 取不到就试下一个
    }
  }
  return undefined;
}

/** 取函数源码（XPCOM 包装上可能只有 `function () {\n    [native code]\n}`） */
function safeToString(fn: (...a: unknown[]) => unknown): string {
  try {
    return String(fn);
  } catch {
    return "(toString 失败)";
  }
}
