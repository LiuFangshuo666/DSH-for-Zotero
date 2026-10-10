/**
 * 同一轮里多段助手正文的合并。
 *
 * ## 为什么单独一个纯函数
 *
 * 真机反馈："会话显示不全，回答停在半句"。原因是 `readTurn` 里
 * `current.response = text` 直接**覆盖** —— 而 dsh 在**多步执行**（调用工具）时
 * 一轮里会写多条 `assistant/message`：
 *
 *  - 最后一条若只有工具调用（正文为空），`if (text)` 跳过 → 回答停在上一段边界；
 *  - 若每段都有正文 → 只有最后一段留下，前面的全丢。
 *
 * 合并语义要同时兼容两种可能：
 *  - **重发式**：每条给"到目前为止的全文" → 新文本以旧文本开头；
 *  - **累积式**：每条只给这一段的增量 → 追加。
 *
 * 抽成纯函数才能把这两种语义都钉进测试 —— 这个 bug 一旦复发，
 * 用户看到的是"回答被截断"，很容易被误当成模型输出问题，很难查。
 */

/**
 * 合并已有正文与新到达的一段。
 *
 * 判据：**新文本是否以已有文本开头**。
 *  - 是 → 重发式，采用新的（否则会重复）
 *  - 否 → 累积式，追加（中间补空行，避免两句话粘成一句）
 */
export function mergeResponseText(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  // 重发式：新的包含旧的全文
  if (incoming.startsWith(existing)) return incoming;
  // 已经在末尾（重复投递同一段）→ 不重复追加
  if (existing.endsWith(incoming)) return existing;
  // 累积式：追加，段间补空行
  const needsBreak = !existing.endsWith("\n") && !incoming.startsWith("\n");
  return needsBreak ? `${existing}\n\n${incoming}` : `${existing}${incoming}`;
}
