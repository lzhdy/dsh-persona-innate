/**
 * 独立验证（QA）：v0.7 三块修复是否"真的接上了"
 *
 * 本文件不复述工程师的用例，目标是回答三个装配级问题：
 *  A. 情绪衰减是否真的发生在会话主链路里（而不是只有 decayForIdleGap 的单测）；
 *  B. 复盘窗口改游标后，本地凌晨事件是否真的不再被漏掉（并给出旧实现的对照证据）；
 *  C. v0.6 事实层门禁在真实写盘路径上是否生效。
 *
 * 手法差异：
 *  - A 走真实 cordis 装配（apply + session/event + 真实 state.json），观察落盘结果，
 *    而不是直接调用 decayForIdleGap；
 *  - B 在子进程里用 TZ=Asia/Shanghai 复现本地时间语义，并同时算旧实现的结果做对照；
 *  - C 断言的是"磁盘文件里没有那个字符串"，而不是内存结构。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { JsonStore } from '../lib/store.js';
import { PersonaStateMachine } from '../lib/state.js';
import { decayForIdleGap, DECAY_MIN_INTERVAL_MS } from '../lib/state-decay.js';
import { ReviewCursorStore, runReviewWithCursor, selectReviewWindow } from '../lib/review-cursor.js';
import { PersonaMemory } from '../lib/memory.js';
import { MockLlm } from '../lib/llm-client.js';
import { DailyReviewEngine } from '../lib/review.js';
import { MemoryFactStore, threadId, attributeId } from '../lib/memory-facts.js';
import { stripCheck, stripMemoryFact } from '../lib/directive-strip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LIB_URL = pathToFileURL(join(REPO, 'lib')).href;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/* ═══════════════════ 通用夹具 ═══════════════════ */

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

/** 指定后缀的读操作抛错（模拟 EACCES），写通道保持可用 */
function fsWithBrokenRead(root, brokenSuffix) {
  const base = tempFs(root);
  return {
    ...base,
    async readText(path) {
      if (String(path).endsWith(brokenSuffix)) throw new Error('EACCES: simulated read failure');
      return base.readText(path);
    },
  };
}

async function freshStore(prefix = 'persona-qa-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return new JsonStore(tempFs(dir), dir);
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

function ev(id, timeIso, over = {}) {
  return {
    id,
    time: timeIso,
    topic: '用户-分享',
    summary: `事件 ${id}`,
    emotionTags: [],
    importance: 0.6,
    provenance: 'user_direct',
    lastRetrieved: null,
    ...over,
  };
}

/* ═══════════════════ A. 情绪衰减接线 ═══════════════════ */

/**
 * 直接落一份"48 小时前被推到 0.8"的 state.json。
 * 48h 是刻意选的：半衰 24h → 衰减因子 0.25，效价 0.8 → 0.2，
 * 与"完全不衰减"的 0.8 相差 0.6，任何一次 apply 的抬升量（实测量级 +0.06）
 * 都盖不过这个差值——所以下面的断言能真正区分"接了衰减"和"没接"。
 */
async function seedStaleState(root, { valence, hoursAgo }) {
  const updatedAt = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  const file = {
    version: 1,
    state: {
      valenceMean: valence,
      arousalMean: 0.5,
      valenceRange: 0.15,
      arousalRange: 0.15,
      contextOffset: 0,
      updatedAt,
    },
    mode: 'open',
    relationshipStage: 'acquaintance',
    reinforcement: [],
    history: [],
    updatedAt,
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'state.json'), JSON.stringify(file, null, 2), 'utf-8');
  return file;
}

/** 在真实 cordis 运行时里装配插件（llmMode=mock，全链路 mock） */
async function assemblePlugin({ dataDir }) {
  const root = new Context();
  root.provide('fs', tempFs(dataDir));
  root.provide('tools', { register: () => () => {} });
  root.provide('systemPrompt', { context: () => () => {} });
  root.provide('commands', { register: () => () => {} });
  const fiber = await root.plugin(applyPluginRef, {
    dataDir,
    sampleRounds: 3,
    injectLimit: 5,
    stripDirectives: true,
    model: 'test-model',
    selfModelHistoryLimit: 10,
    reviewEnabled: false, // 本组只验感知链路，关掉定时复盘避免噪声
    reviewHour: 2,
    honestyCeiling: 0.2,
    auditRounds: [50, 200],
    llmMode: 'mock',
  });
  return { root, fiber };
}

// 动态 import 放在顶层 await 里，避免与上面的常量顺序纠缠
const { apply: applyPluginRef } = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href);

test('QA-A1（装配级，核心）：48 小时空闲后第一轮对话，落盘效价必须已被衰减过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-qa-wire-'));
  const dataDir = join(dir, 'persona-innate');
  // 前置：上次更新在 48 小时前，效价被推到 0.8
  await seedStaleState(dataDir, { valence: 0.8, hoursAgo: 48 });

  const { root, fiber } = await assemblePlugin({ dataDir });
  try {
    // 启动工作在挂载时触发（DSH 无 app-ready 事件）；等它完成，保证状态机已从
    // 48h 前的 state.json 载入。不再靠 emit('app/ready') + 轮询文件存在来猜时序。
    await root.personaMemory.booted;

    // 一条中性工作消息：importance 0.8、无情感标签 → apply 的抬升量很小（约 +0.06）
    root.emit('session/event', {}, {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '今天下午三点我在开会，讨论了下季度的排期安排' }],
      },
    });

    await waitFor(async () => {
      const raw = await readFile(join(dataDir, 'state.json'), 'utf-8');
      return JSON.parse(raw).history.length >= 1;
    });

    const after = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf-8'));
    const v = after.state.valenceMean;

    // 接了衰减：0.8 × 0.5^2 = 0.2，再被本轮事件抬到 ≈ 0.26
    // 没接衰减：0.8 + 0.06 ≈ 0.86
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

test('QA-A2（跨进程语义）：2 小时前落盘的 state.json，新实例衰减后回落且不穿过基线', async () => {
  const store = await freshStore();
  await seedStaleState(store.root, { valence: 0.7, hoursAgo: 2 });

  // 新进程：内存状态全丢，只能从 state.json 的 updatedAt 推时间
  const sm = new PersonaStateMachine(store);
  const before = await sm.snapshot();
  assert.equal(before.state.valenceMean, 0.7, '前置：载入的是 2 小时前被推高的效价');

  const r = await decayForIdleGap(sm);
  assert.equal(r.decayed, true);
  assert.ok(Math.abs(r.dtMs - 2 * HOUR) < 60_000, `dtMs 应≈2h，实际 ${r.dtMs}`);

  const after = await sm.snapshot();
  // 半衰 24h、2h → 0.7 × 0.5^(2/24) ≈ 0.661
  assert.ok(after.state.valenceMean < before.state.valenceMean, `必须回落：${before.state.valenceMean} → ${after.state.valenceMean}`);
  assert.ok(after.state.valenceMean > 0, `不得穿过基线变负：${after.state.valenceMean}`);
  assert.ok(Math.abs(after.state.valenceMean - 0.661) < 0.02, `回落幅度应符合半衰公式，实际 ${after.state.valenceMean}`);

  // "那段空闲被消费掉"：紧接着再调用一次（新进程也是这样）不应再衰减同一段 dt
  const again = await decayForIdleGap(sm);
  assert.equal(again.decayed, false);
  assert.equal(again.reason, 'below-min-interval', '时间基准必须已刷新为刚才那次 decay 的 updatedAt');

  // 负效价同样只向 0 收敛，不会翻正
  const negStore = await freshStore();
  await seedStaleState(negStore.root, { valence: -0.6, hoursAgo: 2 });
  const neg = new PersonaStateMachine(negStore);
  await decayForIdleGap(neg);
  const negAfter = (await neg.snapshot()).state.valenceMean;
  assert.ok(negAfter > -0.6 && negAfter < 0, `负效价应向 0 回落且保持为负，实际 ${negAfter}`);

  // 唤醒度基线是 0.3：0.5 只能降到 0.3 以上，不会穿过
  const aroStore = await freshStore();
  await seedStaleState(aroStore.root, { valence: 0.1, hoursAgo: 2 });
  const aro = new PersonaStateMachine(aroStore);
  await decayForIdleGap(aro);
  const aroAfter = (await aro.snapshot()).state.arousalMean;
  assert.ok(aroAfter > 0.3 && aroAfter < 0.5, `唤醒度应向 0.3 收敛但不穿过，实际 ${aroAfter}`);
});

test('QA-A3：dt < 60s 时不衰减，state.json 的内容与 mtime 都不变', async () => {
  const store = await freshStore();
  await seedStaleState(store.root, { valence: 0.7, hoursAgo: 0 });
  const sm = new PersonaStateMachine(store);

  const path = join(store.root, 'state.json');
  const beforeRaw = await readFile(path, 'utf-8');
  const beforeStat = await stat(path);

  const r = await decayForIdleGap(sm);
  assert.equal(r.decayed, false);
  assert.equal(r.reason, 'below-min-interval');

  const afterRaw = await readFile(path, 'utf-8');
  const afterStat = await stat(path);
  assert.equal(afterRaw, beforeRaw, '内容不得改写');
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'mtime 不得变化（连空写都不允许）');
  assert.equal(DECAY_MIN_INTERVAL_MS, 60_000);
});

test('QA-A4（静态接线守卫）：perceiveEvent 里衰减调用必须先于 apply，且门禁先于游标协议', async () => {
  const src = await readFile(join(REPO, 'src', 'index.ts'), 'utf-8');
  // 只保留非注释行：注释掉的调用骗得过朴素文本搜索（本次变异实验就是这么被绕过的）
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
  const peBody = code.slice(peStart, peEnd);

  const decayAt = peBody.indexOf('await decayForIdleGap(stateMachine)');
  const applyAt = peBody.indexOf('await stateMachine.apply(event, goals)');
  assert.ok(decayAt > 0, 'perceiveEvent 函数体内必须真的调用衰减（只 import 不算接线）');
  assert.ok(applyAt > decayAt, '衰减必须在 apply 之前（否则等于用空闲时长打折刚发生的事）');

  // 门禁：LLM 降级 mock 的 return 必须在 runReviewWithCursor 之前
  const gateAt = code.indexOf("if (llmNow.synthetic && config.llmMode !== 'mock')");
  const protocolAt = code.indexOf('await runReviewWithCursor(');
  assert.ok(gateAt > 0, '应能找到复盘门禁');
  assert.ok(protocolAt > gateAt, '门禁 return 必须发生在进入游标协议之前，否则被拦下的那天会被游标跳过');

  // 行号证据（报告里要贴）
  const lineOf = (needle) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;
  assert.ok(lineOf('await decayForIdleGap(stateMachine)') > 0);
  assert.ok(lineOf('await stateMachine.apply(event, goals)') > lineOf('await decayForIdleGap(stateMachine)'));
  assert.ok(lineOf('await runReviewWithCursor(') > lineOf("config.llmMode !== 'mock'"));
});

/* ═══════════════════ B. 复盘游标窗口 ═══════════════════ */

/**
 * 子进程脚本：在 TZ=Asia/Shanghai 下复现"本地凌晨 03:00 的事件 + 昨天 02:00 的游标"，
 * 同时用旧实现（UTC 日期切片）跑同一组数据做对照。
 */
const TZ_PROBE = `
import { mkdtemp, mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { selectReviewWindow, runReviewWithCursor, ReviewCursorStore } = await import('${LIB_URL}/review-cursor.js');
const { JsonStore } = await import('${LIB_URL}/store.js');

const out = { tzOffsetMin: new Date(0).getTimezoneOffset() };
const pad = (n) => String(n).padStart(2, '0');

// 全部用本地时间构造：断言与运行环境时区无关
const now = new Date(2026, 10, 4, 2, 0, 0);        // 本地 11-04 02:00 的那次复盘
const cursor = new Date(2026, 10, 3, 2, 0, 0);     // 本地 11-03 02:00 的上次复盘
const lateNight = new Date(2026, 10, 3, 3, 0, 0);  // 本地 11-03 03:00 的深夜事件

const ev = (id, d) => ({
  id, time: d.toISOString(), topic: '用户-分享', summary: '深夜聊了几句',
  emotionTags: [], importance: 0.7, provenance: 'user_direct', lastRetrieved: null,
});

out.nowIso = now.toISOString();
out.cursorIso = cursor.toISOString();
out.eventIso = lateNight.toISOString();

// 新逻辑：游标开区间
out.newWindowIds = selectReviewWindow([ev('e_late', lateNight)], cursor.toISOString(), now).map((e) => e.id);

// 旧逻辑：UTC 日期切片等值
const utcDay = (d) => d.toISOString().slice(0, 10);
out.oldMatch = utcDay(lateNight) === utcDay(now);
out.oldEventSlice = utcDay(lateNight);
out.oldNowSlice = utcDay(now);

// 旧逻辑到底漏掉本地哪几个小时：
// 事件发生在本地 11-03 的 h:00；旧实现只在"复盘时刻的 UTC 日期 === 事件的 UTC 日期"时看到它，
// 而复盘每天只跑一次（本地 02:00），所以只能落在事件之后的那几次 02:00 里比对。
const missedHours = [];
const seenHours = [];
for (let h = 0; h < 24; h += 1) {
  const at = new Date(2026, 10, 3, h, 0, 0);
  let seen = false;
  for (let k = 3; k <= 5 && !seen; k += 1) {
    const reviewAt = new Date(2026, 10, k, 2, 0, 0); // 本地第 k 天 02:00 的复盘
    if (!(reviewAt > at)) continue; // 复盘必须在事件之后才可能看到它
    if (utcDay(reviewAt) === utcDay(at)) seen = true;
  }
  (seen ? seenHours : missedHours).push(h);
}
out.oldMissedLocalHours = missedHours;
out.oldSeenLocalHours = seenHours;

// 真实协议：走 runReviewWithCursor（游标文件真的落盘）
const dir = await mkdtemp(join(tmpdir(), 'persona-qa-tz-'));
const fsAdapter = {
  async mkdir(p) { await mkdir(p, { recursive: true }); },
  async readText(p) { return readFile(p, 'utf-8'); },
  async writeText(p, c) { await mkdir(dir, { recursive: true }); await writeFile(p, c, 'utf-8'); },
  async exists(p) { try { await stat(p); return true; } catch { return false; } },
};
const store = new JsonStore(fsAdapter, dir);
const cursorStore = new ReviewCursorStore(store);
await cursorStore.save({ version: 1, lastReviewAt: cursor.toISOString() });
let sawIds = [];
const outcome = await runReviewWithCursor({
  store, cursorStore, now,
  allEvents: [ev('e_late', lateNight)],
  review: async ({ events }) => {
    sawIds = events.map((e) => e.id);
    return { runId: 'r', date: '2026-11-04', mode: 'full', facts: [], eventTags: [], selfModel: null,
      stateReestimate: null, stage: null, stageTrajectory: '', archiveEntry: null, selfImportance: [],
      memoryFacts: { ran: true, persisted: false, threadsCreated: 0, threadsUpdated: 0, attributesCreated: 0,
        attributesUpdated: 0, attributesSuperseded: 0, dropped: 0,
        dropReasons: { 'no-source': 0, 'unknown-source': 0, strip: 0, invalid: 0 }, expired: 0 },
      cost: { llmCalls: 1, memoryFactCalls: 1 } };
  },
});
out.outcomeKind = outcome.kind;
out.protocolSawIds = sawIds;
out.cursorAfter = JSON.parse(await readFile(join(dir, 'review-state.json'), 'utf-8')).lastReviewAt;
console.log(JSON.stringify(out));
`;

function runTzProbe() {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', TZ_PROBE], {
    env: { ...process.env, TZ: 'Asia/Shanghai' },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  assert.equal(res.status, 0, `子进程失败：${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

test('QA-B1：TZ=Asia/Shanghai 下，本地凌晨 03:00 的事件进入窗口，旧逻辑确实看不到', () => {
  const r = runTzProbe();

  // 环境自检：TZ 必须真的生效，否则后面"凌晨"就没有意义
  assert.equal(r.tzOffsetMin, -480, `子进程时区应为 UTC+8（offset -480），实际 ${r.tzOffsetMin}`);

  // 新逻辑：游标开区间 [昨天 02:00, 今天 02:00)
  assert.deepEqual(r.newWindowIds, ['e_late'], '凌晨 03:00 的事件必须落在新窗口里');

  // 真实协议路径同样拿到它
  assert.equal(r.outcomeKind, 'done');
  assert.deepEqual(r.protocolSawIds, ['e_late'], 'runReviewWithCursor 必须把这条事件交给复盘');
  assert.equal(r.cursorAfter, r.nowIso, '成功后游标推进到本次开始时刻');

  // 旧逻辑对照：UTC 切片不等，所以旧实现永远看不到它
  assert.equal(r.oldMatch, false, `旧实现应漏掉它：事件 slice=${r.oldEventSlice} 今天 slice=${r.oldNowSlice}`);
});

test('QA-B1b：旧实现在 UTC+8 下漏掉的本地时段是固定的（给出证据区间）', () => {
  const r = runTzProbe();
  // 复盘固定在本 02:00 → 其 UTC 日期是"前一天"。
  // 事件落在本地 00:00–01:59 时，当晚 02:00 那次复盘还能看到它（UTC 日期同为前一天）；
  // 事件落在本地 02:00–07:59 时，当晚那次复盘已经跑过、次日那次 UTC 日期又变了 → 永久漏掉。
  assert.deepEqual(
    r.oldMissedLocalHours,
    [2, 3, 4, 5, 6, 7],
    `旧实现漏掉的本地小时应为 02:00–07:59，实际 ${JSON.stringify(r.oldMissedLocalHours)}`,
  );
  assert.equal(r.oldSeenLocalHours.length, 18, '其余 18 个小时的事件旧实现能看到');
});

test('QA-B2（幂等）：同一天连跑两次复盘，第二次 skipped 且游标逐字不变、不再调 LLM', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const startedAt = new Date(2026, 10, 4, 2, 0, 0);
  const e1 = ev('e_today', new Date(2026, 10, 4, 0, 30, 0).toISOString());

  let calls = 0;
  const reviewFn = async () => {
    calls += 1;
    return {
      runId: `r${calls}`,
      date: '2026-11-04',
      mode: 'full',
      facts: [],
      eventTags: [],
      selfModel: null,
      stateReestimate: null,
      stage: null,
      stageTrajectory: '',
      archiveEntry: null,
      selfImportance: [],
      memoryFacts: {
        ran: true,
        persisted: false,
        threadsCreated: 0,
        threadsUpdated: 0,
        attributesCreated: 0,
        attributesUpdated: 0,
        attributesSuperseded: 0,
        dropped: 0,
        dropReasons: { 'no-source': 0, 'unknown-source': 0, strip: 0, invalid: 0 },
        expired: 0,
      },
      cost: { llmCalls: 3, memoryFactCalls: 1 },
    };
  };

  const first = await runReviewWithCursor({ store, cursorStore, allEvents: [e1], now: startedAt, review: reviewFn });
  assert.equal(first.kind, 'done');
  const cursorPath = join(store.root, 'review-state.json');
  const bytesAfterFirst = await readFile(cursorPath, 'utf-8');

  // 同一天、10 分钟后再次触发（手动 /persona review 与定时器并发是真实场景）
  const second = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: [e1],
    now: new Date(startedAt.getTime() + 10 * 60_000),
    review: reviewFn,
  });

  assert.equal(second.kind, 'skipped', `同一天第二次必须是 skipped，实际 ${second.kind}`);
  assert.equal(calls, 1, '第二次不得再触发复盘动作（否则会写第二个 self_model 版本）');
  assert.equal(await readFile(cursorPath, 'utf-8'), bytesAfterFirst, '游标文件必须逐字不变');
});

test('QA-B3（门禁等价路径）：review 回调返回 null → failed，游标逐字不变', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const prev = new Date(Date.now() - 30 * HOUR);
  await cursorStore.save({ version: 1, lastReviewAt: prev.toISOString(), lastReviewDate: '2026-11-02' });
  const cursorPath = join(store.root, 'review-state.json');
  const before = await readFile(cursorPath, 'utf-8');

  let called = 0;
  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: [ev('e_new', new Date(Date.now() - HOUR).toISOString())],
    review: async () => {
      called += 1;
      return null; // 门禁：LLM 降级 mock 时拒绝提交
    },
  });

  assert.equal(called, 1, '窗口非空时应走到复盘动作（门禁是在协议之外拦的，不是靠空窗口）');
  assert.equal(outcome.kind, 'failed');
  assert.ok(outcome.reason.includes('游标不推进'), outcome.reason);
  assert.equal(await readFile(cursorPath, 'utf-8'), before, '被拦下的那天必须还能被下次复盘覆盖');
});

test('QA-B4（开区间边界）：与游标同一毫秒的事件会被永久排除——量化它的实际风险', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const t0 = new Date(2026, 10, 4, 2, 0, 0, 123);
  await cursorStore.save({ version: 1, lastReviewAt: t0.toISOString() });

  const onBoundary = ev('e_boundary', t0.toISOString());
  const oneMsLater = ev('e_plus1ms', new Date(t0.getTime() + 1).toISOString());

  const window = selectReviewWindow([onBoundary, oneMsLater], t0.toISOString(), new Date(t0.getTime() + HOUR));
  assert.deepEqual(
    window.map((e) => e.id),
    ['e_plus1ms'],
    '与游标同毫秒的事件被排除（t > from），1ms 之后的正常进入',
  );

  // 是否构成实际风险：游标取自 runReviewWithCursor 内部的 new Date()，
  // 事件时间取自 addEvent 内部的 new Date()。两者撞在同一毫秒才丢，
  // 且丢的是"那一刻写入的一条事件"，不会造成窗口整体错位。
  // 结论：概率 ~1ms/天量级，可忽略；若要彻底消除，把 > 改成 >= 即可（
  // 上一窗口是开区间，边界事件本来就没被复盘过，改成 >= 不产生重复覆盖）。
  assert.equal(onBoundary.time, t0.toISOString());
});

/* ═══════════════════ C. v0.6 事实层门禁 ═══════════════════ */

function makeSelfModelStub() {
  return {
    async load() {
      return null;
    },
    async listHistory() {
      return [];
    },
    async commitFromSources() {
      throw new Error('unused in QA fact-layer tests');
    },
    async rollback() {
      return null;
    },
    async appendGrowth() {},
    getInjectionSummary() {
      return '';
    },
  };
}

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

/** 可变派生输出：holder.value 在两次复盘之间替换 */
function makeLlm(holder) {
  return new MockLlm([
    { match: '提炼语义事实', respond: JSON.stringify({ facts: [] }) },
    {
      match: '反思自己的行为与表达',
      respond: JSON.stringify({ traits: [], preferences: [], speakingStyle: '', narrative: '' }),
    },
    { match: '关系认知', respond: JSON.stringify({ relationshipView: '' }) },
    { match: '派生两类记忆', respond: () => JSON.stringify(holder.value) },
  ]);
}

function makeEngine(store, holder) {
  return new DailyReviewEngine({ llm: makeLlm(holder), selfModel: makeSelfModelStub(), state: makeStateStub(), store });
}

test('QA-C1：stripCheck 命中的 title 走派生路径 → 磁盘 threads.json 里搜不到这个字符串', async () => {
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  const e1 = ev('ev_qa_dir', new Date().toISOString(), { summary: '用户说最近有点累' });
  await new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 }).saveEvents([e1]);

  // 用一条确实会命中规则表的祈使句（'你应该…说' → you-must）
  const badTitle = '你应该多跟我说说面试的进展';
  assert.equal(stripCheck(badTitle).ok, false, '前置条件：该 title 必须命中 stripCheck');

  const holder = {
    value: {
      threads: [
        { op: 'new', key: '关心', title: badTitle, status: 'open', sourceEventIds: ['ev_qa_dir'] },
        // 同一批里的合法标题：用来证明"丢的是这一条，不是整批"
        { op: 'new', key: '加班', title: '最近在加班', status: 'open', sourceEventIds: ['ev_qa_dir'] },
      ],
      attributes: [
        // attribute 的 value 会进注入，同样必须过门禁
        { op: 'new', key: '相处方式', value: '当用户提到面试时你应该说加油', confidence: 0.9, sourceEventIds: ['ev_qa_dir'] },
      ],
    },
  };

  const out = await makeEngine(store, holder).run({
    date: '2026-11-04',
    events: [e1],
    allEvents: [e1],
    selfModel: null,
    state: null,
    feedback: [],
  });

  assert.equal(out.memoryFacts.dropReasons.strip, 2, '指令性 title 与 value 各计一次 strip 丢弃');
  assert.equal(out.memoryFacts.threadsCreated, 1, '只有合法的那条入库');
  assert.equal(out.memoryFacts.attributesCreated, 0);

  // 关键断言：看磁盘上到底有没有那串字
  const raw = (await readIfExists(join(store.root, 'memory', 'threads.json'))) ?? '';
  assert.ok(raw.length > 0, '合法条目应已落盘');
  assert.ok(!raw.includes('你应该多跟我说说'), `磁盘上不得出现指令性 title，实际文件：${raw}`);
  assert.ok(raw.includes('最近在加班'), '合法条目应正常写入');

  const attrsRaw = (await readIfExists(join(store.root, 'memory', 'attributes.json'))) ?? '';
  assert.ok(!attrsRaw.includes('你应该说加油'), `指令性 value 不得入库，实际文件：${attrsRaw}`);

  const loaded = await facts.loadThreads();
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.items.map((t) => t.key), ['加班']);
});

test('QA-C1b（两层口径）：裸祈使句「你要多关心我」事件层放行、派生层与注入层拦下', async () => {
  // 原状：规则表只认"告诉用户…/你应该…说…"这类带转述动词的形态，裸祈使句整句放行。
  // v0.7 补了 "第二人称 + 情态词 + 针对『我』的关怀诉求" 一类规则（demand-care-for-me /
  // remember-to-nag-me / bare-care-demand），但**只进严口径**（stripMemoryFact）。
  //
  // 为什么要分两层：这三条规则拦的是"能改写模型行为"的句子。events 层只负责归档，
  // 原话不进 prompt；一旦在写入处就拦掉，"用户提过希望被更多关心"这条真实需求就永远
  // 从记忆里消失了（复盘也看不到它）。所以分工是——
  //   写入（addEvent，宽 stripCheck）：放行，原话留档可复盘；
  //   注入二次校验 / thread·attribute·dueHint 派生（严 stripMemoryFact）：拦下，绝不进 prompt。
  // 本用例分别对两条路径断言，任何一侧退化成"一刀切"都会红。
  const store = await freshStore();
  const bare = '你要多关心我';
  const demandValue = '多陪陪我';

  // ── 路径一：事件层（宽口径）必须放行 ─────────────────────────
  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });
  assert.equal(stripCheck(bare).ok, true, '宽口径必须放行原话（否则需求在写入处就被抹掉了）');
  const added = await mem.addEvent({ topic: '用户-需求', summary: bare, provenance: 'user_direct', importance: 0.8 });
  assert.equal(added.rejected, false, '事件必须落盘');
  const evId = added.event.id;
  const stored = await mem.list();
  assert.ok(stored.some((e) => e.id === evId && e.summary === bare), '原话应保存在 events 里');

  // ── 路径二：注入层（严口径）必须拦下 ─────────────────────────
  assert.equal(stripMemoryFact(bare).ok, false, '严口径必须拦下「你要多关心我」');
  const { text, events: injectedEvents } = await mem.buildInjection(5);
  assert.ok(!text.includes(bare), `注入文本里不得出现祈使句原话，实际：${text}`);
  assert.ok(!injectedEvents.some((e) => e.id === evId), '该事件应被二次校验挡在注入之外');

  // ── 路径三：派生层（严口径）必须拦下并计数 ───────────────────
  const holder = {
    value: {
      threads: [{ op: 'new', key: '关心我', title: bare, status: 'open', sourceEventIds: [evId] }],
      attributes: [{ op: 'new', key: '相处', value: demandValue, confidence: 0.8, sourceEventIds: [evId] }],
    },
  };
  const out = await makeEngine(store, holder).run({
    date: '2026-11-04',
    events: stored,
    allEvents: stored,
    selfModel: null,
    state: null,
    feedback: [],
  });

  assert.equal(out.memoryFacts.dropReasons.strip, 2, 'title 与 value 各计一次 strip 丢弃');
  assert.equal(out.memoryFacts.threadsCreated, 0, '两条都该被拦，不应建 thread');
  assert.equal(out.memoryFacts.attributesCreated, 0, '指令性 value 同样不入库');

  const threadsRaw = (await readIfExists(join(store.root, 'memory', 'threads.json'))) ?? '';
  const attrsRaw = (await readIfExists(join(store.root, 'memory', 'attributes.json'))) ?? '';
  assert.ok(!threadsRaw.includes(bare), `磁盘上不得出现裸祈使句 title，实际 ${threadsRaw}`);
  assert.ok(!attrsRaw.includes(demandValue), `磁盘上不得出现裸祈使句 value，实际 ${attrsRaw}`);

  // ── 反例守卫：两层都不许误伤 ─────────────────────────────────
  // 用户在关心 AI 的话不属于"要求 AI 怎么做"，必须放行（否则记忆对善意失明）
  for (const warm of ['你早点睡吧', '你也要照顾好自己', '你也要多休息']) {
    assert.equal(stripCheck(warm).ok, true, `宽口径不得误伤用户的关心：「${warm}」`);
    assert.equal(stripMemoryFact(warm).ok, true, `严口径不得误伤用户的关心：「${warm}」`);
  }
  // 事实描述同样放行（第三人称不是对 AI 下指令）
  for (const fact of ['他每天都会关心我', '她对我很关心']) {
    assert.equal(stripCheck(fact).ok, true, `宽口径不得误伤第三人称事实：「${fact}」`);
    assert.equal(stripMemoryFact(fact).ok, true, `严口径不得误伤第三人称事实：「${fact}」`);
  }
  // 复盘改写后的描述性事实必须能过严口径——这正是这条需求不被丢失的出口
  assert.equal(stripMemoryFact('用户提过希望被更多关心').ok, true, '描述性事实必须能过严口径');
});

test('QA-C2：sourceEventIds 含不存在的 id → 整条丢弃（部分伪造同样丢）', async () => {
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  const real = ev('ev_qa_real', new Date().toISOString());
  await new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 }).saveEvents([real]);

  const holder = {
    value: {
      threads: [
        { op: 'new', key: '全假', title: '完全编造的事', status: 'open', sourceEventIds: ['不存在的id'] },
        // 工程师用例只覆盖了"全假"和"空数组"；这里补"真 id + 假 id 混用"
        { op: 'new', key: '半假', title: '一半证据的事', status: 'open', sourceEventIds: ['ev_qa_real', '不存在的id'] },
        { op: 'new', key: '全真', title: '有证据的事', status: 'open', sourceEventIds: ['ev_qa_real'] },
      ],
      attributes: [
        { op: 'new', key: '作息', value: '凌晨两点才睡', confidence: 0.7, sourceEventIds: ['不存在的id'] },
      ],
    },
  };

  const out = await makeEngine(store, holder).run({
    date: '2026-11-04',
    events: [real],
    allEvents: [real],
    selfModel: null,
    state: null,
    feedback: [],
  });

  assert.equal(out.memoryFacts.dropReasons['unknown-source'], 3, `两条 thread + 一条 attribute 都应丢弃，实际 ${JSON.stringify(out.memoryFacts.dropReasons)}`);
  assert.equal(out.memoryFacts.threadsCreated, 1);
  assert.equal(out.memoryFacts.attributesCreated, 0);

  const raw = (await readIfExists(join(store.root, 'memory', 'threads.json'))) ?? '';
  assert.ok(!raw.includes('完全编造的事'), '全假 id 的条目不得入库');
  assert.ok(!raw.includes('一半证据的事'), '部分伪造的条目也必须整条丢弃（不能"降级保留"）');
  assert.ok(raw.includes('有证据的事'));

  const attrsRaw = (await readIfExists(join(store.root, 'memory', 'attributes.json'))) ?? '';
  assert.ok(!attrsRaw.includes('凌晨两点才睡'), 'attribute 同样受 sourceEventIds 门禁约束');

  const loaded = await facts.loadThreads();
  assert.ok(loaded.ok);
  assert.equal(loaded.items.length, 1);
});

test('QA-C3：同 key 不同 value 的 attribute → 旧条 superseded 且指向新条，新条 active', async () => {
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });
  const eOld = ev('ev_qa_city_a', new Date(Date.now() - 2 * DAY).toISOString());
  const eNew = ev('ev_qa_city_b', new Date().toISOString());
  await mem.saveEvents([eOld]);

  const holder = {
    value: {
      threads: [],
      attributes: [{ op: 'new', key: '居住城市', value: '杭州', confidence: 0.8, sourceEventIds: ['ev_qa_city_a'] }],
    },
  };
  const engine = makeEngine(store, holder);
  await engine.run({ date: '2026-11-02', events: [eOld], allEvents: [eOld], selfModel: null, state: null, feedback: [] });

  await mem.saveEvents([eOld, eNew]);
  holder.value = {
    threads: [],
    attributes: [{ op: 'supersede', key: '居住城市', value: '上海', confidence: 0.75, sourceEventIds: ['ev_qa_city_b'] }],
  };
  const second = await engine.run({
    date: '2026-11-04',
    events: [eNew],
    allEvents: [eOld, eNew],
    selfModel: null,
    state: null,
    feedback: [],
  });

  assert.equal(second.memoryFacts.attributesSuperseded, 1);
  assert.equal(second.memoryFacts.attributesCreated, 1);

  const loaded = await facts.loadAttributes();
  assert.ok(loaded.ok);
  assert.equal(loaded.items.length, 2, '同 key 不同 value 必须是两条（否则取代链指不到新条目）');
  const oldOne = loaded.items.find((a) => a.value === '杭州');
  const newOne = loaded.items.find((a) => a.value === '上海');
  assert.ok(oldOne && newOne);
  assert.equal(oldOne.status, 'superseded');
  assert.equal(oldOne.supersededBy, newOne.id, 'supersededBy 必须指向新条 id');
  assert.ok(oldOne.supersededAt, '取代时间要留痕');
  assert.equal(newOne.status, 'active');
  assert.equal(newOne.id, attributeId('居住城市', '上海'));

  // 磁盘上同时存在两条，且旧的带 superseded 标记（人格不会记错单位/城市）
  const raw = await readFile(join(store.root, 'memory', 'attributes.json'), 'utf-8');
  assert.ok(raw.includes('"superseded"') && raw.includes('"active"'));
});

test('QA-C4：open thread 经 buildInjection 进入 open 槽（读的是派生层，不靠调用方传入）', async () => {
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  const interview = ev('ev_qa_itv', new Date(Date.now() - 5 * DAY).toISOString(), {
    summary: '用户说下周三有个重要的面试',
  });
  const plain = ev('ev_qa_plain', new Date(Date.now() - 6 * DAY).toISOString(), { summary: '用户说天气变冷了' });
  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });
  await mem.saveEvents([interview, plain]);

  const nowIso = new Date().toISOString();
  await facts.saveThreads([
    {
      id: threadId('面试'),
      key: '面试',
      title: '下周三的面试',
      status: 'open',
      openedAt: new Date(Date.now() - 5 * DAY).toISOString(),
      lastMentionedAt: new Date(Date.now() - 5 * DAY).toISOString(),
      mentionCount: 1,
      sourceEventIds: ['ev_qa_itv'],
    },
  ]);

  const { slots, events: injected } = await mem.buildInjection(5);
  const hit = slots.find((s) => s.id === 'ev_qa_itv');
  assert.ok(hit, `面试证据应被召回，实际注入 ${injected.map((e) => e.id).join(',')}`);
  assert.equal(hit.slot, 'open', '应经由未结槽进入（slot 名必须是 open）');
  assert.ok(slots.some((s) => s.slot === 'open'));
  // 线程本身的状态没有被注入文本化（只借它选事件）——记录当前行为，供装配侧核对
  const rendered = await mem.buildInjection(5);
  assert.ok(!rendered.text.includes('下周三的面试'), '当前注入文本只渲染事件，不渲染 thread 标题');
});

test('QA-C5：threads.json 读失败 → 不写盘，既有文件逐字保留', async () => {
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  const kept = [
    {
      id: threadId('体检'),
      key: '体检',
      title: '下个月的体检',
      status: 'open',
      openedAt: new Date().toISOString(),
      lastMentionedAt: new Date().toISOString(),
      mentionCount: 1,
      sourceEventIds: ['ev_qa_keep'],
    },
  ];
  await facts.saveThreads(kept);
  const path = join(store.root, 'memory', 'threads.json');
  const before = await readFile(path, 'utf-8');
  const beforeStat = await stat(path);

  const broken = new JsonStore(fsWithBrokenRead(store.root, 'memory/threads.json'), store.root);
  const e1 = ev('ev_qa_keep', new Date().toISOString());
  const holder = {
    value: {
      threads: [{ op: 'new', key: '新事', title: '这次的新事', status: 'open', sourceEventIds: ['ev_qa_keep'] }],
      attributes: [],
    },
  };
  const engine = new DailyReviewEngine({
    llm: makeLlm(holder),
    selfModel: makeSelfModelStub(),
    state: makeStateStub(),
    store: broken,
  });

  const stats = await engine.extractThreadsAndAttributes([e1], { allEvents: [e1] });
  assert.equal(stats.ran, false, '读失败不得发起派生');
  assert.equal(stats.persisted, false, '读失败不得写盘');
  assert.ok(stats.error && stats.error.includes('不可读'), `错误必须明确，实际 ${stats.error}`);

  const after = await readFile(path, 'utf-8');
  const afterStat = await stat(path);
  assert.equal(after, before, '读失败绝不能把既有 threads 覆盖成空');
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '连写一次都不该发生');
  assert.deepEqual(JSON.parse(after).threads.map((t) => t.key), ['体检']);
});

test('QA-C6（缺口已修）：thread 的 dueHint 同样过严口径——指令性提示被剥掉，thread 保留', async () => {
  // 原状：门禁只校验 title/value，dueHint 是 LLM 完全可控的字符串，会被原样存下，
  // 并在 /persona threads 里渲染出来 —— 等于给"给模型写行为脚本"留了一个旁路。
  // v0.7 补上：不过门禁就丢这个字段（hint 只是可选装饰，事实本身没问题，不必连坐整条）。
  // 门禁用的是严口径 stripMemoryFact（与 title/value 一致），不是写入侧的宽口径。
  const store = await freshStore();
  const e1 = ev('ev_qa_due', new Date().toISOString());
  await new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 }).saveEvents([e1]);
  const directiveHint = '你应该提醒用户去做检查';
  assert.equal(stripMemoryFact(directiveHint).ok, false, '前置：这条 dueHint 本身会命中严口径');

  const holder = {
    value: {
      threads: [
        { op: 'new', key: '体检', title: '下个月的体检', status: 'open', sourceEventIds: ['ev_qa_due'], dueHint: directiveHint },
        // 合法的 hint 必须原样保留：门禁不能把正常时间提示一起削掉
        { op: 'new', key: '复诊', title: '下周复诊', status: 'open', sourceEventIds: ['ev_qa_due'], dueHint: '下周三' },
      ],
      attributes: [],
    },
  };
  const out = await makeEngine(store, holder).run({
    date: '2026-11-04',
    events: [e1],
    allEvents: [e1],
    selfModel: null,
    state: null,
    feedback: [],
  });
  assert.equal(out.memoryFacts.dropReasons.strip, 0, 'dueHint 坏掉不该把整条算成 strip 丢弃');
  assert.equal(out.memoryFacts.fieldsStripped, 1, '被剥掉的是"字段"，单独计数');
  assert.equal(out.memoryFacts.threadsCreated, 2, '两条 thread 都应保留（hint 坏不影响条目）');

  const raw = (await readIfExists(join(store.root, 'memory', 'threads.json'))) ?? '';
  assert.ok(!raw.includes(directiveHint), `指令性 dueHint 不得落盘，实际 ${raw}`);
  assert.ok(raw.includes('下周三'), '合法 dueHint 应保留');

  const loaded = await new MemoryFactStore(store).loadThreads();
  assert.ok(loaded.ok);
  const tcm = loaded.items.find((t) => t.key === '体检');
  assert.ok(tcm && tcm.dueHint === undefined, '被剥掉的 hint 不应留下空字段');

  // 它确实会被渲染给用户/会话（index.ts 的 /persona threads 分支）
  const src = await readFile(join(REPO, 'src', 'index.ts'), 'utf-8');
  assert.ok(src.includes('`，提示 ${x.dueHint}`'), 'dueHint 会进入 /persona threads 的输出文本');
});

/* ═══════════════════ 附：装配缺口观察 ═══════════════════ */
test('QA-OBS（装配缺口观察）：attributes 目前只在 /persona threads 命令里出现，无注入消费者', async () => {
  const src = await readFile(join(REPO, 'src', 'index.ts'), 'utf-8');
  const usages = src.split('\n').filter((l) => l.includes('loadAttributes('));
  assert.equal(usages.length, 1, `loadAttributes 只应在 /persona threads 命令里被调用一次，实际 ${usages.length} 处`);
  assert.ok(usages[0].includes('const a = await factStore.loadAttributes()'), usages[0]);

  // 注入侧只有 open thread 的"事件 id"参与装配（openThreadsSource），没有任何 attribute 文本
  assert.ok(src.includes('openThreadsSource: factStore'), '未结槽接线存在');
  assert.ok(!/injected\w*Text\s*=.*attribute/i.test(src), '注入缓存里不应有 attribute 文本');

  // 行为侧：落一条 active attribute，注入文本里不会出现它
  const store = await freshStore();
  const facts = new MemoryFactStore(store);
  await facts.saveAttributes([
    {
      id: attributeId('工作单位', '上海某游戏公司'),
      key: '工作单位',
      value: '上海某游戏公司',
      status: 'active',
      confidence: 0.9,
      sourceEventIds: ['ev_qa_x'],
      firstSeenAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
  const mem = new PersonaMemory(store, { stripDirectives: true, injectLimit: 5 });
  await mem.saveEvents([ev('ev_qa_x', new Date().toISOString(), { summary: '用户说换了工作' })]);
  const { text } = await mem.buildInjection(5);
  assert.ok(!text.includes('上海某游戏公司'), `attributes 目前不进注入，实际文本：${text}`);
});
