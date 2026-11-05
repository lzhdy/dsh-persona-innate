/**
 * P3 schema 测试：facts 七态 + 五时间戳 + evidence_group_id + lastMentionedAt 修正
 *
 * 依据 docs/p3-schema-实现规格.md §5。只验 schema 骨架与两处语义修正，
 * 不改动现有 status 写入语义（新=active、取代=superseded、复活=active）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import {
  MemoryFactStore,
  attributeId,
  deriveMemoryFacts,
  evidenceGroupId,
  inferSpeakerEpistemic,
} from '../lib/memory-facts.js';

function tempFs(root) {
  return {
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async readText(path) {
      return readFile(path, 'utf-8');
    },
    async writeText(path, content) {
      await mkdir(root, { recursive: true });
      await writeFile(path, content, 'utf-8');
    },
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'persona-p3-'));
  return new JsonStore(tempFs(dir), dir);
}

/* ── 1. 七态 status 校验（经 loadAttributes 的 isAttributeShaped） ── */

test('p3-1: 七态 status 全部通过校验，非法 status 被丢弃', async () => {
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  const now = new Date().toISOString();
  const statuses = ['candidate', 'active', 'quarantined', 'disputed', 'superseded', 'retracted', 'expired'];

  await facts.saveAttributes(
    statuses.map((status, i) => ({
      id: attributeId(`k${i}`, `v${i}`),
      key: `k${i}`,
      value: `v${i}`,
      status,
      confidence: 0.5,
      sourceEventIds: ['ev_x'],
      firstSeenAt: now,
      updatedAt: now,
    })),
  );
  const loaded = await facts.loadAttributes();
  assert.ok(loaded.ok);
  assert.equal(loaded.items.length, 7, '七态全部通过 shape 校验');

  await facts.saveAttributes([
    {
      id: attributeId('bad', 'x'),
      key: 'bad',
      value: 'x',
      status: 'bogus',
      confidence: 0.5,
      sourceEventIds: ['ev_x'],
      firstSeenAt: now,
      updatedAt: now,
    },
  ]);
  const bad = await facts.loadAttributes();
  assert.ok(bad.ok);
  assert.equal(bad.items.length, 0, '非法 status 应被丢弃');
});

/* ── 2. evidenceGroupId 同源稳定 / 异源区分 ── */

test('p3-2: evidenceGroupId 同 sourceEventIds 不同顺序同 group，不同来源不同 group', () => {
  assert.equal(evidenceGroupId(['a', 'b']), evidenceGroupId(['b', 'a']), '忽略顺序');
  assert.notEqual(evidenceGroupId(['a', 'b']), evidenceGroupId(['a', 'c']), '不同来源集合不同组');
  assert.ok(evidenceGroupId(['a']).startsWith('eg_'), '前缀为 eg_');
});

/* ── 3. inferSpeakerEpistemic 推导规则 ── */

test('p3-3: inferSpeakerEpistemic 按 provenance 推导 speaker/epistemicType', () => {
  assert.deepEqual(inferSpeakerEpistemic('user_direct'), { speaker: 'user', epistemicType: 'user_statement' });
  assert.deepEqual(inferSpeakerEpistemic('self_direct'), { speaker: 'assistant', epistemicType: 'ai_inference' });
  assert.deepEqual(inferSpeakerEpistemic('self_correction'), { speaker: 'assistant', epistemicType: 'ai_inference' });
  assert.deepEqual(inferSpeakerEpistemic('induced'), { speaker: 'assistant', epistemicType: 'ai_inference' });
  assert.deepEqual(inferSpeakerEpistemic('tool_output'), { speaker: 'tool', epistemicType: 'direct_observation' });
  assert.deepEqual(inferSpeakerEpistemic('retrieved_content'), { speaker: 'tool', epistemicType: 'direct_observation' });
  const inferred = inferSpeakerEpistemic('inferred');
  assert.equal(inferred.speaker, undefined, 'inferred 的 speaker 无法可靠归属');
  assert.equal(inferred.epistemicType, 'ai_inference');
});

/* ── 4. lastMentionedAt 由真实提及时间计算 ── */

test('p3-4: thread 的 lastMentionedAt 取最新 sourceEvent 的 time，而非派生时刻', () => {
  const now = new Date('2026-11-05T12:00:00Z').toISOString();
  const t1 = new Date('2026-11-01T08:00:00Z').toISOString();
  const t2 = new Date('2026-11-03T09:00:00Z').toISOString();
  const eventTimes = new Map([['ev_a', t1], ['ev_b', t2]]);

  const derived = deriveMemoryFacts({
    raw: { threads: [{ key: '面试', title: '周四的面试', status: 'open', sourceEventIds: ['ev_a', 'ev_b'] }], attributes: [] },
    knownEventIds: new Set(['ev_a', 'ev_b']),
    existingThreads: [],
    existingAttributes: [],
    now,
    eventTimes,
  });
  assert.equal(derived.threads[0].lastMentionedAt, t2, '应取最新源事件 time');
  assert.notEqual(derived.threads[0].lastMentionedAt, now, '不再是派生时刻');
});

/* ── 5. attribute 新字段填充 ── */

test('p3-5: 新建 attribute 填充 assertedAt/ingestedAt/statusChangedAt/evidenceGroupId/speaker/epistemicType', () => {
  const now = new Date('2026-11-05T12:00:00Z').toISOString();
  const t1 = new Date('2026-11-01T08:00:00Z').toISOString();
  const t2 = new Date('2026-11-03T09:00:00Z').toISOString();
  const eventTimes = new Map([['ev_a', t1], ['ev_b', t2]]);
  const eventProvenances = new Map([['ev_a', 'user_direct'], ['ev_b', 'user_direct']]);

  const derived = deriveMemoryFacts({
    raw: { threads: [], attributes: [{ key: '工作单位', value: '杭州某公司', confidence: 0.8, sourceEventIds: ['ev_a', 'ev_b'] }] },
    knownEventIds: new Set(['ev_a', 'ev_b']),
    existingThreads: [],
    existingAttributes: [],
    now,
    eventTimes,
    eventProvenances,
  });
  const a = derived.attributes[0];
  assert.equal(a.status, 'active');
  assert.equal(a.assertedAt, t2, 'assertedAt = 最新源事件 time');
  assert.equal(a.ingestedAt, now);
  assert.equal(a.statusChangedAt, now);
  assert.equal(a.speaker, 'user');
  assert.equal(a.epistemicType, 'user_statement');
  assert.equal(a.evidenceGroupId, evidenceGroupId(['ev_a', 'ev_b']));
  assert.equal(a.validFrom, null);
  assert.equal(a.validTo, null);
});

/* ── 6. 迁移兼容 ── */

test('p3-6: 旧两态数据通过校验；无 eventTimes/eventProvenances 回退旧行为', async () => {
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  const now = new Date().toISOString();

  await facts.saveAttributes([
    { id: attributeId('k', 'v'), key: 'k', value: 'v', status: 'active', confidence: 0.5, sourceEventIds: ['ev_x'], firstSeenAt: now, updatedAt: now },
    { id: attributeId('k', 'v2'), key: 'k', value: 'v2', status: 'superseded', confidence: 0.5, sourceEventIds: ['ev_x'], firstSeenAt: now, updatedAt: now, supersededBy: 'at_x', supersededAt: now },
  ]);
  const loaded = await facts.loadAttributes();
  assert.ok(loaded.ok);
  assert.equal(loaded.items.length, 2, '旧两态（active/superseded）是七态子集，直接通过');

  const derived = deriveMemoryFacts({
    raw: {
      threads: [{ key: '面试', title: 'x', status: 'open', sourceEventIds: ['ev_x'] }],
      attributes: [{ key: 'k', value: 'v3', confidence: 0.6, sourceEventIds: ['ev_x'] }],
    },
    knownEventIds: new Set(['ev_x']),
    existingThreads: [],
    existingAttributes: [],
    now,
  });
  assert.equal(derived.threads[0].lastMentionedAt, now, '无 eventTimes 回退 now');
  const a = derived.attributes[0];
  assert.equal(a.assertedAt, undefined, '无 eventTimes 则 assertedAt 留空');
  assert.equal(a.speaker, undefined, '无 eventProvenances 则 speaker 留空');
  assert.equal(a.epistemicType, undefined, '无 eventProvenances 则 epistemicType 留空');
  assert.equal(a.ingestedAt, now);
  assert.equal(a.statusChangedAt, now);
  assert.equal(a.evidenceGroupId, evidenceGroupId(['ev_x']), 'evidenceGroupId 不依赖映射，始终可推导');
});

/* ── 7. superseded / 复活时 statusChangedAt 同步刷新 ── */

test('p3-7: 取代与复活时 statusChangedAt 记录状态变更时刻，写入语义不变', () => {
  const now1 = new Date('2026-11-01T00:00:00Z').toISOString();
  const now2 = new Date('2026-11-02T00:00:00Z').toISOString();
  const ids = new Set(['ev_a']);

  const d1 = deriveMemoryFacts({
    raw: { threads: [], attributes: [{ key: 'k', value: 'v1', sourceEventIds: ['ev_a'] }] },
    knownEventIds: ids,
    existingThreads: [],
    existingAttributes: [],
    now: now1,
  });
  const a1 = d1.attributes.find((a) => a.value === 'v1');
  assert.equal(a1.status, 'active');
  assert.equal(a1.statusChangedAt, now1, '新建时 statusChangedAt = 派生时刻');

  // 同 key 不同 value → 取代
  const d2 = deriveMemoryFacts({
    raw: { threads: [], attributes: [{ key: 'k', value: 'v2', sourceEventIds: ['ev_a'] }] },
    knownEventIds: ids,
    existingThreads: [],
    existingAttributes: d1.attributes,
    now: now2,
  });
  const oldA = d2.attributes.find((a) => a.value === 'v1');
  assert.equal(oldA.status, 'superseded');
  assert.equal(oldA.statusChangedAt, now2, '取代时记录状态变更时刻');

  // 同 key 同 value 复活 v1
  const d3 = deriveMemoryFacts({
    raw: { threads: [], attributes: [{ key: 'k', value: 'v1', sourceEventIds: ['ev_a'] }] },
    knownEventIds: ids,
    existingThreads: [],
    existingAttributes: d2.attributes,
    now: now2,
  });
  const revived = d3.attributes.find((a) => a.value === 'v1');
  assert.equal(revived.status, 'active', '复活语义不变');
  assert.equal(revived.statusChangedAt, now2, '复活时记录状态变更时刻');
});
