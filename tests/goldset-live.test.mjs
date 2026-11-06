/**
 * live 实测接线测试（增量5 第二期）。
 *
 * 覆盖任务规格 D 部分要求的四种情形：
 *   ① 全对 → 指标 1.0；
 *   ② 全错 → 0.0 且 pass:false（不得写成 null）；
 *   ③ 无样例 → null 且 unmeasured='no_samples'；
 *   ④ 缺实现 → null 且 unmeasured='no_implementation'。
 * 另验证 relative_time 三条 check 走真实确定性函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildLiveReport } from '../scripts/eval-goldset-live.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 最小 PersonaEvent 形状（评分只用到 id / time / provenance，但字段保持真实必填） */
function ev(id, time, provenance) {
  return {
    id,
    time,
    topic: 'test',
    summary: `event ${id}`,
    emotionTags: [],
    importance: 0.3,
    provenance,
    lastRetrieved: null,
  };
}

const EVENTS = [
  ev('e-1', '2026-11-03T21:14:00', 'user_direct'),
  ev('e-2', '2026-11-03T21:16:00', 'self_direct'),
  ev('e-3', '2026-11-03T23:59:00', 'user_direct'),
  ev('e-4', '2026-11-04T00:01:00', 'user_direct'),
];

test('① 全对：speaker 指标为 1.0 且 pass=true', async () => {
  const items = [
    { id: 'spk-001', category: 'speaker', goldAnswer: 'user', evidenceEventIds: ['e-1'], check: 'speaker_provenance' },
    { id: 'spk-002', category: 'speaker', goldAnswer: 'assistant', evidenceEventIds: ['e-2'], check: 'speaker_provenance' },
  ];
  const report = await buildLiveReport(items, EVENTS);
  const m = report.summary.metrics['1'];
  assert.equal(m.value, 1);
  assert.equal(m.pass, true);
  assert.equal(m.unmeasured, null);
  assert.equal(m.measured, 2);
});

test('② 全错：指标为 0（不是 null）且 pass=false', async () => {
  // e-1 是 user_direct -> user，但 gold 要 assistant；e-2 是 self_direct -> assistant，但 gold 要 user
  const items = [
    { id: 'spk-001', category: 'speaker', goldAnswer: 'assistant', evidenceEventIds: ['e-1'], check: 'speaker_provenance' },
    { id: 'spk-002', category: 'speaker', goldAnswer: 'user', evidenceEventIds: ['e-2'], check: 'speaker_provenance' },
  ];
  const report = await buildLiveReport(items, EVENTS);
  const m = report.summary.metrics['1'];
  assert.equal(m.value, 0);
  assert.equal(m.pass, false);
  assert.equal(m.unmeasured, null);
});

test('③ 无样例：relative_time 指标为 null 且 unmeasured=no_samples', async () => {
  const report = await buildLiveReport([], EVENTS);
  const m = report.summary.metrics['2'];
  assert.equal(m.value, null);
  assert.equal(m.pass, null);
  assert.equal(m.unmeasured, 'no_samples');
  assert.equal(m.total, 0);
});

test('④ 缺实现：gold 落在实现值域外时为 null 且 unmeasured=no_implementation', async () => {
  const items = [
    { id: 'spk-003', category: 'speaker', goldAnswer: 'system', evidenceEventIds: ['e-1'], check: 'speaker_provenance' },
  ];
  const report = await buildLiveReport(items, EVENTS);
  const m = report.summary.metrics['1'];
  assert.equal(m.value, null);
  assert.equal(m.pass, null);
  assert.equal(m.unmeasured, 'no_implementation');
  assert.equal(m.measured, 0);
  assert.equal(m.skipped[0].id, 'spk-003');
});

test('relative_time 三条 check 走真实函数：local_date / same_day / relative_label', async () => {
  const items = [
    {
      id: 'rel-001',
      category: 'relative_time',
      goldAnswer: '2026-11-03',
      evidenceEventIds: ['e-1'],
      check: 'local_date',
      queryAt: '2026-11-04T15:03:00',
    },
    {
      id: 'rel-002',
      category: 'relative_time',
      goldAnswer: '否',
      evidenceEventIds: ['e-3', 'e-4'],
      check: 'same_day',
      queryAt: '2026-11-04T00:01:00',
    },
    {
      id: 'rel-003',
      category: 'relative_time',
      goldAnswer: '2 天前',
      evidenceEventIds: ['e-1'],
      check: 'relative_label',
      queryAt: '2026-11-05T12:00:00',
    },
  ];
  const report = await buildLiveReport(items, EVENTS);
  const m = report.summary.metrics['2'];
  assert.equal(m.value, 1, '三条确定性评测均应与 gold 一致');
  assert.equal(m.pass, true);
  assert.equal(report.categories.relative_time.items.find((i) => i.id === 'rel-002').predicted, '否');
  assert.equal(report.categories.relative_time.items.find((i) => i.id === 'rel-003').predicted, '2 天前');
});

test('CLI 空跑 lib+fixture：exit 0 且输出含 unmeasured 的合法 JSON', () => {
  const res = spawnSync(process.execPath, [path.join('scripts', 'eval-goldset-live.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.mode, 'live');
  assert.ok(report.summary.metrics['12'].unmeasured === 'cost_not_wired');
  assert.ok(['no_samples', null].includes(report.summary.metrics['3'].unmeasured));
});
