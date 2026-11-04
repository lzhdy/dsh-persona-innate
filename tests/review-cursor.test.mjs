/**
 * v0.7 复盘游标测试
 *
 * 覆盖旧实现的三个故障：
 * 1. UTC 日期切片 → 本地 00:00–01:59 与 08:00–23:59 看得到，02:00–07:59 永远不被任何一次复盘看到
 *    （本机 UTC+8、复盘固定在 02:00 时穷举实测；深夜陪伴高峰正好落在缺口里）
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
  REVIEW_WINDOW_MAX,
  ReviewCursorStore,
  localDateString,
  localDayStart,
  runReviewWithCursor,
  selectReviewWindow,
  selectReviewWindowDetailed,
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

test('v0.7-B1b: 无游标（首次）窗口从最早一条事件起，昨天的事件必须纳入', () => {
  // 旧契约是"退化为本地当日 00:00 起"，那正是首次复盘死锁的来源：
  // 定时复盘在 02:00 跑，窗口就成了 [今天 00:00, 02:00)——通常为空 → 不推进游标 →
  // 第二天完全重复。新契约：没有游标时从最早一条事件起，一次把历史补上。
  const now = new Date(2026, 10, 4, 9, 30, 0); // 本地 2026-11-04 09:30
  const yesterdayLate = ev('e_ystd', new Date(2026, 10, 3, 23, 0, 0).toISOString());
  const todayEarly = ev('e_today', new Date(2026, 10, 4, 1, 0, 0).toISOString());

  const window = selectReviewWindow([yesterdayLate, todayEarly], null, now);
  assert.deepEqual(window.map((e) => e.id), ['e_ystd', 'e_today'], '升级前的历史事件必须被首次复盘看到');

  const detailed = selectReviewWindowDetailed([yesterdayLate, todayEarly], null, now);
  assert.equal(
    detailed.lowerBound,
    yesterdayLate.time,
    '无游标时下界 = 最早一条事件的时刻（闭区间，不能把它自己排除掉）',
  );
  assert.equal(detailed.truncatedEarlier, 0);

  assert.equal(localDayStart(now), new Date(2026, 10, 4, 0, 0, 0).getTime(), '零点必须按本地时区算');
  assert.equal(localDateString(now), '2026-11-04', '标签用本地日期，不用 UTC 切片');
});

test('v0.7-B1c: 首次复盘死锁回归 —— 凌晨 02:00 且无游标时窗口不为空', async () => {
  // 直接复现死锁：事件全部在"昨天"，复盘发生在今天 02:00。
  // 旧语义下窗口 = [今天 00:00, 02:00) = 空 → skipped → 游标不推进 → 永远重复。
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const now = new Date(2026, 10, 4, 2, 0, 0);
  const yesterday = [
    ev('e_y1', new Date(2026, 10, 3, 10, 0, 0).toISOString()),
    ev('e_y2', new Date(2026, 10, 3, 23, 30, 0).toISOString()),
  ];

  let seen = [];
  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: yesterday,
    now,
    review: async ({ events }) => {
      seen = events.map((e) => e.id);
      return fakeOut('2026-11-04');
    },
  });

  assert.equal(outcome.kind, 'done', '无游标 + 今天还没有事件时，不该 skipped（那会永远没有游标）');
  assert.deepEqual(seen, ['e_y1', 'e_y2']);

  const saved = await cursorStore.load();
  assert.ok(saved.ok && saved.cursor, '游标必须被推进，否则明天还会重来一次');
  assert.equal(saved.cursor.lastReviewAt, now.toISOString());
});

/* ── 1c. 无游标时的上限与截断 ─────────────────────────────────── */

test('v0.7-B1d: 无游标时窗口超过上限 → 保留最近的，并如实回报被截掉的更早条数', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const now = new Date(2026, 10, 4, 12, 0, 0);

  // 上限 + 37 条，时刻递增
  const total = REVIEW_WINDOW_MAX + 37;
  const events = Array.from({ length: total }, (_, i) =>
    ev(`e_${String(i).padStart(3, '0')}`, new Date(now.getTime() - (total - i) * 60_000).toISOString()),
  );

  let seen = [];
  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: events,
    now,
    review: async ({ events: win }) => {
      seen = win;
      return fakeOut('2026-11-04');
    },
  });

  assert.equal(outcome.kind, 'done');
  assert.equal(seen.length, REVIEW_WINDOW_MAX, `窗口应被截到 ${REVIEW_WINDOW_MAX} 条`);
  assert.equal(outcome.truncatedEarlier, 37, '被排除的更早事件条数必须回传，不能静默丢弃');
  assert.equal(seen[seen.length - 1].id, `e_${String(total - 1).padStart(3, '0')}`, '保留的是最近的');
  assert.equal(seen[0].id, 'e_037', '从最早端截断：前 37 条被排除');

  // 截断不影响游标推进：本次窗口右端仍是 now，下一轮从 now 继续，被截掉的不重复
  const saved = await cursorStore.load();
  assert.ok(saved.ok && saved.cursor);
  assert.equal(saved.cursor.lastReviewAt, now.toISOString());
});

test('v0.7-B1e: 未超上限时不回报 truncatedEarlier（避免日志噪音）', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const now = new Date(2026, 10, 4, 12, 0, 0);
  const events = Array.from({ length: REVIEW_WINDOW_MAX }, (_, i) =>
    ev(`e_${i}`, new Date(now.getTime() - (REVIEW_WINDOW_MAX - i) * 60_000).toISOString()),
  );

  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: events,
    now,
    review: async () => fakeOut('2026-11-04'),
  });

  assert.equal(outcome.kind, 'done');
  assert.equal(outcome.truncatedEarlier, undefined, '正好等于上限时没有截断');
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

/* ── 8. 启动补跑的窗口上界：只补"进程不在期间"的事件 ────────── */

test('v0.7-B8: 启动补跑带上界 until —— 本次会话刚写的事件不算缺口，且不会被游标跳过', async () => {
  // 真实故障（并行跑测试时稳定复现）：进程启动 → 用户开口 → 事件落盘 →
  // 补跑这时才跑到 runDailyReview，于是把"本次会话的事件"也当成历史缺口复盘了一遍，
  // 和紧随其后的手动 /persona review 抢同一个窗口（抢输了手动那条只能报
  // "上一次复盘仍在进行中"）。补跑的正确口径是 (游标, 启动时刻]。
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const readyAtMs = Date.now();
  const readyAt = new Date(readyAtMs);

  const downtime = ev('e_downtime', isoAt(readyAtMs - 3 * HOUR)); // 进程不在期间产生的
  const live = ev('e_live', isoAt(readyAtMs + 50)); // 启动之后、本次会话产生的
  const atReady = ev('e_at_ready', isoAt(readyAtMs)); // 与启动同一毫秒（边界）

  const seen = [];
  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: [downtime, live, atReady],
    until: readyAt,
    now: new Date(readyAtMs + 1000),
    review: async ({ events }) => {
      seen.push(...events.map((e) => e.id));
      return fakeOut('2026-11-04');
    },
  });

  assert.equal(outcome.kind, 'done');
  assert.deepEqual(seen, ['e_downtime'], `补跑只该看到停机期间的事件，实际：${JSON.stringify(seen)}`);

  // 游标停在右端 until，不是补跑结束的时刻：live 事件必须留在下一次窗口里
  const saved = await cursorStore.load();
  assert.ok(saved.ok);
  assert.equal(saved.cursor.lastReviewAt, isoAt(readyAtMs), '游标右端 = 启动时刻');

  // 下一次（手动 / 定时）复盘把 live 事件补上——这是"上界不等于丢事件"的证明
  const nextSeen = [];
  const next = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: [downtime, live, atReady],
    now: new Date(readyAtMs + 2000),
    review: async ({ events }) => {
      nextSeen.push(...events.map((e) => e.id));
      return fakeOut('2026-11-04');
    },
  });
  assert.equal(next.kind, 'done');
  assert.ok(nextSeen.includes('e_live'), `启动后写入的事件必须被下一次复盘收走，实际：${JSON.stringify(nextSeen)}`);
});

test('v0.7-B8b: 补跑窗口为空（启动前没有新事件）→ skipped，不推进游标、不调用 LLM', async () => {  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  const readyAtMs = Date.now();

  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: [ev('e_live', isoAt(readyAtMs + 10))],
    until: new Date(readyAtMs),
    now: new Date(readyAtMs + 500),
    review: async () => {
      throw new Error('窗口为空时不该调用复盘');
    },
  });

  assert.equal(outcome.kind, 'skipped');
});

/* ── 9. 定时器没跑成（关机）：窗口是时间区间，不是"今天" ─────────── */

test('v0.7-B9: 02:00 电脑关机，次日手动复盘必须覆盖错过的整天（不按日期切）', async () => {
  // 用户的真实担心：定时复盘没跑，第二天手动跑会不会"只复盘当日窗口"，
  // 把昨天整个挡在外面。答案必须是否——窗口是 (游标, 现在) 的时刻区间，
  // 与日历日无关；date 只是输出上的标签（changeNote/"每日复盘 X"），从不参与筛选。
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);

  // 上次复盘：11-03 凌晨 02:00
  const lastReview = new Date(2026, 10, 3, 2, 0, 0);
  await cursorStore.save({ version: 1, lastReviewAt: lastReview.toISOString() });

  // 11-03 一整天的事件 + 11-04 早上开机后的事件
  const events = [
    ev('e_d3_morning', new Date(2026, 10, 3, 10, 0, 0).toISOString()),
    ev('e_d3_night', new Date(2026, 10, 3, 23, 0, 0).toISOString()),
    ev('e_d4_early', new Date(2026, 10, 4, 9, 15, 0).toISOString()),
  ];

  // 11-04 02:00 机器不在；09:30 开机后手动 /persona review
  const now = new Date(2026, 10, 4, 9, 30, 0);
  const seen = [];
  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: events,
    now,
    review: async ({ events: win, date }) => {
      seen.push(...win.map((e) => e.id));
      // 标签是"今天"，但窗口跨了两天——这正是本次要钉住的一点
      assert.equal(date, '2026-11-04', '标签按复盘当天算');
      return fakeOut(date);
    },
  });

  assert.equal(outcome.kind, 'done');
  assert.deepEqual(
    seen,
    ['e_d3_morning', 'e_d3_night', 'e_d4_early'],
    '昨天整天的事件必须一起纳入，不能只取"今天"',
  );

  const saved = await cursorStore.load();
  assert.ok(saved.ok && saved.cursor);
  assert.equal(saved.cursor.lastReviewAt, now.toISOString(), '游标推进到本次复盘时刻');
});

test('v0.7-B9b: 连续关机多天 → 一次覆盖整段，但不会超过单次上限', async () => {
  const store = await freshStore();
  const cursorStore = new ReviewCursorStore(store);
  // 上次复盘在 5 天前
  const lastReview = new Date(2026, 10, 3, 2, 0, 0);
  await cursorStore.save({ version: 1, lastReviewAt: lastReview.toISOString() });

  // 这 5 天里每天 50 条 → 250 条，超过 200 上限
  const events = [];
  for (let d = 0; d < 5; d += 1) {
    for (let i = 0; i < 50; i += 1) {
      const t = new Date(2026, 10, 3, 3, 0, 0).getTime() + (d * 24 * 60 + i) * 60_000;
      events.push(ev(`e_d${d}_${i}`, new Date(t).toISOString()));
    }
  }
  const now = new Date(2026, 10, 8, 9, 30, 0);

  const outcome = await runReviewWithCursor({
    store,
    cursorStore,
    allEvents: events,
    now,
    review: async ({ events: win }) => fakeOut('2026-11-08'),
  });

  assert.equal(outcome.kind, 'done');
  assert.equal(outcome.window.length, REVIEW_WINDOW_MAX, '一次最多 200 条');
  assert.equal(outcome.truncatedEarlier, 50, '更早的 50 条如实报数，不静默丢弃');
  // 关键：游标仍推进到 now —— 被截断的更早事件不会在下一轮重复
  const saved = await cursorStore.load();
  assert.ok(saved.ok && saved.cursor);
  assert.equal(saved.cursor.lastReviewAt, now.toISOString());
});
