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
export const SALIENCE_WEIGHT = {
    user_direct: 1.0,
    induced: 0.2,
    inferred: 0.5,
    retrieved_content: 0.1,
    self_correction: 0.5,
    self_direct: 0.35,
    tool_output: 0.15,
};
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