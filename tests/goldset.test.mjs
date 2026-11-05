/**
 * 增量5 评测资产化骨架测试。
 *
 * 覆盖（对应实现规格 §6）：
 *   1) schema 合法：七类枚举 + id 前缀（spk/rel/upd/ctm/abs/per/asc）；
 *   2) 跑分脚本空跑 exit 0 且输出合法 JSON（准确性 null、成本占位）；
 *   3) 13 项指标阈值与最终设计 §11.2 完全一致；
 *   4) --category 过滤生效；
 *   5) 隐藏集物理隔离（默认不跑，--hidden 1 才跑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CATEGORIES,
  CATEGORY_PREFIXES,
  METRICS,
  loadItems,
  buildReport,
} from '../scripts/eval-goldset.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join('scripts', 'eval-goldset.mjs');

/** 以 CLI 方式跑一次脚本，返回 { status, stdout, stderr }。 */
function runScript(args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('schema 合法：七类枚举与 id 前缀完全一致', () => {
  assert.deepEqual(CATEGORIES, [
    'speaker',
    'relative_time',
    'knowledge_update',
    'contamination',
    'abstention',
    'persona_stability',
    'association',
  ]);
  assert.deepEqual(CATEGORY_PREFIXES, {
    speaker: 'spk',
    relative_time: 'rel',
    knowledge_update: 'upd',
    contamination: 'ctm',
    abstention: 'abs',
    persona_stability: 'per',
    association: 'asc',
  });
});

test('公开集标注：speaker 3 条 + relative_time 3 条，其余五类空占位', () => {
  const items = loadItems();
  const byCat = {};
  for (const it of items) byCat[it.category] = (byCat[it.category] || 0) + 1;
  assert.equal(byCat.speaker, 3, 'speaker 类应为 3 条');
  assert.equal(byCat.relative_time, 3, 'relative_time 类应为 3 条');
  for (const cat of ['knowledge_update', 'contamination', 'abstention', 'persona_stability', 'association']) {
    assert.equal(byCat[cat] || 0, 0, `${cat} 类应为空占位`);
  }
  assert.equal(items.length, 6, '首批样例共 6 条');
});

test('每条样例字段齐全、category 合法、id 前缀与类别匹配', () => {
  const required = ['id', 'category', 'question', 'goldAnswer', 'allowAbstain', 'evidenceEventIds'];
  const items = loadItems();
  for (const it of items) {
    assert.ok(CATEGORIES.includes(it.category), `非法类别：${it.category}`);
    for (const key of required) {
      assert.ok(key in it, `条目 ${it.id} 缺少字段 ${key}`);
    }
    const prefix = CATEGORY_PREFIXES[it.category];
    assert.ok(it.id.startsWith(`${prefix}-`), `条目 ${it.id} 的 id 前缀应为 ${prefix}-`);
    assert.equal(typeof it.allowAbstain, 'boolean', `${it.id} 的 allowAbstain 应为 boolean`);
    assert.ok(Array.isArray(it.evidenceEventIds), `${it.id} 的 evidenceEventIds 应为数组`);
  }
});

test('13 项指标阈值与最终设计 §11.2 完全一致', () => {
  const expected = {
    1: 0.95,
    2: 0.95,
    3: 0.95,
    4: 0,
    5: 0,
    6: 0,
    7: 0.9,
    8: 0.1,
    9: 0,
    10: 0.9,
    11: 1,
    12: 0.15,
    13: 0.2,
  };
  assert.equal(Object.keys(METRICS).length, 13, '应有 13 项指标');
  for (const key of Object.keys(expected)) {
    assert.equal(METRICS[key].threshold, expected[key], `指标 ${key} 阈值应为 ${expected[key]}`);
  }
});

test('跑分脚本空跑 exit 0 且输出合法 JSON（准确性 null、成本占位）', () => {
  const res = runScript();
  assert.equal(res.status, 0, `脚本应 exit 0，stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);

  assert.equal(Object.keys(report.categories).length, 7, 'categories 应含七类');
  assert.equal(report.categories.speaker.total, 3);
  assert.equal(report.categories.relative_time.total, 3);
  assert.equal(report.categories.knowledge_update.total, 0);

  // 准确性指标 1-11：value 恒 null、pass null、threshold 保留
  for (let i = 1; i <= 11; i += 1) {
    const m = report.summary.metrics[String(i)];
    assert.equal(m.value, null, `指标 ${i} 应为未测 null`);
    assert.equal(m.pass, null, `指标 ${i} pass 应为 null`);
    assert.equal(typeof m.threshold, 'number', `指标 ${i} 应保留阈值`);
  }
  // 成本指标 12-13：占位 note
  for (let i = 12; i <= 13; i += 1) {
    const m = report.summary.metrics[String(i)];
    assert.equal(m.value, null);
    assert.equal(m.note, '成本指标待系统跑通后接实测', `指标 ${i} 应带成本占位 note`);
  }
  assert.ok(report.summary.note.includes('空跑'), 'summary.note 应说明空跑状态');
  assert.equal(report.hiddenIncluded, false, '默认不跑隐藏集');
});

test('--category 过滤生效：只输出指定类别', () => {
  const res = runScript(['--category', 'speaker']);
  assert.equal(res.status, 0);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(report.categories), ['speaker'], '只应含 speaker 类');
  assert.ok(report.summary.note.includes('--category speaker'), 'note 应说明过滤');
});

test('隐藏集物理隔离：默认不跑，--hidden 1 才追加', () => {
  const def = JSON.parse(runScript().stdout);
  assert.equal(def.hiddenIncluded, false);

  const on = JSON.parse(runScript(['--hidden', '1']).stdout);
  assert.equal(on.hiddenIncluded, true);
});

test('buildReport 直接调用产出与 CLI 结构一致', () => {
  const items = loadItems();
  const report = buildReport(items);
  assert.equal(report.categories.speaker.total, 3);
  assert.equal(report.summary.metrics['1'].value, null);
  assert.equal(report.summary.metrics['12'].note, '成本指标待系统跑通后接实测');
});
