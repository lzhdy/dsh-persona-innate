/** 游标文件（store root 下；硬状态，用原子写） */
export const REVIEW_CURSOR_PATH = 'review-state.json';
/**
 * 启动补跑的最小间隔（24h）。
 * 定时器每天一次；距上次复盘不足 24h 说明那次已经跑过（或用不着补），
 * 每次启动都补会白白多花一次 LLM 调用与一个 self_model 版本——DSH 一天可能启动十几次。TODO(calibrate)
 */
export const CATCH_UP_MIN_GAP_MS = 24 * 60 * 60 * 1000;
/**
 * 游标存储。
 * 读失败必须显式返回错误而不是 null：把"读不到"当成"没有游标"会让窗口退回最早一条事件，
 * 于是整段历史被反复复盘（重复版本），或者游标被覆盖成空值。
 */
export class ReviewCursorStore {
    store;
    path;
    constructor(store, path = REVIEW_CURSOR_PATH) {
        this.store = store;
        this.path = path;
    }
    async load() {
        let raw;
        try {
            raw = await this.store.readText(this.path);
        }
        catch (err) {
            return { ok: false, reason: `${this.path} 读取失败：${err instanceof Error ? err.message : String(err)}` };
        }
        if (!raw.trim())
            return { ok: true, cursor: null }; // 首次运行：没有游标
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return { ok: false, reason: `${this.path} JSON 损坏（不按"无游标"处理，避免重复复盘）` };
        }
        const c = parsed;
        if (!c || typeof c.lastReviewAt !== 'string' || !c.lastReviewAt) {
            return { ok: false, reason: `${this.path} 缺少 lastReviewAt` };
        }
        return {
            ok: true,
            cursor: {
                version: 1,
                lastReviewAt: c.lastReviewAt,
                ...(typeof c.lastReviewDate === 'string' ? { lastReviewDate: c.lastReviewDate } : {}),
            },
        };
    }
    async save(cursor) {
        await this.store.writeTextAtomic(this.path, JSON.stringify(cursor, null, 2));
    }
}
/** 本地零点（毫秒）。刻意不用 toISOString 切片：UTC 切片的"今天"在本地 02:00 前后会指向前一天 */
export function localDayStart(now) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
/** 本地日期串 YYYY-MM-DD（只作标签/审计，不参与窗口计算） */
export function localDateString(now) {
    const p = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
/**
 * 复盘窗口：游标时刻（开区间）→ 现在。
 * 时间戳不可解析的事件直接排除（无法确定它属于哪段窗口）。
 *
 * `until` 是可选的上界（开区间）。只有启动补跑会传它：补跑要补的是"进程不在期间"的缺口，
 * 不该把本次会话刚刚写入的事件也算进来（那既浪费一次 LLM 调用，又会和紧随其后的
 * 手动 /persona review 抢同一个窗口）。传上界时窗口变成 (from, until)，闭区间会让
 * "启动那一毫秒写入的事件"挤进补跑，因此这里取严格小于。
 */
/** 单次复盘窗口的事件上限。
 * 无游标（首次运行 / 升级后）时窗口可能覆盖全部历史，不设上限会让第一次复盘
 * 变成一次天价 LLM 调用。超出部分从**最早端**截断（保留最近的），并如实记录
 * "有 N 条更早的事件未纳入"——不静默丢弃。 */
export const REVIEW_WINDOW_MAX = 200;
/**
 * 选窗口。下界规则：
 * - 有游标：`(游标, now|until)` 开区间——游标时刻的事件不重复复盘。
 * - **无游标：从最早一条事件起**（含该条）。
 *
 * 无游标为什么不能退化成"本地当日 00:00"：定时复盘在 02:00 执行，窗口就变成
 * `[今天 00:00, 02:00)`——那两小时通常在睡觉，于是窗口为空 → 按"空窗口不推进"
 * 跳过 → 游标仍为 null → 第二天完全重复。**首次复盘会死锁**。同时升级前写入的
 * 事件永远落在下界之前，只成记忆、不成成长。
 */
export function selectReviewWindowDetailed(events, cursorAt, now, until = null) {
    const upper = until ? until.getTime() : Number.POSITIVE_INFINITY;
    const parsedCursor = cursorAt ? Date.parse(cursorAt) : Number.NaN;
    const hasCursor = Number.isFinite(parsedCursor);
    let from;
    if (hasCursor) {
        from = parsedCursor;
    }
    else {
        let earliest = Number.POSITIVE_INFINITY;
        for (const e of events) {
            const t = Date.parse(e.time);
            if (Number.isFinite(t) && t < upper && t < earliest)
                earliest = t;
        }
        // 没有任何可解析且早于上界的事件 → 窗口必然为空（调用方会 skipped），
        // 这里只是防止 `new Date(Infinity).toISOString()` 抛 RangeError 的兜底。
        from = Number.isFinite(earliest) ? earliest : localDayStart(now);
    }
    const window = events.filter((e) => {
        const t = Date.parse(e.time);
        if (!Number.isFinite(t) || t >= upper)
            return false;
        // 有游标用开区间（游标时刻不重复）；无游标时下界就是最早那条事件本身，
        // 必须用闭区间，否则它会被自己的下界排除掉。
        return hasCursor ? t > from : t >= from;
    });
    const truncatedEarlier = Math.max(0, window.length - REVIEW_WINDOW_MAX);
    return {
        events: truncatedEarlier > 0 ? window.slice(window.length - REVIEW_WINDOW_MAX) : window,
        lowerBound: new Date(from).toISOString(),
        truncatedEarlier,
    };
}
/**
 * 只要事件、不要截断信息的薄封装。
 * 仅用于"只关心内容"的调用点；复盘路径必须用 selectReviewWindowDetailed，
 * 否则截断会被静默吞掉。
 */
export function selectReviewWindow(events, cursorAt, now, until = null) {
    return selectReviewWindowDetailed(events, cursorAt, now, until).events;
}
/** 启动时是否该补跑：无游标（首次/升级后）或距上次复盘 ≥ 24h */
export function shouldCatchUpReview(cursorAt, now, minGapMs = CATCH_UP_MIN_GAP_MS) {
    if (!cursorAt)
        return true;
    const t = Date.parse(cursorAt);
    if (!Number.isFinite(t))
        return true;
    return now.getTime() - t >= minGapMs;
}
/**
 * 复盘执行协议（游标推进的唯一合法路径）。
 *
 * 三条规矩，每条都对应一个具体故障：
 * 1. 窗口为空 → 不推进。否则会把"没有新事件"记成"已复盘到此刻"，把之后的事件吞掉。
 * 2. 复盘没产出（门禁/异常）→ 不推进。否则那天永远不会再复盘（游标跳过了它）。
 * 3. 成功 → 推进到"本次窗口的右端"，不是复盘结束时刻：复盘期间新写入的事件必须落在下一次窗口里。
 *    （普通路径的右端就是 startedAt；启动补跑传了 until 时右端是 until，
 *      这样 until 之后、补跑执行期间写入的事件不会因为游标跳过去而丢失。）
 */
export async function runReviewWithCursor(opts) {
    const startedAt = opts.now ?? new Date();
    const startedIso = startedAt.toISOString();
    const until = opts.until ?? null;
    const cursorStore = opts.cursorStore ?? new ReviewCursorStore(opts.store);
    const loaded = await cursorStore.load();
    if (!loaded.ok) {
        // 读不到游标就不复盘：要么重复提交同一天（多一个版本），要么把游标覆盖掉
        return { kind: 'skipped', reason: `复盘游标不可读，本次不执行：${loaded.reason}`, startedAt: startedIso };
    }
    const from = loaded.cursor?.lastReviewAt ?? null;
    const selection = selectReviewWindowDetailed(opts.allEvents, from, startedAt, until);
    const window = selection.events;
    if (window.length === 0) {
        return {
            kind: 'skipped',
            reason: from
                ? `上次复盘（${from}）之后${until ? `、${until.toISOString()} 之前` : ''}没有新事件，跳过`
                : '还没有可复盘的记忆事件，跳过',
            startedAt: startedIso,
        };
    }
    const date = localDateString(startedAt);
    let out;
    try {
        out = await opts.review({ date, events: window, startedAt: startedIso, from });
    }
    catch (err) {
        return {
            kind: 'failed',
            reason: `复盘执行异常：${err instanceof Error ? err.message : String(err)}`,
            startedAt: startedIso,
        };
    }
    if (!out) {
        return { kind: 'failed', reason: '复盘未产出结果（门禁拦截或异常），游标不推进', startedAt: startedIso };
    }
    let cursorWarning;
    try {
        // 右端而不是"结束时刻"：补跑时右端是 until，此后写入的事件留给下一次窗口
        const rightEdge = (until ?? startedAt).toISOString();
        await cursorStore.save({ version: 1, lastReviewAt: rightEdge, lastReviewDate: date });
    }
    catch (err) {
        // 游标写失败不改判"复盘成功"这个事实（内容已经提交了），但必须留痕：
        // 下一次会重复覆盖同一段窗口，值得在日志里看见。
        cursorWarning = `游标写入失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return {
        kind: 'done',
        out,
        window,
        startedAt: startedIso,
        ...(cursorWarning ? { cursorWarning } : {}),
        ...(selection.truncatedEarlier > 0 ? { truncatedEarlier: selection.truncatedEarlier } : {}),
    };
}
//# sourceMappingURL=review-cursor.js.map