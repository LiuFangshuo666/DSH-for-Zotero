/**
 * 从源码里取"一段有边界的东西"的助手 —— 给源码文本断言用。
 *
 * ## 为什么需要它（三份独立审计的共同结论）
 *
 * 这个仓库有一批守卫靠**读源码做文本断言**（因为 `sessionPane.ts` 里那些插件类方法
 * 没法在 Node 里直接跑）。它们原先普遍这么写：
 *
 * ```js
 *   const start = src.indexOf("private startToolPoller(");
 *   const body = src.slice(start, start + 2600);   // ← 固定字符窗口
 * ```
 *
 * **这类窗口在本项目里误报过三次**：
 *
 * 1. `toolPollers.set(dir` 在函数末尾，给函数加了一段守卫后它被推到 `+3765`，
 *    而窗口还是 2600 —— 测试立刻报「注册时也必须用 dir 当键」，而代码完全正确；
 * 2. 按**方法名**搜索时命中了**注释里提到这个名字**的地方（那句
 *    "重复启动轮询不会重复执行"），切出 660 字符，13 个操作全报"缺失"；
 * 3. 按关键字找"下一个方法"（`search(/\n {2}(private|async) /)`）时，
 *    守卫自己的注释里就含 `async`，切片在**函数体中间**断掉。
 *
 * 两个后果都很糟：
 *  - **改源码位置会红** → 守卫变成噪声，人会习惯性忽略它；
 *  - **改坏行为可能不红** → 窗口够宽就什么都能匹配上，"已经钉住了"是错觉。
 *
 * ## 这里的做法
 *
 * 按**语法边界**取，而不是按字符数：匹配**签名行**，再从**第一个 `{`** 起配平。
 * 「块的起点」这个问题由"匹配签名行"本身解决了 —— 匹配到哪一行，块就从哪一行开始，
 * 不需要任何回退启发式（见下面那段失败尝试的记录）。
 *
 * ⚠️ 仍要提醒：文本断言**本质上是弱判据**。能跑真实代码的地方优先用那种办法
 * （见 `sessionRender.test.mjs` 的 `loadRenderer()`：把页面脚本的前半段放进 `vm`
 * 里求值，那根本不需要读文本）。这里只是把"读文本"这一类做得**不脆**。
 *
 * ## ⚠️ 一个失败过的尝试（记下来免得有人再走一遍）
 *
 * 我本想把 27 处 `indexOf(签名) + slice(at, at + N)` **批量**换掉，于是写过一个
 * `blockFromPattern(source, pattern)`：从任意字面文本开始取配平块。
 *
 * **它不可靠，已删除。** 因为"匹配位置"不等于"块的起点"：
 *
 * ```text
 *   saveReplyAsNote: function (question, answer) {      ← 块从这一行开始
 *     return api.saveReplyAsNote({                      ← 匹配处往后第一个 `{` 是这里
 * ```
 *
 * 从匹配处往后找第一个 `{` 会先撞上**参数列表的 `(`**；而"往回退到空行或注释行"
 * 的启发式，在文档注释紧贴签名时会退进注释里（实测切出 102～245 字符，
 * 起点落在注释的结束标记上）。
 *
 * ⚠️ 写这段时我踩了一个坑，值得记下来：注释里**不能直接写出块注释的结束标记**
 * （那两个字符 `*` 加 `/`）—— 它会**当场把这条注释关掉**，于是后面几行变成真代码，
 * 报出"Unexpected identifier"，而报错行看起来完全无辜。
 * 想表达它时请用「注释结束标记」这种说法，或像这里一样绕开。
 *
 * **用一个新的脆弱换掉旧的脆弱没有意义** —— 而且旧的至少已过 500 条测试。
 * 所以：只有**签名形态明确、且能立刻验证**的场合才用这里的助手（目前只有
 * `methodBody`）。其余 27 处保持原样即可。
 */

/**
 * 取一个函数或方法的**完整定义**（签名在前、配平的大括号收尾）。
 *
 * ⚠️ 匹配的是**签名行**（行首缩进 + 可选修饰符 + 名字 + `(`），
 * 所以块的起点就是这一行 —— 不需要任何启发式回退。
 * 这正是 `blockFromPattern` 做不到的地方：它的匹配可能落在签名中间。
 *
 * @param source - 整个源文件文本
 * @param name - 函数/方法名（不含括号）
 * @returns 源码片段；找不到时返回 `undefined`
 */
export function methodBody(source, name) {
  const re = new RegExp(
    `^[ \\t]*(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+)*` +
      `(?:async\\s+)?${escapeRegExp(name)}\\s*\\(`,
    "m",
  );
  const m = re.exec(source);
  if (!m) return undefined;
  return balancedFrom(source, m.index);
}

/**
 * 取一个顶层函数的函数体。`methodBody` 的别名，语义相同 ——
 * 两个名字都留着是因为调用点的语境不同（类方法 vs 顶层函数），
 * 读起来更顺。真的需要区分时再分开实现。
 */
export function functionBody(source, name) {
  return methodBody(source, name);
}

/**
 * 从 `start` 开始取一段**配平的大括号块**。
 *
 * ## ⚠️ 必须从第一个 `{` 开始配平，而不是从第一个括号
 *
 * 第一版从 `start` 起对 `{`/`[`/`(` 一律计数，结果对
 * `private async startToolPoller(record: SessionRecord) {` 只切出 **54 字符** ——
 * 因为**参数列表的 `(` 先出现**，它的 `)` 一闭合就"配平结束"了，函数体根本没进去。
 * 测试随即报"找不到 toolPollers.has(dir)"。
 *
 * 所以先跳过签名、从**第一个 `{`** 起配平 —— 那才是函数体。
 *
 * ⚠️ 字符串字面量与注释里的括号仍会带偏它，但对本仓库的用途足够：
 * 偏差只会让片段**偏大**，而断言都是"必须包含某片段"式的。
 */
function balancedFrom(source, start) {
  const open = source.indexOf("{", start);
  if (open < 0) return source.slice(start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** 转义正则元字符 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
