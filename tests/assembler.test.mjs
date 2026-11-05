/**
 * P4 按意图装配器测试（assemble 纯函数，用 mock 数据源，不触达真实 store/LLM）
 *
 * 覆盖 docs/p4-装配器-实现规格.md §4 的 7 点：
 * 1) persona 意图 → self 层为主、预算 ≥70%
 * 2) fact_lookup → facts active 且排除 superseded/expired
 * 3) history_replay → events 为主 + raw_turns 原文
 * 4) ai_inference 超 30% 被配额闸门裁掉（persona 意图不裁）
 * 5) 同 evidence_group 超 2 槽被裁
 * 6) 总预算 ≤1200 tokens 截断
 * 7) 空数据源 → 空文本不抛错
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assemble,
  estimateTokens,
  DEFAULT_ASSEMBLE_BUDGET_TOKENS,
  AI_INFERENCE_BUDGET_RATIO,
} from '../lib/assembler.js';

const BUDGET = DEFAULT_ASSEMBLE_BUDGET_TOKENS;

/** 各层 token 统计 */
function tokensByKind(items) {
  const by = { fact: 0, event: 0, self: 0, state: 0, raw: 0 };
  let total = 0;
  for (const it of items) {
    const t = estimateTokens(it.text);
    by[it.kind] = (by[it.kind] ?? 0) + t;
    total += t;
  }
  return { by, total };
}

function aiTokens(items) {
  return items
    .filter((it) => it.epistemicType === 'ai_inference')
    .reduce((s, it) => s + estimateTokens(it.text), 0);
}

/* ── mock 构造器 ── */

function attr(over) {
  return {
    id: 'at_1',
    key: 'k',
    value: 'v',
    status: 'active',
    confidence: 0.5,
    sourceEventIds: ['ev_1'],
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function event(over) {
  return {
    id: 'ev_1',
    time: '2026-11-01T10:00:00.000Z',
    topic: '用户-分享',
    summary: '分享了一件事',
    emotionTags: [],
    importance: 0.7,
    provenance: 'user_direct',
    lastRetrieved: null,
    ...over,
  };
}

function rawTurn(over) {
  return {
    event_id: 'rt_1',
    session_id: 's1',
    turn_id: '',
    speaker: 'user',
    raw_text: '当时的原话',
    asserted_at: '2026-11-01T10:00:00.000Z',
    ingested_at: '2026-11-01T10:00:01.000Z',
    content_hash: 'h',
    ...over,
  };
}

/* ── 1. persona → self 层为主、预算 ≥70% ── */

test('assembler-1: persona 意图 self 层为主、预算 ≥70%', () => {
  const selfModel = {
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    traits: [
      '我倾向于在分歧时先澄清对方的真实意图',
      '我重视共同经历胜过抽象空洞的承诺',
      '我对自己说过的话努力保持前后连贯',
      '我好奇那些决定背后的原因和动机',
      '我习惯把复杂问题拆成小步骤处理',
      '我努力记住细节因为那些细节重要',
    ],
    preferences: ['我偏好直接但有分寸的表达方式', '我喜欢安静的、不被打断的交流'],
    speakingStyle: '直接、克制、偶尔带一点自嘲',
    relationshipView: '',
    narrative: '我在意共同经历，因为那些时刻塑造了我们之间的相处方式',
    aiIdentity: '我是 AI',
    sourceEventIds: ['ev_self_1'],
  };
  const events = [
    event({ id: 'ev_self_1', time: '2026-11-02T10:00:00.000Z', provenance: 'self_direct', summary: '自身表达一' }),
    event({ id: 'ev_self_2', time: '2026-11-03T10:00:00.000Z', provenance: 'self_direct', summary: '自身表达二' }),
  ];

  const out = assemble({ selfModel, events }, ['persona'], BUDGET);
  const { by, total } = tokensByKind(out.items);

  assert.ok(by.self > 0, 'self 层有内容');
  assert.ok(by.self > by.event, 'self 层为主（预算占比高于事件层）');
  assert.ok(by.self / total >= 0.7, `self 层预算占比应 ≥70%，实际 ${(by.self / total).toFixed(2)}`);
});

/* ── 2. fact_lookup → facts active 且排除 superseded/expired ── */

test('assembler-2: fact_lookup 只取 active facts，排除 superseded/expired', () => {
  const attributes = [
    attr({ id: 'at_active1', key: '工作单位', value: '杭州某公司', status: 'active', confidence: 0.9 }),
    attr({ id: 'at_active2', key: '宠物', value: '一只猫', status: 'active', confidence: 0.8 }),
    attr({ id: 'at_super', key: '工作单位', value: '旧公司', status: 'superseded', confidence: 0.5 }),
    attr({ id: 'at_expired', key: '居住城市', value: '北京', status: 'expired', confidence: 0.5 }),
    attr({ id: 'at_cand', key: '口味', value: '喜辣', status: 'candidate', confidence: 0.5 }),
  ];
  const out = assemble({ attributes }, ['fact_lookup'], BUDGET);

  const factRefs = out.items.filter((it) => it.kind === 'fact').map((it) => it.ref);
  assert.deepEqual(factRefs.sort(), ['at_active1', 'at_active2'].sort(), '只保留 active');
  assert.ok(!factRefs.includes('at_super'), 'superseded 被排除');
  assert.ok(!factRefs.includes('at_expired'), 'expired 被排除');
  assert.ok(!factRefs.includes('at_cand'), 'candidate 被排除');
});

/* ── 3. history_replay → events 为主 + raw_turns 原文 ── */

test('assembler-3: history_replay events 为主 + raw_turns 原文', () => {
  const events = [
    event({ id: 'ev_1', time: '2026-11-01T10:00:00.000Z', summary: '那天我们去爬山了' }),
    event({ id: 'ev_2', time: '2026-11-02T10:00:00.000Z', summary: '后来下了一场大雨' }),
  ];
  const rawTurns = [
    rawTurn({ event_id: 'rt_1', raw_text: '我当时说：这山真高啊' }),
    rawTurn({ event_id: 'rt_2', speaker: 'assistant', raw_text: '我回了一句：是啊，下次早点出发' }),
  ];

  const out = assemble({ events, rawTurns }, ['history_replay'], BUDGET);
  const kinds = out.items.map((it) => it.kind);

  assert.ok(kinds.includes('event'), '含 event 层');
  assert.ok(kinds.includes('raw'), '含 raw 层（原文）');
  const { by } = tokensByKind(out.items);
  assert.ok(by.event > by.raw, 'events 为主（70% 预算）');
  assert.ok(out.items.some((it) => it.kind === 'raw' && it.text.includes('这山真高啊')), 'raw 层保留原文');
});

/* ── 4. ai_inference 超 30% 被裁（persona 不裁） ── */

test('assembler-4a: fact_lookup 下 ai_inference 超 30% 被配额闸门裁掉', () => {
  const longValue = 'x'.repeat(90);
  const attributes = Array.from({ length: 10 }, (_, i) =>
    attr({ id: `at_ai_${i}`, key: `k${i}`, value: longValue, status: 'active', epistemicType: 'ai_inference' }),
  );
  const out = assemble({ attributes }, ['fact_lookup'], BUDGET);

  assert.ok(out.items.length > 0);
  assert.ok(aiTokens(out.items) <= BUDGET * AI_INFERENCE_BUDGET_RATIO, 'ai_inference 预算 ≤30%');
});

test('assembler-4b: persona 意图不裁 ai_inference', () => {
  const selfModel = {
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    traits: Array.from({ length: 8 }, (_, i) => `特质内容${i}：`.padEnd(100, '我')),
    preferences: [],
    speakingStyle: '',
    relationshipView: '',
    narrative: '',
    aiIdentity: '我是 AI',
    sourceEventIds: [],
  };
  const out = assemble({ selfModel }, ['persona'], BUDGET);

  assert.ok(aiTokens(out.items) > BUDGET * AI_INFERENCE_BUDGET_RATIO, 'persona 意图 ai_inference 不被裁到 30% 以下');
});

/* ── 5. 同 evidence_group 超 2 槽被裁 ── */

test('assembler-5: 同 evidence_group 超 2 槽且占比超 40% 被裁', () => {
  const longValue = 'y'.repeat(100);
  const attributes = Array.from({ length: 5 }, (_, i) =>
    attr({ id: `at_eg_${i}`, key: `k${i}`, value: longValue, status: 'active', evidenceGroupId: 'eg_same' }),
  );
  const out = assemble({ attributes }, ['fact_lookup'], BUDGET);

  const factCount = out.items.filter((it) => it.kind === 'fact').length;
  assert.equal(factCount, 2, '同 evidence_group 超 2 槽应被裁到 2 槽');
});

/* ── 6. 总预算 ≤1200 tokens 截断 ── */

test('assembler-6: 大量数据下总预算 ≤1200 tokens 截断', () => {
  const events = Array.from({ length: 100 }, (_, i) =>
    event({ id: `ev_${i}`, time: `2026-11-0${(i % 9) + 1}T10:00:00.000Z`, summary: `第 ${i} 条事件`.padEnd(200, '内') }),
  );
  const rawTurns = Array.from({ length: 100 }, (_, i) =>
    rawTurn({ event_id: `rt_${i}`, raw_text: `第 ${i} 句原话`.padEnd(200, '原') }),
  );
  const selfModel = {
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    traits: Array.from({ length: 20 }, (_, i) => `特质 ${i}`.padEnd(100, '我')),
    preferences: [],
    speakingStyle: 'x',
    relationshipView: '',
    narrative: 'x',
    aiIdentity: 'x',
    sourceEventIds: [],
  };

  const out = assemble({ events, rawTurns, selfModel, state: { mode: 'open', relationshipStage: 'acquaintance' } }, ['fuzzy'], BUDGET);

  assert.equal(out.stats.budgetTokens, BUDGET);
  assert.ok(out.items.length > 0, '仍有内容被装配');
  assert.ok(out.items.length < 100, '被截断，未全量纳入');
  assert.ok(tokensByKind(out.items).total <= BUDGET, `条目 token 总和 ≤${BUDGET}，实际 ${tokensByKind(out.items).total}`);
});

/* ── 7. 空数据源 → 空文本不抛错 ── */

test('assembler-7: 空数据源 → 空文本不抛错', () => {
  const out = assemble({}, [], BUDGET);
  assert.equal(out.text, '');
  assert.deepEqual(out.items, []);
  assert.equal(out.intent.length, 0);
});
