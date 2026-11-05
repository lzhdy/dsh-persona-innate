/** procedure 晋升判定（§4.4 保守近似）：candidate → active 须跨 ≥2 个日期 */
export function decideProcedurePromotion(candidate, eventTimes) {
    const days = new Set();
    for (const id of candidate.sourceEventIds) {
        const t = eventTimes?.get(id);
        if (t)
            days.add(t.slice(0, 10));
    }
    if (days.size >= 2)
        return { promote: true, reason: `跨 ${days.size} 个日期，做法稳定` };
    return { promote: false, reason: `证据仅 ${days.size} 个日期，不足 2，保持 candidate` };
}
//# sourceMappingURL=procedure-promotion.js.map