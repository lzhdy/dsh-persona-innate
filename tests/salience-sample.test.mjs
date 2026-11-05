/**
 * 增量4 salience 降采样测试（sampleBySalience 纯函数）
 *
 * 覆盖（对应 docs/增量4-salience-实现规格.md §2 五点）：
 * 1) 事件数 ≤limit → 全保留，时间升序不变
 * 2) 事件数 >limit → 高 importance 较早事件保留、最近低 salience 被挤出
 * 3) 降采样结果时间升序（时序不变）
 * 4) limit=0 → 空数组不抛错
 * 5) 同 importance 两条，更近的 salience 更高（时间衰减生效）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleBySalience, salienceScore } from '../lib/recall.js';

/** 构造一条 PersonaEvent（覆盖默认值） */
function ev(over) {
  return {
    id: 'e1',
    time: '2026-11-05T12:00:00.000Z',
    topic: '闲聊',
    summary: '',
    emotionTags: [],
    importance: 0.5,
    provenance: 'user_direct',
    lastRetrieved: null,
    ...over,
  };
}

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

/* ── 1. ≤limit 全保留，时间升序不变 ── */

test('sampleBySalience：事件数 ≤limit 全保留，时间升序不变', () => {
  const events = [
    ev({ id: 'a', time: '2026-11-01T10:00:00.000Z' }),
    ev({ id: 'c', time: '2026-11-03T10:00:00.000Z' }),
    ev({ id: 'b', time: '2026-11-02T10:00:00.000Z' }),
  ];
  const out = sampleBySalience(events, 5, NOW);
  assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c'], '全保留且按时间升序恢复');
});

/* ── 2. >limit：高 importance 较早事件保留，最近低 salience 被挤出 ── */

test('sampleBySalience：事件数 >limit 时高 salience 较早事件保留、低 salience 被挤出', () => {
  const events = [
    ev({ id: 'old-important', time: '2026-10-16T12:00:00.000Z', importance: 0.9 }), // 20 天前，高 importance
    ev({ id: 'recent-low', time: '2026-11-05T12:00:00.000Z', importance: 0.1 }),     // 现在，低 importance
  ];
  const out = sampleBySalience(events, 1, NOW);
  assert.deepEqual(
    out.map((e) => e.id),
    ['old-important'],
    '高 importance 较早事件被保留，最近低 salience 事件被挤出',
  );
});

/* ── 3. 结果时间升序 ── */

test('sampleBySalience：降采样结果时间升序（时序不变）', () => {
  const events = [
    ev({ id: 'd', time: '2026-11-04T10:00:00.000Z', importance: 0.9 }),
    ev({ id: 'a', time: '2026-11-01T10:00:00.000Z', importance: 0.9 }),
    ev({ id: 'c', time: '2026-11-03T10:00:00.000Z', importance: 0.9 }),
    ev({ id: 'b', time: '2026-11-02T10:00:00.000Z', importance: 0.9 }),
  ];
  const out = sampleBySalience(events, 3, NOW);
  const times = out.map((e) => e.time);
  assert.deepEqual(times, [...times].sort(), '输出按时间升序');
  assert.equal(out.length, 3, '取 top-3');
});

/* ── 4. limit=0 → 空数组不抛错 ── */

test('sampleBySalience：limit=0 → 空数组不抛错', () => {
  const events = [ev({ id: 'a' }), ev({ id: 'b' })];
  assert.deepEqual(sampleBySalience(events, 0, NOW), []);
  assert.deepEqual(sampleBySalience([], 3, NOW), []);
});

/* ── 5. 同 importance 两条，更近的 salience 更高（时间衰减生效） ── */

test('sampleBySalience：同 importance 两条，更近的 salience 更高、limit=1 时保留更近者', () => {
  const closer = ev({ id: 'closer', time: '2026-11-04T12:00:00.000Z', importance: 0.5 });
  const older = ev({ id: 'older', time: '2026-10-01T12:00:00.000Z', importance: 0.5 });

  assert.ok(
    salienceScore(closer, NOW) > salienceScore(older, NOW),
    '同 importance 下更近的事件 salience 更高（recencyFactor 衰减生效）',
  );

  const out = sampleBySalience([closer, older], 1, NOW);
  assert.deepEqual(out.map((e) => e.id), ['closer'], 'limit=1 时保留更近者');
});

/* ── 补充：不修改入参（纯函数） ── */

test('sampleBySalience：不改动入参数组（纯函数）', () => {
  const events = [
    ev({ id: 'a', time: '2026-11-01T10:00:00.000Z' }),
    ev({ id: 'b', time: '2026-11-02T10:00:00.000Z' }),
  ];
  const before = events.map((e) => e.id);
  sampleBySalience(events, 1, NOW);
  assert.deepEqual(events.map((e) => e.id), before, '入参数组顺序不被修改');
});
