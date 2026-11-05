import { SALIENCE_WEIGHT, traceableInferred } from './provenance.js';
import { MS_PER_DAY, localDayDiff } from './time.js';
/** 一天的毫秒数（从 time.ts 转出：memory-facts 等模块从这里取，保持引用面不变） */
export { MS_PER_DAY } from './time.js';
/** 时间衰减半衰期（天）。起步值，待观察期校准 */
export const DEFAULT_TAU_DAYS = 14;
/** 近因槽窗口（小时） */
export const RECENT_WINDOW_HOURS = 72;
/** 轮廓槽最小年龄（天）：久未提取但仍重要的记忆 */
export const OUTLINE_MIN_AGE_DAYS = 60;
/** 线索槽最低相似度与最少共享内容词元数（中文一句话里通常只共享一个词，不能要求 2 个） */
export const CUE_MIN_SIMILARITY = 0.04;
export const CUE_MIN_SHARED_TOKENS = 1;
/** 衰减地板：旧记忆不会被完全压没，只是沉到排序底部 */
const DECAY_FLOOR = 0.25;
const ALL_SLOTS = ['recent', 'open', 'cue', 'self', 'outline'];
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}
function timeOf(e) {
    const t = Date.parse(e.time);
    return Number.isFinite(t) ? t : 0;
}
/** 0.5^(Δt/τ)：14 天半衰，60 天后约 5% */
export function recencyFactor(e, now, tauDays = DEFAULT_TAU_DAYS) {
    const t = timeOf(e);
    if (!t)
        return 0;
    const days = Math.max(0, (now - t) / MS_PER_DAY);
    return Math.pow(0.5, days / Math.max(0.5, tauDays));
}
/**
 * 显著性 = 来源显著性 × 重要性 × 衰减项。
 * 衰减不把旧记忆压到 0，而是压到 DECAY_FLOOR，保证"很久以前但很重要"仍能被轮廓槽取到。
 */
export function salienceScore(e, now, tauDays = DEFAULT_TAU_DAYS) {
    const weight = SALIENCE_WEIGHT[e.provenance] ?? 0.2;
    const rec = recencyFactor(e, now, tauDays);
    return weight * clamp01(e.importance) * (DECAY_FLOOR + (1 - DECAY_FLOOR) * rec);
}
/**
 * salience 降采样（增量4 第二职责①）：按 salience 降序取 top-limit，再按时间升序恢复时序
 * （喂给 LLM 的时间序不变）。
 *
 * 与"时间序取最近 N 条"（slice(-N)）不同：salienceScore 本身含 recencyFactor 时间衰减，
 * 按 salience 降序天然平衡"近因"与"重要"——近期事件 recency 高、重要事件 importance 高，
 * 两者都能进 top-N，避免停机多日后高 salience 长尾事件被最近的低 salience 杂事挤掉。
 * 只影响"先看谁"，不触碰 status/confidence/有效期（红线）。
 */
export function sampleBySalience(events, limit, nowMs) {
    return events
        .slice()
        .sort((a, b) => salienceScore(b, nowMs) - salienceScore(a, nowMs))
        .slice(0, limit)
        .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
/* ───────────── 线索匹配（无分词依赖） ───────────── */
/**
 * 词元集合：中文按二元组切分，英文/数字按词切分。
 * 不引分词依赖：二元组对中文句子相似度足够，且对错别字/语序更鲁棒。
 */
export function cueTokens(text) {
    const out = new Set();
    const s = String(text ?? '').toLowerCase();
    if (!s)
        return out;
    for (const run of s.match(/[\p{Script=Han}]+/gu) ?? []) {
        if (run.length === 1)
            out.add(run);
        for (let i = 0; i + 1 < run.length; i += 1)
            out.add(run.slice(i, i + 2));
    }
    for (const w of s.match(/[a-z0-9_]+/g) ?? [])
        out.add(w);
    return out;
}
/**
 * 线索匹配的停用词元：这些二元组几乎每条记忆都有，共享它们不构成"想起这件事"的理由。
 * 不引分词依赖，靠一张小表压掉「用户说…」这类模板前缀带来的假命中。
 */
const CUE_STOP_TOKENS = new Set([
    '用户',
    '我的',
    '我们',
    '你的',
    '你们',
    '他的',
    '她的',
    '这个',
    '那个',
    '一个',
    '什么',
    '怎么',
    '就是',
    '觉得',
    '今天',
    '昨天',
    '明天',
    '说了',
    '说的',
    '事件',
]);
/** 余弦相似度 + 共享内容词元数（单字与停用词元不计入 shared） */
export function cueSimilarity(a, b) {
    const A = cueTokens(a);
    const B = cueTokens(b);
    if (A.size === 0 || B.size === 0)
        return { score: 0, shared: 0 };
    let overlap = 0;
    let shared = 0;
    for (const token of A) {
        if (!B.has(token))
            continue;
        overlap += 1;
        if (token.length >= 2 && !CUE_STOP_TOKENS.has(token))
            shared += 1;
    }
    return { score: overlap / Math.sqrt(A.size * B.size), shared };
}
/* ───────────── 描述性时间标注 ───────────── */
/**
 * 相对时间描述（注入用描述性事实，不是指令）。
 *
 * 口径：**本地日历日之差**，不是"经过的 24 小时"。
 * 旧实现用 `Math.floor((now - t) / MS_PER_DAY)`，于是"昨晚 21:14"在今天下午 15:03
 * 注入时只过了 17.8 小时，被标成「今天」——模型会把昨天下午的事当成刚发生的。
 * 判定口径与 `review-cursor` 的复盘窗口统一到 `time.ts`。
 */
export function relativeDayLabel(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t))
        return '';
    const days = localDayDiff(t, now);
    if (days <= 0)
        return '今天';
    if (days === 1)
        return '昨天';
    if (days < 7)
        return `${days} 天前`;
    if (days < 30)
        return `${Math.floor(days / 7)} 周前`;
    if (days < 365)
        return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
}
/* ───────────── 装配 ───────────── */
/**
 * 五槽装配：近因 / 未结 / 线索 / 自我 / 轮廓，各至多一条，剩余名额按显著性补足。
 */
export function assembleRecall(events, limit, opts = {}) {
    const now = opts.now ?? Date.now();
    const tauDays = opts.tauDays ?? DEFAULT_TAU_DAYS;
    const max = Math.max(0, Math.trunc(limit));
    const items = [];
    const taken = new Set();
    const filled = new Set();
    if (max === 0 || events.length === 0) {
        return { items, emptySlots: [...ALL_SLOTS] };
    }
    // 0) 入口门禁：不可追溯的 inferred 不进池。
    // 文档口径「不可追溯的 inferred 视为无效，不应进入检索/注入」——这条校验此前只有单测，
    // 装配路径完全没接，等于放了一条无来源的推断以 0.5 显著性进入注入。判据「外部证据」在装配层失效。
    const pool = events.filter((e) => traceableInferred(e));
    /** 从候选池取分数最高且未被占用的那一条 */
    const takeFrom = (slot, pool, scoreOf) => {
        if (items.length >= max)
            return;
        let best = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const e of pool) {
            if (taken.has(e.id))
                continue;
            const s = scoreOf(e);
            if (s > bestScore) {
                bestScore = s;
                best = e;
            }
        }
        if (!best)
            return;
        taken.add(best.id);
        filled.add(slot);
        items.push({ event: best, slot, score: bestScore });
    };
    // 1) 近因：72 小时内的最近共同经历（连续性）
    const recentCutoff = now - RECENT_WINDOW_HOURS * 3_600_000;
    takeFrom('recent', pool.filter((e) => timeOf(e) >= recentCutoff), (e) => salienceScore(e, now, tauDays));
    // 2) 未结：仍 open 的线索（同一性/关心）——M4 接入 threads 后自动生效
    if (opts.openThreads && opts.openThreads.size > 0) {
        const ids = new Set();
        for (const list of opts.openThreads.values())
            for (const id of list)
                ids.add(id);
        takeFrom('open', pool.filter((e) => ids.has(e.id)), (e) => salienceScore(e, now, tauDays));
    }
    // 3) 线索：与当前消息共享词元的旧事（线索依赖提取）
    const cueText = (opts.cueText ?? '').trim();
    if (cueText) {
        // 只比对内容（summary）：topic 是分类标签，拿它匹配会让同类事件全命中
        takeFrom('cue', pool.filter((e) => {
            const { score, shared } = cueSimilarity(cueText, e.summary);
            return shared >= CUE_MIN_SHARED_TOKENS && score >= CUE_MIN_SIMILARITY;
        }), (e) => {
            const { score } = cueSimilarity(cueText, e.summary);
            return score * (0.6 + 0.4 * recencyFactor(e, now, tauDays));
        });
    }
    // 4) 自我：已经带立场模式或高重要度的自身表达（同一性证据）
    takeFrom('self', pool.filter((e) => e.provenance === 'self_direct' && (Boolean(e.selfPattern) || e.importance >= 0.7)), (e) => recencyFactor(e, now, tauDays) * (0.5 + 0.5 * clamp01(e.importance)));
    // 5) 轮廓：久未提取但仍然重要的旧记忆（有限性：细节褪去，轮廓留存）
    const outlineCutoff = now - OUTLINE_MIN_AGE_DAYS * MS_PER_DAY;
    takeFrom('outline', pool.filter((e) => timeOf(e) > 0 && timeOf(e) <= outlineCutoff), (e) => clamp01(e.importance) * (1 - recencyFactor(e, now, tauDays)));
    // 6) 补足：剩余名额按显著性取。
    //
    // 这里必须分两池、且给自我侧设上限。原因：open/cue/outline 三槽在真实数据下经常全空
    // （未接 threads、当前消息无线索、没有 60 天以上的旧事），补足就会吃掉 3/5 的名额；
    // 若补足不带来源约束，"多样性由构造保证"只在 recent/self 两槽成立，最终构成又退回
    // 由 salience 主导——而 self_direct 样本量天然是用户的 3 倍，结果仍是自述占满。
    const selfQuota = Math.ceil(max / 2);
    const selfUsed = () => items.filter((it) => SELF_SIDE.has(it.event.provenance)).length;
    // 6.1 先补非自我侧（用户经历优先）：这些是"它记得我"的来源
    while (items.length < max) {
        const before = items.length;
        takeFrom('fill', pool.filter((e) => !SELF_SIDE.has(e.provenance)), (e) => salienceScore(e, now, tauDays));
        if (items.length === before)
            break;
    }
    // 6.2 再用剩余名额补自我侧，但不超过配额上限
    while (items.length < max && selfUsed() < selfQuota) {
        const before = items.length;
        takeFrom('fill', pool.filter((e) => SELF_SIDE.has(e.provenance)), (e) => salienceScore(e, now, tauDays));
        if (items.length === before)
            break;
    }
    // 6.3 名额仍未满（某一侧被清空时）→ 放开配额，总比注入过短好
    while (items.length < max) {
        const before = items.length;
        takeFrom('fill', pool, (e) => salienceScore(e, now, tauDays));
        if (items.length === before)
            break;
    }
    const emptySlots = ALL_SLOTS.filter((slot) => !filled.has(slot));
    // 渲染顺序：用户的事排在插件自述之前。槽位决定"选谁"，这个稳定分组决定"先读到谁"。
    // 不改变入选集合，只让模型先看到用户在过什么日子。
    items.sort((a, b) => provenanceRank(a.event) - provenanceRank(b.event));
    return { items, emptySlots };
}
/**
 * "自我侧"来源：都是插件自己说的话。
 * 保留优先级不因此降低（O6：自己觉得重要的记忆该留），这里限制的只是"该不该占据注入名额"。
 */
const SELF_SIDE = new Set(['self_direct', 'self_correction', 'induced']);
/** 注入渲染分组（稳定排序：同组保持槽位顺序） */
const PROVENANCE_RANK = {
    user_direct: 0,
    self_correction: 1,
    inferred: 2,
    self_direct: 3,
    induced: 4,
    tool_output: 5,
    retrieved_content: 6,
};
function provenanceRank(e) {
    return PROVENANCE_RANK[e.provenance] ?? 7;
}
//# sourceMappingURL=recall.js.map