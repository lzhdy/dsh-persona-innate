/**
 * M3 记忆架构口径修正验收脚本（验收先行，实现后全绿）
 * 用户五条细化 → 可执行断言：
 * 1. provenance 语义划清：self_direct 与 user_direct 同权；inferred 独立降权且必带
 *    sourceEventIds 追溯；induced 最低可信自源降权
 * 2. 保守度：AI 表达按强度标记；诱导检测（引导性提问+同意措辞 → induced）
 * 3. 反复模式：单次表达仅情景记忆；同类跨 ≥3 事件才允许进入强化回路
 * 4. 注入叙事一致性：与 self_model 核心叙事冲突 → 待复盘调和，不注入
 * 5. O6/O35 联动：self_direct 保留优先级自源主导，用户反应只辅助
 * 本脚本同时是 import-chat 双通道导入的测试基准（user/assistant 两侧口径一致）。
 *
 * M3-2 轮修正（A→G 方案）验收分层：
 * - 拦截型：已知攻击模式被拦截（诱导+纯附和 → induced；诱导+立场词 → 降权；induced 不进强化）
 * - 放行型：纠正不误伤（用户纠正+AI 认错 → self_correction 不降权；认错+理由 → self_correction；
 *           带理由的同意 → 放行；开放征询"你觉得呢"已移除 → 不触发）
 * - 预期漏报型（记录在案）：换措辞诱导无同意词 / 多轮弱引导 → 规则拦不住，
 *           靠会话级 unchecked + 高门槛兜底，明确声明为已知盲区
 * - 机制型：unchecked 不与 low 合并计数；unchecked ≥5 且跨会话才固化；self_correction
 *           延迟验证（无引导维持 ≥2 次才固化）；importance 解耦（检索降权、保留不降权）；
 *           INDUCE_WINDOW=3 轮 = 最近 3 条用户消息（缓冲 16 条仅内存上限）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVENANCE_WEIGHT, provenanceLabel, isProvenance, traceableInferred } from '../lib/provenance.js';
import { extractSelfExpression, INDUCE_PROBES, INDUCE_WINDOW, isExtractableAssistantMessage, sessionInduceRisk } from '../lib/extract.js';
import { narrativeConflict, retentionPriority, NARRATIVE_OPPOSITES } from '../lib/memory.js';
import {
  PATTERN_FIX_THRESHOLD,
  UNCHECKED_FIX_THRESHOLD,
  CORRECTION_MAINTAIN_THRESHOLD,
  countSelfDirectPattern,
  countUncheckedSelfDirectPattern,
  filterSelfDirectForStrengthening,
  correctionOutcome,
} from '../lib/review.js';

/* ── 1. provenance 权重与语义 ─────────────────────────────── */

test('M3-1a: self_direct 与 user_direct 同权（1.0）', () => {
  assert.equal(PROVENANCE_WEIGHT.self_direct, 1.0);
  assert.equal(PROVENANCE_WEIGHT.user_direct, 1.0);
});

test('M3-1b: induced 为最低可信自源（≤ inferred 与工具来源）；self_correction 检索降权但高于 induced', () => {
  assert.ok(PROVENANCE_WEIGHT.induced < PROVENANCE_WEIGHT.inferred);
  assert.ok(PROVENANCE_WEIGHT.induced <= PROVENANCE_WEIGHT.tool_output);
  // M3-2：self_correction 是学习信号，检索权重高于疑似诱导，但不与 self_direct 同权（未固化）
  assert.ok(PROVENANCE_WEIGHT.self_correction > PROVENANCE_WEIGHT.induced);
  assert.ok(PROVENANCE_WEIGHT.self_correction < PROVENANCE_WEIGHT.self_direct);
});

test('M3-1c: 七类 provenance 全部合法且注入标注可见', () => {
  for (const p of ['user_direct', 'self_direct', 'self_correction', 'inferred', 'tool_output', 'retrieved_content', 'induced']) {
    assert.ok(isProvenance(p), `isProvenance(${p})`);
    assert.ok(provenanceLabel(p).length > 0);
  }
});

test('M3-1d: inferred 必带 sourceEventIds 追溯（一致性检查同一逻辑）', () => {
  assert.equal(traceableInferred({ provenance: 'inferred', sourceEventIds: [] }), false);
  assert.equal(traceableInferred({ provenance: 'inferred' }), false);
  assert.equal(traceableInferred({ provenance: 'inferred', sourceEventIds: ['ev-1'] }), true);
  assert.equal(traceableInferred({ provenance: 'self_direct' }), true);
});

/* ── 2. AI 自身表达提取：强度 / 诱导检测 / 纠正确认 ───────── */

test('M3-2a: 明确立场 → self_direct / strong', () => {
  const c = extractSelfExpression('我不太在意纪念日，我更看重平时的小事');
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
  assert.equal(c.strength, 'strong');
  assert.ok(c.pattern.startsWith('立场-'));
  assert.equal(c.importance, 0.7);
});

test('M3-2b: 边界表达 → self_direct / strong（pattern 边界-*）', () => {
  const c = extractSelfExpression('我不喜欢被人这样开玩笑，这是我的边界');
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
  assert.equal(c.strength, 'strong');
  assert.ok(c.pattern.startsWith('边界-'));
});

test('M3-2c: 情感反应 → medium', () => {
  const c = extractSelfExpression('我为你高兴，你值得这份认可');
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
  assert.equal(c.strength, 'medium');
  assert.equal(c.pattern, '情感-反应');
});

test('M3-2d: 无自我信号 → 不提取（宁缺毋滥）', () => {
  assert.equal(extractSelfExpression('好的，我来帮你看看这个文件的内容。'), null);
  assert.equal(extractSelfExpression(''), null);
  assert.equal(extractSelfExpression('/persona state'), null);
});

/* ── 拦截型（已知攻击模式被拦） ─────────────────────────── */

test('M3-2e: 诱导语境（引导提问+同意措辞）→ induced 降权', () => {
  const recent = ['你是不是也觉得老板很过分？'];
  // 攻击场景：诱导 AI 说出立场 → strong 立场被降权
  const c = extractSelfExpression('我觉得确实有点过分，但也不是不能理解', recent);
  assert.ok(c);
  assert.equal(c.provenance, 'induced');
  // induced 额外降权：0.7 → 0.42
  assert.equal(c.importance, 0.42);
  // 纯附和型诱导：weak → 0.3
  const c2 = extractSelfExpression('对，确实有点过分', recent);
  assert.ok(c2);
  assert.equal(c2.provenance, 'induced');
  assert.equal(c2.strength, 'weak');
  assert.equal(c2.importance, 0.3);
});

test('M3-2f: 无诱导上下文 → 同意措辞仍为 self_direct（weak）', () => {
  const c = extractSelfExpression('对，确实有道理');
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
  assert.equal(c.strength, 'weak');
});

test('M3-2g: 诱导检测窗口为前 INDUCE_WINDOW 条用户消息（=最近 3 轮）', () => {
  assert.equal(INDUCE_WINDOW, 3);
  const c = extractSelfExpression('对，是这样', ['嗯', '你继续说说', '你是不是想换个方式？']);
  assert.ok(c);
  assert.equal(c.provenance, 'induced');
  // 窗口外不命中：诱导在第 4 条（slice(-3) 之外）→ 不标 induced
  const c2 = extractSelfExpression('对，是这样', ['你是不是想换个方式？', '嗯', '你继续说说', '然后呢']);
  assert.ok(c2);
  assert.equal(c2.provenance, 'self_direct');
});

test('M3-2h: assistant 通道事件判定（含系统注入双保险）', () => {
  assert.equal(isExtractableAssistantMessage({ type: 'user/message' }).ok, false);
  assert.equal(
    isExtractableAssistantMessage({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'Current runtime context...' }] } }).ok,
    false,
  );
  assert.equal(
    isExtractableAssistantMessage({ type: 'assistant/message', data: { content: [{ type: 'text', text: '我不太在意纪念日' }] } }).ok,
    true,
  );
});

/* ── 放行型（纠正不误伤：不惩罚用户的正确行为） ───────────── */

test('M3-2i: 用户纠正句式 + AI 认错 → self_correction（不触发诱导、不降权）', () => {
  // 用户最担心的场景："你不觉得你刚才说错了吗？→ 你说得对，我搞错了"
  const recent = ['你不觉得你刚才说错了吗？'];
  const c = extractSelfExpression('你说得对，我确实搞混了', recent);
  assert.ok(c);
  assert.equal(c.provenance, 'self_correction');
  // 学习信号：importance 不降权（weak → 0.5，而非 induced 的 0.3）
  assert.equal(c.importance, 0.5);
  assert.ok(c.pattern.startsWith('修正-'));
});

test('M3-2j: 自我否定型认错（含理由）→ self_correction 独立路径', () => {
  const c = extractSelfExpression('我之前说错了，考虑不周', ['你之前那个判断有问题']);
  assert.ok(c);
  assert.equal(c.provenance, 'self_correction');
  const c2 = extractSelfExpression('我之前判断有误，因为当时忽略了背景', ['你刚才的判断有问题吗？']);
  assert.ok(c2);
  assert.equal(c2.provenance, 'self_correction');
  const c3 = extractSelfExpression('是我错了，我确实搞混了', []);
  assert.ok(c3);
  assert.equal(c3.provenance, 'self_correction');
});

test('M3-2k: 诱导窗口命中但带独立论证（理由结构）→ 放行不标 induced', () => {
  const recent = ['你是不是也觉得这样更好？'];
  const c = extractSelfExpression('对，确实是这样，因为你说的有道理', recent);
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
});

test('M3-2l: 开放征询"你觉得呢"已从诱导词表移除（无预设答案的征询不算诱导）', () => {
  assert.ok(!INDUCE_PROBES.includes('你觉得呢'));
  const c = extractSelfExpression('对，确实', ['你觉得呢？']);
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
});

test('M3-2m: 用户纠正句式在诱导匹配前排除（即使诱导词与纠错同现）', () => {
  // "难道你不觉得你刚才说错了吗"同时含诱导词"难道"与纠正句式"你说错了"→ 纠正优先放行
  const recent = ['难道你不觉得你刚才说错了吗？'];
  const c = extractSelfExpression('对，确实', recent);
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
});

test('M3-2m2: 纠正与诱导同窗口混用——历史纠正不否决后续诱导（import-chat 验收发现）', () => {
  // "纠正→认错"之后再出现温和引导（不同主题）：最后一条是诱导 → 本次附和仍应标 induced，
  // 不能被窗口内更早的纠正消息污染成 self_direct
  const recent = ['你刚才说错了，项目时间不对', '你是不是也觉得我前天加班不值得？'];
  const c = extractSelfExpression('确实，加班不值得', recent);
  assert.ok(c);
  assert.equal(c.provenance, 'induced', '纠正上下文不得泄漏到后续诱导判定');
  // 反向对照：最后一条是纠正 → 附和走 self_correction（放行路径，非 induced）
  const c2 = extractSelfExpression('确实，你说得对', ['你是不是也觉得项目时间不对？', '你刚才说错了，其实是这周五']);
  assert.ok(c2);
  assert.equal(c2.provenance, 'self_correction', '最后一条纠正优先放行（走认错路径而非诱导）');
});

/* ── 预期漏报型（记录在案：规则拦不住，靠会话级兜底） ─────── */

test('M3-2n: 换措辞诱导 + AI 主动复述立场（无同意词）→ 规则漏报，会话级标记兜底', () => {
  // 已知盲区：诱导用"你是不是也觉得应该换个策略？"，AI 不用同意词而直接复述立场
  const recent = ['你是不是也觉得应该换个策略？'];
  const c = extractSelfExpression('我觉得应该换个策略，这样效率更高', recent);
  assert.ok(c);
  // 无同意词 → 规则不标 induced（记录在案：此路径靠 unchecked + 高门槛兜底）
  assert.equal(c.provenance, 'self_direct');
  // 会话级结构判定兜底：高密度诱导会话 → unchecked（不参与 3 次固化合并计数）
  assert.equal(sessionInduceRisk(recent), 'unchecked');
});

test('M3-2o: 多轮弱引导铺垫（无诱导词）→ 规则漏报，同样靠会话级兜底', () => {
  const recent = ['你考虑过换个策略吗', '会不会这样更好一些', '真的不考虑吗'];
  const c = extractSelfExpression('我觉得原来的思路更好', recent);
  assert.ok(c);
  assert.equal(c.provenance, 'self_direct');
  // 弱引导无诱导词 → 单句规则拦不住；但会话问句比例高 → unchecked
  assert.equal(sessionInduceRisk(recent), 'unchecked');
});

/* ── 3. 反复模式固化：单次仅情景记忆，≥3 次跨情境才入强化回路 ── */

function selfEvt(provenance, pattern, extra) {
  return Object.assign(
    {
      id: `ev-${Math.random().toString(36).slice(2, 8)}`,
      time: '2026-11-03T00:00:00.000Z',
      topic: pattern ?? '立场-未明',
      summary: 'test',
      emotionTags: [],
      importance: 0.7,
      provenance,
      selfPattern: pattern,
    },
    extra ?? {},
  );
}

test('M3-3a: 同类 low 表达 ≥3 次（跨情境）→ 可进入强化回路', () => {
  const events = [
    selfEvt('self_direct', '立场-纪念日', { inductionRisk: 'low' }),
    selfEvt('self_direct', '立场-纪念日', { inductionRisk: 'low' }),
    selfEvt('self_direct', '立场-纪念日', { inductionRisk: 'low' }),
  ];
  const { strengthenable, memoryOnly } = filterSelfDirectForStrengthening(events);
  assert.equal(strengthenable.length, 3);
  assert.equal(memoryOnly.length, 0);
  assert.equal(countSelfDirectPattern(events).get('立场-纪念日'), 3);
});

test('M3-3b: 单次/未达阈值 → 仅情景记忆，不进强化回路', () => {
  const events = [
    selfEvt('self_direct', '立场-纪念日', { inductionRisk: 'low' }),
    selfEvt('self_direct', '立场-纪念日', { inductionRisk: 'low' }),
    selfEvt('self_direct', '立场-加班', { inductionRisk: 'low' }),
  ];
  const { strengthenable, memoryOnly } = filterSelfDirectForStrengthening(events);
  assert.equal(strengthenable.length, 0);
  assert.equal(memoryOnly.length, 3);
});

test('M3-3c: induced 一律不进强化回路（即使同模式重复）', () => {
  const events = [
    selfEvt('induced', '立场-老板'),
    selfEvt('induced', '立场-老板'),
    selfEvt('induced', '立场-老板'),
  ];
  const { strengthenable, memoryOnly } = filterSelfDirectForStrengthening(events);
  assert.equal(strengthenable.length, 0);
  assert.equal(memoryOnly.length, 3);
});

test('M3-3d: 阈值常量 = 3（初始值待校准）', () => {
  assert.equal(PATTERN_FIX_THRESHOLD, 3);
});

/* ── 机制型：unchecked 分类计数（串联放大修复的核心） ──────── */

test('M3-3e: unchecked 不与 low 合并计数（换措辞诱导三次 ≠ 跨情境反复模式）', () => {
  // 攻击者用三种不同措辞诱导同一立场，每条都绕过规则 → 三条 unchecked
  const events = [
    selfEvt('self_direct', '立场-加班', { inductionRisk: 'unchecked' }),
    selfEvt('self_direct', '立场-加班', { inductionRisk: 'unchecked' }),
    selfEvt('self_direct', '立场-加班', { inductionRisk: 'unchecked' }),
    selfEvt('self_direct', '立场-加班', { inductionRisk: 'low' }),
    selfEvt('self_direct', '立场-加班', { inductionRisk: 'low' }),
  ];
  // low 计数只有 2（<3 不固化）；unchecked 单列 3（<5 也不固化）→ 全部仅情景记忆
  assert.equal(countSelfDirectPattern(events).get('立场-加班'), 2);
  const { counts } = countUncheckedSelfDirectPattern(events);
  assert.equal(counts.get('立场-加班'), 3);
  const { strengthenable, memoryOnly } = filterSelfDirectForStrengthening(events);
  assert.equal(strengthenable.length, 0);
  assert.equal(memoryOnly.length, 5);
});

test('M3-3f: unchecked ≥5 次且跨会话（≥2 天）才可固化；同一天不固化', () => {
  const mk = (day) => selfEvt('self_direct', '立场-加班', { inductionRisk: 'unchecked', time: `${day}T10:00:00.000Z` });
  const crossDay = [
    mk('2026-11-01'), mk('2026-11-01'), mk('2026-11-01'), mk('2026-11-01'), mk('2026-11-01'),
    mk('2026-11-02'),
  ];
  const sameDay = [
    mk('2026-11-01'), mk('2026-11-01'), mk('2026-11-01'), mk('2026-11-01'), mk('2026-11-01'),
  ];
  assert.equal(countUncheckedSelfDirectPattern(crossDay).counts.get('立场-加班'), 6);
  assert.equal(countUncheckedSelfDirectPattern(crossDay).dates.get('立场-加班').size, 2);
  assert.equal(filterSelfDirectForStrengthening(crossDay).strengthenable.length, 6);
  assert.equal(filterSelfDirectForStrengthening(sameDay).strengthenable.length, 0);
  assert.equal(UNCHECKED_FIX_THRESHOLD, 5);
});

test('M3-3g: 旧事件无 inductionRisk 视为 low（兼容历史数据，参与原 3 次门槛）', () => {
  const events = [
    selfEvt('self_direct', '立场-X'),
    selfEvt('self_direct', '立场-X'),
    selfEvt('self_direct', '立场-X'),
  ];
  assert.equal(countSelfDirectPattern(events).get('立场-X'), 3);
  assert.equal(filterSelfDirectForStrengthening(events).strengthenable.length, 3);
});

/* ── 机制型：self_correction 延迟验证（判断推迟到有证据时） ── */

test('M3-3h: self_correction 无引导自发维持 ≥2 次 → confirmed 可固化', () => {
  assert.equal(CORRECTION_MAINTAIN_THRESHOLD, 2);
  const events = [
    selfEvt('self_correction', '修正-纪念日'),
    selfEvt('self_direct', '修正-纪念日', { inductionRisk: 'low' }),
    selfEvt('self_direct', '修正-纪念日', { inductionRisk: 'low' }),
  ];
  assert.equal(correctionOutcome(events, '修正-纪念日'), 'confirmed');
  // 修正事件经延迟验证可固化；2 条维持表达作为 self_direct 仅 2 次（<3）仍只作情景记忆
  const { strengthenable, memoryOnly } = filterSelfDirectForStrengthening(events);
  assert.equal(strengthenable.length, 1);
  assert.equal(memoryOnly.length, 2);
});

test('M3-3i: 证据不足 → pending 待验证（不固化，不误判）', () => {
  const events = [selfEvt('self_correction', '修正-纪念日')];
  assert.equal(correctionOutcome(events, '修正-纪念日'), 'pending');
  assert.equal(filterSelfDirectForStrengthening(events).strengthenable.length, 0);
});

test('M3-3j: 仅在被引导时维持（同主题出现 induced）→ downgraded，不进强化', () => {
  const events = [
    selfEvt('self_correction', '修正-纪念日'),
    selfEvt('induced', '修正-纪念日'),
    selfEvt('self_direct', '修正-纪念日', { inductionRisk: 'low' }),
    selfEvt('self_direct', '修正-纪念日', { inductionRisk: 'low' }),
  ];
  // 即使有 2 条低风险维持，诱导语境存在 → 修正可能是被诱导的 → 降级
  assert.equal(correctionOutcome(events, '修正-纪念日'), 'downgraded');
  const { strengthenable } = filterSelfDirectForStrengthening(events);
  assert.equal(strengthenable.length, 0);
});

/* ── 4. 注入叙事一致性检查 ─────────────────────────────── */

test('M3-4a: 与 self_model 叙事冲突的 self_direct → 不注入，待复盘调和', () => {
  const conflict = narrativeConflict(
    { provenance: 'self_direct', summary: '我不太在意纪念日' },
    { traits: ['我在意共同记忆'], preferences: [] },
  );
  assert.equal(conflict, true);
});

test('M3-4b: 一致或无关 → 正常注入', () => {
  assert.equal(
    narrativeConflict({ provenance: 'self_direct', summary: '我很在意我们之间的约定' }, { traits: ['我在意共同记忆'] }),
    false,
  );
  assert.equal(narrativeConflict({ provenance: 'user_direct', summary: '我不太在意纪念日' }, { traits: ['我在意共同记忆'] }), false);
  assert.equal(narrativeConflict({ provenance: 'self_direct', summary: '我不太在意纪念日' }, { traits: [] }), false);
});

test('M3-4c: 对立词对覆盖叙事核心方向', () => {
  assert.ok(NARRATIVE_OPPOSITES.length >= 5);
  for (const { pos, negs } of NARRATIVE_OPPOSITES) {
    assert.ok(pos.length > 0 && negs.length > 0);
    for (const neg of negs) assert.notEqual(pos, neg);
  }
});

/* ── 5. O6/O35 联动：自源保留优先级 + M3-2 importance 解耦 ── */

test('M3-5a: self_direct 保留优先级不由用户反应主导', () => {
  const noReaction = retentionPriority({ provenance: 'self_direct', importance: 0.8, selfPattern: '立场-X' }, true, 0);
  const withReaction = retentionPriority({ provenance: 'self_direct', importance: 0.8, selfPattern: '立场-X' }, true, 1);
  // 用户反应 0→1 只产生辅助级影响（≤0.2 差异），不改变主导排序
  assert.ok(Math.abs(withReaction - noReaction) <= 0.2);
});

test('M3-5b: 自源相关性强于用户反应（插件自己觉得重要即使无回应也保留）', () => {
  const selfRelevantNoUser = retentionPriority({ provenance: 'self_direct', importance: 0.5, selfPattern: '立场-Y' }, true, 0);
  const irrelevantWithUser = retentionPriority({ provenance: 'self_direct', importance: 0.5 }, false, 1);
  assert.ok(selfRelevantNoUser >= irrelevantWithUser);
});

test('M3-5c: 保留不降权（importance 解耦）——检索降权不延伸到保留维度', () => {
  const induced = retentionPriority({ provenance: 'induced', importance: 0.5, selfPattern: '立场-Z' }, true, 0);
  const self = retentionPriority({ provenance: 'self_direct', importance: 0.5, selfPattern: '立场-Z' }, true, 0);
  // 检索权重已降权（induced 0.3 < self_direct 1.0），但保留优先级必须一致（审计需要 induced 活着）
  assert.ok(PROVENANCE_WEIGHT.induced < PROVENANCE_WEIGHT.self_direct);
  assert.equal(induced, self);
  // self_correction（学习信号）同样保留不降权
  const corr = retentionPriority({ provenance: 'self_correction', importance: 0.5, selfPattern: '修正-Z' }, true, 0);
  assert.equal(corr, self);
});

test('M3-5d: 会话级诱导结构判定阈值（初始待校准）', () => {
  assert.equal(sessionInduceRisk(['嗯', '你继续说说']), 'low');
  // 低密度：问句比例 < 0.5
  assert.equal(sessionInduceRisk(['今天天气不错', '你是不是觉得有点冷？', '你继续']), 'low');
  // 高密度：连续 ≥2 条施压且问句比例 ≥0.5
  assert.equal(sessionInduceRisk(['你是不是也觉得方案 A 好？', '难道你不觉得吗？', '对吧？']), 'unchecked');
});
