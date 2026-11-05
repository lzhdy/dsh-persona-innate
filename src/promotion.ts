/**
 * P2 巩固闸门：traits 晋升决策（纯函数，无 I/O，可单测）。
 *
 * 机制依据：《记忆架构最终设计 v1.0》§4.4 self_model 晋升门槛 + §10 P2 行。
 * 为什么这是「保守近似」而非完整 §4.4：§4.4 的「≥3 独立证据组」「无未解反证」
 * 需要 trait 级证据（evidence_group_id / contrary_evidence_ids，P3 才补）；而「跨会话」
 * 在 events 层没有 session 字段。故 P2 用现有字段做保守近似：
 *   - ≥1 条非 AI 独白来源（provenance === 'user_direct'）近似 §4.4 条件 3；
 *   - 跨 ≥2 个日期（time.slice(0,10) 去重）近似 §4.4 条件 2 的「跨会话」。
 *
 * 预期效果（对齐 ADR-2「默认冻结」）：复盘是增量窗口（游标开区间），单次窗口
 * 几乎都落在同一天 → crossDate 恒 false → traits 默认不晋升、进 candidate。
 * 该门槛对负面自述与正面自述对称（「我记忆好乱」与「我记性很好」同受限制）。
 */
import type { PersonaEvent, PromotionDecision } from './types.js';

export type { PromotionDecision };

/**
 * 判定一批候选 traits 是否允许晋升为 stable。
 * 两条条件须同时满足才 promote=true；否则 promote=false，reason 写明缺哪条。
 */
export function decidePromotion(
  candidateTraits: readonly string[],
  reflectEvents: readonly PersonaEvent[],
): PromotionDecision {
  // 防御：剔除空串 / 纯空白 / 非字符串条目后仍无有效候选 → 视为无候选。
  const effective = (candidateTraits ?? []).filter(
    (t) => typeof t === 'string' && t.trim().length > 0,
  );
  if (effective.length === 0) {
    return { promote: false, reason: '无候选特质' };
  }

  const hasUserDirect = reflectEvents.some((e) => e.provenance === 'user_direct');
  if (!hasUserDirect) {
    return { promote: false, reason: '缺少非 AI 独白来源（需 ≥1 条 provenance=user_direct 的事件）' };
  }

  // malformed 事件（time 缺失/非字符串）不计入跨日期统计：只统计能确定日期的事件。
  const dates = new Set(
    reflectEvents.filter((e) => typeof e.time === 'string').map((e) => e.time.slice(0, 10)),
  );
  const crossDate = dates.size >= 2;
  if (!crossDate) {
    return { promote: false, reason: '仅跨单个日期（需 ≥2 个不同日期的事件）' };
  }

  return { promote: true, reason: '满足：≥1 条 user_direct 来源且跨 ≥2 个日期' };
}
