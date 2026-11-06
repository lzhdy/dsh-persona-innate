/**
 * P2 巩固闸门：traits 晋升决策（纯函数，无 I/O，可单测）。
 *
 * 机制依据：《记忆架构最终设计 v1.0》§4.4 self_model 晋升门槛 + §10 P2 行。
 * 为什么这是「保守近似」而非完整 §4.4：§4.4 的「≥3 独立证据组」「无未解反证」
 * 需要 trait 级证据（evidence_group_id / contrary_evidence_ids，P3 才补）；而「跨会话」
 * 在 events 层没有 session 字段。故这里用现有字段做保守近似：
 *   - ≥1 条非 AI 独白来源（provenance === 'user_direct'）近似 §4.4 条件 3；
 *   - 跨 ≥2 个日期（time.slice(0,10) 去重）近似 §4.4 条件 2 的「跨会话」。
 *
 * ── ISS-048 为什么会重写（原实现是单向棘轮）──────────────────────
 * 原签名是 `decidePromotion(candidateTexts, reflectEvents)`：证据取"本次复盘窗口"。
 * 复盘窗口是增量区间（游标开区间），单次窗口几乎总落在同一天 → 跨日期恒 false →
 * 没有任何候选能晋升，`candidateTraits` 只进不出。正确口径是**看候选自己的证据**：
 * 泛化特质自带 sourceEventIds，把它拿去全量事件里查时间，才能数出"跨几个日期"。
 * 同一仓库里 procedures 早已是这么判的（decideProcedurePromotion），本文件与之对齐。
 *
 * 用户已拍板的两条前提：
 * 1. LLM 即时产出的 traits（diff.traits）没有事件证据 → 只进候选，永不晋升；
 * 2. 只有带证据的泛化特质可晋升，且须「跨 ≥2 日期」+「≥1 条 user_direct」。
 */
import type { CandidateTrait } from './types.js';

/** 证据事件的判定视图（只取判定要用的两个字段，避免把整条事件传进纯函数） */
export interface TraitEvidence {
  time: string;
  provenance: string;
}

/** 逐候选判决（promote=true 才允许进 stable） */
export interface TraitPromotionResult {
  text: string;
  promote: boolean;
  /** 可审计的理由，无论晋升与否都非空 */
  reason: string;
}

/**
 * 逐候选判定 traits 是否允许晋升为 stable。
 *
 * 五步顺序即优先级，reason 文案是冻结口径（/persona review 与测试都按它断言）：
 * 1. 没有证据 → 冻结（覆盖旧 string[] 数据与 LLM 即时 traits）；
 * 2. 有 id 但一条都查不到 → 冻结（事件可能已归档，不能凭不存在的证据晋升）；
 * 3. 证据只落在 1 个日期 → 冻结（"跨会话"是门槛本身）；
 * 4. 证据里全是 AI 独白 → 冻结（自己说自己是怎样的人，不算数）；
 * 5. 全过 → 晋升。
 *
 * 为什么不看"当次复盘窗口"：窗口是天为单位裁的，而门槛问的是这条候选的一生。
 * 这也是本函数与已删除的 decidePromotion 的唯一实质差别。
 */
export function decideTraitPromotions(
  candidates: readonly CandidateTrait[],
  evidence: ReadonlyMap<string, TraitEvidence>,
): TraitPromotionResult[] {
  const results: TraitPromotionResult[] = [];
  for (const c of candidates ?? []) {
    const text = typeof c?.text === 'string' ? c.text.trim() : '';
    if (!text) continue; // 空文本不是候选（防御：LLM 可能吐空白）

    const ids = Array.isArray(c.sourceEventIds) ? c.sourceEventIds.filter((id) => typeof id === 'string') : [];
    if (ids.length === 0) {
      results.push({ text, promote: false, reason: '候选无证据（sourceEventIds 为空）' });
      continue;
    }

    // 去重后仍为空 → 证据全是编造的 id（或事件已被归档清理）
    const hits = [...new Set(ids)].map((id) => evidence.get(id)).filter((e): e is TraitEvidence => !!e);
    if (hits.length === 0) {
      results.push({ text, promote: false, reason: '证据事件不存在（可能已归档）' });
      continue;
    }

    const dates = new Set(
      hits.filter((e) => typeof e.time === 'string').map((e) => e.time.slice(0, 10)),
    );
    if (dates.size < 2) {
      results.push({ text, promote: false, reason: '仅跨单个日期（需 ≥2 个不同日期的事件）' });
      continue;
    }

    if (!hits.some((e) => e.provenance === 'user_direct')) {
      results.push({
        text,
        promote: false,
        reason: '缺少非 AI 独白来源（需 ≥1 条 provenance=user_direct 的事件）',
      });
      continue;
    }

    results.push({ text, promote: true, reason: `满足：证据跨 ${dates.size} 个日期且含 user_direct 来源` });
  }
  return results;
}
