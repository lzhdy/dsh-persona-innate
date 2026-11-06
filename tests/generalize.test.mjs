/**
 * 增量2 综合泛化测试（generalize 方法）
 *
 * 覆盖（对应 docs/增量2-综合泛化-实现规格.md §4）：
 * 1) self facts <2 → 返回 [] 且不发 LLM 调用
 * 2) 2 条 self facts、LLM 返回 1 条 trait 关联 2 条 fact → 通过，sourceEventIds 去重后 ≥2
 * 3) trait 只关联 1 条 fact（或该 fact 只有 1 个事件）→ 被「≥2 事件」闸门丢弃
 * 4) trait 的 sourceFactIds 含未知 id → 该 id 被忽略，剩余证据 <2 → 丢弃
 * 5) LLM 返回非 JSON → 返回 []（降级）
 * 6) 泛化结果与 reflectSelf traits 去重合并进 candidateTraits（run 集成）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { MockLlm } from '../lib/llm-client.js';
import { DailyReviewEngine, GENERALIZE_PROMPT } from '../lib/review.js';

/** 临时目录版 FsLike（与 review.test.mjs 同一手法） */
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
  const dir = await mkdtemp(join(tmpdir(), 'persona-gen-'));
  return new JsonStore(tempFs(dir), dir);
}

/** 内存版 StateMachineLike（本线不写状态机，仅占位满足接口） */
function makeStateStub() {
  return {
    appraise() {
      return { goalRelevance: 0, conductveness: 0, surprise: 0, agency: 'external' };
    },
    async apply() {
      throw new Error('unused in generalize tests');
    },
    async decay() {
      throw new Error('unused in generalize tests');
    },
    getMode() {
      return 'open';
    },
    getRelationshipStage() {
      return 'acquaintance';
    },
    async reinforce() {
      throw new Error('unused in generalize tests');
    },
    async snapshot() {
      throw new Error('unused in generalize tests');
    },
  };
}

/** 内存版 SelfModelServiceLike（记录 candidate 提交） */
function makeSelfModelStub(seed) {
  return {
    current: seed,
    candidateCommits: [],
    async load() {
      return this.current;
    },
    async listHistory() {
      return this.current ? [this.current] : [];
    },
    async commitFromSources(diff, evidence, sources, changeNote) {
      const prev = this.current ?? {};
      this.current = { ...prev, version: (prev.version ?? 0) + 1, traits: [...(prev.traits ?? []), ...(diff.traits ?? [])] };
      return this.current;
    },
    async commitCandidates(candidates) {
      const prev = this.current ?? {};
      const snap = {
        ...prev,
        version: (prev.version ?? 0) + 1,
        candidateTraits: [...(prev.candidateTraits ?? []), ...candidates],
      };
      this.current = snap;
      this.candidateCommits.push({ candidates, snap });
      return snap;
    },
    async appendGrowth() {},
    getInjectionSummary() {
      return '';
    },
  };
}

/** 构造一条 PersonaFact（覆盖默认值） */
function fact(over) {
  return {
    id: 'f1',
    type: 'self',
    content: '我会先澄清',
    sourceEventIds: ['ev_a'],
    confidence: 0.5,
    ...over,
  };
}

/** 带调用计数的 LLM 桩（generalize 只用 complete） */
function countingLlm(respond) {
  const calls = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      return respond(input);
    },
  };
}

/** 只关心 generalize 的最小引擎（不触达 store/selfModel/state） */
function engineWith(llm) {
  return new DailyReviewEngine({
    llm,
    selfModel: makeSelfModelStub(null),
    state: makeStateStub(),
    store: { makeId: () => 'x' },
  });
}

/* ── 1. self facts <2 → 直接返回 [] 不发 LLM ── */

test('generalize：self facts <2 → 返回 [] 且不发 LLM 调用', async () => {
  const llm = countingLlm(() => JSON.stringify({ traits: [] }));
  const engine = engineWith(llm);

  assert.deepEqual(await engine.generalize([]), []);
  assert.deepEqual(await engine.generalize([fact({ id: 'f1' })]), [], '仅 1 条 self fact');
  assert.deepEqual(
    await engine.generalize([fact({ id: 'f1', type: 'user' }), fact({ id: 'f2', type: 'world' })]),
    [],
    'self facts 为 0（全是 user/world）',
  );
  assert.equal(llm.calls.length, 0, '少于 2 条 self fact 不该发 LLM 调用');
});

/* ── 2. 2 条 self facts → trait 关联 2 条 fact 通过 ── */

test('generalize：2 条 self facts、trait 关联 2 条 fact → 通过，sourceEventIds ≥2', async () => {
  const facts = [
    fact({ id: 'f1', content: '我会先澄清', sourceEventIds: ['ev_a'] }),
    fact({ id: 'f2', content: '我会再展开', sourceEventIds: ['ev_b'] }),
  ];
  const llm = countingLlm(() => JSON.stringify({
    traits: [{ trait: '我倾向于先澄清再展开', sourceFactIds: ['f1', 'f2'] }],
  }));
  const out = await engineWith(llm).generalize(facts);
  assert.equal(out.length, 1);
  assert.equal(out[0].trait, '我倾向于先澄清再展开');
  assert.deepEqual(out[0].sourceEventIds, ['ev_a', 'ev_b'], 'sourceEventIds 由 fact 的事件证据展开');
  assert.ok(out[0].sourceEventIds.length >= 2, '机制闸门：去重后 ≥2 事件');
});

/* ── 3. 只关联 1 条 fact（或 1 个事件）→ 丢弃 ── */

test('generalize：trait 只关联 1 条 fact → 「≥2 事件」闸门丢弃', async () => {
  const facts = [
    fact({ id: 'f1', content: '我会先澄清', sourceEventIds: ['ev_a'] }),
    fact({ id: 'f2', content: '我会再展开', sourceEventIds: ['ev_b'] }),
  ];
  const llm = countingLlm(() => JSON.stringify({
    traits: [{ trait: '单条事实', sourceFactIds: ['f1'] }],
  }));
  const out = await engineWith(llm).generalize(facts);
  assert.equal(out.length, 0, '只关联 1 条 fact → 事件数 <2 → 丢弃');
});

test('generalize：trait 关联 2 条 fact 但只有 1 个不同事件 → 丢弃', async () => {
  const facts = [
    fact({ id: 'f1', content: '我会先澄清', sourceEventIds: ['ev_a'] }),
    fact({ id: 'f2', content: '我会再展开', sourceEventIds: ['ev_a'] }), // 同一事件
  ];
  const llm = countingLlm(() => JSON.stringify({
    traits: [{ trait: '同事件', sourceFactIds: ['f1', 'f2'] }],
  }));
  const out = await engineWith(llm).generalize(facts);
  assert.equal(out.length, 0, '去重后仅 1 个事件 → 丢弃');
});

/* ── 4. sourceFactIds 含未知 id → 忽略，剩余 <2 → 丢弃 ── */

test('generalize：sourceFactIds 含未知 id → 忽略，剩余证据 <2 → 丢弃', async () => {
  const facts = [
    fact({ id: 'f1', content: '我会先澄清', sourceEventIds: ['ev_a'] }),
    fact({ id: 'f2', content: '我会再展开', sourceEventIds: ['ev_b'] }),
  ];
  const llm = countingLlm(() => JSON.stringify({
    traits: [{ trait: '含未知id', sourceFactIds: ['f1', 'ghost'] }],
  }));
  const out = await engineWith(llm).generalize(facts);
  assert.equal(out.length, 0, '未知 id 被忽略后仅 1 事件 → 丢弃');
});

/* ── 5. LLM 返回非 JSON → [] ── */

test('generalize：LLM 返回非 JSON → 返回 []（降级）', async () => {
  const facts = [
    fact({ id: 'f1', content: '我会先澄清', sourceEventIds: ['ev_a'] }),
    fact({ id: 'f2', content: '我会再展开', sourceEventIds: ['ev_b'] }),
  ];
  const llm = countingLlm(() => '完全不是 JSON 的输出');
  const out = await engineWith(llm).generalize(facts);
  assert.deepEqual(out, []);
});

/* ── 6. 泛化结果与 reflectSelf traits 去重合并进 candidateTraits ── */

test('run 集成：泛化特质与 reflectSelf traits 去重合并进 candidateTraits', async () => {
  const store = await freshStore();
  const selfModel = makeSelfModelStub(null);
  const llm = new MockLlm([
    {
      match: '提炼语义事实',
      respond: JSON.stringify({
        facts: [
          { type: 'self', content: '我会先澄清', sourceEventIds: ['ev_a'], confidence: 0.6 },
          { type: 'self', content: '我会再展开', sourceEventIds: ['ev_b'], confidence: 0.6 },
        ],
      }),
    },
    {
      match: '归纳出你的稳定特质',
      respond: (input) => {
        // 从 prompt 里的 listing（"- [factId] ..."）抽取事实 id，避免依赖 makeId 的调用顺序
        const ids = [...input.prompt.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
        return JSON.stringify({
          traits: [
            { trait: '泛化特质', sourceFactIds: ids.slice(0, 2) },
            { trait: '即时特质', sourceFactIds: ids.slice(0, 2) }, // 与 reflectSelf 重复，测去重
          ],
        });
      },
    },
    {
      match: '反思自己的行为与表达',
      respond: JSON.stringify({ traits: ['即时特质'], preferences: [], speakingStyle: '', narrative: '' }),
    },
    {
      match: '更新对这段关系的认知',
      respond: JSON.stringify({ relationshipView: '' }),
    },
    {
      match: '派生两类记忆',
      respond: JSON.stringify({ threads: [], attributes: [] }),
    },
    {
      match: '你自己遇到什么情况',
      respond: JSON.stringify({ procedures: [] }),
    },
  ]);

  const engine = new DailyReviewEngine({ llm, selfModel, state: makeStateStub(), store });
  const events = [
    { id: 'ev_a', time: '2026-11-01T10:00:00.000Z', topic: '用户-分享', summary: '分享', emotionTags: [], importance: 0.7, provenance: 'inferred', lastRetrieved: null },
    { id: 'ev_b', time: '2026-11-01T11:00:00.000Z', topic: '用户-分享', summary: '再分享', emotionTags: [], importance: 0.7, provenance: 'inferred', lastRetrieved: null },
  ];
  const out = await engine.run({
    date: '2026-11-01',
    events,
    allEvents: events,
    selfModel: await selfModel.load(),
    state: null,
    feedback: [],
  });

  assert.equal(out.cost.generalizeCalls, 1, 'generalize 单独计 1 次调用');
  assert.equal(out.cost.llmCalls, 3, 'llmCalls 口径不变（仍只计核心三步）');
  // ISS-048：逐候选判定。两条各自冻结——
  // 但理由都落在"日期"上：泛化特质有证据（同一天两条 inferred），
  // 而「即时特质」的同名条目**也**由泛化路径给出，合并后同样带上了这两条证据
  // （buildTraitCandidates 按文本合并、证据取并集：宁可让它有机会晋升，
  //  也不要因为先到的是即时表述就把整条永久判死）。
  assert.deepEqual(out.promotion?.promoted, [], '两条都不晋升');
  const reasons = Object.fromEntries((out.promotion?.blocked ?? []).map((b) => [b.text, b.reason]));
  assert.match(reasons['泛化特质'] ?? '', /仅跨单个日期/, '泛化特质：证据只落在 1 个日期');
  assert.match(reasons['即时特质'] ?? '', /仅跨单个日期/, '即时特质：合并到的证据同样只落在 1 个日期');

  const snap = await selfModel.load();
  assert.ok(snap.candidateTraits.some((c) => c.text === '泛化特质'), '泛化特质进 candidateTraits');
  assert.ok(snap.candidateTraits.some((c) => c.text === '即时特质'), '即时特质进 candidateTraits');
  assert.equal(
    snap.candidateTraits.filter((c) => c.text === '即时特质').length,
    1,
    '重复特质按文本去重合并，不重复写入',
  );
  // 证据必须跟着候选一起进池子（原缺陷就是在这里把 sourceEventIds 丢了）
  const gen = snap.candidateTraits.find((c) => c.text === '泛化特质');
  assert.deepEqual(gen.sourceEventIds.sort(), ['ev_a', 'ev_b'], '泛化候选必须自带证据');
});

/* ── 7. 泛化特质带证据跨 2 日期 → 晋升进 stable（ISS-048 后的正向通路）── */

test('run 集成：泛化特质跨 2 日期且含 user_direct → 晋升进 stable，候选池不留同名', async () => {
  const store = await freshStore();
  const selfModel = makeSelfModelStub(null);
  const llm = new MockLlm([
    {
      match: '提炼语义事实',
      respond: JSON.stringify({
        facts: [
          { type: 'self', content: '我会先澄清', sourceEventIds: ['ev_a'], confidence: 0.6 },
          { type: 'self', content: '我会再展开', sourceEventIds: ['ev_b'], confidence: 0.6 },
        ],
      }),
    },
    {
      match: '归纳出你的稳定特质',
      respond: (input) => {
        const ids = [...input.prompt.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
        return JSON.stringify({
          traits: [{ trait: '泛化特质', sourceFactIds: ids.slice(0, 2) }],
        });
      },
    },
    {
      // reflectSelf 不产 traits → diff.traits = []，触发边界 A（仅泛化特质非空）
      match: '反思自己的行为与表达',
      respond: JSON.stringify({ traits: [], preferences: [], speakingStyle: '', narrative: '' }),
    },
    {
      match: '更新对这段关系的认知',
      respond: JSON.stringify({ relationshipView: '' }),
    },
    {
      match: '派生两类记忆',
      respond: JSON.stringify({ threads: [], attributes: [] }),
    },
    {
      match: '你自己遇到什么情况',
      respond: JSON.stringify({ procedures: [] }),
    },
  ]);

  const engine = new DailyReviewEngine({ llm, selfModel, state: makeStateStub(), store });
  const events = [
    { id: 'ev_a', time: '2026-11-01T10:00:00.000Z', topic: '用户-分享', summary: '分享', emotionTags: [], importance: 0.7, provenance: 'user_direct', lastRetrieved: null },
    { id: 'ev_b', time: '2026-11-02T11:00:00.000Z', topic: '自身-表达', summary: '表达', emotionTags: [], importance: 0.7, provenance: 'self_direct', lastRetrieved: null },
  ];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    allEvents: events,
    selfModel: await selfModel.load(),
    state: null,
    feedback: [],
  });

  // 泛化特质带 ev_a(user_direct 11-01) + ev_b(self_direct 11-02)：跨 2 日期 + 含 user_direct → 晋升。
  // 这是 ISS-048 修复后才存在的通路——原实现拿"本次窗口"当证据，这类候选永远过不了闸门。
  assert.deepEqual(out.promotion?.promoted, ['泛化特质'], '带证据且跨日期 → 晋升');
  assert.deepEqual(out.promotion?.blocked, [], '没有候选被隔离');

  const snap = await selfModel.load();
  assert.ok((snap.traits ?? []).includes('泛化特质'), '泛化特质进入 stable');
  assert.equal(
    (snap.candidateTraits ?? []).some((c) => c.text === '泛化特质'),
    false,
    '晋升后候选池里不得再有同名条目（否则同一特质两处并存）',
  );
});

test('GENERALIZE_PROMPT：中文模板且要求 JSON 输出、禁止祈使句', () => {
  assert.ok(typeof GENERALIZE_PROMPT === 'string' && GENERALIZE_PROMPT.length > 20);
  assert.ok(GENERALIZE_PROMPT.includes('JSON'));
  assert.ok(GENERALIZE_PROMPT.includes('禁止祈使句'));
  assert.ok(GENERALIZE_PROMPT.includes('至少 2 条不同的语义事实'));
});
