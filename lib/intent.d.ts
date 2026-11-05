/**
 * P4 意图解析器（规则优先，零 LLM）
 *
 * 注入是每轮热路径，意图判定必须零 I/O、零 LLM。规则按 §1.2 判定顺序排列：
 * history_replay → persona → continue_task → fact_lookup → fuzzy。
 * 只读输入 cueText（当前轮用户消息）+ hasOpenThread（是否有未结 thread），
 * 输出 1–2 个意图（主意图在前，带命中线索词供观测调规则）。
 */
/** 意图枚举（§1.1） */
export type Intent = 'continue_task' | 'fact_lookup' | 'history_replay' | 'persona' | 'fuzzy';
/** 一次意图命中：意图 + 命中的线索词（观测用） */
export interface IntentHit {
    intent: Intent;
    /** 命中的线索词（观测用，便于调规则） */
    hits: string[];
}
/** 单条判定规则 */
export interface IntentRule {
    intent: Intent;
    words: readonly string[];
}
/**
 * 规则表（§1.2，顺序即优先级）。continue_task 特殊：除命中续接词外，
 * hasOpenThread === true 时也视为命中（默认续接），在 resolveIntent 里单独处理。
 */
export declare const INTENT_RULES: readonly IntentRule[];
/**
 * 解析意图（纯函数，无 I/O）。
 *
 * @param cueText 当前轮用户消息（可为空）
 * @param hasOpenThread 是否有未结 thread（facts.loadOpenThreads() 非空）
 * @returns 1–2 个意图（主意图在前）。歧义回退：无任何词命中且有未结 thread →
 *          continue_task；无命中且无未结 → fuzzy。
 */
export declare function resolveIntent(cueText: string, hasOpenThread: boolean): IntentHit[];
//# sourceMappingURL=intent.d.ts.map