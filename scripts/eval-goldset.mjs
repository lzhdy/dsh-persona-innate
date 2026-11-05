/**
 * 增量5 评测资产化骨架：gold set 跑分脚本（空跑）。
 *
 * 依据：《dsh-memory-architecture-final-design.md》v1.1 §11（验收标准）+ §16.5（增量5）。
 * 现状：P3-P6 及增量 1/2/3/4 尚未施工，无被测实现，因此本脚本只负责——
 *   1) 读入公开集（默认）或公开集+隐藏集（--hidden 1）；
 *   2) 按七类聚合条目数；
 *   3) 输出 13 项指标框架：准确性指标（1-11）值恒为 null（未测），
 *      成本指标（12-13）输出占位 { value: null, note: "成本指标待系统跑通后接实测" }。
 * 严禁填写任何预估值（对应最终设计 §14「未测项保持未验证」）。
 *
 * 无第三方依赖，Node 22+ ESM。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 脚本所在目录（scripts/）。 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录。 */
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'goldset', 'public');
const HIDDEN_DIR = path.join(ROOT_DIR, 'goldset', 'hidden');

/** 七类（对应最终设计 §11.1）。 */
export const CATEGORIES = [
  'speaker',
  'relative_time',
  'knowledge_update',
  'contamination',
  'abstention',
  'persona_stability',
  'association',
];

/** 类别 → id 前缀。 */
export const CATEGORY_PREFIXES = {
  speaker: 'spk',
  relative_time: 'rel',
  knowledge_update: 'upd',
  contamination: 'ctm',
  abstention: 'abs',
  persona_stability: 'per',
  association: 'asc',
};

/** 13 项核心指标（对应最终设计 §11.2）。 */
export const METRICS = {
  1: { name: 'speaker 归属准确率', threshold: 0.95, kind: 'accuracy', operator: '>=' },
  2: { name: '相对时间归一化/区间正确率', threshold: 0.95, kind: 'accuracy', operator: '>=' },
  3: { name: '知识更新正确率', threshold: 0.95, kind: 'accuracy', operator: '>=' },
  4: { name: 'superseded 旧值被当作当前事实次数', threshold: 0, kind: 'count', operator: '==' },
  5: { name: 'quarantined/已知错误事实进入注入上下文比例', threshold: 0, kind: 'count', operator: '==' },
  6: { name: 'AI 疑问冒充用户事实', threshold: 0, kind: 'count', operator: '==' },
  7: { name: '不可回答项正确弃权率', threshold: 0.9, kind: 'accuracy', operator: '>=' },
  8: { name: '可回答项错误弃权率', threshold: 0.1, kind: 'accuracy', operator: '<=' },
  9: { name: '被污染候选特质注入次数', threshold: 0, kind: 'count', operator: '==' },
  10: { name: '稳定特质一致率', threshold: 0.9, kind: 'accuracy', operator: '>=' },
  11: { name: '派生事实证据链接可解析率', threshold: 1.0, kind: 'accuracy', operator: '==' },
  12: { name: 'p95 输入 token 相对 events-only 基线增幅', threshold: 0.15, kind: 'cost', operator: '<=' },
  13: { name: 'p95 端到端延迟增幅', threshold: 0.2, kind: 'cost', operator: '<=' },
};

/** 类别 → 关联的指标编号（成本指标 12/13 为全局，不在此列）。 */
export const CATEGORY_METRICS = {
  speaker: [1],
  relative_time: [2],
  knowledge_update: [3, 4],
  contamination: [5, 6],
  abstention: [7, 8],
  persona_stability: [9, 10],
  association: [11],
};

/** 成本指标占位说明。 */
export const COST_METRIC_NOTE = '成本指标待系统跑通后接实测';

/** 本地日期字符串 YYYY-MM-DD（不随 UTC 偏移）。 */
function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 生成一次跑分的 runId。 */
function makeRunId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `eval-${ts}-${rnd}`;
}

/** 读取一个目录下所有 *.json 文件并合并为 item 数组。目录不存在时返回空数组。 */
function readItemsFromDir(dir) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const raw = readFileSync(path.join(dir, name), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`gold set 文件必须是数组：${path.join(dir, name)}`);
    }
    // 若条目缺 category，则用文件名兜底（去掉 .json）。
    const fallbackCategory = name.slice(0, -'.json'.length);
    for (const item of parsed) {
      items.push({ category: fallbackCategory, ...item });
    }
  }
  return items;
}

/**
 * 读入条目。
 * @param {{hidden?: boolean}} opts hidden 为 true 时追加隐藏集。
 * @returns {Array<object>} 合并后的 item 数组。
 */
export function loadItems({ hidden = false } = {}) {
  const items = readItemsFromDir(PUBLIC_DIR);
  if (hidden) {
    items.push(...readItemsFromDir(HIDDEN_DIR));
  }
  return items;
}

/** 准确性指标（未测）占位。 */
function accuracyMetric(threshold) {
  return { value: null, threshold, pass: null };
}

/** 成本指标占位（永远如此，对应最终设计 §14）。 */
function costMetric(threshold) {
  return { value: null, threshold, pass: null, note: COST_METRIC_NOTE };
}

/**
 * 按类别聚合条目并生成报告。
 * @param {Array<object>} items
 * @param {{hidden?: boolean, category?: string}} opts
 * @returns {object} 报告对象。
 */
export function buildReport(items, { hidden = false, category } = {}) {
  const categories = {};
  for (const cat of CATEGORIES) {
    const total = items.filter((it) => it.category === cat).length;
    if (category && category !== cat) continue;
    const entry = { total, answered: 0 };
    for (const m of CATEGORY_METRICS[cat]) {
      const def = METRICS[m];
      entry[`metric${m}`] = def.kind === 'cost' ? costMetric(def.threshold) : accuracyMetric(def.threshold);
    }
    categories[cat] = entry;
  }

  const summaryMetrics = {};
  for (const key of Object.keys(METRICS)) {
    const def = METRICS[key];
    summaryMetrics[key] = def.kind === 'cost' ? costMetric(def.threshold) : accuracyMetric(def.threshold);
  }

  const noteParts = ['空跑：当前无被测实现，准确性指标均为未测'];
  if (category) noteParts.push(`已按 --category ${category} 过滤`);

  return {
    runId: makeRunId(),
    date: localDateString(),
    hiddenIncluded: hidden,
    categories,
    summary: {
      metrics: summaryMetrics,
      note: noteParts.join('；'),
    },
  };
}

/** 解析命令行参数。 */
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

/** CLI 入口：读入 → 聚合 → 输出 JSON 到 stdout。 */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const items = loadItems({ hidden: opts.hidden });
  const report = buildReport(items, opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// 仅在作为主模块直接运行时执行 CLI；被 import 时不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
