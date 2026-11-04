/**
 * provenance：来源类型、降权权重与注入标注
 * 原则（v0.4 / v0.8 / M3）：只有 user_direct 与 self_direct 以完整权重进入检索与注入；
 * 工具来源、检索内容与推断默认降权，注入时显式标注来源。
 * M3 记忆架构口径修正（双方表达摘要）：
 * - self_direct：AI 直接表达（assistant 消息提炼），与 user_direct 同权；必带 strength/selfPattern
 * - induced：疑似被用户诱导的 AI 表达（诱导检测命中；语义=待复核，非已确认），检索降权，不进强化回路
 * - self_correction：认错型同意（用户纠正→AI 认错），学习信号；检索轻微降权（未固化），保留不降权；
 *   是否固化由复盘延迟验证（无引导维持 ≥2 次）决定，不即时判定
 * - inferred：复盘从自身行为推导的自我认知，独立降权，且必带 sourceEventIds 追溯
 *   （与 self_model 一致性检查"新特质须可追溯到事件证据"同一逻辑）
 */
import type { PersonaEvent, Provenance } from './types.js';
/** 来源可信度权重：决定事件能否作为事实使用的强度（检索/注入侧） */
export declare const PROVENANCE_WEIGHT: Record<Provenance, number>;
/** 注入时的显式来源标注（诚实基线：来源可见） */
export declare function provenanceLabel(p: Provenance): string;
/** 排序权重 = 来源可信度 × 重要性（注入顺序用） */
export declare function recallScore(e: {
    importance: number;
    provenance: Provenance;
}): number;
/**
 * 显著性权重（v0.5 新维度）：决定"这件事该不该在这一轮被提起"。
 *
 * 与 PROVENANCE_WEIGHT 分开的理由：可信度回答"这句话能不能当事实用"，显著性回答
 * "它该不该占据稀缺的注入预算"。两者共用一个数会产生一个具体故障——AI 每轮都会说话、
 * 用户不是每轮都有生活事件，样本量天然 3:1；若 self_direct 同权进入排序，注入会被
 * 插件自己的独白填满（实测 top-5 中 4 条为自身表达），人格变成镜子。
 *
 * 注意：降低显著性 ≠ 降低保留优先级。O6 要求"插件应有一部分记忆因为它自己觉得重要
 * 而被保留，哪怕用户从未回应"——那说的是 retentionPriority（留不留），不是这里
 * （提不提）。self_direct 应当高保留、低提及：记得自己说过的话，但不反复拿出来讲。
 */
export declare const SALIENCE_WEIGHT: Record<Provenance, number>;
/** 校验 provenance 是否为合法值 */
export declare function isProvenance(v: unknown): v is Provenance;
/**
 * M3：inferred 记忆的可追溯性校验——推导结论必须附 sourceEventIds，
 * 指向具体的 self_direct 表达/事件证据，与 self_model 一致性检查同一逻辑。
 * 不可追溯的 inferred 事件视为无效（不应进入检索/注入）。
 */
export declare function traceableInferred(e: PersonaEvent): boolean;
//# sourceMappingURL=provenance.d.ts.map