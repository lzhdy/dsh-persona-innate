/**
 * 增量1 procedures 晋升闸门（§4.4 保守近似，纯函数，无 I/O，可单测）。
 *
 * 与 traits 的 decidePromotion（P2）同一设计（ADR-2「默认冻结」）：
 * candidate → active 须跨 ≥2 个日期。单日复盘窗口下恒 false → procedures
 * 默认冻结在 candidate，等跨日期累积后自动晋升。这是 ADR-2 的刻意设计，
 * 不追求即时晋升。
 */
import type { PersonaProcedure, PromotionDecision } from './types.js';

/** procedure 晋升判定（§4.4 保守近似）：candidate → active 须跨 ≥2 个日期 */
export function decideProcedurePromotion(
  candidate: PersonaProcedure,
  eventTimes?: ReadonlyMap<string, string>,
): PromotionDecision {
  const days = new Set<string>();
  for (const id of candidate.sourceEventIds) {
    const t = eventTimes?.get(id);
    if (t) days.add(t.slice(0, 10));
  }
  if (days.size >= 2) return { promote: true, reason: `跨 ${days.size} 个日期，做法稳定` };
  return { promote: false, reason: `证据仅 ${days.size} 个日期，不足 2，保持 candidate` };
}
