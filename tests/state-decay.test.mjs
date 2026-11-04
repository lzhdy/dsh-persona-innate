/**
 * v0.7 情绪衰减接线测试（装配级，不是 sm.decay() 单测）
 *
 * 背景：decay(dtMs) 早就实现好了，但真实会话链路从不调用它（唯一调用点是评测门面），
 * 于是效价只被事件推高、永不复原——本机实测 36 分钟 −0.03 → 0.53，11 次更新 10 次上升。
 *
 * 所以这里测的不是"衰减公式对不对"（公式本轮不改），而是：
 * 用真实 PersonaStateMachine + 真实落盘的 state.json 走一遍"跨进程两轮会话"，
 * 断言效价确实回落，且回落只发生在接线函数被调用时（对照组不回落）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import { PersonaStateMachine } from '../lib/state.js';
import { DECAY_MIN_INTERVAL_MS, createSerialQueue, decayForIdleGap } from '../lib/state-decay.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

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
  const dir = await mkdtemp(join(tmpdir(), 'persona-decay-'));
  return new JsonStore(tempFs(dir), dir);
}

/** 直接落一份 state.json：模拟"上次更新发生在 hoursAgo 小时前"的跨进程现场 */
async function seedState(store, { valence, hoursAgo }) {
  const updatedAt = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  const state = {
    valenceMean: valence,
    arousalMean: 0.5,
    valenceRange: 0.15,
    arousalRange: 0.15,
    contextOffset: 0,
    updatedAt,
  };
  const file = {
    version: 1,
    state,
    mode: 'open',
    relationshipStage: 'acquaintance',
    reinforcement: [],
    history: [],
    updatedAt,
  };
  await writeFile(join(store.root, 'state.json'), JSON.stringify(file, null, 2), 'utf-8');
  return state;
}

function ev(id, over = {}) {
  return {
    id,
    time: new Date().toISOString(),
    topic: '用户-分享',
    summary: '用户说今天过得还不错',
    emotionTags: [],
    importance: 0.6,
    provenance: 'user_direct',
    lastRetrieved: null,
    ...over,
  };
}

const GOALS = { user: ['日常'], self: [] };

/* ── 1. 时间跳跃后效价必须回落（这是本次修复的核心断言） ───────── */

test('v0.7-A1: 空闲 2 小时后 decayForIdleGap 让效价回落（旧接线下只升不降）', async () => {
  const store = await freshStore();
  await seedState(store, { valence: 0.7, hoursAgo: 2 });

  // 新进程：从 state.json 载入"2 小时前被推到 0.7"的现场
  const sm = new PersonaStateMachine(store);
  const before = await sm.snapshot();
  assert.equal(before.state.valenceMean, 0.7, '前置：载入的是被推高的效价');

  const r = await decayForIdleGap(sm);
  assert.equal(r.decayed, true, '超过 1 分钟的空闲必须触发衰减');
  assert.ok(r.dtMs >= 2 * HOUR - 60_000, `时间差应约为 2 小时，实际 ${r.dtMs}`);

  const after = await sm.snapshot();
  assert.ok(
    after.state.valenceMean < before.state.valenceMean,
    `效价必须回落，实际 ${before.state.valenceMean} → ${after.state.valenceMean}`,
  );
  // 半衰 24h、2 小时 → 保留 0.7 × 0.5^(2/24) ≈ 0.66
  assert.ok(after.state.valenceMean > 0.6, '2 小时不该把效价打到接近 0（惯性仍在）');
});

/* ── 2. 接线与否必须产生可观测差异（对照组不回落） ─────────────── */

test('v0.7-A2: 同样的两轮会话，走接线（先衰减再应用）比不走接线的终态更低', async () => {
  const controlStore = await freshStore();
  const wiredStore = await freshStore();
  await seedState(controlStore, { valence: 0.7, hoursAgo: 2 });
  await seedState(wiredStore, { valence: 0.7, hoursAgo: 2 });

  const event = ev('u_turn2', { summary: '用户说今天过得还不错', emotionTags: ['开心'] });

  // 对照组：旧行为——直接 apply（效价只被事件继续推高）
  const control = new PersonaStateMachine(controlStore);
  const controlState = await control.apply(event, GOALS);

  // 实验组：perceiveEvent 现在的行为——先衰减再 apply
  const wired = new PersonaStateMachine(wiredStore);
  await decayForIdleGap(wired);
  const wiredState = await wired.apply(event, GOALS);

  assert.ok(
    wiredState.valenceMean < controlState.valenceMean,
    `接线后终态必须更低：wired=${wiredState.valenceMean} control=${controlState.valenceMean}`,
  );
});

/* ── 3. 太短的空闲不衰减（不写盘、不改状态） ─────────────────── */

test('v0.7-A3: 距上次更新不足 1 分钟不衰减，避免每轮无谓写盘', async () => {
  assert.equal(DECAY_MIN_INTERVAL_MS, 60_000);
  const store = await freshStore();
  await seedState(store, { valence: 0.7, hoursAgo: 0 });
  const sm = new PersonaStateMachine(store);

  const raw = await readFile(join(store.root, 'state.json'), 'utf-8');
  const r = await decayForIdleGap(sm);
  assert.equal(r.decayed, false);
  assert.equal(r.reason, 'below-min-interval');

  const again = await readFile(join(store.root, 'state.json'), 'utf-8');
  assert.equal(again, raw, '不衰减时不得改写 state.json');
  assert.equal((await sm.snapshot()).state.valenceMean, 0.7);
});

test('v0.7-A4: 时间戳异常 / 快照读失败 → 不衰减且不抛（衰减是修正项，不能打断主链路）', async () => {
  const badTime = {
    async snapshot() {
      return { state: { updatedAt: 'not-a-date' } };
    },
    async decay() {
      throw new Error('不该被调用');
    },
  };
  const r1 = await decayForIdleGap(badTime);
  assert.equal(r1.decayed, false);
  assert.equal(r1.reason, 'invalid-updatedAt');

  const broken = {
    async snapshot() {
      throw new Error('EACCES');
    },
    async decay() {
      throw new Error('不该被调用');
    },
  };
  const r2 = await decayForIdleGap(broken);
  assert.equal(r2.decayed, false);
  assert.equal(r2.reason, 'snapshot-failed');
});

/* ── 4. 串行队列：并发感知不会把同一段 dt 扣两次 ─────────────── */

test('v0.7-A5: 并发两次感知经串行队列后，第二段的 dt 已被第一次消费掉', async () => {
  const store = await freshStore();
  await seedState(store, { valence: 0.7, hoursAgo: 2 });
  const sm = new PersonaStateMachine(store);
  const q = createSerialQueue();

  const [first, second] = await Promise.all([q(() => decayForIdleGap(sm)), q(() => decayForIdleGap(sm))]);
  assert.equal(first.decayed, true, '第一次应衰减');
  assert.equal(second.decayed, false, '第二次的 dt 已被第一次消费（否则同一段空闲被扣两次）');
  assert.equal(second.reason, 'below-min-interval');
});

test('v0.7-A6: 串行队列按入队顺序执行（不并发、不丢任务）', async () => {
  const q = createSerialQueue();
  const order = [];
  await Promise.all([
    q(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('a-end');
    }),
    q(async () => {
      order.push('b-start');
      order.push('b-end');
    }),
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

/* ── 5. 真实会话形状：多次上升后必须出现一次下降 ─────────────── */

test('v0.7-A7: 连续三轮"每轮间隔 3 小时"，接线组终态必须低于只升不降的对照组', async () => {
  const wiredStore = await freshStore();
  const controlStore = await freshStore();
  await seedState(wiredStore, { valence: 0.2, hoursAgo: 0 });
  await seedState(controlStore, { valence: 0.2, hoursAgo: 0 });

  /** 把落盘的 updatedAt 改到 3 小时前：等价于"进程内又过了 3 小时" */
  const ageStateBy3h = async (store) => {
    const file = JSON.parse(await readFile(join(store.root, 'state.json'), 'utf-8'));
    file.state.updatedAt = new Date(Date.now() - 3 * HOUR).toISOString();
    file.updatedAt = file.state.updatedAt;
    await writeFile(join(store.root, 'state.json'), JSON.stringify(file, null, 2), 'utf-8');
  };

  const turn = (i) =>
    ev(`u_r${i}`, { emotionTags: ['开心', '喜欢'], summary: '用户说今天很开心，很喜欢这次聊天' });

  let wiredFinal = 0;
  let controlFinal = 0;
  for (let i = 0; i < 3; i += 1) {
    // 对照组：旧接线——只 apply，从不衰减
    await ageStateBy3h(controlStore);
    controlFinal = (await new PersonaStateMachine(controlStore).apply(turn(i), GOALS)).valenceMean;

    // 实验组：decayForIdleGap + apply（perceiveEvent 现在的行为）
    await ageStateBy3h(wiredStore);
    const wired = new PersonaStateMachine(wiredStore);
    await decayForIdleGap(wired);
    wiredFinal = (await wired.apply(turn(i), GOALS)).valenceMean;
  }

  assert.ok(
    wiredFinal < controlFinal,
    `每轮之间 3 小时的衰减必须让终态低于只升不降的对照组：wired=${wiredFinal.toFixed(3)} control=${controlFinal.toFixed(3)}`,
  );
});
