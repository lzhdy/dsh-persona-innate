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
export declare function decideProcedurePromotion(candidate: PersonaProcedure, eventTimes?: ReadonlyMap<string, string>): PromotionDecision;
//# sourceMappingURL=procedure-promotion.d.ts.map