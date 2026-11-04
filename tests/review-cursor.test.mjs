/**
 * v0.7 复盘游标测试
 *
 * 覆盖旧实现的三个故障：
 * 1. UTC 日期切片 → 本地 00:00–08:00 的事件永远不被任何一次复盘看到（深夜陪伴高峰）
 * 2. 没有游标 → 02:00 进程不在就永久丢一天
 * 3. 没有幂等 → 手动与定时可对同一天重复提交，产生两个 self_model 版本
 *
 * 这里测的是"窗口怎么算 + 什么时候推进游标"这条协议（runReviewWithCursor），
 * 也就是 index.ts 的 runDailyReview 唯一走的那条路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../lib/store.js';
import {
  CATCH_UP_MIN_GAP_MS,
  ReviewCursorStore,
  localDateString,
  localDayStart,
  runReviewWithCursor,
  selectReviewWindow,
  shouldCatchUpReview,
} from '../lib/review-cursor.js';

const HOUR = 3_600_000;

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

/** 指定后缀的读抛错，写通道保持可用（模拟 EACCES） */
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

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'persona-cursor-'));
  return new JsonStore(tempFs(dir), dir);
}

function ev(id, iso, over = {}) {
  return {
    id,
    time: iso,
    topic: '用户-分享',
    summary: `事件 ${id}`,
    emotionTags: [],
    importance: 0.6,
    provenance: 'user_direct',
    lastRetrieved: null,
    ...over,
  };
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

/** 一个足够真的 ReviewOutput（只填消费点会读到的字段） */
function fakeOut(date) {
  return {
    runId: 'r1',
    date,
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
}

/* ── 1. 有游标：窗口只取游标之后的事件 ───────────────────────── */

test('v0.7-B1: 有游标时窗口只取游标之后的（含边界：等于游标时刻的事件不算新）', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const cursorAt = Date.now() - 5 * HOUR;
  await cursorStore.save({ version: 1, lastReviewAt: isoAt(cursorAt) });

  const before = ev('e_before', isoAt(cursorAt - HOUR));
  const onCursor = ev('e_on', isoAt(cursorAt));
  const after = ev('e_after', isoAt(cursorAt + HOUR));

  let captured = null;
  const outcome = await runReviewWithCursor({
    store,
    allEvents: [before, onCursor, after],
    cursorStore,
    review: async ({ events }) => {
      captured = events;
      return fakeOut('2026-11-04');
    },
  });

  assert.equal(outcome.kind, 'done');
  assert.deepEqual(
    captured.map((e) => e.id),
    ['e_after'],
    '游标之前/正好游标时刻的事件都不该再复盘（游标是开区间）',
  );
});

test('v0.7-B1b: 无游标（首次）退化为本地当日 00:00 起，昨天的事件不重放', () => {
  const now = new Date(2026, 10, 4, 9, 30, 0); // 本地 2026-11-04 09:30
  const yesterdayLate = ev('e_ystd', new Date(2026, 10, 3, 23, 0, 0).toISOString());
  const todayEarly = ev('e_today', new Date(2026, 10, 4, 1, 0, 0).toISOString());

  const window = selectReviewWindow([yesterdayLate, todayEarly], null, now);
  assert.deepEqual(window.map((e) => e.id), ['e_today']);
  assert.equal(localDayStart(now), new Date(2026, 10, 4, 0, 0, 0).getTime(), '零点必须按本地时区算');
  assert.equal(localDateString(now), '2026-11-04', '标签用本地日期，不用 UTC 切片');
});

/* ── 2. 窗口为空：不推进游标 ─────────────────────────────────── */

test('v0.7-B2: 窗口为空 → skipped，且游标文件原样不动', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const cursorAt = isoAt(Date.now() - HOUR);
  await cursorStore.save({ version: 1, lastReviewAt: cursorAt, lastReviewDate: '2026-11-03' });
  const before = await readFile(join(store.root, 'review-state.json'), 'utf-8');

  const outcome = await runReviewWithCursor({
    store,
    allEvents: [ev('e_old', isoAt(Date.now() - 10 * HOUR))],
    cursorStore,
    review: async () => {
      throw new Error('窗口为空时不该调用复盘');
    },
  });

  assert.equal(outcome.kind, 'skipped');
  assert.ok(outcome.reason.includes('没有新事件'), `提示应说清楚原因，实际：${outcome.reason}`);
  const after = await readFile(join(store.root, 'review-state.json'), 'utf-8');
  assert.equal(after, before, '不推进游标：否则"没有新事件"会被记成"已复盘到此刻"，吞掉后续事件');
});

/* ── 3. 成功复盘：游标推进到"开始时刻" ────────────────────────── */

test('v0.7-B3: 成功复盘后游标推进到本次开始时刻（不是结束时刻）', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  await cursorStore.save({ version: 1, lastReviewAt: isoAt(Date.now() - 30 * HOUR) });

  const now = new Date(2026, 10, 4, 2, 0, 0);
  const inWindow = ev('e_new', new Date(2026, 10, 4, 0, 30, 0).toISOString());

  let seenStart = null;
  const outcome = await runReviewWithCursor({
    store,
    allEvents: [inWindow],
    cursorStore,
    now,
    review: async ({ startedAt }) => {
      seenStart = startedAt;
      return fakeOut('2026-11-04');
    },
  });

  assert.equal(outcome.kind, 'done');
  assert.equal(seenStart, now.toISOString(), '复盘动作拿到的开始时刻应与游标基准一致');

  const saved = await cursorStore.load();
  assert.ok(saved.ok && saved.cursor);
  assert.equal(saved.cursor.lastReviewAt, now.toISOString(), '游标 = 开始时刻');
  assert.equal(saved.cursor.lastReviewDate, '2026-11-04');

  // 关键性质：开始时刻之后再写入的事件，下一次必须还在窗口里
  const duringReview = ev('e_during', new Date(2026, 10, 4, 2, 0, 5).toISOString());
  const nextWindow = selectReviewWindow([inWindow, duringReview], saved.cursor.lastReviewAt, new Date(2026, 10, 5, 2, 0, 0));
  assert.deepEqual(nextWindow.map((e) => e.id), ['e_during'], '复盘期间新写入的事件不能被跳过');
});

/* ── 4. 复盘无产出（门禁拦截/异常）：不推进游标 ───────────────── */

test('v0.7-B4: 复盘返回 null（门禁拦截/未提交）→ failed，游标不推进', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const cursorAt = isoAt(Date.now() - 30 * HOUR);
  await cursorStore.save({ version: 1, lastReviewAt: cursorAt });
  const before = await readFile(join(store.root, 'review-state.json'), 'utf-8');

  const outcome = await runReviewWithCursor({
    store,
    allEvents: [ev('e_new', isoAt(Date.now() - HOUR))],
    cursorStore,
    review: async () => null, // 门禁：LLM 降级 mock 时拒绝提交
  });

  assert.equal(outcome.kind, 'failed');
  assert.ok(outcome.reason.includes('游标不推进'));
  const after = await readFile(join(store.root, 'review-state.json'), 'utf-8');
  assert.equal(after, before, '门禁拦下的那一天必须还能被下次复盘覆盖');
});

test('v0.7-B4b: 复盘抛异常 → failed，游标不推进', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const cursorAt = isoAt(Date.now() - 30 * HOUR);
  await cursorStore.save({ version: 1, lastReviewAt: cursorAt });
  const before = await readFile(join(store.root, 'review-state.json'), 'utf-8');

  const outcome = await runReviewWithCursor({
    store,
    allEvents: [ev('e_new', isoAt(Date.now() - HOUR))],
    cursorStore,
    review: async () => {
      throw new Error('commit 失败');
    },
  });

  assert.equal(outcome.kind, 'failed');
  assert.ok(outcome.reason.includes('commit 失败'));
  assert.equal(await readFile(join(store.root, 'review-state.json'), 'utf-8'), before);
});

/* ── 5. 跨时区：本地凌晨的事件必须被下一次复盘覆盖 ───────────── */

test('v0.7-B5: 本地 03:00 的事件会被次日 02:00 的复盘覆盖（旧 UTC 日期切片会漏掉它）', async () => {
  // 全部用本地时间构造，断言与环境时区无关
  const lastReview = new Date(2026, 10, 3, 2, 0, 0); // 本地 11-03 02:00
  const lateNight = new Date(2026, 10, 3, 3, 0, 0); // 本地 11-03 03:00（正好落在旧实现的缺口里）
  const now = new Date(2026, 10, 4, 2, 0, 0); // 本地 11-04 02:00 的下一次复盘

  const window = selectReviewWindow(
    [ev('e_late', lateNight.toISOString())],
    lastReview.toISOString(),
    now,
  );
  assert.deepEqual(window.map((e) => e.id), ['e_late'], '凌晨三点的事必须被覆盖');

  // 回归说明：旧实现按 UTC 日期切片，凌晨 02:00 执行时"今天"是 UTC 的前一天，
  // 这两者必然不等（除非本地时区就是 UTC，那里本来就没有这个缺口）。
  const utcSliceOfNow = now.toISOString().slice(0, 10);
  const utcSliceOfEvent = lateNight.toISOString().slice(0, 10);
  if (now.getTimezoneOffset() !== 0) {
    assert.notEqual(
      utcSliceOfEvent,
      utcSliceOfNow,
      '注解：UTC 日期切片下这条事件与"今天"不相等，旧实现因此永远看不到它',
    );
  }
});

/* ── 6. 游标读失败：不能当空值覆盖 ───────────────────────────── */

test('v0.7-B6: 游标读失败 → skipped，不覆盖既有游标', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  await cursorStore.save({ version: 1, lastReviewAt: isoAt(Date.now() - 30 * HOUR) });
  const before = await readFile(join(store.root, 'review-state.json'), 'utf-8');

  const broken = new JsonStore(fsWithBrokenRead(store.root, 'review-state.json'), store.root);
  const outcome = await runReviewWithCursor({
    store: broken,
    allEvents: [ev('e_new', isoAt(Date.now() - HOUR))],
    review: async () => {
      throw new Error('游标读不到时不该复盘（会重复提交同一天）');
    },
  });

  assert.equal(outcome.kind, 'skipped');
  assert.ok(outcome.reason.includes('不可读'), `实际：${outcome.reason}`);
  assert.equal(await readFile(join(store.root, 'review-state.json'), 'utf-8'), before);
});

/* ── 7. 启动补跑判据 ────────────────────────────────────────── */

test('v0.7-B7: 启动补跑只在"无游标"或"距上次 ≥24h"时触发', () => {
  assert.equal(CATCH_UP_MIN_GAP_MS, 24 * HOUR);
  const now = new Date(2026, 10, 4, 10, 0, 0);

  assert.equal(shouldCatchUpReview(null, now), true, '无游标（首次/升级后）→ 补跑');
  assert.equal(shouldCatchUpReview(new Date(now.getTime() - HOUR).toISOString(), now), false, '1 小时前刚复盘 → 不补');
  assert.equal(
    shouldCatchUpReview(new Date(now.getTime() - 25 * HOUR).toISOString(), now),
    true,
    '25 小时前 → 补跑（02:00 的定时器没跑成）',
  );
  assert.equal(shouldCatchUpReview('garbage', now), true, '游标不可解析 → 按无游标处理');
});
