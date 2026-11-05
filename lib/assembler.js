import { provenanceLabel, traceableInferred } from './provenance.js';
import { inferSpeakerEpistemic } from './memory-facts.js';
import { relativeDayLabel } from './recall.js';
/** 总预算默认值（§2.3 第 3 条，p95 口径） */
export const DEFAULT_ASSEMBLE_BUDGET_TOKENS = 1200;
/** evidence_group 占总预算比例上限（§2.3 第 1 条） */
export const EVIDENCE_GROUP_BUDGET_RATIO = 0.4;
/** evidence_group 槽位上限（§2.3 第 1 条） */
export const EVIDENCE_GROUP_MAX_SLOTS = 2;
/** ai_inference 占总预算比例上限（§2.3 第 2 条，persona 除外） */
export const AI_INFERENCE_BUDGET_RATIO = 0.3;
/** token 粗略口径：中文 1 字符 ≈ 1 token（混合文本用字符数近似，测试可验证） */
export function estimateTokens(text) {
    return Math.max(1, String(text ?? '').length);
}
/** 折叠换行与连续空白（只用于渲染，不改存储原文） */
function oneLine(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}
/** 意图 → 中文标签（注入 header 用） */
const INTENT_LABEL = {
    continue_task: '继续当前任务',
    fact_lookup: '事实查询',
    history_replay: '历史回放',
    persona: '人格/自我',
    fuzzy: '模糊回忆',
};
/** 装配计划（§2.2 契约三表）：意图 → 各层预算分配（ratio 合计 = 1） */
const PLANS = {
    continue_task: [
        { layer: 'state', ratio: 0.6 },
        { layer: 'event', ratio: 0.3 },
        { layer: 'self', ratio: 0.1 },
    ],
    fact_lookup: [
        { layer: 'fact', ratio: 0.7 },
        { layer: 'event', ratio: 0.2 },
        { layer: 'state', ratio: 0.1 },
    ],
    history_replay: [
        { layer: 'event', ratio: 0.7 },
        { layer: 'raw', ratio: 0.3 },
    ],
    persona: [
        { layer: 'self', ratio: 0.7 },
        { layer: 'event', ratio: 0.3 },
    ],
    fuzzy: [
        { layer: 'event', ratio: 0.35 },
        { layer: 'fact', ratio: 0.25 }, // 候选合计 0.6
        { layer: 'raw', ratio: 0.2 }, // 展开 0.4
        { layer: 'self', ratio: 0.1 },
        { layer: 'state', ratio: 0.1 },
    ],
};
/* ══════════════════════ 各层候选构建 ══════════════════════ */
/** attribute 是否当前有效（validFrom/validTo 为 null 视为未知 = 有效） */
function isCurrentlyValid(a, nowMs) {
    const from = a.validFrom ? Date.parse(a.validFrom) : NaN;
    const to = a.validTo ? Date.parse(a.validTo) : NaN;
    if (Number.isFinite(from) && nowMs < from)
        return false;
    if (Number.isFinite(to) && nowMs >= to)
        return false;
    return true;
}
function buildFactCandidates(attributes, nowMs) {
    return attributes
        .filter((a) => a.status === 'active')
        .filter((a) => isCurrentlyValid(a, nowMs))
        .slice()
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .map((a) => {
        const text = `${a.key}：${a.value}`;
        return {
            kind: 'fact',
            ref: a.id,
            text,
            epistemicType: a.epistemicType,
            evidenceGroupId: a.evidenceGroupId,
            tokens: estimateTokens(text),
        };
    });
}
function buildEventCandidates(events, nowMs, preferIds) {
    return events
        .filter((e) => traceableInferred(e))
        .slice()
        .sort((a, b) => {
        const pa = preferIds?.has(a.id) ? 0 : 1;
        const pb = preferIds?.has(b.id) ? 0 : 1;
        if (pa !== pb)
            return pa - pb;
        return a.time < b.time ? 1 : a.time > b.time ? -1 : 0;
    })
        .map((e) => {
        const when = relativeDayLabel(e.time, nowMs);
        const date = e.time.slice(0, 10);
        const stamp = when ? `${date}（${when}）` : date;
        const text = `[${provenanceLabel(e.provenance)}] ${stamp} ${oneLine(e.topic)}：${oneLine(e.summary)}`;
        const se = inferSpeakerEpistemic(e.provenance);
        return {
            kind: 'event',
            ref: e.id,
            text,
            epistemicType: se.epistemicType,
            tokens: estimateTokens(text),
        };
    });
}
function selfItem(text, ref) {
    return {
        kind: 'self',
        ref,
        text,
        // self_model 内容是 AI 归纳的自我认知（§4.3 认识论类型）
        epistemicType: 'ai_inference',
        tokens: estimateTokens(text),
    };
}
function buildSelfCandidates(selfModel) {
    if (!selfModel)
        return [];
    const items = [];
    (selfModel.traits ?? []).forEach((t, i) => items.push(selfItem(`特质：${t}`, `self:trait:${i}`)));
    (selfModel.preferences ?? []).forEach((p, i) => items.push(selfItem(`偏好：${p}`, `self:pref:${i}`)));
    const style = selfModel.speakingStyle?.trim();
    if (style)
        items.push(selfItem(`说话方式：${style}`, 'self:style'));
    const narrative = selfModel.narrative?.trim();
    if (narrative)
        items.push(selfItem(`叙事：${narrative}`, 'self:narrative'));
    return items;
}
function buildStateCandidates(state) {
    if (!state)
        return [];
    const text = `模式：${state.mode} · 关系阶段：${state.relationshipStage}`;
    return [{ kind: 'state', ref: 'state', text, tokens: estimateTokens(text) }];
}
function buildRawCandidates(rawTurns) {
    return rawTurns
        .slice()
        .sort((a, b) => (a.asserted_at < b.asserted_at ? 1 : a.asserted_at > b.asserted_at ? -1 : 0))
        .map((t) => {
        const text = `[${t.speaker}] ${oneLine(t.raw_text)}`;
        return { kind: 'raw', ref: t.event_id, text, tokens: estimateTokens(text) };
    });
}
/** 某些意图下事件排序的优先 id 集合（证据优先：让事实/自我模型的证据事件排前面） */
function eventPreferIds(primary, attributes, selfModel) {
    if (primary === 'fact_lookup') {
        const ids = new Set();
        for (const a of attributes) {
            if (a.status !== 'active')
                continue;
            for (const id of a.sourceEventIds ?? [])
                ids.add(id);
        }
        return ids;
    }
    if (primary === 'persona') {
        return new Set(selfModel?.sourceEventIds ?? []);
    }
    return new Set();
}
/* ══════════════════════ 配额闸门 ══════════════════════ */
/** evidence_group 闸门：同组 >2 槽且占比 >40% 时，裁到 ≤2 槽 */
function applyEvidenceGroupGate(items, budget) {
    const groups = new Map();
    for (const it of items) {
        if (!it.evidenceGroupId)
            continue;
        const list = groups.get(it.evidenceGroupId);
        if (list)
            list.push(it);
        else
            groups.set(it.evidenceGroupId, [it]);
    }
    const drop = new Set();
    for (const list of groups.values()) {
        if (list.length <= EVIDENCE_GROUP_MAX_SLOTS)
            continue;
        const groupTokens = list.reduce((s, i) => s + i.tokens, 0);
        if (groupTokens <= budget * EVIDENCE_GROUP_BUDGET_RATIO)
            continue;
        // 超 2 槽且占比超 40%：保留前 2 槽，其余裁掉
        for (let i = EVIDENCE_GROUP_MAX_SLOTS; i < list.length; i += 1)
            drop.add(list[i]);
    }
    return items.filter((it) => !drop.has(it));
}
/** ai_inference 闸门：占预算 >30% 时裁掉超出部分（persona 意图不裁） */
function applyAiInferenceGate(items, primary, budget) {
    if (primary === 'persona')
        return items;
    const maxAi = budget * AI_INFERENCE_BUDGET_RATIO;
    const kept = [];
    let aiUsed = 0;
    for (const it of items) {
        if (it.epistemicType === 'ai_inference') {
            if (aiUsed + it.tokens > maxAi)
                continue; // 裁掉这条
            aiUsed += it.tokens;
        }
        kept.push(it);
    }
    return kept;
}
/* ══════════════════════ 装配主函数 ══════════════════════ */
/**
 * 按意图装配（纯函数）。
 *
 * @param input 已加载的各层数据
 * @param intents resolveIntent 的结果（取 [0] 为主意图）
 * @param budgetTokens 总预算（token 口径，默认 1200）
 */
export function assemble(input, intents, budgetTokens = DEFAULT_ASSEMBLE_BUDGET_TOKENS) {
    const primary = intents[0] ?? 'fuzzy';
    const budget = Math.max(1, Math.trunc(budgetTokens) || DEFAULT_ASSEMBLE_BUDGET_TOKENS);
    const nowMs = input.now ?? Date.now();
    const attributes = input.attributes ?? [];
    const events = input.events ?? [];
    const rawTurns = input.rawTurns ?? [];
    const selfModel = input.selfModel ?? null;
    const state = input.state ?? null;
    const preferIds = eventPreferIds(primary, attributes, selfModel);
    const pools = {
        fact: buildFactCandidates(attributes, nowMs),
        event: buildEventCandidates(events, nowMs, preferIds),
        self: buildSelfCandidates(selfModel),
        state: buildStateCandidates(state),
        raw: buildRawCandidates(rawTurns),
    };
    // 按计划分配预算，逐层取候选
    const selected = [];
    for (const slot of PLANS[primary]) {
        let slotBudget = budget * slot.ratio;
        for (const item of pools[slot.layer]) {
            if (slotBudget <= 0)
                break;
            if (selected.length > 0 && item.tokens > slotBudget)
                break;
            selected.push(item);
            slotBudget -= item.tokens;
        }
    }
    // 配额闸门（§2.3，在字符预算截断之前）
    const gated = applyAiInferenceGate(applyEvidenceGroupGate(selected, budget), primary, budget);
    // 总预算截断
    const kept = [];
    let used = 0;
    for (const it of gated) {
        if (kept.length > 0 && used + it.tokens > budget)
            break;
        kept.push(it);
        used += it.tokens;
    }
    const evidenceGroups = new Set(kept.map((i) => i.evidenceGroupId).filter((v) => !!v)).size;
    const aiInferenceCount = kept.filter((i) => i.epistemicType === 'ai_inference').length;
    const header = `【工作记忆（按意图装配 · ${INTENT_LABEL[primary]}）】`;
    const lines = kept.map((it) => `- ${it.text}`);
    const text = lines.length ? `${header}\n${lines.join('\n')}` : '';
    return {
        intent: [...intents],
        items: kept.map((it) => ({
            kind: it.kind,
            ref: it.ref,
            text: it.text,
            epistemicType: it.epistemicType,
        })),
        text,
        stats: { evidenceGroups, aiInferenceCount, budgetTokens: budget },
    };
}
//# sourceMappingURL=assembler.js.map