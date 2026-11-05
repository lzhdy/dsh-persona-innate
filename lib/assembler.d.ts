/**
 * P4 按意图装配器（`assemble` 为纯函数，数据加载不在这里做，测试友好）
 *
 * 输入已加载的各层数据（attributes/events/rawTurns/selfModel/state），按意图选主读层、
 * 定预算、过配额闸门，产出带标签工作记忆（AssembleResult）。
 *
 * 配额闸门（§2.3，替代旧机械 50%）：
 * 1. evidence_group ≤40% 或 ≤2 槽；
 * 2. ai_inference ≤30%（persona 意图除外）；
 * 3. 总预算 ≤ DEFAULT_ASSEMBLE_BUDGET_TOKENS（截断在闸门之后）。
 *
 * 本模块零 LLM、零写路径；空数据源不抛错，返回空文本。
 */
import type { PersonaAttribute, PersonaEvent, PersonaStateFile, RawTurn, SelfModelSnapshot } from './types.js';
import type { Intent } from './intent.js';
/** 总预算默认值（§2.3 第 3 条，p95 口径） */
export declare const DEFAULT_ASSEMBLE_BUDGET_TOKENS = 1200;
/** evidence_group 占总预算比例上限（§2.3 第 1 条） */
export declare const EVIDENCE_GROUP_BUDGET_RATIO = 0.4;
/** evidence_group 槽位上限（§2.3 第 1 条） */
export declare const EVIDENCE_GROUP_MAX_SLOTS = 2;
/** ai_inference 占总预算比例上限（§2.3 第 2 条，persona 除外） */
export declare const AI_INFERENCE_BUDGET_RATIO = 0.3;
/** 装配条目的层类别（§2.4） */
export type AssembleItemKind = 'fact' | 'event' | 'self' | 'state' | 'raw';
/** 单条装配结果（§2.4） */
export interface AssembleItem {
    kind: AssembleItemKind;
    ref: string;
    text: string;
    epistemicType?: string;
}
/** 装配统计（§2.4） */
export interface AssembleStats {
    /** 最终条目里不同 evidenceGroupId 的数量 */
    evidenceGroups: number;
    /** 最终条目里 epistemicType==='ai_inference' 的数量 */
    aiInferenceCount: number;
    /** 使用的 token 预算 */
    budgetTokens: number;
}
/** 装配输出（§2.4） */
export interface AssembleResult {
    intent: Intent[];
    items: AssembleItem[];
    /** 带标签工作记忆（与旧 buildInjection 同款格式，便于 diff） */
    text: string;
    stats: AssembleStats;
}
/** 装配输入：各层已加载数据（数据加载由调用方完成） */
export interface AssembleInput {
    attributes?: readonly PersonaAttribute[];
    events?: readonly PersonaEvent[];
    rawTurns?: readonly RawTurn[];
    selfModel?: SelfModelSnapshot | null;
    state?: PersonaStateFile | null;
    /** 装配时刻（毫秒），用于 validFrom/validTo 判定与相对时间标注 */
    now?: number;
}
/** token 粗略口径：中文 1 字符 ≈ 1 token（混合文本用字符数近似，测试可验证） */
export declare function estimateTokens(text: string): number;
/**
 * 按意图装配（纯函数）。
 *
 * @param input 已加载的各层数据
 * @param intents resolveIntent 的结果（取 [0] 为主意图）
 * @param budgetTokens 总预算（token 口径，默认 1200）
 */
export declare function assemble(input: AssembleInput, intents: readonly Intent[], budgetTokens?: number): AssembleResult;
//# sourceMappingURL=assembler.d.ts.map