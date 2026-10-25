/**
 * ## 历史会话下拉的显示名
 *
 * 真机反馈："会话选择用更直观的命名"。
 *
 * 原来的选项长这样：
 *
 * ```text
 *   当前 session-9f2c31ab…
 *   ● session-4d81e0c7… 2026/10/25 14:32
 * ```
 *
 * 用户面对一列 `session-xxxxxxxx…` 根本分不清哪条是哪条 —— 那是**给机器看的 id**，
 * 不是给人看的名字。现在改成「标题 · 相对时间」，标题来自会话记录（首次提问生成）。
 *
 * ## 为什么相对时间而不是绝对时间
 *
 * 找"上次那条对话"时，人脑用的是"前两天那条"，不是"2026-10-23 15:04"。
 * 但太久远的用相对时间反而难懂（"97 天前"），所以超过一周回落到日期。
 */

/** 一组会话的展示信息（只取显示需要的字段） */
export interface SessionLabelInput {
  sessionId: string;
  /** 会话记录里的标题（首次提问生成）；没有就用 id 尾部兜底 */
  title?: string;
  /** 最后更新时间（毫秒） */
  updatedAt?: number;
  /** 宿主是否仍在跑这一轮 */
  running?: boolean;
  /** 是否是面板当前所在的那条 */
  current?: boolean;
}

/**
 * 相对时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / N 天前 / YYYY-MM-DD。
 *
 * @param at 目标时间（毫秒）
 * @param now 当前时间（毫秒），由调用方注入便于测试
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const diff = now - at;
  // 未来时间（时钟偏差）按"刚刚"处理，不要显示"-3 分钟前"
  if (diff < 60_000) return "刚刚";

  const then = new Date(at);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const clock = `${pad(then.getHours())}:${pad(then.getMinutes())}`;

  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (sameDay) return `今天 ${clock}`;

  // 昨天：用**日历日**减一天判断，而不是"差 24 小时"。
  //
  // ⚠️ 一小时内的小时差分支在上面就return了，所以"23:50 → 次日 00:10"
  // 显示的是「20 分钟前」而不是「昨天 23:50」—— 这是**有意**的：
  // 20 分钟前比"昨天"更精确，用户不会觉得时间错了。
  // 只有跨过午夜**且超过一小时**时才走到这里，那时「昨天 HH:mm」才对。
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${clock}`;
  }

  if (diff < 7 * 24 * 60 * 60_000)
    return `${Math.floor(diff / 86_400_000)} 天前`;

  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
}

/** 会话在 `<select>` 里的一行文字 */
export function sessionOptionLabel(
  input: SessionLabelInput,
  now: number = Date.now(),
): string {
  const title =
    (input.title ?? "").trim() ||
    // 没有标题时用 id 尾部：至少比整个 uuid 短，且仍可区分
    `会话 ${input.sessionId.slice(-6)}`;
  const when = input.updatedAt ? relativeTime(input.updatedAt, now) : "";
  const parts = [title];
  if (when) parts.push(when);
  let label = parts.join(" · ");
  if (input.current) label += "（当前）";
  // 运行中的会话前面加个点，和原来的视觉习惯保持一致
  return input.running ? `● ${label}` : label;
}
