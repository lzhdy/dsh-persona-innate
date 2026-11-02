/** 来源可信度权重：决定事件能否作为事实使用的强度 */
export const PROVENANCE_WEIGHT = {
    user_direct: 1.0,
    inferred: 0.5,
    tool_output: 0.4,
    retrieved_content: 0.3,
};
/** 注入时的显式来源标注（诚实基线：来源可见） */
export function provenanceLabel(p) {
    switch (p) {
        case 'user_direct':
            return '用户直接表达';
        case 'tool_output':
            return '工具输出（降权）';
        case 'retrieved_content':
            return '检索内容（降权）';
        case 'inferred':
            return '推断';
    }
}
/** 排序权重 = 来源可信度 × 重要性（注入顺序用） */
export function recallScore(e) {
    return PROVENANCE_WEIGHT[e.provenance] * e.importance;
}
/** 校验 provenance 是否为合法值 */
export function isProvenance(v) {
    return v === 'user_direct' || v === 'tool_output' || v === 'retrieved_content' || v === 'inferred';
}
//# sourceMappingURL=provenance.js.map