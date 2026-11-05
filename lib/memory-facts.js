/**
 * 记忆事实层（v0.6）：threads（会结束的事）/ attributes（不过期的事实）
 *
 * 机制依据见 types.ts 中 PersonaThread / PersonaAttribute 的注释；本文件负责三件事：
 * 1. 存储：memory/threads.json + memory/attributes.json，原子写；
 *    读失败绝不退化成"空库 + 下次覆盖"（events 层踩过的同一个坑）。
 * 2. 派生：把 LLM 的输出（不可信）变成可信条目——stripMemoryFact（严口径）门禁 + sourceEventIds 存在性校验，
 *    校验不过整条丢弃（不补空数组、不降置信度凑数）。
 * 3. 合并：thread 按 key 跨天合并（重复提及是信号不是噪音）；
 *    attribute 按 key+value 提置信度，同 key 不同 value 则旧条 superseded。
 *
 * 本文件不含 LLM 调用，全部是纯函数 + 存储；调用点只有复盘引擎（写入路径必须零 LLM 调用）。
 */
import { createHash } from 'node:crypto';
import { stripMemoryFact } from './directive-strip.js';
import { MS_PER_DAY } from './recall.js';
/* ══════════════════════ 常量 ══════════════════════ */
/**
 * open thread 多久没被提及就收敛为 expired（天）。
 *
 * 30 天是起步值，TODO(calibrate)：
 * - 太短会把"下个月才出结果的事"（考研、体检复查）误杀，用户再提时状态得重新开；
 * - 太长了等于不收敛，open 槽会被一堆僵尸线索占满，注入里永远是那几件旧事。
 * 先取 30 天（覆盖多数"周/月"量级的生活事件），观察期后按实际复用率调整。
 */
export const THREAD_EXPIRY_DAYS = 30;
/** 同一 attribute 每次被重复确认时加的置信度（增长慢，避免两次提及就"确信"） */
export const ATTRIBUTE_CONFIDENCE_STEP = 0.1;
/** 新 attribute 的默认置信度（LLM 未给值时） */
const DEFAULT_ATTRIBUTE_CONFIDENCE = 0.5;
/** 稳定 id 的哈希截断长度：10 个十六进制字符（40 bit），数百条量级无碰撞之忧 */
const STABLE_ID_LEN = 10;
/** threads 存储目录（相对 store root） */
const FACTS_DIR = 'memory';
/* ══════════════════════ 稳定 id ══════════════════════ */
/**
 * 稳定短哈希 id：同一 seed 永远得到同一 id，跨天/跨进程/跨机器一致。
 *
 * 不用 store.makeId()（randomUUID）：thread 要能"同 key 跨天合并"，
 * id 必须由 key 推导而不是随机生成，否则每天都会新建一条同名 thread。
 */
export function stableId(prefix, seed) {
    const digest = createHash('sha256').update(seed, 'utf8').digest('hex');
    return `${prefix}${digest.slice(0, STABLE_ID_LEN)}`;
}
/** thread id：只由 key 推导（同 key = 同一件事） */
export function threadId(key) {
    return stableId('th_', normalizeFactKey(key));
}
/** attribute id：由 key + value 推导（同 key 不同 value 必须是两条，否则取代链指不到新条目） */
export function attributeId(key, value) {
    return stableId('at_', `${normalizeFactKey(key)}\u0000${String(value).trim()}`);
}
/**
 * 同源去重标识（§4.9）：同一组 sourceEventIds（忽略顺序）→ 同一 group。
 * 最小语义：完全相同的来源集合归为一组。部分重叠的"部分同源"留给后续。
 */
export function evidenceGroupId(sourceEventIds) {
    return stableId('eg_', [...sourceEventIds].sort().join('|'));
}
/** provenance → (speaker, epistemicType)。inferred 的 speaker 无法可靠归属，留空。 */
export function inferSpeakerEpistemic(p) {
    switch (p) {
        case 'user_direct': return { speaker: 'user', epistemicType: 'user_statement' };
        case 'self_direct':
        case 'self_correction':
        case 'induced': return { speaker: 'assistant', epistemicType: 'ai_inference' };
        case 'tool_output':
        case 'retrieved_content': return { speaker: 'tool', epistemicType: 'direct_observation' };
        case 'inferred': return { speaker: undefined, epistemicType: 'ai_inference' };
    }
}
/**
 * 归一化主题 key：去首尾空白、压缩内部空白、统一小写。
 * 小写对中文无影响，但对英文 key（Pet / pet）是必需的——否则同一件事会分裂成两条 thread。
 */
export function normalizeFactKey(raw) {
    return String(raw ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}
/**
 * threads / attributes 的存储门面。
 *
 * 为什么不用 store.readJson：它在读失败时静默返回 null，调用方无法区分
 * "首次运行（没有文件）"与"文件读不到"——后者若被当成空库，下一次写入就把全库覆盖。
 * 所以这里只用 readText（读失败会抛出）+ 显式区分三态。
 */
export class MemoryFactStore {
    store;
    dir;
    constructor(store, dir = FACTS_DIR) {
        this.store = store;
        this.dir = dir;
    }
    get threadsPath() {
        return `${this.dir}/threads.json`;
    }
    get attributesPath() {
        return `${this.dir}/attributes.json`;
    }
    /**
     * 读一个 { version, [key]: T[] } 结构。
     * 三态：文件不存在 → 空库（正常首次运行）；读失败/解析失败/结构不符 → ok:false。
     */
    async readList(path, key) {
        let raw;
        try {
            // store.readText：不存在返回空串；读失败抛出（不静默降级）
            raw = await this.store.readText(path);
        }
        catch (err) {
            return { ok: false, reason: `${path} 读取失败：${errorMessage(err)}` };
        }
        if (!raw.trim())
            return { ok: true, items: [] }; // 首次运行：没有文件，或文件为空
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return { ok: false, reason: `${path} JSON 损坏（不按空库处理，避免下次写入覆盖）` };
        }
        if (!parsed || typeof parsed !== 'object') {
            return { ok: false, reason: `${path} 结构非法（顶层不是对象）` };
        }
        const list = parsed[key];
        if (!Array.isArray(list)) {
            return { ok: false, reason: `${path} 缺少 ${key} 数组` };
        }
        return { ok: true, items: list };
    }
    async loadThreads() {
        const res = await this.readList(this.threadsPath, 'threads');
        if (!res.ok)
            return res;
        return { ok: true, items: res.items.filter(isThreadShaped) };
    }
    async loadAttributes() {
        const res = await this.readList(this.attributesPath, 'attributes');
        if (!res.ok)
            return res;
        return { ok: true, items: res.items.filter(isAttributeShaped) };
    }
    /** 原子写（temp+rename / 先备份再覆盖）；不用 writeText，硬状态不允许截断即丢 */
    async saveThreads(threads) {
        const file = { version: 1, threads: [...threads] };
        await this.store.writeTextAtomic(this.threadsPath, JSON.stringify(file, null, 2));
    }
    async saveAttributes(attributes) {
        const file = { version: 1, attributes: [...attributes] };
        await this.store.writeTextAtomic(this.attributesPath, JSON.stringify(file, null, 2));
    }
    /**
     * 注入侧读取：open thread → { threadId: sourceEventIds }。
     *
     * 这里刻意把读失败吞成空 map：注入是每轮热路径，读不到派生层只该意味着
     * "这轮少一个槽位"，不该让整轮对话报错。写路径（复盘）则相反——读失败必须停手。
     */
    async loadOpenThreads() {
        try {
            const res = await this.loadThreads();
            if (!res.ok)
                return new Map();
            return openThreadEventMap(res.items);
        }
        catch {
            return new Map();
        }
    }
}
/** 结构性校验（只拦明显坏数据，不改语义；坏条目不静默"修复"成别的值） */
function isThreadShaped(v) {
    const t = v;
    return (!!t &&
        typeof t.id === 'string' &&
        typeof t.key === 'string' &&
        typeof t.title === 'string' &&
        (t.status === 'open' || t.status === 'resolved' || t.status === 'expired') &&
        typeof t.lastMentionedAt === 'string' &&
        Array.isArray(t.sourceEventIds));
}
/** facts 七态状态机（§4.7）；旧两态数据（active/superseded）是七态子集，天然通过校验 */
const FACT_STATUSES = new Set([
    'candidate', 'active', 'quarantined', 'disputed',
    'superseded', 'retracted', 'expired',
]);
function isAttributeShaped(v) {
    const a = v;
    return (!!a &&
        typeof a.id === 'string' &&
        typeof a.key === 'string' &&
        typeof a.value === 'string' &&
        typeof a.status === 'string' &&
        FACT_STATUSES.has(a.status) &&
        Array.isArray(a.sourceEventIds));
}
/* ══════════════════════ 注入侧转换 ══════════════════════ */
/**
 * open thread → 未结槽输入（threadId → 证据事件 id）。
 * 只取 open：resolved/expired 的事再被提起就是"翻旧账"，那不是此刻要想起的事。
 */
export function openThreadEventMap(threads) {
    const map = new Map();
    for (const t of threads) {
        if (t.status !== 'open')
            continue;
        if (!Array.isArray(t.sourceEventIds) || t.sourceEventIds.length === 0)
            continue;
        map.set(t.id, [...t.sourceEventIds]);
    }
    return map;
}
/* ══════════════════════ 过期收敛 ══════════════════════ */
/**
 * 把长期未被提及的 open thread 收敛为 expired（原地修改并返回收敛条数）。
 *
 * 为什么要收敛而不是永久 open：open 槽每轮只出一个名额，
 * 不收敛的话最早那几件事会永久占位（与 v0.5 修掉的"检索冻结"是同一类故障）。
 */
export function expireStaleThreads(threads, nowMs) {
    let expired = 0;
    const nowIso = new Date(nowMs).toISOString();
    for (const t of threads) {
        if (t.status !== 'open')
            continue;
        const last = Date.parse(t.lastMentionedAt);
        if (!Number.isFinite(last))
            continue;
        if ((nowMs - last) / MS_PER_DAY <= THREAD_EXPIRY_DAYS)
            continue;
        t.status = 'expired';
        t.expiredAt = nowIso;
        delete t.resolvedAt;
        expired += 1;
    }
    return expired;
}
/** 造一份零值统计（调用方可覆盖部分字段） */
export function emptyMemoryFactStats(patch = {}) {
    return {
        ran: false,
        persisted: false,
        threadsCreated: 0,
        threadsUpdated: 0,
        attributesCreated: 0,
        attributesUpdated: 0,
        attributesSuperseded: 0,
        dropped: 0,
        dropReasons: { 'no-source': 0, 'unknown-source': 0, strip: 0, invalid: 0 },
        fieldsStripped: 0,
        expired: 0,
        ...patch,
    };
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function drop(stats, reason) {
    stats.dropped += 1;
    stats.dropReasons[reason] = (stats.dropReasons[reason] ?? 0) + 1;
}
/** 规整 sourceEventIds：只留非空字符串并去重（LLM 常给重复 id） */
function normalizeIds(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const v of raw) {
        if (typeof v !== 'string')
            continue;
        const id = v.trim();
        if (!id || out.includes(id))
            continue;
        out.push(id);
    }
    return out;
}
/** 取 ids 对应事件里 Date.parse 最大的事件 id；映射缺失/无合法时间 → undefined */
function latestEventId(ids, eventTimes) {
    if (!eventTimes || ids.length === 0)
        return undefined;
    let best;
    let bestMs = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
        const t = eventTimes.get(id);
        if (!t)
            continue;
        const ms = Date.parse(t);
        if (Number.isFinite(ms) && ms > bestMs) {
            bestMs = ms;
            best = id;
        }
    }
    return best;
}
/** 取 ids 对应事件里 Date.parse 最大的 time；映射缺失/无合法时间 → undefined */
function latestEventTime(ids, eventTimes) {
    if (!eventTimes || ids.length === 0)
        return undefined;
    let best;
    let bestMs = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
        const t = eventTimes.get(id);
        if (!t)
            continue;
        const ms = Date.parse(t);
        if (Number.isFinite(ms) && ms > bestMs) {
            bestMs = ms;
            best = t;
        }
    }
    return best;
}
/**
 * sourceEventIds 校验：非空 + 每个 id 都必须在 events 里真实存在。
 * 不通过就整条丢弃——"补一个空数组"等于放行一条无证据的记忆，
 * 与 traceableInferred 的口径一致（不可追溯的推导视为无效）。
 */
function checkIds(ids, knownEventIds) {
    if (ids.length === 0)
        return { ok: false, reason: 'no-source' };
    for (const id of ids) {
        if (!knownEventIds.has(id))
            return { ok: false, reason: 'unknown-source' };
    }
    return { ok: true };
}
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}
/**
 * dueHint 门禁（v0.7）。
 *
 * 它是 thread 里唯一没过门禁的 LLM 自由文本字段，而且会在 `/persona threads`
 * 里被渲染出来——等于给"给模型写行为脚本"留了一个旁路。门禁口径与 title/value 一致。
 *
 * 处理方式与整条丢弃不同：hint 只是可选装饰，坏了丢字段、保留 thread（事实本身没问题），
 * 单独计进 fieldsStripped，不污染 dropped / dropReasons 的"整条丢弃"语义。
 */
function sanitizeDueHint(raw, stats) {
    if (typeof raw !== 'string')
        return undefined;
    const hint = raw.trim();
    if (!hint)
        return undefined;
    if (!stripMemoryFact(hint).ok) {
        stats.fieldsStripped += 1;
        return undefined;
    }
    return hint;
}
function asStatus(v) {
    if (v === 'open' || v === 'resolved' || v === 'expired')
        return v;
    return null;
}
/**
 * 把 LLM 输出派生为 threads / attributes（纯函数，无 I/O，可单测）。
 *
 * 门禁顺序（先便宜后昂贵，且丢弃原因要能解释）：
 * 1. 字段形状（key/title/value/status）→ 'invalid'
 * 2. stripMemoryFact（不许 LLM 给自己写行为脚本；派生层用严口径）→ 'strip'
 * 3. sourceEventIds 存在性 → 'no-source' / 'unknown-source'
 * 4. 合并（只有全部门禁通过的条目才有资格改库）
 */
export function deriveMemoryFacts(input) {
    const stats = emptyMemoryFactStats({ ran: true });
    const threads = input.existingThreads.map((t) => ({ ...t }));
    const attributes = input.existingAttributes.map((a) => ({ ...a }));
    const now = input.now;
    let threadsDirty = false;
    let attributesDirty = false;
    /* ── threads ── */
    const rawThreads = Array.isArray(input.raw?.threads) ? input.raw?.threads : [];
    for (const cand of rawThreads) {
        if (!cand || typeof cand !== 'object') {
            drop(stats, 'invalid');
            continue;
        }
        const key = normalizeFactKey(cand.key);
        const title = typeof cand.title === 'string' ? cand.title.trim() : '';
        if (!key || !title) {
            drop(stats, 'invalid');
            continue;
        }
        // 门禁：title 是最终会进注入文本的字段，含祈使句整条丢弃
        if (!stripMemoryFact(title).ok) {
            drop(stats, 'strip');
            continue;
        }
        const status = asStatus(cand.status);
        if (!status) {
            drop(stats, 'invalid');
            continue;
        }
        const ids = normalizeIds(cand.sourceEventIds);
        const idCheck = checkIds(ids, input.knownEventIds);
        if (!idCheck.ok) {
            drop(stats, idCheck.reason);
            continue;
        }
        // op 只作 LLM 的自我提示，合并以"key 是否已存在"为准：
        // LLM 漏标/错标 op 时不该产生第二条同名 thread。
        const id = threadId(key);
        const existing = threads.find((t) => t.id === id) ?? threads.find((t) => t.key === key);
        const dueHint = sanitizeDueHint(cand.dueHint, stats);
        if (!existing) {
            threads.push({
                id,
                key,
                title,
                status,
                openedAt: now,
                lastMentionedAt: latestEventTime(ids, input.eventTimes) ?? now,
                mentionCount: ids.length,
                sourceEventIds: [...ids],
                ...(dueHint ? { dueHint } : {}),
                ...(status === 'resolved' ? { resolvedAt: now } : {}),
                ...(status === 'expired' ? { expiredAt: now } : {}),
            });
            stats.threadsCreated += 1;
            threadsDirty = true;
            continue;
        }
        // 更新：mentionCount 只加"本次新增的事件"，同一事件重复解析不虚增
        const added = ids.filter((i) => !existing.sourceEventIds.includes(i));
        existing.mentionCount += added.length;
        if (added.length > 0)
            existing.sourceEventIds = [...existing.sourceEventIds, ...added];
        existing.lastMentionedAt = latestEventTime(ids, input.eventTimes) ?? now;
        if (title)
            existing.title = title; // 标题允许随信息变多而细化
        if (dueHint)
            existing.dueHint = dueHint;
        if (status !== existing.status) {
            existing.status = status;
            if (status === 'resolved') {
                existing.resolvedAt = now;
                delete existing.expiredAt;
            }
            else if (status === 'open') {
                // 重新被提起 = 这件事又活了（resolved 的事被判"其实还没完"，或 expired 的事又出现）
                delete existing.resolvedAt;
                delete existing.expiredAt;
            }
            else {
                existing.expiredAt = now;
            }
        }
        stats.threadsUpdated += 1;
        threadsDirty = true;
    }
    /* ── attributes ── */
    const rawAttributes = Array.isArray(input.raw?.attributes)
        ? input.raw?.attributes
        : [];
    for (const cand of rawAttributes) {
        if (!cand || typeof cand !== 'object') {
            drop(stats, 'invalid');
            continue;
        }
        const key = normalizeFactKey(cand.key);
        const value = typeof cand.value === 'string' ? cand.value.trim() : '';
        if (!key || !value) {
            drop(stats, 'invalid');
            continue;
        }
        // 门禁：value 会进注入，含祈使句整条丢弃
        if (!stripMemoryFact(value).ok) {
            drop(stats, 'strip');
            continue;
        }
        const ids = normalizeIds(cand.sourceEventIds);
        const idCheck = checkIds(ids, input.knownEventIds);
        if (!idCheck.ok) {
            drop(stats, idCheck.reason);
            continue;
        }
        const confidence = typeof cand.confidence === 'number'
            ? clamp01(cand.confidence)
            : DEFAULT_ATTRIBUTE_CONFIDENCE;
        const latestId = latestEventId(ids, input.eventTimes);
        const latestProv = latestId ? input.eventProvenances?.get(latestId) : undefined;
        const se = latestProv ? inferSpeakerEpistemic(latestProv) : {};
        const id = attributeId(key, value);
        const same = attributes.find((a) => a.id === id);
        if (same) {
            // 同 key + 同 value：再确认一次 → 提置信度（不新建）
            same.confidence = Math.min(1, same.confidence + ATTRIBUTE_CONFIDENCE_STEP);
            same.updatedAt = now;
            same.ingestedAt = now;
            if (se.speaker)
                same.speaker = se.speaker;
            if (se.epistemicType)
                same.epistemicType = se.epistemicType;
            const assertedAt = latestEventTime(ids, input.eventTimes);
            if (assertedAt)
                same.assertedAt = assertedAt;
            const added = ids.filter((i) => !same.sourceEventIds.includes(i));
            if (added.length > 0) {
                same.sourceEventIds = [...same.sourceEventIds, ...added];
                same.evidenceGroupId = evidenceGroupId(same.sourceEventIds);
            }
            if (same.status === 'superseded') {
                // 用户把改掉的事又改回来了：复活旧条目，并把它自己从取代链上摘下来
                same.status = 'active';
                delete same.supersededBy;
                delete same.supersededAt;
                same.statusChangedAt = now;
                stats.attributesUpdated += 1;
                attributesDirty = true;
            }
            else {
                stats.attributesUpdated += 1;
                attributesDirty = true;
            }
            continue;
        }
        // 同 key 的其它 active 条目 → 被这条取代（旧公司不能永远有效）
        for (const old of attributes) {
            if (old.key !== key || old.status !== 'active')
                continue;
            old.status = 'superseded';
            old.supersededBy = id;
            old.supersededAt = now;
            old.statusChangedAt = now;
            stats.attributesSuperseded += 1;
            attributesDirty = true;
        }
        attributes.push({
            id,
            key,
            value,
            status: 'active',
            confidence,
            sourceEventIds: [...ids],
            firstSeenAt: now,
            updatedAt: now,
            speaker: se.speaker,
            epistemicType: se.epistemicType,
            assertedAt: latestEventTime(ids, input.eventTimes),
            ingestedAt: now,
            statusChangedAt: now,
            validFrom: null,
            validTo: null,
            evidenceGroupId: evidenceGroupId(ids),
        });
        stats.attributesCreated += 1;
        attributesDirty = true;
    }
    // 过期收敛放在合并之后：本次刚被提及的事 lastMentionedAt 已刷新，不会被误杀
    const nowMs = Date.parse(now);
    if (Number.isFinite(nowMs)) {
        const expired = expireStaleThreads(threads, nowMs);
        if (expired > 0) {
            stats.expired = expired;
            threadsDirty = true;
        }
    }
    return { threads, attributes, stats, threadsDirty, attributesDirty };
}
/** 供外部（测试/命令）读全量事件 id 后直接构造集合 */
export function eventIdSet(events) {
    return new Set(events.map((e) => e.id));
}
//# sourceMappingURL=memory-facts.js.map