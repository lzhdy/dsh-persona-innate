/**
 * state 状态机单测（线 E）
 * 覆盖：默认初始化 / appraise 四信号 / apply 分布参数更新与异常回退 / selfGoalWeight=0 抛错 /
 * decay 衰减 / mode 强弱势切换 / 关系阶段推进 / reinforce 记录与 solidified 标记 / snapshot·history 落盘
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import {
  RELATIONSHIP_STAGES,
  DEFAULT_USER_GOAL_WEIGHT,
  DEFAULT_SELF_GOAL_WEIGHT,
  defaultEmotionalState,
  PersonaStateMachine,
} from '../lib/state.js';

/** 临时目录版 FsLike（同 m0.test.mjs 手法） */
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
  const dir = await mkdtemp(join(tmpdir(), 'persona-state-'));
  const store = new JsonStore(tempFs(dir), dir);
  store.root = dir; // 测试读取落盘文件用
  return store;
}

function ev(over) {
  return {
    id: over.id ?? 'e1',
    time: new Date().toISOString(),
    topic: '分享',
    summary: '随便聊聊',
    emotionTags: [],
    importance: 0.5,
    provenance: 'user_direct',
    lastRetrieved: null,
    ...over,
  };
}

const GOALS = { user: ['用户目标'], self: ['我的好奇'] };

test('默认状态初始化：导出常量与 defaultEmotionalState 对齐冻结契约', async () => {
  assert.deepEqual(RELATIONSHIP_STAGES, ['acquaintance', 'familiar', 'trust', 'intimate']);
  assert.equal(DEFAULT_USER_GOAL_WEIGHT, 0.7);
  assert.equal(DEFAULT_SELF_GOAL_WEIGHT, 0.3);

  const d = defaultEmotionalState();
  assert.equal(d.valenceMean, 0);
  assert.equal(d.arousalMean, 0.3);
  assert.equal(d.valenceRange, 0.15);
  assert.equal(d.arousalRange, 0.15);
  assert.equal(d.contextOffset, 0);

  const store = await freshStore();
  const sm = new PersonaStateMachine(store);
  const snap = await sm.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.state.valenceMean, 0);
  assert.equal(snap.state.arousalMean, 0.3);
  assert.equal(snap.state.valenceRange, 0.15);
  assert.equal(snap.state.contextOffset, 0);
  assert.equal(sm.getMode(), 'open');
  assert.equal(sm.getRelationshipStage(), 'acquaintance');
  assert.deepEqual(snap.reinforcement, []);
  assert.deepEqual(snap.history, []);
});

test('selfGoalWeight=0（或负数/NaN）构造即抛错（O34）', async () => {
  const store = await freshStore();
  assert.throws(() => new PersonaStateMachine(store, { selfGoalWeight: 0 }), /selfGoalWeight/);
  assert.throws(() => new PersonaStateMachine(store, { selfGoalWeight: -0.1 }), /selfGoalWeight/);
  assert.throws(() => new PersonaStateMachine(store, { selfGoalWeight: NaN }), /selfGoalWeight/);
  // 正常值不抛
  new PersonaStateMachine(store, { selfGoalWeight: 0.0001 });
});

test('appraise 输出四信号且字段合法', async () => {
  const store = await freshStore();
  const sm = new PersonaStateMachine(store);
  const a = sm.appraise(
    ev({ topic: '分享', summary: '今天很开心，谢谢陪伴', emotionTags: ['开心'], importance: 0.9 }),
    { user: ['开心'], self: [] },
  );
  assert.ok(typeof a.goalRelevance === 'number', 'goalRelevance 存在');
  assert.ok(a.goalRelevance >= -1 && a.goalRelevance <= 1, `goalRelevance 在 [-1,1]：${a.goalRelevance}`);
  assert.ok(typeof a.conductveness === 'number');
  assert.ok(a.conductveness >= -1 && a.conductveness <= 1, `conductveness 在 [-1,1]：${a.conductveness}`);
  assert.ok(a.conductveness > 0, '正向事件符合性应为正');
  assert.ok(typeof a.surprise === 'number');
  assert.ok(a.surprise >= 0 && a.surprise <= 1, `surprise 在 [0,1]：${a.surprise}`);
  assert.ok(['self', 'user', 'external'].includes(a.agency), `agency 合法：${a.agency}`);
  assert.equal(a.agency, 'user', 'user_direct 事件应归因 user');

  // self_initiated → agency self
  const b = sm.appraise(ev({ provenance: 'inferred', initiation: 'self_initiated' }), GOALS);
  assert.equal(b.agency, 'self');
});

test('apply 更新分布参数并落 history', async () => {
  const store = await freshStore();
  const sm = new PersonaStateMachine(store);
  const before = await sm.snapshot();

  const s = await sm.apply(
    ev({ topic: '分享', summary: '今天很开心，完成了一件大事', emotionTags: ['开心'], importance: 0.9 }),
    GOALS,
  );
  assert.ok(s.valenceMean > before.state.valenceMean, `正向事件抬升效价：${before.state.valenceMean} → ${s.valenceMean}`);
  assert.ok(s.arousalMean > 0.3, `意外性+符合性拉升唤醒：${s.arousalMean}`);

  const after = await sm.snapshot();
  assert.equal(after.history.length, 1, 'apply 记录一条 history 快照');
  assert.ok(typeof after.history[0].at === 'string');
  assert.equal(after.history[0].state.valenceMean, s.valenceMean);
});

test('apply 异常时回退默认人格且不抛出', async () => {
  // 坏 store：readJson/exists 正常，writeJson 必抛
  const brokenStore = {
    async readJson() {
      return null;
    },
    async writeJson() {
      throw new Error('disk full');
    },
    async exists() {
      return false;
    },
    makeId: () => 'xid',
  };
  const sm = new PersonaStateMachine(brokenStore);
  const s = await sm.apply(ev({ summary: '糟糕，失败了', emotionTags: ['失望'], importance: 0.9 }), GOALS);
  // 回退默认人格
  assert.equal(s.valenceMean, 0);
  assert.equal(s.arousalMean, 0.3);
  assert.equal(s.valenceRange, 0.15);
  assert.equal(s.contextOffset, 0);
  assert.equal(sm.getMode(), 'open');
});

test('decay 按半衰期把均值衰减回基线、波动范围放宽', async () => {
  const store = await freshStore();
  const HALF = 24 * 60 * 60 * 1000;
  const sm = new PersonaStateMachine(store, { decayHalfLifeMs: HALF });
  // 先制造偏离基线的状态
  await sm.apply(ev({ summary: '糟糕，失败了，难过', emotionTags: ['失望'], importance: 0.9 }), GOALS);
  const before = (await sm.snapshot()).state;
  assert.ok(before.valenceMean < 0, '前置：负向事件压低效价');

  // 一个半衰期 f=0.5：均值严格减半
  const mid = await sm.decay(HALF);
  assert.ok(Math.abs(mid.valenceMean - before.valenceMean * 0.5) < 1e-9, `一个半衰期货价减半：${mid.valenceMean}`);

  // 再经 10 个半衰期：f≈1/1024，几乎完全回基线
  const decayed = await sm.decay(HALF * 10);
  assert.ok(Math.abs(decayed.valenceMean) < 1e-3, `效价衰减回 0：${decayed.valenceMean}`);
  assert.ok(Math.abs(decayed.arousalMean - 0.3) < 1e-3, `唤醒衰减回 0.3：${decayed.arousalMean}`);
  assert.ok(Math.abs(decayed.contextOffset) < 1e-3, `偏移回 0：${decayed.contextOffset}`);
  assert.ok(Math.abs(decayed.valenceRange - 0.15) < 1e-3, `波动范围放宽回基线 0.15：${decayed.valenceRange}`);
});

test('getMode：强情境收窄 / 弱情境放宽', async () => {
  const store = await freshStore();
  const sm = new PersonaStateMachine(store);

  // 危机 → guarded
  await sm.apply(ev({ id: 'c1', topic: '求助', summary: '我遇到危机了，需要紧急帮助' }), GOALS);
  assert.equal(sm.getMode(), 'guarded');
  const guardedRange = (await sm.snapshot()).state.valenceRange;
  assert.ok(guardedRange < 0.15, `guarded 收窄波动：${guardedRange}`);

  // 明确任务 → focused
  await sm.apply(ev({ id: 't1', topic: '任务', summary: '帮我解决这个 bug 报错问题' }), GOALS);
  assert.equal(sm.getMode(), 'focused');

  // 闲聊 → open
  await sm.apply(ev({ id: 'c2', topic: '闲聊', summary: '今天天气不错，随便说说日常' }), GOALS);
  assert.equal(sm.getMode(), 'open');
  const openRange = (await sm.snapshot()).state.valenceRange;
  assert.ok(openRange > guardedRange, `open 放宽波动：${openRange} > ${guardedRange}`);
});

test('关系阶段按证据数推进（acquaintance→familiar→trust），晋升触发 onRuleChange', async () => {
  const calls = [];
  const store = await freshStore();
  const sm = new PersonaStateMachine(store, {
    onRuleChange: async (rule, narrative, evidence) => {
      calls.push({ rule, narrative, evidence });
    },
  });
  assert.equal(sm.getRelationshipStage(), 'acquaintance');

  // user_direct 事件累计 3 条 → familiar
  for (let i = 0; i < 3; i++) {
    await sm.apply(ev({ id: `u${i}`, topic: '分享', summary: `用户直接聊了第 ${i} 件事` }), GOALS);
  }
  assert.equal(sm.getRelationshipStage(), 'familiar');
  assert.ok(calls.length >= 1, '阶段晋升应触发 onRuleChange 叙事解释');
  assert.ok(calls[0].rule.includes('relationship-stage:familiar'), `rule 指向新阶段：${calls[0].rule}`);
  assert.ok(Array.isArray(calls[0].evidence));

  // 累计 10 条 → trust（再补 7 条）
  for (let i = 3; i < 10; i++) {
    await sm.apply(ev({ id: `u${i}`, topic: '分享', summary: `用户直接聊了第 ${i} 件事` }), GOALS);
  }
  assert.equal(sm.getRelationshipStage(), 'trust');

  // 跨会话：新实例 load 后阶段保持
  const sm2 = new PersonaStateMachine(store);
  const st = await sm2.load();
  assert.ok(st, 'load 返回已持久化状态');
  assert.equal(sm2.getRelationshipStage(), 'trust');
});

test('reinforce：记录三元组为状态转移偏好，solidified 触发 onRuleChange', async () => {
  const calls = [];
  const store = await freshStore();
  const sm = new PersonaStateMachine(store, {
    onRuleChange: async (rule, narrative, evidence) => {
      calls.push({ rule, narrative, evidence });
    },
  });

  // 未固化：只记录，不触发叙事
  const r1 = await sm.reinforce({
    tendency: '遇到分歧先问而非说服',
    eventId: 'u1',
    userFeedback: '用户点头认可',
    solidified: false,
  });
  assert.ok(r1.id && r1.id.length > 0, '分配 id');
  assert.ok(r1.time, '分配 time');
  assert.equal(r1.solidified, false);
  assert.equal(calls.length, 0, '未固化不触发 onRuleChange');

  // 已固化：自源证据可独立固化，触发叙事解释
  const r2 = await sm.reinforce({
    tendency: '先复述再回应',
    eventId: 'u2',
    selfEvidence: '复盘推导与自我叙事一致',
    solidified: true,
  });
  assert.equal(r2.solidified, true);
  assert.equal(calls.length, 1, '固化的偏好改变转移规则须叙事解释');
  assert.ok(calls[0].rule.includes('tendency:先复述再回应'));
  assert.ok(calls[0].evidence.includes('u2'));

  const snap = await sm.snapshot();
  assert.equal(snap.reinforcement.length, 2);
});

test('snapshot/history 落盘 state.json，history 上限 200', async () => {
  const store = await freshStore();
  const sm = new PersonaStateMachine(store);
  for (let i = 0; i < 205; i++) {
    await sm.apply(ev({ id: `h${i}`, topic: '分享', summary: `第 ${i} 条` }), GOALS);
  }
  const snap = await sm.snapshot();
  assert.equal(snap.history.length, 200, `history 截断到上限 200：${snap.history.length}`);

  const raw = JSON.parse(await readFile(join(store.root, 'state.json'), 'utf-8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.state.valenceMean, snap.state.valenceMean);
  assert.equal(raw.mode, 'open');
  assert.ok(['acquaintance', 'familiar', 'trust', 'intimate'].includes(raw.relationshipStage));
  assert.equal(raw.history.length, 200);
  assert.ok(typeof raw.history[0].state.valenceMean === 'number');
});
