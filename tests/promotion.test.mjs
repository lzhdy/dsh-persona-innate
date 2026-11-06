/**
 * P2 巩固闸门测试（ISS-048 改造后）
 *
 * 原实现是「单向棘轮」：闸门拿**本次复盘窗口**当证据，单日窗口恒 1 天 → 一条也晋升不了，
 * 候选只进不出。改造后闸门看的是**候选自身的证据**（sourceEventIds 去全量事件里查时间），
 * 并且判定证据 = 本轮证据 ∪ 候选池里已累积的证据。
 *
 * 覆盖（对应 ISS-048 修复规格 §三 A7）：
 * 1) decideTraitPromotions 五分支：无证据 / 证据不存在 / 单日期 / 缺 user_direct / 全过
 * 2) commitCandidates：按文本合并、sourceEventIds 取并集、不碰 traits、版本 +1、history 保留
 * 3) removeCandidates：晋升后移出候选池；无匹配项不涨版本
 * 4) 旧数据兼容：candidateTraits 为 string[] 时能加载并归一化，不抛错、不误晋升
 * 5) run 集成：即时 traits 恒冻结 / 带证据的泛化特质晋升且候选池同名消失 /
 *    同一候选连续两天复盘 → 第二天晋升 / 污染回归（负面自述不进 stable）
 * 6) getInjectionSummary 不含 candidateTraits
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { MockLlm } from '../lib/llm-client.js';
import { decideTraitPromotions } from '../lib/promotion.js';
import { DailyReviewEngine } from '../lib/review.js';
import { SelfModelService, EXISTENTIAL_ANCHOR, normalizeCandidateTraits } from '../lib/self-model.js';

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

/** 证据表：从事件数组构造 id → {time, provenance}（与 review.loadTraitEvidence 同构） */
function evidenceOf(events) {
  return new Map(events.map((e) => [e.id, { time: e.time, provenance: e.provenance }]));
}

/** 一条候选（默认无证据） */
function cand(text, sourceEventIds = []) {
  return { text, sourceEventIds };
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

/** 三步复盘 LLM（distillFacts 空事实；reflectSelf 返回给定 diff；其余空） */
function reviewLlm(reflectDiff) {
  return new MockLlm([
    { match: '提炼语义事实', respond: JSON.stringify({ facts: [] }) },
    { match: '反思自己的行为与表达', respond: JSON.stringify(reflectDiff) },
    { match: '更新对这段关系的认知', respond: JSON.stringify({ relationshipView: '' }) },
    { match: '派生两类记忆', respond: JSON.stringify({ threads: [], attributes: [] }) },
    { match: '你自己遇到什么情况', respond: JSON.stringify({ procedures: [] }) },
  ]);
}

/**
 * 全链路 LLM：每条给定事件产出一条 type=self 的 fact，泛化把它们收成一条带证据的特质。
 * 事实 id 从 prompt 现取（不依赖 makeId 的调用顺序，见 generalize.test.mjs 同一手法）。
 */
function fullLlm({ eventIds, traitText }) {
  return new MockLlm([
    {
      match: '提炼语义事实',
      respond: JSON.stringify({
        facts: eventIds.map((id, i) => ({
          type: 'self',
          content: `我在这件事上的一贯做法 ${i + 1}`,
          sourceEventIds: [id],
          confidence: 0.6,
        })),
      }),
    },
    {
      match: '归纳出你的稳定特质',
      respond: (input) => {
        const ids = [...input.prompt.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
        return JSON.stringify({ traits: [{ trait: traitText, sourceFactIds: ids }] });
      },
    },
    {
      match: '反思自己的行为与表达',
      respond: JSON.stringify({ traits: [], preferences: [], speakingStyle: '', narrative: '' }),
    },
    { match: '更新对这段关系的认知', respond: JSON.stringify({ relationshipView: '' }) },
    { match: '派生两类记忆', respond: JSON.stringify({ threads: [], attributes: [] }) },
    { match: '你自己遇到什么情况', respond: JSON.stringify({ procedures: [] }) },
  ]);
}

/* ── 1. decideTraitPromotions 纯函数五分支 ── */

test('decideTraitPromotions：证据跨 2 日期 + 含 user_direct → 晋升', () => {
  const events = [
    evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 'u2', provenance: 'user_direct', time: '2026-11-02T09:00:00.000Z' }),
  ];
  const [d] = decideTraitPromotions([cand('在意被记住', ['u1', 'u2'])], evidenceOf(events));
  assert.equal(d.promote, true);
  assert.match(d.reason, /满足：证据跨 2 个日期且含 user_direct 来源/);
});

test('decideTraitPromotions：证据只落在 1 个日期 → 隔离（跨日期是门槛本身）', () => {
  const events = [
    evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 'u2', provenance: 'user_direct', time: '2026-11-01T18:00:00.000Z' }),
  ];
  const [d] = decideTraitPromotions([cand('在意被记住', ['u1', 'u2'])], evidenceOf(events));
  assert.equal(d.promote, false);
  assert.match(d.reason, /仅跨单个日期（需 ≥2 个不同日期的事件）/);
});

test('decideTraitPromotions：跨 2 日期但全是 AI 独白 → 隔离（自己说自己是怎样的人不算数）', () => {
  const events = [
    evt({ id: 's1', provenance: 'self_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 's2', provenance: 'self_direct', time: '2026-11-02T09:00:00.000Z' }),
  ];
  const [d] = decideTraitPromotions([cand('记忆混乱', ['s1', 's2'])], evidenceOf(events));
  assert.equal(d.promote, false);
  assert.match(d.reason, /缺少非 AI 独白来源（需 ≥1 条 provenance=user_direct 的事件）/);
});

test('decideTraitPromotions：sourceEventIds 为空（旧数据 / 即时 traits）→ 隔离', () => {
  const events = [evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' })];
  const [d] = decideTraitPromotions([cand('LLM 直出的特质')], evidenceOf(events));
  assert.equal(d.promote, false);
  assert.match(d.reason, /候选无证据（sourceEventIds 为空）/);
});

test('decideTraitPromotions：有 id 但一条都查不到 → 隔离（可能已归档）', () => {
  const [d] = decideTraitPromotions([cand('在意被记住', ['ghost1', 'ghost2'])], new Map());
  assert.equal(d.promote, false);
  assert.match(d.reason, /证据事件不存在（可能已归档）/);
});

test('decideTraitPromotions：五条候选逐条判决，互不牵连', () => {
  const events = [
    evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 'u2', provenance: 'user_direct', time: '2026-11-02T09:00:00.000Z' }),
    evt({ id: 's1', provenance: 'self_direct', time: '2026-11-01T10:00:00.000Z' }),
    evt({ id: 's2', provenance: 'self_direct', time: '2026-11-02T10:00:00.000Z' }),
  ];
  const out = decideTraitPromotions(
    [
      cand('可晋升', ['u1', 'u2']),
      cand('单日期', ['u1']),
      cand('纯独白', ['s1', 's2']),
      cand('无证据'),
      cand('证据缺失', ['nope']),
    ],
    evidenceOf(events),
  );
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((d) => d.promote), [true, false, false, false, false], '只有第一条能晋升');
  for (const d of out) assert.ok(d.reason.length > 0, `${d.text} 的 reason 必须非空`);
});

test('decideTraitPromotions：空候选 / 空白文本 / undefined → 不产出判决，不抛错', () => {
  assert.deepEqual(decideTraitPromotions([], new Map()), []);
  assert.deepEqual(decideTraitPromotions([cand('   '), cand('')], new Map()), [], '空白文本不是候选');
  assert.deepEqual(decideTraitPromotions(undefined, new Map()), [], 'undefined 也不炸');
});

test('decideTraitPromotions：malformed time 不计入日期；证据 id 重复只算一次', () => {
  const events = [
    evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' }),
    evt({ id: 'bad', provenance: 'user_direct', time: undefined }),
  ];
  const [d] = decideTraitPromotions([cand('在意被记住', ['u1', 'u1', 'bad'])], evidenceOf(events));
  assert.equal(d.promote, false, '有效日期去重后仅 1 个');
  assert.match(d.reason, /仅跨单个日期/);
});

/* ── 2. commitCandidates：按文本合并 + 证据并集 ── */

test('commitCandidates：按文本合并、证据取并集、不碰 traits、版本 +1、history 保留', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store, { historyLimit: 5 });
  await svc.load(); // 种子 v1

  await svc.commitFromSources({ traits: ['已有特质'] }, ['e1'], ['reflection']); // v2

  const v3 = await svc.commitCandidates([cand('候选A', ['e1']), cand('候选B'), cand('候选A', ['e2'])]);
  assert.equal(v3.version, 3, '版本 +1');
  assert.deepEqual(v3.candidateTraits.map((c) => c.text), ['候选A', '候选B'], '按文本去重合并');
  assert.deepEqual(v3.candidateTraits[0].sourceEventIds, ['e1', 'e2'], '同一批里重复提交 → 证据并集');
  assert.ok(v3.candidateTraits[0].firstSeenAt, '新候选记录首次出现时间');
  assert.ok(v3.candidateTraits[0].lastSeenAt, '新候选记录最近出现时间');
  assert.deepEqual(v3.traits, ['已有特质'], '不碰 stable traits');
  assert.match(v3.changeNote ?? '', /晋升隔离/, 'changeNote 记录隔离');

  // A7-7：两次提交同一文本 → 不重复写入，证据累积（这是"跨日期"能攒够的前提）
  const v4 = await svc.commitCandidates([cand('候选A', ['e3']), cand('候选C', ['e9'])]);
  assert.equal(v4.candidateTraits.length, 3, '同一文本不重复写入');
  assert.deepEqual(
    v4.candidateTraits.find((c) => c.text === '候选A').sourceEventIds,
    ['e1', 'e2', 'e3'],
    '跨提交证据累积（并集）',
  );
  assert.deepEqual(v4.traits, ['已有特质'], 'traits 仍不变');

  const history = await svc.listHistory();
  assert.ok(history.some((h) => h.version === 2), '旧 current 入 history');
});

test('commitFromSources 保留候选，但晋升成功的同名候选必须离开候选池', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  await svc.load(); // v1

  await svc.commitCandidates([cand('候选X'), cand('将被晋升', ['e1', 'e2'])]); // v2
  const v3 = await svc.commitFromSources({ preferences: ['偏好Y'] }, ['e1'], ['reflection']);
  assert.deepEqual(v3.candidateTraits.map((c) => c.text), ['候选X', '将被晋升'], '不丢弃既有候选');

  const v4 = await svc.commitFromSources({ traits: ['将被晋升'] }, ['e1', 'e2'], ['reflection']);
  assert.deepEqual(v4.traits, ['将被晋升']);
  assert.deepEqual(v4.candidateTraits.map((c) => c.text), ['候选X'], '已晋升的文本移出候选池');
});

/* ── 3. removeCandidates ── */

test('removeCandidates：按文本移出、版本 +1、旧版本入 history；无匹配不写盘', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store, { historyLimit: 5 });
  await svc.load();
  const v2 = await svc.commitCandidates([cand('甲'), cand('乙'), cand('丙')]);

  const v3 = await svc.removeCandidates(['乙']);
  assert.equal(v3.version, v2.version + 1, '版本 +1');
  assert.deepEqual(v3.candidateTraits.map((c) => c.text), ['甲', '丙']);
  assert.ok((await svc.listHistory()).some((h) => h.version === v2.version), '旧 current 入 history');

  const v4 = await svc.removeCandidates(['不存在']);
  assert.equal(v4.version, v3.version, '无匹配项不涨版本（否则回滚窗口被白涨的版本挤掉）');
});

/* ── 4. 旧数据兼容（磁盘上还是 string[]）── */

test('normalizeCandidateTraits：string[] → 带空证据的对象；垃圾条目丢弃', () => {
  assert.deepEqual(normalizeCandidateTraits(['渴望自然化', '  感激用户帮助  ']), [
    { text: '渴望自然化', sourceEventIds: [] },
    { text: '感激用户帮助', sourceEventIds: [] },
  ]);
  assert.deepEqual(
    normalizeCandidateTraits([{ text: '注重对话连贯性', sourceEventIds: ['e1'] }]),
    [{ text: '注重对话连贯性', sourceEventIds: ['e1'] }],
    '已是新格式 → 原样保留证据',
  );
  assert.deepEqual(
    normalizeCandidateTraits(['重复', { text: '重复', sourceEventIds: ['e9'] }]),
    [{ text: '重复', sourceEventIds: ['e9'] }],
    '同文本合并，证据并集',
  );
  assert.deepEqual(normalizeCandidateTraits([null, 42, { text: '   ' }, {}]), [], '垃圾条目丢弃');
  assert.deepEqual(normalizeCandidateTraits(undefined), []);
  assert.deepEqual(normalizeCandidateTraits('不是数组'), []);
});

test('旧格式 string[] 能直接 load（无需手工迁移），且不会被误晋升', async () => {
  const store = await freshStore();
  // 真实用户机器上的形态：3 条字符串候选 + history 里 1 个旧版本
  const legacy = {
    version: 1,
    current: {
      version: 6,
      createdAt: '2026-11-05T00:00:00.000Z',
      traits: ['已有特质'],
      preferences: [],
      speakingStyle: '（未成形）',
      relationshipView: '',
      narrative: '',
      aiIdentity: EXISTENTIAL_ANCHOR,
      sourceEventIds: [],
      candidateTraits: ['渴望自然化', '感激用户帮助', '注重对话连贯性'],
    },
    history: [
      {
        version: 5,
        createdAt: '2026-11-04T00:00:00.000Z',
        traits: [],
        preferences: [],
        speakingStyle: '（未成形）',
        relationshipView: '',
        narrative: '',
        aiIdentity: EXISTENTIAL_ANCHOR,
        sourceEventIds: [],
        candidateTraits: ['更早的候选'],
      },
    ],
    growthArchive: [],
  };
  await store.writeJson('self-model.json', legacy);

  const svc = new SelfModelService(store);
  const snap = await svc.load(); // 不抛错
  assert.deepEqual(
    snap.candidateTraits.map((c) => c.text),
    ['渴望自然化', '感激用户帮助', '注重对话连贯性'],
    '三条旧候选原样读出',
  );
  for (const c of snap.candidateTraits) {
    assert.deepEqual(c.sourceEventIds, [], '旧候选没有证据 → 空数组（不编造）');
  }
  const history = await svc.listHistory();
  assert.deepEqual(history[0].candidateTraits.map((c) => c.text), ['更早的候选'], 'history 也归一化');
  assert.deepEqual(history[0].candidateTraits[0].sourceEventIds, []);

  // 旧候选无证据 → 闸门第一步就冻结（预期行为，不是错误）
  const events = [evt({ id: 'u1', provenance: 'user_direct', time: '2026-11-01T09:00:00.000Z' })];
  const verdicts = decideTraitPromotions(snap.candidateTraits, evidenceOf(events));
  assert.deepEqual(verdicts.map((v) => v.promote), [false, false, false]);
  for (const v of verdicts) assert.match(v.reason, /候选无证据/);
});

/* ── 5. run 集成 ── */

test('run 集成：即时 traits 无证据 → 隔离进候选、不进 stable；其余字段照常 commit', async () => {
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

  // ISS-048：即时 traits 永远冻结（用户拍板），无论窗口跨不跨日期
  assert.ok(out.promotion, 'out.promotion 应记录判决');
  assert.deepEqual(out.promotion.promoted, [], '即时 traits 不晋升');
  assert.equal(out.promotion.candidateCount, 1);
  assert.match(out.promotion.blocked[0].reason, /候选无证据/, 'reason 说明缺证据');

  const snap = await svc.load();
  assert.equal(snap.traits.includes('会在难过时先倾听'), false, '不进 stable');
  assert.ok(
    snap.candidateTraits.some((c) => c.text === '会在难过时先倾听'),
    '落入 candidateTraits（不能凭空消失）',
  );
  assert.ok(snap.preferences.includes('偏好先问再判断'), 'preferences 照常 commit');
  assert.equal(snap.speakingStyle, '短句、温和', 'speakingStyle 照常 commit');
  assert.ok(snap.narrative.includes('我会在意用户的情绪'), 'narrative 照常 commit');
});

test('run 集成：带证据的泛化特质跨 2 日期 → 晋升 stable，且候选池同名条目消失', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  // 先让候选池里存着同名候选（模拟它已经在池子里躺了几天）——晋升后必须消失
  await svc.commitCandidates([{ text: '会先澄清再展开', sourceEventIds: ['ev_a'] }]);

  const events = [
    evt({ id: 'ev_a', provenance: 'user_direct', time: '2026-11-01T10:00:00.000Z' }),
    evt({ id: 'ev_b', provenance: 'user_direct', time: '2026-11-02T11:00:00.000Z' }),
  ];
  const engine = new DailyReviewEngine({
    llm: fullLlm({ eventIds: ['ev_a', 'ev_b'], traitText: '会先澄清再展开' }),
    selfModel: svc,
    state: makeStateStub(),
    store,
  });
  const out = await engine.run({
    date: '2026-11-02',
    events,
    allEvents: events,
    selfModel: await svc.load(),
    state: null,
    feedback: [],
  });

  assert.deepEqual(out.promotion?.promoted, ['会先澄清再展开'], '证据跨 2 日期且含 user_direct → 晋升');
  assert.deepEqual(out.promotion?.blocked, [], '没有候选被隔离');

  const snap = await svc.load();
  assert.ok(snap.traits.includes('会先澄清再展开'), '晋升进 stable');
  assert.equal(
    snap.candidateTraits.length,
    0,
    `晋升后候选池必须为空（同一特质不能同时在 stable 与 candidates），实际 ${JSON.stringify(snap.candidateTraits)}`,
  );
});

test('run 集成：同一候选连续两天复盘 → 第二天晋升（证据累积生效）', async () => {
  const store = await freshStore();
  const svc = new SelfModelService(store);
  const day1 = [
    evt({ id: 'd1a', provenance: 'user_direct', time: '2026-11-02T10:00:00.000Z' }),
    evt({ id: 'd1b', provenance: 'user_direct', time: '2026-11-02T12:00:00.000Z' }),
  ];
  const day2 = [
    evt({ id: 'd2a', provenance: 'user_direct', time: '2026-11-03T10:00:00.000Z' }),
    evt({ id: 'd2b', provenance: 'user_direct', time: '2026-11-03T12:00:00.000Z' }),
  ];

  // 第一天：证据全在 11-02 一天 → 隔离（正是用户看到的「仅跨单个日期」）
  const run1 = await new DailyReviewEngine({
    llm: fullLlm({ eventIds: ['d1a', 'd1b'], traitText: '会先澄清再展开' }),
    selfModel: svc,
    state: makeStateStub(),
    store,
  }).run({ date: '2026-11-02', events: day1, allEvents: day1, selfModel: await svc.load(), state: null, feedback: [] });

  assert.deepEqual(run1.promotion?.promoted, [], '第一天不晋升');
  assert.match(run1.promotion?.blocked?.[0]?.reason ?? '', /仅跨单个日期/);
  const after1 = await svc.load();
  assert.deepEqual(
    [...after1.candidateTraits[0].sourceEventIds].sort(),
    ['d1a', 'd1b'],
    '第一天的证据被存进候选池（原实现丢的就是它）',
  );

  // 第二天：本轮证据仍在 11-03 一天，并上池里 11-02 的证据 → 跨 2 日期 → 晋升
  const run2 = await new DailyReviewEngine({
    llm: fullLlm({ eventIds: ['d2a', 'd2b'], traitText: '会先澄清再展开' }),
    selfModel: svc,
    state: makeStateStub(),
    store,
  }).run({ date: '2026-11-03', events: day2, allEvents: [...day1, ...day2], selfModel: await svc.load(), state: null, feedback: [] });

  assert.deepEqual(run2.promotion?.promoted, ['会先澄清再展开'], '第二天证据累积到跨 2 日期 → 晋升');
  const after2 = await svc.load();
  assert.ok(after2.traits.includes('会先澄清再展开'), '进入 stable');
  assert.equal(after2.candidateTraits.length, 0, '候选池清空');
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

  assert.deepEqual(out.promotion?.promoted, [], '纯自述 → 全部冻结');
  const snap = await svc.load();
  assert.equal(snap.traits.includes('记忆混乱'), false, '自述 trait 不进 current.traits');
  assert.ok(snap.candidateTraits.some((c) => c.text === '记忆混乱'), '自述 trait 进 candidateTraits');
});

/* ── 6. 注入隔离 ── */

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
    candidateTraits: [
      { text: '记忆混乱', sourceEventIds: [] },
      { text: '会猜题', sourceEventIds: [] },
    ],
  });
  assert.ok(!text.includes('记忆混乱'), 'candidateTraits 不出现在注入摘要');
  assert.ok(!text.includes('会猜题'), 'candidateTraits 不出现在注入摘要');
  assert.ok(!text.includes('稳定特质'), '摘要只含说话方式/叙事/关系/AI 身份，不含 traits 行');
  assert.ok(text.includes('说话方式'), '摘要格式不变');
});
