/**
 * 时间语义 — 单一事实源。
 *
 * 为什么单独一个模块：同一个"今天"曾在两处有不同定义，然后真的错了。
 * - `review-cursor` 用**本地零点**（并写注释解释为什么不能用 UTC 切片）；
 * - `recall.relativeDayLabel` 用**经过的 24 小时整除**。
 *
 * 后果：11-03 21:14（本地）的事件在 11-04 15:03 注入时只过了 17.8 小时，
 * 被标成「今天」，prompt 里出现 `2026-11-03（今天）`。对人格插件这不是排版问题：
 * 它会让模型把昨天下午的事当成刚发生的事，影响"这件事还热不热"的判断。
 *
 * 两条口径：
 * - 「日」一律指**本地日历日**，不是 UTC 日，也不是 24 小时窗口；
 * - 只有需要"窗口边界"的地方用时刻（`localDayStart`），需要"差几天"的地方用日索引（`localDayIndex`）。
 */

export const MS_PER_DAY = 86_400_000;

/**
 * 本地零点（毫秒）。
 * 刻意不用 `toISOString().slice(0,10)`：UTC 切片的"今天"在本地 02:00 前后会指向前一天。
 */
export function localDayStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * 本地日历日的序号（整数，可相减）。
 *
 * 做法：先把时刻"搬到"本地墙上时间（用 UTC 表示），再按 24h 取整。
 * `getTimezoneOffset()` 是「本地 → UTC 要加的分钟数」（东八区为 -480），
 * 所以 `ms - offset*60000` 得到的就是本地墙上时间的 UTC 表示。
 *
 * 这样 11-04 00:30 与 11-03 23:30 相差 1 个日索引（而不是 0），
 * 与 `localDayStart` 的语义一致。
 */
export function localDayIndex(ms: number): number {
  const offsetMin = new Date(ms).getTimezoneOffset();
  return Math.floor((ms - offsetMin * 60_000) / MS_PER_DAY);
}

/** 本地日历日之差：`toMs` 比 `fromMs` 晚几天。同日为 0，昨天为 1。 */
export function localDayDiff(fromMs: number, toMs: number): number {
  return localDayIndex(toMs) - localDayIndex(fromMs);
}

/** 本地日期串 YYYY-MM-DD（只作标签/审计，不参与窗口计算） */
export function localDateString(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
