/**
 * P4 意图解析器测试（resolveIntent 纯函数，无 I/O）
 *
 * 覆盖 docs/p4-装配器-实现规格.md §4 的 8 点：
 * 1) 时间词/历史词 → history_replay
 * 2) 人格词 → persona（你是谁 归 persona）
 * 3) 任务续接词或 hasOpenThread → continue_task
 * 4) 偏好/属性词 → fact_lookup
 * 5) 无命中 + 无未结 → fuzzy
 * 6) 无命中 + 有未结 → continue_task（歧义回退）
 * 7) 多意图命中取前 2 个且不重复
 * 8) 空输入 → fuzzy
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntent, INTENT_RULES } from '../lib/intent.js';

/** 主意图（0 号） */
function primary(cue, hasOpenThread = false) {
  return resolveIntent(cue, hasOpenThread)[0].intent;
}

/* ── 1. 时间词/历史词 → history_replay ── */

test('intent-1: 时间词/历史词 → history_replay', () => {
  for (const cue of ['那天我们去了哪', '你上次说过', '你之前提过', '当时怎么说的', '还记得吗', '你曾经说过']) {
    assert.equal(primary(cue), 'history_replay', `「${cue}」应判 history_replay`);
  }
});

/* ── 2. 人格词 → persona（你是谁 归 persona 而非 fact_lookup） ── */

test('intent-2: 人格词 → persona，且「你是谁」归 persona', () => {
  for (const cue of ['你是什么样的人', '你觉得自己怎么样', '你的性格', '你是谁', '你说话方式']) {
    assert.equal(primary(cue), 'persona', `「${cue}」应判 persona`);
  }
  // 「你是谁」不能落到 fact_lookup
  const hit = resolveIntent('你是谁', false);
  assert.equal(hit[0].intent, 'persona');
});

/* ── 3. 任务续接词或 hasOpenThread → continue_task ── */

test('intent-3: 任务续接词或 hasOpenThread → continue_task', () => {
  for (const cue of ['继续', '接着讲', '那个任务', '进度如何', '接下来']) {
    assert.equal(primary(cue), 'continue_task', `「${cue}」应判 continue_task`);
  }
  // hasOpenThread 且无词命中 → continue_task
  assert.equal(primary('随便聊聊', true), 'continue_task');
});

/* ── 4. 偏好/属性词 → fact_lookup ── */

test('intent-4: 偏好/属性词 → fact_lookup', () => {
  for (const cue of ['你喜欢什么', '你的习惯', '你知道我', '我的生日', '我的名字', '我一般', '记得我吗']) {
    assert.equal(primary(cue), 'fact_lookup', `「${cue}」应判 fact_lookup`);
  }
});

/* ── 5. 无命中 + 无未结 → fuzzy ── */

test('intent-5: 无命中 + 无未结 → fuzzy', () => {
  assert.equal(primary('今天天气不错'), 'fuzzy');
  assert.equal(primary('嗯'), 'fuzzy');
});

/* ── 6. 无命中 + 有未结 → continue_task（歧义回退） ── */

test('intent-6: 无命中 + 有未结 → continue_task（歧义回退）', () => {
  const hit = resolveIntent('今天天气不错', true);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].intent, 'continue_task');
});

/* ── 7. 多意图命中取前 2 个且不重复 ── */

test('intent-7: 多意图命中取前 2 个且不重复', () => {
  // 历史词 + 续接词（「上次」命中 history_replay，「继续」命中 continue_task）
  const a = resolveIntent('上次你说了那个任务，继续', false);
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((h) => h.intent), ['history_replay', 'continue_task']);

  // 历史词 + 人格词（只取前 2，fact_lookup 不出现）
  const b = resolveIntent('那天你觉得自己是谁', false);
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((h) => h.intent), ['history_replay', 'persona']);

  // 三个意图命中时只保留前 2 个且不重复
  const c = resolveIntent('那天你说过你是谁，继续', false);
  assert.equal(c.length, 2);
  assert.equal(new Set(c.map((h) => h.intent)).size, 2, '意图不重复');
});

/* ── 8. 空输入 → fuzzy ── */

test('intent-8: 空输入 → fuzzy', () => {
  const hit = resolveIntent('', false);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].intent, 'fuzzy');
  assert.deepEqual(hit[0].hits, []);
});

/* ── 附加：INTENT_RULES 顺序即优先级，含五意图 ── */

test('intent-附加: INTENT_RULES 顺序即优先级，覆盖五意图', () => {
  const intents = INTENT_RULES.map((r) => r.intent);
  assert.deepEqual(intents, ['history_replay', 'persona', 'continue_task', 'fact_lookup']);
  assert.ok(INTENT_RULES.every((r) => Array.isArray(r.words) && r.words.length > 0));
});
