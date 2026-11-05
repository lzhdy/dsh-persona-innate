/**
 * 增量1 procedures 程序性记忆层测试
 *
 * 覆盖（对应 docs/增量1-procedures-实现规格.md §6）：
 * 1) procedureId 同 trigger 稳定、异 trigger 区分（含归一化）
 * 2) isProcedureShaped：合法通过、非法 status/epistemicType/字段类型拒绝
 * 3) deriveProcedures：新建 candidate（epistemicType=ai_inference/speaker=assistant/status=candidate）；
 *    sourceEventIds 空 → no-source 丢弃、未知 → unknown-source 丢弃、含祈使句 → strip 丢弃
 * 4) decideProcedurePromotion：单日 false、跨 2 日期 true、eventTimes 缺失 false
 * 5) 同 trigger 跨天合并（更新 action/rationale、合并证据、不新建第二条、status 不变）
 * 6) ProcedureStore：round-trip + 非法条目不静默修复（读回时被 shape 过滤）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import {
  ProcedureStore,
  deriveProcedures,
  procedureId,
  isProcedureShaped,
} from '../lib/procedures.js';
import { decideProcedurePromotion } from '../lib/procedure-promotion.js';

/** 临时目录版 FsLike（与 p3-schema.test.mjs 同一手法） */
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
  const dir = await mkdtemp(join(tmpdir(), 'persona-proc-'));
  return new JsonStore(tempFs(dir), dir);
}

/** 构造一条最小 PersonaProcedure（覆盖必填字段） */
function proc(over) {
  return {
    id: 'pr_x',
    trigger: '当用户问开放问题时，我会先澄清再展开',
    action: '先澄清再回答',
    rationale: '避免误解',
    speaker: 'assistant',
    epistemicType: 'ai_inference',
    status: 'candidate',
    confidence: 0.5,
    sourceEventIds: ['ev_a'],
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

/* ── 1. procedureId 稳定 / 区分 ── */

test('procedureId：同 trigger 稳定、归一化一致、异 trigger 区分', () => {
  const a = procedureId('当用户问开放问题时，我会先澄清再展开');
  const b = procedureId('当用户问开放问题时，我会先澄清再展开');
  assert.equal(a, b, '同 trigger 必须得到同一 id');
  assert.ok(a.startsWith('pr_'), 'id 前缀为 pr_');

  // 归一化：去首尾空白、压缩内部空白、统一小写后仍同 id
  assert.equal(procedureId('  Foo  Bar '), procedureId('foo bar'), '归一化后同 trigger 同 id');

  const c = procedureId('当用户情绪低落时，我会先倾听');
  assert.notEqual(a, c, '异 trigger 必须区分');
});

/* ── 2. isProcedureShaped 结构校验 ── */

test('isProcedureShaped：合法通过、非法 status/epistemicType/字段类型拒绝', () => {
  assert.equal(isProcedureShaped(proc()), true, '合法条目通过');

  assert.equal(isProcedureShaped(proc({ status: 'bogus' })), false, '非法 status 拒绝');
  assert.equal(isProcedureShaped(proc({ status: 'active' })), true, '七态之一（active）通过');
  assert.equal(isProcedureShaped(proc({ epistemicType: 'bogus' })), false, '非法 epistemicType 拒绝');
  assert.equal(isProcedureShaped(proc({ epistemicType: 'user_statement' })), true, '三态之一通过');
  assert.equal(isProcedureShaped(proc({ sourceEventIds: 'not-array' })), false, 'sourceEventIds 非数组拒绝');
  assert.equal(isProcedureShaped(proc({ trigger: 123 })), false, 'trigger 非字符串拒绝');
  assert.equal(isProcedureShaped(null), false, 'null 拒绝');
});

/* ── 3. deriveProcedures 门禁 + 新建 candidate ── */

test('deriveProcedures：新建 candidate（ai_inference/assistant/candidate + 证据链字段）', () => {
  const now = new Date('2026-11-05T12:00:00Z').toISOString();
  const t1 = new Date('2026-11-01T08:00:00Z').toISOString();
  const t2 = new Date('2026-11-03T09:00:00Z').toISOString();
  const eventTimes = new Map([['ev_a', t1], ['ev_b', t2]]);

  const trigger = '当用户问开放问题时，我会先澄清再展开';
  const derived = deriveProcedures({
    raw: {
      procedures: [{
        trigger,
        action: '先澄清再回答',
        rationale: '避免误解',
        sourceEventIds: ['ev_a', 'ev_b'],
      }],
    },
    knownEventIds: new Set(['ev_a', 'ev_b']),
    existingProcedures: [],
    now,
    eventTimes,
  });

  assert.equal(derived.procedures.length, 1);
  const p = derived.procedures[0];
  assert.equal(p.id, procedureId(trigger), 'id 由 trigger 推导');
  assert.equal(p.status, 'candidate', '默认 candidate（红线）');
  assert.equal(p.epistemicType, 'ai_inference', '认识论固定 ai_inference（红线）');
  assert.equal(p.speaker, 'assistant', 'speaker 固定 assistant');
  assert.equal(p.confidence, 0.5);
  assert.deepEqual(p.sourceEventIds, ['ev_a', 'ev_b']);
  assert.equal(p.assertedAt, t2, 'assertedAt = 最新源事件 time');
  assert.equal(p.ingestedAt, now);
  assert.equal(p.statusChangedAt, now);
  assert.equal(p.firstSeenAt, now);
  assert.equal(p.updatedAt, now);
  assert.equal(p.validFrom, null);
  assert.equal(p.validTo, null);
  assert.ok(p.evidenceGroupId?.startsWith('eg_'), 'evidenceGroupId 已填');
  assert.equal(derived.stats.proceduresCreated, 1);
  assert.equal(derived.stats.dropped, 0);
  assert.equal(derived.dirty, true);
});

test('deriveProcedures：sourceEventIds 空 → no-source 丢弃、未知 → unknown-source 丢弃', () => {
  const now = new Date('2026-11-05T12:00:00Z').toISOString();

  const empty = deriveProcedures({
    raw: { procedures: [{ trigger: 't', action: 'a', rationale: 'r', sourceEventIds: [] }] },
    knownEventIds: new Set(['ev_a']),
    existingProcedures: [],
    now,
  });
  assert.equal(empty.procedures.length, 0);
  assert.equal(empty.stats.dropped, 1);
  assert.equal(empty.stats.dropReasons['no-source'], 1);

  const unknown = deriveProcedures({
    raw: { procedures: [{ trigger: 't', action: 'a', rationale: 'r', sourceEventIds: ['ghost'] }] },
    knownEventIds: new Set(['ev_a']),
    existingProcedures: [],
    now,
  });
  assert.equal(unknown.procedures.length, 0, '指向不存在事件的 procedure 整条丢弃（红线）');
  assert.equal(unknown.stats.dropped, 1);
  assert.equal(unknown.stats.dropReasons['unknown-source'], 1);
});

test('deriveProcedures：trigger/action/rationale 任一含祈使句 → strip 丢弃', () => {
  const now = new Date('2026-11-05T12:00:00Z').toISOString();

  const badAction = deriveProcedures({
    raw: {
      procedures: [{
        trigger: '当用户提到吃药时',
        action: '提醒用户按时吃药', // 祈使句：告诉用户该做什么
        rationale: '避免漏服',
        sourceEventIds: ['ev_a'],
      }],
    },
    knownEventIds: new Set(['ev_a']),
    existingProcedures: [],
    now,
  });
  assert.equal(badAction.procedures.length, 0, '含祈使句的 procedure 整条丢弃（红线）');
  assert.equal(badAction.stats.dropReasons.strip, 1);
  assert.equal(badAction.stats.dropped, 1);
});

test('deriveProcedures：字段缺失（trigger/action/rationale 非空）→ invalid 丢弃', () => {
  const now = new Date('2026-11-05T12:00:00Z').toISOString();
  const derived = deriveProcedures({
    raw: { procedures: [{ trigger: '', action: 'a', rationale: 'r', sourceEventIds: ['ev_a'] }] },
    knownEventIds: new Set(['ev_a']),
    existingProcedures: [],
    now,
  });
  assert.equal(derived.procedures.length, 0);
  assert.equal(derived.stats.dropReasons.invalid, 1);
});

/* ── 4. decideProcedurePromotion 晋升闸门 ── */

test('decideProcedurePromotion：单日 false、跨 2 日期 true、eventTimes 缺失 false', () => {
  const candidate = proc({ sourceEventIds: ['e1', 'e2'] });

  const singleDay = new Map([
    ['e1', '2026-11-01T08:00:00.000Z'],
    ['e2', '2026-11-01T20:00:00.000Z'],
  ]);
  const d1 = decideProcedurePromotion(candidate, singleDay);
  assert.equal(d1.promote, false, '单日窗口默认冻结');
  assert.match(d1.reason, /不足 2/);

  const twoDays = new Map([
    ['e1', '2026-11-01T08:00:00.000Z'],
    ['e2', '2026-11-02T08:00:00.000Z'],
  ]);
  const d2 = decideProcedurePromotion(candidate, twoDays);
  assert.equal(d2.promote, true, '跨 2 日期 → 晋升');
  assert.match(d2.reason, /跨 2 个日期/);
  assert.ok(d2.reason.length > 0, '晋升时 reason 也非空');

  assert.equal(decideProcedurePromotion(candidate).promote, false, 'eventTimes 缺失 → false');
  assert.equal(decideProcedurePromotion(candidate, new Map()).promote, false, '空映射 → false');
});

/* ── 5. 同 trigger 跨天合并 ── */

test('deriveProcedures：同 trigger 跨天合并（更新 action/rationale、合并证据、不新建、status 不变）', () => {
  const now1 = new Date('2026-11-01T00:00:00Z').toISOString();
  const now2 = new Date('2026-11-02T00:00:00Z').toISOString();
  const ids = new Set(['ev_a', 'ev_b']);
  const trigger = '当用户问开放问题时，我会先澄清再展开';

  const d1 = deriveProcedures({
    raw: { procedures: [{ trigger, action: '先澄清', rationale: '避免误解', sourceEventIds: ['ev_a'] }] },
    knownEventIds: ids,
    existingProcedures: [],
    now: now1,
  });
  assert.equal(d1.procedures.length, 1);
  assert.equal(d1.stats.proceduresCreated, 1);

  const d2 = deriveProcedures({
    raw: { procedures: [{ trigger, action: '先澄清再分点展开', rationale: '更清晰', sourceEventIds: ['ev_b'] }] },
    knownEventIds: ids,
    existingProcedures: d1.procedures,
    now: now2,
  });
  assert.equal(d2.procedures.length, 1, '同 trigger 不新建第二条');
  assert.equal(d2.stats.proceduresCreated, 0);
  assert.equal(d2.stats.proceduresUpdated, 1);

  const p = d2.procedures[0];
  assert.equal(p.action, '先澄清再分点展开', 'action 允许细化');
  assert.equal(p.rationale, '更清晰', 'rationale 允许细化');
  assert.deepEqual(p.sourceEventIds, ['ev_a', 'ev_b'], '证据链合并');
  assert.equal(p.status, 'candidate', 'status 不变（晋升走闸门，不做即时晋升）');
  assert.equal(p.updatedAt, now2, 'updatedAt 刷新');
  assert.equal(p.firstSeenAt, now1, 'firstSeenAt 保持首见时刻');
});

/* ── 6. ProcedureStore round-trip + shape 过滤 ── */

test('ProcedureStore：round-trip 保留条目，非法 status 读回时被过滤', async () => {
  const store = await freshStore();
  const ps = new ProcedureStore(store);
  const good = proc({ id: 'pr_good' });
  const bad = proc({ id: 'pr_bad', status: 'bogus' });

  await ps.saveProcedures([good, bad]);
  const loaded = await ps.loadProcedures();
  assert.ok(loaded.ok, '读盘成功');
  assert.equal(loaded.items.length, 1, '非法 status 条目读回时被 isProcedureShaped 过滤');
  assert.equal(loaded.items[0].id, 'pr_good');
});

test('ProcedureStore：文件不存在 → 空库（ok:true）', async () => {
  const store = await freshStore();
  const ps = new ProcedureStore(store);
  const loaded = await ps.loadProcedures();
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.items, []);
});
