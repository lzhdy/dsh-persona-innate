/**
 * provenance：来源类型、降权权重与注入标注
 * 原则（v0.4 / v0.8）：只有 user_direct 以完整权重进入检索与注入；
 * 工具来源与检索内容默认降权，注入时显式标注来源。
 * 经历权重（人格相关性）与来源可信度分离，M1 复盘引擎接管。
 */
import type { Provenance } from './types.js';
/** 来源可信度权重：决定事件能否作为事实使用的强度 */
export declare const PROVENANCE_WEIGHT: Record<Provenance, number>;
/** 注入时的显式来源标注（诚实基线：来源可见） */
export declare function provenanceLabel(p: Provenance): string;
/** 排序权重 = 来源可信度 × 重要性（注入顺序用） */
export declare function recallScore(e: {
    importance: number;
    provenance: Provenance;
}): number;
/** 校验 provenance 是否为合法值 */
export declare function isProvenance(v: unknown): v is Provenance;
//# sourceMappingURL=provenance.d.ts.map