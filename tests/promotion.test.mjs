/**
 * P2 巩固闸门测试（decidePromotion 纯函数 + commitCandidates + run 集成 + 注入隔离 + 污染回归）
 *
 * 覆盖（对应 docs/p2-巩固闸门-实现规格.md §6）：
 * 1) decidePromotion 四分支：空候选 / 无 user_direct / 单日期 / 跨 2 日期
 * 2) commitCandidates：去重合并、不碰 traits、版本 +1、history 保留
 * 3) run 集成：promote=false（traits 进 candidateTraits、不进 stable）+ promote=true（正常晋升）
 * 4) getInjectionSummary 不含 candidateTraits
 * 5) 污染回归：「我记忆好乱」自述 trait 不进 current.traits
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { MockLlm } from '../lib/llm-client.js';
import { decidePromotion } from '../lib/promotion.js';
import { DailyReviewEngine } from '../lib/review.js';
import { SelfModelService, EXISTENTIAL_ANCHOR } from '../lib/self-model.js';

/** 临时目录版 FsLike（与 self-model.test.mjs 同一手法） */
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
  const dir = await mkdtemp(join(tmpdir(), 'persona-p2-'));
  return new JsonStore(tempFs(dir), dir);
}

/** 构造一条 PersonaEvent（覆盖默认值） */
function evt(over) {
  return {
    id: 'e1',
    time: new Date().toISOString(),
    topic: '闲聊',
    summary: '',
    emotionTags: [],
    importance: 0.5,
    provenance: 'inferred',
    lastRetrieved: null,
    ...over,
  };
}

/** 内存版 StateMachineLike（本线不写状态机，仅占位） */
function makeStateStub() {
  return {
    appraise() {
      return { goalRelevance: 0, conductveness: 0, surprise: 0, agency: 'external' };
    },
    async apply() {
      throw new Error('unused');
    },
    async decay() {
      throw new Error('unused');
    },
    getMode() {
      return 'open';
    },
    getRelationshipStage() {
      return 'acquaintance';
    },
    async reinforce() {
      throw new Error('unused');
    },
    async snapshot() {
      throw new Error('unused');
    },
  };
}

/** 三步复盘 LLM（distillFacts 空事实；reflectSelf 返回给定 diff；updateMirror 空） */
function reviewLlm(reflectDiff) {
  return new MockLlm([
    { match: '提炼语义事实', respond: JSON.stringify({ facts: [] }) },
    { match: '反思自己的行为与表达', respond: JSON.stringify(reflectDiff) },
    { match: '关系认知', respond: JSON.stringify({ relationshipView: '' }) },
  ]);
}

/* ── 1. decidePromotion 纯函数四分支 ── */

test('decidePromotion：空候选 → false，reason=无候选特质', () => {
  const d = decidePromotion([], [evt({ provenance: 'user_direct' })]);
  assert.equal(d.promote, false);
  assert.ok(d.reason.length > 0, 'reason 必须非空');
  assert.match(d.reason, /无候选特质/);
});

test('decidePromotion：无 user_direct（纯 AI 独白，含负面自述）→ false', () => {
  const events = [
    evt({ id: 's1', provenance: 'self_direct', topic: '自我表达', summary: '我记忆好乱', time: '2026-11-01T10:00:00.000Z' }),
    evt({ id: 's2', provenance: 'self_direct', topic: '自我表达', summary: '我总是记不清细节', time: '2026-11-02T10:00:00.000Z' }),
  ];
  const d = decidePromotion(['记忆混乱'], events);
  assert.equal(d.promote, false, '纯 AI 独白不晋升（对称含负面自述）');
  assert.match(d.reason, /user_direct/, 'reason 写明缺少 user_direct');
});

test('decidePromotion：有 user_direct 但单日期 → false（默认冻结）', () => {
  const events = [
    evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 'u2', provenance: 'user_direct', time: '2026-11-01T18:00:00.000Z' }),
  ];
  const d = decidePromotion(['在意被记住'], events);
  assert.equal(d.promote, false, '单日窗口默认冻结');
  assert.match(d.reason, /日期/, 'reason 写明缺少跨日期');
});

test('decidePromotion：user_direct + 跨 2 日期 → true', () => {
  const events = [
    evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 'u2', provenance: 'user_direct', time: '2026-11-02T09:00:00.000Z' }),
  ];
  const d = decidePromotion(['在意被记住'], events);
  assert.equal(d.promote, true);
  assert.ok(d.reason.length > 0, '晋升时 reason 也非空');
});

test('decidePromotion：malformed 事件（time 缺失/非字符串）不抛错，按不计入跨日期处理', () => {
  const events = [
    evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 'bad1', provenance: 'user_direct', time: undefined }),
    evt({ id: 'bad2', provenance: 'user_direct', time: 12345 }),
  ];
  const d = decidePromotion(['在意被记住'], events);
  assert.equal(d.promote, false, '有效日期去重后仅 1 个 → 默认冻结');
  assert.match(d.reason, /日期/);
});

test('decidePromotion：纯空白 / 非字符串候选视为无候选 → false', () => {
  const events = [evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' })];
  const d = decidePromotion(['   ', '  \t'], events);
  assert.equal(d.promote, false);
  assert.match(d.reason, /无候选特质/);
});

/* ── 2. commitCandidates 单测 ── */

test('commitCandidates：去重合并、不碰 traits、版本 +1、history 保留', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store, { historyLimit: 5 });
  await svc.load(); // 种子 v1

  await svc.commitFromSources({ traits: ['已有特质'] }, ['e1'], ['reflection']); // v2

  const v3 = await svc.commitCandidates(['候选A', '候选B', '候选A']); // 去重 → 2 条
  assert.equal(v3.version, 3, '版本 +1');
  assert.deepEqual(v3.candidateTraits, ['候选A', '候选B'], '去重合并进 candidateTraits');
  assert.deepEqual(v3.traits, ['已有特质'], '不碰 stable traits');
  assert.match(v3.changeNote ?? '', /晋升隔离/, 'changeNote 记录隔离');
  assert.ok(v3.changeNote.includes('2'), 'changeNote 含候选条数');

  // 再次合并：已存在的不重复，新加入的追加
  const v4 = await svc.commitCandidates(['候选B', '候选C']);
  assert.deepEqual(v4.candidateTraits, ['候选A', '候选B', '候选C'], '跨提交去重');
  assert.deepEqual(v4.traits, ['已有特质'], 'traits 仍不变');

  const history = await svc.listHistory();
  assert.ok(history.some((h) => h.version === 2), '旧 current 入 history');
});

test('commitFromSources 保留 candidateTraits（不丢失已隔离候选）', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  await svc.load(); // v1

  await svc.commitCandidates(['候选X']); // v2：写入候选
  const v3 = await svc.commitFromSources({ preferences: ['偏好Y'] }, ['e1'], ['reflection']); // v3：只更新偏好

  assert.deepEqual(v3.candidateTraits, ['候选X'], 'commitFromSources 不得丢弃既有候选');
  assert.deepEqual(v3.traits, [], 'traits 不受影响');
  assert.deepEqual(v3.preferences, ['偏好Y']);
});

/* ── 4. 注入隔离 ── */

test('getInjectionSummary 不含 candidateTraits（只注入 stable）', () => {
  const svc = new SelfModelService(null);
  const text = svc.getInjectionSummary({
    version: 2,
    createdAt: new Date().toISOString(),
    traits: ['稳定特质'],
    preferences: [],
    speakingStyle: '温和',
    relationshipView: '',
    narrative: '',
    aiIdentity: EXISTENTIAL_ANCHOR,
    sourceEventIds: [],
    candidateTraits: ['记忆混乱', '会猜题'],
  });
  assert.ok(!text.includes('记忆混乱'), 'candidateTraits 不出现在注入摘要');
  assert.ok(!text.includes('会猜题'), 'candidateTraits 不出现在注入摘要');
  assert.ok(text.includes('稳定特质') === false || text.includes('说话方式'), '摘要只含 stable 相关字段');
});

/* ── 3 + 5. run 集成：promote=false / promote=true / 污染回归 ── */

test('run 集成 promote=false：traits 进 candidateTraits、不进 stable；其余字段照常 commit', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  const engine = new DailyReviewEngine({
    llm: reviewLlm({
      traits: ['会在难过时先倾听'],
      preferences: ['偏好先问再判断'],
      speakingStyle: '短句、温和',
      narrative: '我会在意用户的情绪。',
    }),
    selfModel: svc,
    state: makeStateStub(),
    store,
  });

  const events = [
    evt({ id: 'u1', provenance: 'inferred', topic: '用户-加班', summary: '用户加班到深夜', importance: 0.7, time: '2026-11-02T10:00:00.000Z' }),
  ];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    allEvents: events,
    selfModel: await svc.load(),
    state: null,
    feedback: [],
  });

  // 决策带 reason 落盘
  assert.ok(out.promotion, 'out.promotion 应记录决策');
  assert.equal(out.promotion.decision.promote, false, '无 user_direct → 隔离');
  assert.ok(out.promotion.decision.reason.length > 0, '隔离 reason 非空');
  assert.equal(out.promotion.candidateCount, 1, '候选条数 = 1');

  const snap = await svc.load();
  assert.ok(snap, '复盘后快照存在');
  assert.equal(snap.traits.includes('会在难过时先倾听'), false, 'traits 不进 stable');
  assert.ok(snap.candidateTraits?.includes('会在难过时先倾听'), 'traits 落入 candidateTraits');
  assert.ok(snap.preferences.includes('偏好先问再判断'), 'preferences 照常 commit');
  assert.equal(snap.speakingStyle, '短句、温和', 'speakingStyle 照常 commit');
  assert.ok(snap.narrative.includes('我会在意用户的情绪'), 'narrative 照常 commit');
});

test('run 集成 promote=true：traits 正常晋升 stable', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  const engine = new DailyReviewEngine({
    llm: reviewLlm({ traits: ['会在难过时先倾听'], preferences: [], speakingStyle: '', narrative: '' }),
    selfModel: svc,
    state: makeStateStub(),
    store,
  });

  const events = [
    evt({ id: 'u1', provenance: 'user_direct', topic: '用户-分享', summary: '分享', importance: 0.8, time: '2026-11-01T10:00:00.000Z' }),
    evt({ id: 'u2', provenance: 'user_direct', topic: '用户-分享', summary: '再分享', importance: 0.7, time: '2026-11-02T10:00:00.000Z' }),
  ];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    allEvents: events,
    selfModel: await svc.load(),
    state: null,
    feedback: [],
  });

  assert.equal(out.promotion?.decision.promote, true, 'user_direct + 跨 2 日期 → 晋升');
  const snap = await svc.load();
  assert.ok(snap.traits.includes('会在难过时先倾听'), 'traits 晋升进 stable');
  assert.equal(snap.candidateTraits?.length ?? 0, 0, '晋升后无候选残留');
});

test('污染回归：「我记忆好乱」自述 trait 不进 current.traits', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  const engine = new DailyReviewEngine({
    llm: reviewLlm({ traits: ['记忆混乱'], preferences: [], speakingStyle: '', narrative: '' }),
    selfModel: svc,
    state: makeStateStub(),
    store,
  });

  const events = [
    evt({
      id: 'self-1',
      provenance: 'self_direct',
      topic: '自我表达',
      summary: 'AI 自述：我记忆好乱',
      importance: 0.7,
      time: '2026-11-02T10:00:00.000Z',
    }),
  ];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    allEvents: events,
    selfModel: await svc.load(),
    state: null,
    feedback: [],
  });

  assert.equal(out.promotion?.decision.promote, false, '纯自述 → 默认冻结');
  const snap = await svc.load();
  assert.equal(snap.traits.includes('记忆混乱'), false, '自述 trait 不进 current.traits');
  assert.ok(snap.candidateTraits?.includes('记忆混乱'), '自述 trait 进 candidateTraits');
});
