/**
 * M1 每日复盘引擎测试（线 D）
 * 覆盖：shouldRun 三判定（O17）/ full 八步流水线 / degraded 降级 / skip 空输出 /
 *       LLM 垃圾输出降级不崩 / consistency 失败捕获 / 自源重要性并列（O6/O35）
 * 约定：纯 JS ESM，import ../lib/*.js；不 import ../lib/self-model.js 与 ../lib/state.js
 *       ——内存 stub 实现 SelfModelServiceLike / StateMachineLike（接口在 types.ts）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { MockLlm } from '../lib/llm-client.js';
import { DailyReviewEngine, REVIEW_PROMPTS } from '../lib/review.js';

/** 临时目录版 FsLike（与 m0.test.mjs 同一手法） */
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
  const dir = await mkdtemp(join(tmpdir(), 'persona-review-'));
  return new JsonStore(tempFs(dir), dir);
}

/** 内存版 SelfModelServiceLike（types.ts 接口；不 import 真实实现） */
function makeSelfModelStub(seed) {
  return {
    current: seed,
    commits: [],
    candidateCommits: [],
    growth: [],
    shouldThrow: null,
    async load() {
      return this.current;
    },
    async listHistory() {
      return this.current ? [this.current] : [];
    },
    async commitFromSources(diff, evidence, sources, changeNote) {
      if (this.shouldThrow) throw this.shouldThrow;
      const prev = this.current;
      const snap = {
        version: (prev?.version ?? 0) + 1,
        createdAt: new Date().toISOString(),
        traits: [...(prev?.traits ?? []), ...(diff.traits ?? [])],
        preferences: [...(prev?.preferences ?? []), ...(diff.preferences ?? [])],
        speakingStyle: diff.speakingStyle ?? prev?.speakingStyle ?? '（未成形）',
        relationshipView: diff.relationshipView ?? prev?.relationshipView ?? '',
        narrative: (prev?.narrative ?? '') + (diff.narrative ?? ''),
        aiIdentity: prev?.aiIdentity ?? '我是 AI，正在通过与你的相处形成自己的方式。',
        changeNote,
        sourceEventIds: [...(prev?.sourceEventIds ?? []), ...evidence],
        sourceTraces: { reflection: evidence, looking_glass: evidence },
        // 与真实 SelfModelService 对齐：commitFromSources 保留候选，但晋升成功的同名候选要移出
        candidateTraits: (prev?.candidateTraits ?? []).filter((c) => !(diff.traits ?? []).includes(c.text)),
      };
      this.current = snap;
      this.commits.push({ diff, evidence, sources, changeNote, snap });
      return snap;
    },
    async commitCandidates(candidates) {
      const prev = this.current ?? {};
      const snap = {
        ...prev,
        version: (prev.version ?? 0) + 1,
        createdAt: new Date().toISOString(),
        candidateTraits: [...(prev.candidateTraits ?? []), ...candidates],
      };
      this.current = snap;
      this.candidateCommits.push({ candidates, snap });
      return snap;
    },
    async removeCandidates(texts) {
      const prev = this.current ?? {};
      const drop = new Set(texts);
      const snap = {
        ...prev,
        version: (prev.version ?? 0) + 1,
        createdAt: new Date().toISOString(),
        candidateTraits: (prev.candidateTraits ?? []).filter((c) => !drop.has(c.text)),
      };
      this.current = snap;
      return snap;
    },
    async appendGrowth(entry) {
      this.growth.push(entry);
    },
    getInjectionSummary() {
      return '';
    },
  };
}

/** 内存版 StateMachineLike（本线不写状态机，仅占位满足接口） */
function makeStateStub() {
  return {
    appraise() {
      return { goalRelevance: 0, conductveness: 0, surprise: 0, agency: 'external' };
    },
    async apply() {
      throw new Error('unused in review tests');
    },
    async decay() {
      throw new Error('unused in review tests');
    },
    getMode() {
      return 'open';
    },
    getRelationshipStage() {
      return 'acquaintance';
    },
    async reinforce() {
      throw new Error('unused in review tests');
    },
    async snapshot() {
      throw new Error('unused in review tests');
    },
  };
}

/** 构造一条 PersonaEvent（覆盖默认值） */
function ev(over) {
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

/** 种子快照：2 条旧特质（judgeStage → forming），preferences 含 '天文'（自源目标） */
const seedSnapshot = {
  version: 1,
  createdAt: new Date().toISOString(),
  traits: ['已有特质甲', '已有特质乙'],
  preferences: ['天文'],
  speakingStyle: '（未成形）',
  relationshipView: '',
  narrative: '',
  aiIdentity: '我是 AI，正在通过与你的相处形成自己的方式。',
  sourceEventIds: [],
};

/** 脚本化 MockLlm：三个 prompt 各返回固定 JSON（匹配 REVIEW_PROMPTS 里的特征短语） */
function scriptedLlm() {
  return new MockLlm([
    {
      match: '提炼语义事实',
      respond: JSON.stringify({
        facts: [
          { type: 'user', content: '用户养了一只叫煤球的黑猫', sourceEventIds: ['ev-share'], confidence: 0.9 },
        ],
      }),
    },
    {
      match: '反思自己的行为',
      respond: JSON.stringify({
        traits: ['会在用户难过时先倾听而非给建议'],
        preferences: ['偏好先问再判断'],
        speakingStyle: '短句、温和',
        narrative: '我会在意用户的情绪，因为那次他加班到深夜还在和我说话。',
      }),
    },
    {
      match: '关系认知',
      respond: JSON.stringify({ relationshipView: '我们越来越熟，他会主动分享日常。' }),
    },
  ]);
}

test('REVIEW_PROMPTS：中文模板且要求 JSON 输出', () => {
  for (const key of ['distillFacts', 'reflectSelf', 'updateMirror']) {
    const p = REVIEW_PROMPTS[key];
    assert.ok(typeof p === 'string' && p.length > 20, `${key} 模板非空`);
    assert.ok(p.includes('JSON'), `${key} 应要求 JSON 输出`);
  }
});

test('shouldRun：三种判定（O17）', async () => {
  const store = await freshStore();
  const engine = new DailyReviewEngine({
    llm: new MockLlm(),
    selfModel: makeSelfModelStub(null),
    state: makeStateStub(),
    store,
  });
  const base = { date: '2026-11-02', selfModel: null, state: null, feedback: [] };
  assert.equal(engine.shouldRun({ ...base, events: [] }), 'skip', '无输入 → skip');
  assert.equal(
    engine.shouldRun({ ...base, events: [ev({ id: 'b1', initiation: 'external_triggered', topic: '身体事件' })] }),
    'degraded',
    '仅身体事件 → degraded',
  );
  assert.equal(
    engine.shouldRun({ ...base, events: [ev({ id: 'u1' })] }),
    'full',
    '普通事件 → full',
  );
  assert.equal(
    engine.shouldRun({
      ...base,
      events: [ev({ id: 'b1', initiation: 'external_triggered' }), ev({ id: 'u1' })],
    }),
    'full',
    '身体事件+普通事件混合 → full',
  );
});

test('full 流程：facts / 新版本 selfModel / stage=shaping / archive / selfImportance / llmCalls=3', async () => {
  const store = await freshStore();
  const selfModel = makeSelfModelStub({ ...seedSnapshot });
  const engine = new DailyReviewEngine({ llm: scriptedLlm(), selfModel, state: makeStateStub(), store });
  const events = [
    ev({
      id: 'ev-share',
      topic: '用户-分享',
      summary: '用户说他养了一只叫煤球的黑猫',
      importance: 0.8,
      provenance: 'user_direct',
      time: '2026-11-01T10:00:00.000Z',
    }),
    ev({
      id: 'ev-night',
      topic: '用户-加班',
      summary: '用户加班到深夜，情绪低落',
      importance: 0.7,
      provenance: 'user_direct',
      time: '2026-11-02T10:00:00.000Z',
    }),
  ];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    selfModel: selfModel.current,
    state: null,
    feedback: [
      { eventId: 'ev-share', response: '哈哈对', inferredAttitude: 'positive', time: new Date().toISOString() },
    ],
  });

  assert.equal(out.mode, 'full');
  assert.equal(out.cost.llmCalls, 3, 'full 最多 3 次 LLM 调用（distillFacts/reflectSelf/updateMirror）');
  // ISS-048：reflectSelf 直接产出的 traits 没有事件证据 → 恒冻结（用户拍板），
  // 即使窗口跨了 2 个日期也不晋升。这正是"单向棘轮"被拆掉之后仍然要守住的那条线。
  assert.deepEqual(out.promotion?.promoted, [], '即时 traits 无证据 → 不晋升');
  assert.match(out.promotion?.blocked?.[0]?.reason ?? '', /候选无证据/, 'reason 说明缺证据');

  // step2 facts
  assert.ok(out.facts.length >= 1, '应提炼出语义事实');
  assert.ok(out.facts[0].content.includes('煤球'), '事实内容来自当日事件');
  assert.ok(out.facts[0].id, '事实有 id');
  assert.ok(out.facts[0].sourceEventIds.includes('ev-share'), '事实挂事件证据链');

  // step6 新版本
  assert.ok(out.selfModel, 'commitFromSources 应返回新版本');
  // v3：候选隔离先写一版（v2），随后 stable commit 再写一版（v3）——
  // 两条写入路径各自版本化，与既有 commit 语义一致。
  assert.equal(out.selfModel.version, 3, '版本号递增（候选隔离 + stable commit 各一版）');
  // ISS-048：即时 traits 无事件证据 → 不进 stable，但必须落进候选池（不能凭空消失）
  assert.equal(
    out.selfModel.traits.includes('会在用户难过时先倾听而非给建议'),
    false,
    '无证据的即时 trait 不晋升 stable',
  );
  assert.ok(
    (out.selfModel.candidateTraits ?? []).some((c) => c.text === '会在用户难过时先倾听而非给建议'),
    '即时 trait 落候选池待验证',
  );
  assert.equal(selfModel.commits[0].sources.includes('reflection'), true);
  assert.ok(selfModel.commits[0].evidence.includes('ev-share'), '证据链含事件 id');

  // step7 stage：stable 仍是 2 条旧特质，但说话方式已成形 → 仍判 shaping（性格开始成形）
  assert.equal(out.stage, 'shaping');
  assert.ok(out.stageTrajectory.includes('forming→shaping'), `轨迹应为 forming→shaping，实际 ${out.stageTrajectory}`);

  // step8 成长档案
  assert.ok(out.archiveEntry, '应输出成长档案条目');
  assert.equal(out.archiveEntry.eventRefs.length, 2, '档案引用全部关键事件');
  assert.equal(selfModel.growth.length, 1, 'appendGrowth 写入成长档案');

  // 自源重要性条目齐全
  assert.equal(out.selfImportance.length, 2);
});

test('degraded：只做 step1-2 + 事件标签，不更新 self_model', async () => {
  const store = await freshStore();
  const selfModel = makeSelfModelStub({ ...seedSnapshot });
  const engine = new DailyReviewEngine({ llm: scriptedLlm(), selfModel, state: makeStateStub(), store });
  const events = [
    ev({
      id: 'b1',
      topic: '身体事件-电量',
      summary: '插件电量低',
      initiation: 'external_triggered',
      importance: 0.6,
    }),
  ];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    selfModel: selfModel.current,
    state: null,
    feedback: [],
  });

  assert.equal(out.mode, 'degraded');
  assert.equal(out.selfModel, null, '降级复盘不更新 self_model');
  assert.equal(selfModel.commits.length, 0, '降级复盘不得调 commitFromSources');
  assert.equal(out.cost.llmCalls, 1, '降级只调 1 次 LLM（distillFacts）');
  assert.ok(out.facts.length >= 1, '降级仍提炼 facts');
  const tag = out.eventTags.find((t) => t.eventId === 'b1');
  assert.ok(tag, '降级也输出事件标签');
  assert.ok(tag.tags.includes('init:external_triggered'), `事件标签含 initiation 标记：${tag.tags}`);
});

test('skip：无输入空输出', async () => {
  const store = await freshStore();
  const selfModel = makeSelfModelStub(null);
  const engine = new DailyReviewEngine({ llm: scriptedLlm(), selfModel, state: makeStateStub(), store });
  const out = await engine.run({ date: '2026-11-02', events: [], selfModel: null, state: null, feedback: [] });

  assert.equal(out.mode, 'skip');
  assert.equal(out.facts.length, 0);
  assert.equal(out.eventTags.length, 0);
  assert.equal(out.selfModel, null);
  assert.equal(out.stage, null);
  assert.equal(out.archiveEntry, null);
  assert.equal(out.selfImportance.length, 0);
  assert.equal(out.cost.llmCalls, 0, 'skip 不发生 LLM 调用');
});

test('LLM 返回垃圾：各步降级为空继续，不崩', async () => {
  const store = await freshStore();
  const badLlm = new MockLlm([{ match: /.*/, respond: '这不是 JSON，只是一段随便说的话{{{' }]);
  const selfModel = makeSelfModelStub({ ...seedSnapshot });
  const engine = new DailyReviewEngine({ llm: badLlm, selfModel, state: makeStateStub(), store });
  const events = [ev({ id: 'u1', topic: '闲聊', summary: '用户随便聊了几句', importance: 0.6 })];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    selfModel: selfModel.current,
    state: null,
    feedback: [],
  });

  assert.equal(out.mode, 'full');
  assert.equal(out.facts.length, 0, '非 JSON → facts 降级为空');
  assert.equal(out.selfModel, null, '空 diff 不提交新版本');
  assert.equal(out.cost.llmCalls, 3, '三步 LLM 调用都发生了，流程走完');
  assert.equal(out.stage, 'forming', 'commit 失败时回退到当前快照判定阶段');
  assert.ok(out.archiveEntry, '成长档案仍追加');
});

test('commitFromSources 抛错被捕获：selfModel:null，流程不中断', async () => {
  const store = await freshStore();
  const selfModel = makeSelfModelStub({ ...seedSnapshot });
  selfModel.shouldThrow = new Error('consistency: 新特质缺少事件证据');
  const engine = new DailyReviewEngine({ llm: scriptedLlm(), selfModel, state: makeStateStub(), store });
  const events = [ev({ id: 'u1', topic: '闲聊', summary: '用户聊了几句', importance: 0.6 })];
  const out = await engine.run({
    date: '2026-11-02',
    events,
    selfModel: selfModel.current,
    state: null,
    feedback: [],
  });

  assert.equal(out.selfModel, null, '一致性抛错 → 输出 selfModel:null');
  assert.equal(out.stage, 'forming', '阶段判定回退到当前快照（seed 2 特质 → forming）');
  assert.ok(out.archiveEntry, '成长档案仍追加（自我连续性来源）');
  assert.equal(selfModel.growth.length, 1);
});

test('自源重要性并列：用户零反馈仍 selfSource:true（O6/O35）', async () => {
  const store = await freshStore();
  const selfModel = makeSelfModelStub({ ...seedSnapshot }); // preferences 含 '天文'
  const engine = new DailyReviewEngine({ llm: scriptedLlm(), selfModel, state: makeStateStub(), store });
  const events = [
    ev({ id: 'ev-astro', topic: '天文观测', summary: '用户在聊星云照片', importance: 0.4 }),
    ev({ id: 'ev-food', topic: '吃饭', summary: '用户点了外卖', importance: 0.4 }),
  ];
  // feedback 为空——用户从未回应
  const out = await engine.run({
    date: '2026-11-02',
    events,
    selfModel: selfModel.current,
    state: null,
    feedback: [],
  });

  const astro = out.selfImportance.find((s) => s.eventId === 'ev-astro');
  assert.ok(astro, '应输出自源重要性条目');
  assert.equal(astro.selfSource, true, '与 selfGoal「天文」相关 → selfSource:true，即使用户零反馈');
  assert.equal(astro.importance, 0.65, 'importance = max(原值 0.4, 0.65)');

  const food = out.selfImportance.find((s) => s.eventId === 'ev-food');
  assert.ok(food, '普通事件也有条目');
  assert.equal(food.selfSource, false, '与自身目标无关 → selfSource:false');
  assert.equal(food.importance, 0.4, '普通事件重要性保持原值，不被抬高也不被压制');
});
