/**
 * 增量5 评测资产化 · 第二期：live 实测接线（只接确定性实现）。
 *
 * 目标：让 speaker / relative_time 两类 gold set 真正能算出数，证明评测管线打穿；
 * 其余类别在无确定性实现时如实输出 null + unmeasured 原因，不伪造数值。
 *
 * 红线（对应任务规格 B/C 部分）：
 * - 只调用仓库里已有的确定性纯函数：inferSpeakerEpistemic / localDateString / localDayDiff / relativeDayLabel；
 * - 任何需要 LLM 才能作答的指标保持 null，并标 unmeasured='no_implementation'；
 * - 有样例且算出 0 的如实输出 0 与 pass:false，不得写成 null；
 * - 默认空跑脚本 scripts/eval-goldset.mjs 完全不变；本文件为独立实测入口。
 *
 * 无第三方依赖，Node 22+ ESM。运行前需 npm run build（依赖 ../lib/*.js）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { JsonStore } from '../lib/store.js';
import { inferSpeakerEpistemic } from '../lib/memory-facts.js';
import { localDateString, localDayDiff } from '../lib/time.js';
import { relativeDayLabel } from '../lib/recall.js';

import { CATEGORIES, METRICS, CATEGORY_METRICS, COST_METRIC_NOTE } from './eval-goldset.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'goldset', 'public');
const HIDDEN_DIR = path.join(ROOT_DIR, 'goldset', 'hidden');
const FIXTURE_FILE = path.join(ROOT_DIR, 'goldset', 'fixtures', 'events.json');

/**
 * inferSpeakerEpistemic 能产出的 speaker 值域。
 * 用于判断某条 gold 答案是否落在「有确定性实现」的范围内：
 * provenance 七态只映射 user / assistant / tool，system 无对应来源。
 */
const SPEAKER_IMPLEMENTATION_DOMAIN = new Set(['user', 'assistant', 'tool']);

/** 内存 FsLike：让 JsonStore 走真实存储代码路径，但不触碰真实 ~/.dsh。 */
function memoryFs() {
  const files = new Map();
  return {
    async mkdir() {},
    async exists(p) {
      return files.has(p);
    },
    async readText(p) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    async writeText(p, content) {
      files.set(p, content);
    },
    async appendText(p, chunk) {
      files.set(p, (files.get(p) ?? '') + chunk);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

/**
 * 把 fixture 事件写进内存 JsonStore 再读回，返回存储后的 PersonaEvent[]。
 * 走真实 JsonStore 的 writeJson / readJson 路径，证明 fixture 是合法可持久化的。
 */
export async function roundTripFixtureEvents(events) {
  const store = new JsonStore(memoryFs(), '/mem');
  await store.writeJson('events.json', { version: 1, events });
  const loaded = await store.readJson('events.json');
  if (!loaded || !Array.isArray(loaded.events)) {
    throw new Error('fixture 事件往返读写失败');
  }
  return loaded.events;
}

/** 判断 pass：按指标定义的方向比较。 */
function passOf(value, threshold, operator) {
  if (operator === '>=') return value >= threshold;
  if (operator === '<=') return value <= threshold;
  if (operator === '==') return value === threshold;
  return null;
}

/**
 * speaker 单条评分：用真实实现 inferSpeakerEpistemic(provenance) 推导 speaker。
 * 不自行判定归属，只做「实现输出 vs goldAnswer」的直接比较。
 */
export function evalSpeakerItem(item, eventById) {
  const event = eventById.get(item.evidenceEventIds?.[0]);
  if (!event) {
    return { id: item.id, measured: false, unmeasured: 'missing_fixture', detail: '证据事件不存在' };
  }
  if (!SPEAKER_IMPLEMENTATION_DOMAIN.has(item.goldAnswer)) {
    return {
      id: item.id,
      measured: false,
      unmeasured: 'no_implementation',
      detail: `inferSpeakerEpistemic 值域不含 '${item.goldAnswer}'（PersonaEvent.provenance 无该来源）`,
    };
  }
  const { speaker } = inferSpeakerEpistemic(event.provenance);
  if (!speaker) {
    return {
      id: item.id,
      measured: false,
      unmeasured: 'no_implementation',
      detail: `provenance=${event.provenance} 无法确定性归属 speaker`,
    };
  }
  return {
    id: item.id,
    measured: true,
    predicted: speaker,
    gold: item.goldAnswer,
    correct: speaker === item.goldAnswer,
  };
}

/**
 * relative_time 单条评分：按 item.check 调用对应确定性函数。
 * check 取值：local_date / day_diff / relative_label（语义见 README §4.1）。
 */
export function evalRelativeTimeItem(item, eventById) {
  const events = (item.evidenceEventIds ?? []).map((id) => eventById.get(id));
  if (events.length === 0 || events.some((e) => !e)) {
    return { id: item.id, measured: false, unmeasured: 'missing_fixture', detail: '证据事件不存在' };
  }
  let predicted;
  switch (item.check) {
    case 'local_date':
      predicted = localDateString(new Date(Date.parse(events[0].time)));
      break;
    case 'day_diff':
      predicted = String(localDayDiff(Date.parse(events[0].time), Date.parse(events[1].time)));
      break;
    case 'relative_label': {
      const nowMs = item.queryAt ? Date.parse(item.queryAt) : Date.parse(events[0].time);
      predicted = relativeDayLabel(events[0].time, nowMs);
      break;
    }
    default:
      return {
        id: item.id,
        measured: false,
        unmeasured: 'no_implementation',
        detail: `未知 check='${item.check}'，无可调用的确定性函数`,
      };
  }
  return {
    id: item.id,
    measured: true,
    predicted,
    gold: item.goldAnswer,
    correct: predicted === item.goldAnswer,
  };
}

/** 聚合一组单条结果。 */
export function aggregateResults(results) {
  const measured = results.filter((r) => r.measured);
  return {
    total: results.length,
    measured: measured.length,
    correct: measured.filter((r) => r.correct).length,
    results,
  };
}

/**
 * 由聚合结果生成某项指标。
 * 三种未测原因：no_samples（无样例）/ no_implementation（有样例但无确定性实现）/ cost_not_wired（成本指标）。
 */
export function metricFromAggregate(key, agg) {
  const def = METRICS[key];
  if (agg.total === 0) {
    return { value: null, threshold: def.threshold, pass: null, unmeasured: 'no_samples', measured: 0, total: 0 };
  }
  const skipped = agg.results
    .filter((r) => !r.measured)
    .map((r) => ({ id: r.id, unmeasured: r.unmeasured, detail: r.detail }));
  if (agg.measured === 0) {
    return {
      value: null,
      threshold: def.threshold,
      pass: null,
      unmeasured: 'no_implementation',
      measured: 0,
      total: agg.total,
      skipped,
    };
  }
  const value = agg.correct / agg.measured;
  const metric = {
    value,
    threshold: def.threshold,
    pass: passOf(value, def.threshold, def.operator),
    unmeasured: null,
    measured: agg.measured,
    total: agg.total,
  };
  if (skipped.length > 0) metric.skipped = skipped;
  return metric;
}

/** 成本指标（12/13）恒占位：不是没样例，而是系统整体成本尚未接实测。 */
function costMetric(threshold) {
  return { value: null, threshold, pass: null, unmeasured: 'cost_not_wired', note: COST_METRIC_NOTE };
}

/** 本地日期串 YYYY-MM-DD。 */
function localDateToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function makeRunId() {
  return `eval-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生成 live 报告（纯函数，便于测试）。
 * @param {Array<object>} items gold items
 * @param {Array<object>} events PersonaEvent 数组（fixture）
 * @param {{hidden?: boolean, category?: string}} opts
 */
export async function buildLiveReport(items, events, { hidden = false, category } = {}) {
  const stored = await roundTripFixtureEvents(events);
  const eventById = new Map(stored.map((e) => [e.id, e]));

  const speakerResults = items
    .filter((it) => it.category === 'speaker')
    .map((it) => evalSpeakerItem(it, eventById));
  const relativeResults = items
    .filter((it) => it.category === 'relative_time')
    .map((it) => evalRelativeTimeItem(it, eventById));

  const speakerAgg = aggregateResults(speakerResults);
  const relativeAgg = aggregateResults(relativeResults);

  const categories = {};
  for (const cat of CATEGORIES) {
    if (category && category !== cat) continue;
    const catItems = items.filter((it) => it.category === cat);
    let agg;
    if (cat === 'speaker') agg = speakerAgg;
    else if (cat === 'relative_time') agg = relativeAgg;
    else agg = { total: catItems.length, measured: 0, correct: 0, results: [] };

    const entry = { total: agg.total, measured: agg.measured, answered: agg.measured };
    for (const m of CATEGORY_METRICS[cat]) {
      entry[`metric${m}`] = metricFromAggregate(m, agg);
    }
    if (cat === 'speaker' || cat === 'relative_time') {
      entry.items = agg.results.map((r) => ({
        id: r.id,
        measured: r.measured,
        predicted: r.predicted ?? null,
        gold: r.gold ?? null,
        correct: r.correct ?? null,
        ...(r.measured ? {} : { unmeasured: r.unmeasured, detail: r.detail }),
      }));
    }
    categories[cat] = entry;
  }

  const summaryMetrics = {};
  // 1/2：已接线；3-11：其类别当前无样例，按 no_samples；12/13：成本占位。
  for (const key of Object.keys(METRICS)) {
    const k = Number(key);
    if (k === 1) summaryMetrics[key] = metricFromAggregate(1, speakerAgg);
    else if (k === 2) summaryMetrics[key] = metricFromAggregate(2, relativeAgg);
    else if (k >= 12) summaryMetrics[key] = costMetric(METRICS[key].threshold);
    else {
      const cat = Object.keys(CATEGORY_METRICS).find((c) => CATEGORY_METRICS[c].includes(k));
      const catTotal = cat ? items.filter((it) => it.category === cat).length : 0;
      summaryMetrics[key] = metricFromAggregate(k, {
        total: catTotal,
        measured: 0,
        correct: 0,
        results: [],
      });
    }
  }

  const noteParts = ['实测接线：speaker / relative_time 走确定性实现；其余指标按 unmeasured 标注原因'];
  if (category) noteParts.push(`已按 --category ${category} 过滤`);

  return {
    runId: makeRunId(),
    date: localDateToday(),
    mode: 'live',
    hiddenIncluded: hidden,
    categories,
    summary: { metrics: summaryMetrics, note: noteParts.join('；') },
  };
}

/** 读取一个目录下所有 *.json 并合并（缺 category 时用文件名兜底）。 */
function readItemsFromDir(dir) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`gold set 文件必须是数组：${path.join(dir, name)}`);
    const fallbackCategory = name.slice(0, -'.json'.length);
    for (const item of parsed) items.push({ category: fallbackCategory, ...item });
  }
  return items;
}

export function loadLiveItems({ hidden = false } = {}) {
  const items = readItemsFromDir(PUBLIC_DIR);
  if (hidden) items.push(...readItemsFromDir(HIDDEN_DIR));
  return items;
}

export function loadFixtureEvents() {
  if (!existsSync(FIXTURE_FILE)) {
    throw new Error(`缺少 fixture 事件文件：${FIXTURE_FILE}`);
  }
  return JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'));
}

function parseArgs(argv) {
  const opts = { hidden: false, category: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--category') {
      opts.category = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--category=')) {
      opts.category = arg.slice('--category='.length);
    } else if (arg === '--hidden') {
      opts.hidden = ['1', 'true'].includes(String(argv[i + 1]).toLowerCase());
      i += 1;
    } else if (arg.startsWith('--hidden=')) {
      opts.hidden = ['1', 'true'].includes(arg.slice('--hidden='.length).toLowerCase());
    }
  }
  if (opts.category && !CATEGORIES.includes(opts.category)) {
    throw new Error(`未知类别：${opts.category}。可选：${CATEGORIES.join(', ')}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const items = loadLiveItems({ hidden: opts.hidden });
  const events = loadFixtureEvents();
  const report = await buildLiveReport(items, events, opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
