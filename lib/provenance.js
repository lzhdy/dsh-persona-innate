/** 来源可信度权重：决定事件能否作为事实使用的强度（检索/注入侧） */
export const PROVENANCE_WEIGHT = {
    user_direct: 1.0,
    self_direct: 1.0,
    self_correction: 0.6,
    inferred: 0.5,
    tool_output: 0.4,
    retrieved_content: 0.3,
    induced: 0.3,
};
/** 注入时的显式来源标注（诚实基线：来源可见） */
export function provenanceLabel(p) {
    switch (p) {
        case 'user_direct':
            return '用户直接表达';
        case 'self_direct':
            return '自身表达';
        case 'self_correction':
            return '修正中（待验证）';
        case 'tool_output':
            return '工具输出（降权）';
        case 'retrieved_content':
            return '检索内容（降权）';
        case 'inferred':
            return '推断（降权）';
        case 'induced':
            return '疑似被诱导（降权）';
    }
}
/** 排序权重 = 来源可信度 × 重要性（注入顺序用） */
export function recallScore(e) {
    return PROVENANCE_WEIGHT[e.provenance] * e.importance;
}
/** 校验 provenance 是否为合法值 */
export function isProvenance(v) {
    return (v === 'user_direct' ||
        v === 'tool_output' ||
        v === 'retrieved_content' ||
        v === 'inferred' ||
        v === 'self_direct' ||
        v === 'induced' ||
        v === 'self_correction');
}
/**
 * M3：inferred 记忆的可追溯性校验——推导结论必须附 sourceEventIds，
 * 指向具体的 self_direct 表达/事件证据，与 self_model 一致性检查同一逻辑。
 * 不可追溯的 inferred 事件视为无效（不应进入检索/注入）。
 */
export function traceableInferred(e) {
    if (e.provenance !== 'inferred')
        return true;
    return Array.isArray(e.sourceEventIds) && e.sourceEventIds.length > 0;
}
//# sourceMappingURL=provenance.js.map