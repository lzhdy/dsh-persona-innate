/**
 * 逐候选判定 traits 是否允许晋升为 stable。
 *
 * 五步顺序即优先级，reason 文案是冻结口径（/persona review 与测试都按它断言）：
 * 1. 没有证据 → 冻结（覆盖旧 string[] 数据与 LLM 即时 traits）；
 * 2. 有 id 但一条都查不到 → 冻结（事件可能已归档，不能凭不存在的证据晋升）；
 * 3. 证据只落在 1 个日期 → 冻结（"跨会话"是门槛本身）；
 * 4. 证据里全是 AI 独白 → 冻结（自己说自己是怎样的人，不算数）；
 * 5. 全过 → 晋升。
 *
 * 为什么不看"当次复盘窗口"：窗口是天为单位裁的，而门槛问的是这条候选的一生。
 * 这也是本函数与已删除的 decidePromotion 的唯一实质差别。
 */
export function decideTraitPromotions(candidates, evidence) {
    const results = [];
    for (const c of candidates ?? []) {
        const text = typeof c?.text === 'string' ? c.text.trim() : '';
        if (!text)
            continue; // 空文本不是候选（防御：LLM 可能吐空白）
        const ids = Array.isArray(c.sourceEventIds) ? c.sourceEventIds.filter((id) => typeof id === 'string') : [];
        if (ids.length === 0) {
            results.push({ text, promote: false, reason: '候选无证据（sourceEventIds 为空）' });
            continue;
        }
        // 去重后仍为空 → 证据全是编造的 id（或事件已被归档清理）
        const hits = [...new Set(ids)].map((id) => evidence.get(id)).filter((e) => !!e);
        if (hits.length === 0) {
            results.push({ text, promote: false, reason: '证据事件不存在（可能已归档）' });
            continue;
        }
        const dates = new Set(hits.filter((e) => typeof e.time === 'string').map((e) => e.time.slice(0, 10)));
        if (dates.size < 2) {
            results.push({ text, promote: false, reason: '仅跨单个日期（需 ≥2 个不同日期的事件）' });
            continue;
        }
        if (!hits.some((e) => e.provenance === 'user_direct')) {
            results.push({
                text,
                promote: false,
                reason: '缺少非 AI 独白来源（需 ≥1 条 provenance=user_direct 的事件）',
            });
            continue;
        }
        results.push({ text, promote: true, reason: `满足：证据跨 ${dates.size} 个日期且含 user_direct 来源` });
    }
    return results;
}
//# sourceMappingURL=promotion.js.map