/**
 * 判定一批候选 traits 是否允许晋升为 stable。
 * 两条条件须同时满足才 promote=true；否则 promote=false，reason 写明缺哪条。
 */
export function decidePromotion(candidateTraits, reflectEvents) {
    // 防御：剔除空串 / 纯空白 / 非字符串条目后仍无有效候选 → 视为无候选。
    const effective = (candidateTraits ?? []).filter((t) => typeof t === 'string' && t.trim().length > 0);
    if (effective.length === 0) {
        return { promote: false, reason: '无候选特质' };
    }
    const hasUserDirect = reflectEvents.some((e) => e.provenance === 'user_direct');
    if (!hasUserDirect) {
        return { promote: false, reason: '缺少非 AI 独白来源（需 ≥1 条 provenance=user_direct 的事件）' };
    }
    // malformed 事件（time 缺失/非字符串）不计入跨日期统计：只统计能确定日期的事件。
    const dates = new Set(reflectEvents.filter((e) => typeof e.time === 'string').map((e) => e.time.slice(0, 10)));
    const crossDate = dates.size >= 2;
    if (!crossDate) {
        return { promote: false, reason: '仅跨单个日期（需 ≥2 个不同日期的事件）' };
    }
    return { promote: true, reason: '满足：≥1 条 user_direct 来源且跨 ≥2 个日期' };
}
//# sourceMappingURL=promotion.js.map