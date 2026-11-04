/**
 * v0.7 情绪衰减接线测试
 *
 * 背景：decay(dtMs) 早就实现好了，但真实会话链路从不调用它（唯一调用点是评测门面），
 * 于是效价只被事件推高、永不复原——本机实测 36 分钟 −0.03 → 0.53，11 次更新 10 次上升。
 *
 * 分两层，缺一不可：
 * - **装配级（A1/A4）**：走真实 cordis 装配（apply + session/event + 真实 state.json），
 *   断言落盘的效价被衰减过；再加一条静态守卫锁住"perceiveEvent 里真的调了衰减、且在 apply 之前"。
 *   这两条是必要的：只要把它们删掉，"把 index.ts 的衰减调用注释掉" 依然能全绿
 *   —— 本项目已经出现过三次「组件级绿、装配级无覆盖」（decay 有单测但主链路不调用、
 *   traceableInferred 有单测但装配入口不校验、衰减接线自身）。
 * - 函数级（A2/A3/A5/A6/A7）：decayForIdleGap / 串行队列的判据与边界。
 *   它们只回答"函数被调用时算得对不对"，**不能**证明接线存在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { JsonStore } from '../lib/store.js';
import { PersonaStateMachine } from '../lib/state.js';
import { DECAY_MIN_INTERVAL_MS, createSerialQueue, decayForIdleGap } from '../lib/state-decay.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

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

/**
 * 直接落一份 state.json：模拟"上次更新发生在 hoursAgo 小时前"的跨进程现场。
 *
 * 48h 是刻意选的：半衰 24h → 因子 0.25，效价 0.8 → 0.2，与"完全不衰减"的 0.8 相差 0.6，
 * 而一次 apply 的抬升量只有 +0.06 量级 —— 断言因此能真正区分"接了衰减"和"没接"。
 */
async function seedStateAt(dir, { valence, hoursAgo }) {
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
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify(file, null, 2), 'utf-8');
  return state;
}

/** 同上的 store 版（函数级用例用） */
async function seedState(store, opts) {
  return seedStateAt(store.root, opts);
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function waitFor(pred, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let ok = false;
    try {
      ok = await pred();
    } catch {
      ok = false;
    }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor 超时');
}

/** 懒加载插件 apply（lib/index.js 顶层有 peer 依赖解析，放在用例里 import 更稳） */
let applyRef = null;
async function loadPluginApply() {
  if (!applyRef) {
    const mod = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href);
    applyRef = mod.apply;
  }
  return applyRef;
}

/**
 * 在真实 cordis 运行时里装配插件（llmMode=mock，全链路 mock）。
 * reviewEnabled=false：本组只验感知链路，关掉定时复盘避免噪声与时序干扰。
 */
async function assemblePlugin({ dataDir }) {
  const applyPlugin = await loadPluginApply();
  const root = new Context();
  root.provide('fs', tempFs(dataDir));
  root.provide('tools', { register: () => () => {} });
  root.provide('systemPrompt', { context: () => () => {} });
  root.provide('commands', { register: () => () => {} });
  const fiber = await root.plugin(applyPlugin, {
    dataDir,
    sampleRounds: 3,
    injectLimit: 5,
    stripDirectives: true,
    model: 'test-model',
    selfModelHistoryLimit: 10,
    reviewEnabled: false,
    reviewHour: 2,
    honestyCeiling: 0.2,
    auditRounds: [50, 200],
    llmMode: 'mock',
  });
  return { root, fiber };
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

/* ── 0. 装配级：真实 cordis 链路 + 静态守卫（删掉接线必须变红） ───── */

/**
 * 为什么必须有一条走真实装配的用例：
 * QA 的变异实验证明——把 index.ts 里的 `await decayForIdleGap(stateMachine);` 注释掉，
 * 函数级用例全绿、一条不红。因为"衰减算得对"和"衰减被调用"是两件事，
 * 而这次要修的正是后者。
 *
 * 48 小时空闲的算术：半衰 24h → 因子 0.25，0.8 → 0.2；本轮事件只抬升 ≈+0.06。
 * 接了衰减 ≈0.26，没接 ≈0.86 —— 阈值取 0.5，两边的差距不可能互相冒充。
 */
test('v0.7-A1（装配级核心）：48 小时空闲后第一轮对话，落盘效价必须已被衰减', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-wire-'));
  const dataDir = join(dir, 'persona-innate');
  await seedStateAt(dataDir, { valence: 0.8, hoursAgo: 48 });

  const { root, fiber } = await assemblePlugin({ dataDir });
  try {
    // 启动工作在挂载时触发（DSH 无 app-ready 事件）；等它完成，保证状态机已载入
    await root.personaMemory.booted;

    // 一条中性工作消息：importance 0.8、无情感标签 → apply 的抬升量很小（约 +0.06）
    root.emit(
      'session/event',
      {},
      {
        type: 'user/message',
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '今天下午三点我在开会，讨论了下季度的排期安排' }],
        },
      },
    );

    await waitFor(async () => {
      const raw = await readFile(join(dataDir, 'state.json'), 'utf-8');
      return JSON.parse(raw).history.length >= 1;
    });

    const after = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf-8'));
    const v = after.state.valenceMean;
    assert.ok(
      v < 0.5,
      `落盘效价应已被 48h 空闲衰减拉回低位（期望 ≈0.26；未接线会 ≈0.86），实际 ${v}`,
    );
    assert.ok(v > 0, `衰减不得穿过基线（效价应保持为正），实际 ${v}`);
    assert.equal(after.history.length, 1, '本轮应恰好 apply 一次');
  } finally {
    await fiber.dispose();
  }
});

/**
 * 静态守卫：装配级用例依赖"能跑起来 + 有事件"，成本高且易受环境干扰；
 * 这一条用源码层面的最小证据把接线钉住（读 src/index.ts，先剥注释行——
 * 朴素文本搜索会被注释掉的调用骗过，QA 第一版就栽在这里）。
 */
test('v0.7-A4（静态守卫）：perceiveEvent 内衰减调用必须存在且先于 apply；门禁先于游标协议', async () => {
  const src = await readFile(join(REPO, 'src', 'index.ts'), 'utf-8');
  // 剥掉注释行（整行 // / 块注释 / JSDoc 续行），避免"注释里的调用"冒充真实接线
  const code = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
    })
    .join('\n');

  const peStart = code.indexOf('const perceiveEvent = async');
  assert.ok(peStart > 0, '应能找到 perceiveEvent 定义');
  const peEnd = code.indexOf('const stateFacade', peStart);
  assert.ok(peEnd > peStart, '应能找到 perceiveEvent 的结束边界（stateFacade 之前）');
  const peBody = code.slice(peStart, peEnd);

  const decayAt = peBody.indexOf('await decayForIdleGap(stateMachine)');
  const applyAt = peBody.indexOf('await stateMachine.apply(event, goals)');
  assert.ok(decayAt > 0, 'perceiveEvent 函数体内必须真的调用衰减（只 import 不算接线）');
  assert.ok(applyAt > decayAt, '衰减必须在 apply 之前（否则等于用空闲时长打折刚发生的事）');

  // 复盘门禁必须早于游标协议：否则被门禁拦下的那天会被游标跳过，永远不再复盘
  const gateAt = code.indexOf("if (llmNow.synthetic && config.llmMode !== 'mock')");
  const protocolAt = code.indexOf('await runReviewWithCursor(');
  assert.ok(gateAt > 0, '应能找到复盘门禁');
  assert.ok(protocolAt > gateAt, '门禁 return 必须发生在进入游标协议之前');

  // 行号证据（汇报里要贴）
  const lineOf = (needle) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;
  assert.ok(lineOf('await decayForIdleGap(stateMachine)') > 0);
  assert.ok(lineOf('await stateMachine.apply(event, goals)') > lineOf('await decayForIdleGap(stateMachine)'));
});

/* ── 1. 函数级：时间跳跃后效价必须回落 ───────────────────────── */

test('v0.7-A1b（函数级）: 空闲 2 小时后 decayForIdleGap 让效价回落（旧接线下只升不降）', async () => {
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

/* ── 2. 函数级：接不接衰减产生可观测差异（对照组不回落） ─────────── */

test('v0.7-A2（函数级，不能替代 A1）: 两轮会话里先衰减再应用，终态低于只应用不衰减', async () => {
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

test('v0.7-A4b: 时间戳异常 / 快照读失败 → 不衰减且不抛（衰减是修正项，不能打断主链路）', async () => {
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
