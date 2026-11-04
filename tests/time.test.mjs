/**
 * 时间语义回归：同一个「今天」只能有一个定义。
 *
 * 这一组用例的来源是一个真实错误：
 * `relativeDayLabel` 曾用「经过的 24 小时」整除，于是昨晚 21:14 的事在今天下午
 * 15:03 注入时只过了 17.8 小时，被标成「2026-11-03（今天）」。
 * 而 `review-cursor` 的「今天」用的是本地零点。同一个词两套语义。
 *
 * 因此这里的判据是「本地日历日」而不是「24 小时窗口」，
 * 并且刻意用 `new Date(y, m, d, h, mi)` 构造本地时刻，使断言与时区无关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localDayStart, localDayIndex, localDayDiff, localDateString } from '../lib/time.js';
import { relativeDayLabel } from '../lib/recall.js';

test('v0.5.3-T1 localDayStart 按本地零点，不按 UTC 切片', () => {
  const d = new Date(2026, 10, 4, 15, 3); // 2026-11-04 15:03 本地
  assert.equal(localDayStart(d), new Date(2026, 10, 4, 0, 0, 0).getTime());
  assert.equal(localDateString(d), '2026-11-04');
});

test('v0.5.3-T2 localDayIndex 对同一本地日的不同时刻相等', () => {
  const a = new Date(2026, 10, 4, 0, 1).getTime();
  const b = new Date(2026, 10, 4, 23, 59).getTime();
  assert.equal(localDayIndex(a), localDayIndex(b), '同一本地日必须同日索引');
});

test('v0.5.3-T3 跨本地零点即差 1 天，与 24 小时窗口无关', () => {
  const before = new Date(2026, 10, 3, 23, 59).getTime();
  const after = new Date(2026, 10, 4, 0, 1).getTime();
  assert.equal(localDayDiff(before, after), 1, '只差 2 分钟，但跨了日界，应算 1 天');
});

test('v0.5.3-T4 真实误判场景：昨晚 21:14 在今天 15:03 应是「昨天」', () => {
  // 对应线上事件 2026-11-03T13:14Z = 本地 2026-11-03 21:14
  const eventIso = new Date(2026, 10, 3, 21, 14).toISOString();
  const now = new Date(2026, 10, 4, 15, 3).getTime();
  assert.equal(relativeDayLabel(eventIso, now), '昨天', '17.8 小时 < 24 小时，但不是同一天');
});

test('v0.5.3-T5 同一本地日仍是「今天」', () => {
  const eventIso = new Date(2026, 10, 4, 0, 5).toISOString();
  const now = new Date(2026, 10, 4, 23, 55).getTime();
  assert.equal(relativeDayLabel(eventIso, now), '今天');
});

test('v0.5.3-T6 分档边界：3 天 / 2 周 / 3 个月 / 1 年', () => {
  const now = new Date(2026, 10, 4, 12, 0).getTime();
  const at = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  assert.equal(relativeDayLabel(at(2026, 10, 1), now), '3 天前');
  assert.equal(relativeDayLabel(at(2026, 9, 21), now), '2 周前');
  assert.equal(relativeDayLabel(at(2026, 7, 4), now), '3 个月前');
  assert.equal(relativeDayLabel(at(2025, 10, 4), now), '1 年前');
});

test('v0.5.3-T7 非法时间串返回空标签，不抛错', () => {
  assert.equal(relativeDayLabel('not-a-date', Date.now()), '');
});

test('v0.5.3-T8 未来时刻不产生负数标签', () => {
  const now = new Date(2026, 10, 4, 12, 0).getTime();
  const future = new Date(2026, 10, 5, 12, 0).toISOString();
  assert.equal(relativeDayLabel(future, now), '今天', '时钟漂移导致的未来事件按「今天」处理，不能出现「-1 天前」');
});
