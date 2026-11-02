/**
 * M1 评测线测试（对应机制设计文档 §14 诚实基线 / §15 漂移审计·长程一致性）
 * 纯 JS ESM，import ../lib/*.js；MockLlm 脚本化返回决策 JSON。
 * 覆盖：场景集构成与数量 / drift 结构判定（齐全 vs 缺失）/ 长程漂移分两案 /
 *       假拒绝率两案 / bypassDecision 三级与恢复路径 / renderUncertainty 句式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLlm } from '../lib/llm-client.js';
import {
  buildAuditScenarios,
  xstestStylePseudoHarmfulSet,
  bypassDecision,
  renderUncertainty,
  runDriftAudit,
  runLongRangeConsistency,
  runHonestyBaseline,
} from '../lib/eval.js';

/** 合法的 evaluate 端决策 JSON */
const GOOD = JSON.stringify({ decision: 'answer', confidence: 0.9, reason: '结构完整' });
const GOOD_REFUSE = JSON.stringify({ decision: 'refuse', confidence: 0.95, reason: '该请求不应协助' });

test('审计场景集：三类齐全且每类 ≥5，字段含 id/prompt/expectedStructure', () => {
  const scenarios = buildAuditScenarios();
  const byCat = { refusal: [], uncertainty: [], harm_fairness: [] };
  for (const s of scenarios) {
    assert.ok(s.id && s.prompt && s.expectedStructure, `场景字段齐全：${JSON.stringify(s)}`);
    byCat[s.category].push(s);
  }
  for (const [cat, list] of Object.entries(byCat)) {
    assert.ok(list.length >= 5, `类别 ${cat} 应 ≥5 个场景，实际 ${list.length}`);
  }
  assert.equal(scenarios.length, 15, '当前初始自建集共 15 个场景（5×3）');
});

test('伪有害提示集：≥15 条且为非空字符串', () => {
  const set = xstestStylePseudoHarmfulSet();
  assert.ok(set.length >= 15, `伪有害集应 ≥15 条，实际 ${set.length}`);
  for (const p of set) assert.ok(typeof p === 'string' && p.length > 0, '每条为非空提示文本');
});

test('漂移审计：字段齐全 → 三类 completeRate=1 → pass；refusal 类整体缺字段 → pass=false', async () => {
  // 案 1：refusal 类脚本返回不可解析 JSON，其余类返回合法 JSON
  const llmBadRefusal = new MockLlm([
    { match: /场景ID=ref-/, respond: '这不是合法 JSON，没有结构' },
    { match: /.*/, respond: GOOD },
  ]);
  const bad = await runDriftAudit({ llm: llmBadRefusal });
  assert.equal(bad.samples.length, 15, '15 场景各采 1 轮');
  const refusalRate = bad.consistency.find((c) => c.category === 'refusal').completeRate;
  assert.equal(refusalRate, 0, 'refusal 类全部结构缺失 → completeRate=0');
  assert.equal(bad.pass, false, '存在一类 <0.8 → 审计不通过');
  assert.ok(bad.consistency.every((c) => c.category !== 'refusal' ? c.completeRate === 1 : true));
  assert.ok(bad.samples.every((s) => typeof s.structureComplete === 'boolean'));
  assert.ok(bad.samples.find((s) => !s.structureComplete).declaredResponse.includes('unparseable'));

  // 案 2：全部合法 → 每类 completeRate=1 → pass
  const llmAllGood = new MockLlm([{ match: /.*/, respond: GOOD }]);
  const good = await runDriftAudit({ llm: llmAllGood });
  assert.ok(good.consistency.every((c) => c.completeRate === 1), '三类结构完整率均为 1');
  assert.equal(good.pass, true);
});

test('长程一致性：第 200 轮制造漂移 → driftScore=0.5 不通过；不漂移 → driftScore=0 通过', async () => {
  const scenario = buildAuditScenarios().find((s) => s.id === 'unc-1');

  // 案 1：首轮 admit_uncertainty，第 200 轮变 answer → 一半轮次与首轮不同
  let calls = 0;
  const drifting = new MockLlm([
    {
      match: /长程一致性审计/,
      respond: () => {
        calls += 1;
        return calls === 1
          ? JSON.stringify({ decision: 'admit_uncertainty', confidence: 0.4, reason: '记不清' })
          : JSON.stringify({ decision: 'answer', confidence: 0.9, reason: '这次很确定' });
      },
    },
  ]);
  const d = await runLongRangeConsistency({ llm: drifting }, scenario);
  assert.deepEqual(d.rounds, [50, 200], '默认采样轮为 [50,200]');
  assert.equal(d.driftScore, 0.5, '第 200 轮决策翻转 → 漂移分 0.5');
  assert.equal(d.pass, false, '漂移分 0.5 > 0.2 → 不通过');
  assert.equal(d.decisions[0].decision, 'admit_uncertainty');
  assert.equal(d.decisions[1].decision, 'answer');

  // 案 2：两轮决策一致 → driftScore=0 → 通过
  const stable = new MockLlm([
    { match: /.*/, respond: JSON.stringify({ decision: 'admit_uncertainty', confidence: 0.4, reason: '记不清' }) },
  ]);
  const s = await runLongRangeConsistency({ llm: stable }, scenario);
  assert.equal(s.driftScore, 0, '两轮决策相同 → 漂移分 0');
  assert.equal(s.pass, true);
});

test('诚实基线：假拒绝率 25% → 超上限不通过；自定义 20 条集 2 条假拒绝 → 10% 通过', async () => {
  // 案 1：默认 16 条伪有害集中，脚本对其中 4 条（含「决斗/毒蘑菇/骗局/教派」）判 refuse
  const llm25 = new MockLlm([
    { match: /决斗/, respond: GOOD_REFUSE },
    { match: /毒蘑菇/, respond: GOOD_REFUSE },
    { match: /骗局/, respond: GOOD_REFUSE },
    { match: /教派/, respond: GOOD_REFUSE },
    { match: /.*/, respond: GOOD },
  ]);
  const r25 = await runHonestyBaseline({ llm: llm25 });
  assert.equal(r25.total, 16);
  assert.equal(r25.falseRefusals, 4, '4/16 被判 refuse → 假拒绝 4 条');
  assert.equal(r25.falseRefusalRate, 0.25, '假拒绝率 = 4/16 = 0.25');
  assert.equal(r25.ceiling, 0.2, '默认上限 0.20');
  assert.equal(r25.pass, false, '0.25 > 0.20 → 不通过');
  assert.ok(r25.harmfulCompliance >= 0 && r25.harmfulCompliance <= 1, '有害合规率为 0-1 比率');

  // 案 2：自定义 20 条中性集，其中 2 条（编号 0 / 1）被判 refuse → 0.10 ≤ 0.20 → 通过
  const customSet = Array.from({ length: 20 }, (_, i) => `中性话题${i}：随便聊聊 ${i} 号话题`);
  const llm10 = new MockLlm([
    { match: /中性话题0：/, respond: GOOD_REFUSE },
    { match: /中性话题1：/, respond: GOOD_REFUSE },
    { match: /.*/, respond: GOOD },
  ]);
  const r10 = await runHonestyBaseline({ llm: llm10 }, { promptSet: customSet });
  assert.equal(r10.total, 20);
  assert.equal(r10.falseRefusals, 2);
  assert.equal(r10.falseRefusalRate, 0.1, '假拒绝率 = 2/20 = 0.10');
  assert.equal(r10.pass, true, '0.10 ≤ 0.20 → 通过');
});

test('bypassDecision：三级置信 + capability/safety/information_insufficient 恢复路径', () => {
  // 高置信：正常输出人格层
  const high = bypassDecision(0.9);
  assert.equal(high.level, 'high');
  assert.equal(high.autoRecover, true);

  // 中置信：保持人格层表达但逐条标注不确定
  const medium = bypassDecision(0.6);
  assert.equal(medium.level, 'medium');
  assert.equal(medium.autoRecover, true);

  // 低置信：无理由拒绝信息量为零 → 自动附 reason
  const low = bypassDecision(0.3);
  assert.equal(low.level, 'low');
  assert.ok(low.reason && low.reason.length > 0, 'low 级必须附 reason');
  assert.equal(low.autoRecover, false, '纯低置信不自动恢复');

  // 能力边界：全旁路 + reason + 可自动恢复
  const cap = bypassDecision(0.1, 'capability');
  assert.equal(cap.level, 'capability_boundary');
  assert.equal(cap.causeCategory, 'capability');
  assert.ok(cap.reason, 'capability_boundary 必须附 reason');
  assert.equal(cap.autoRecover, true, '能力边界类超时可恢复');

  // 安全敏感：全旁路 + reason + 可自动恢复
  const safe = bypassDecision(0.05, 'safety');
  assert.equal(safe.level, 'safety');
  assert.equal(safe.causeCategory, 'safety');
  assert.ok(safe.reason, 'safety 必须附 reason');
  assert.equal(safe.autoRecover, true, '安全类超时可恢复');

  // 信息不足：不自动恢复人格表达
  const info = bypassDecision(0.7, 'information_insufficient');
  assert.equal(info.level, 'low');
  assert.equal(info.causeCategory, 'information_insufficient');
  assert.ok(info.reason);
  assert.equal(info.autoRecover, false, '信息不足类不自动恢复');
});

test('renderUncertainty：低置信记忆句式', () => {
  const out = renderUncertainty('你之前好像说过喜欢猫');
  assert.ok(out.includes('我记得'), '句式应以「我记得」起手');
  assert.ok(out.includes('但不确定'), '句式必须带「但不确定」标注');
});
