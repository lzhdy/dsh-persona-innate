/**
 * 复盘游标（v0.7）：把复盘窗口从"日期切片"改成"上次复盘时刻 → 现在"
 *
 * 旧实现的问题（index.ts 里 `new Date().toISOString().slice(0,10)` + 日期等值过滤）：
 * 1. toISOString 是 UTC。本地 02:00 执行时切片是"UTC 的前一天"，那一次窗口实际覆盖
 *    本地前一天 08:00 → 当天 07:59。按本机 UTC+8 穷举（每小时的整点事件 × 之后几次 02:00 复盘）：
 *    本地 **02:00–07:59** 的事件永远不被任何一次复盘看到，其余 18 个小时看得到。
 *    （00:00–01:59 幸免：它们与当晚 02:00 那次复盘同属"UTC 的前一天"。）
 *    02:00–07:59 正好压在深夜陪伴高峰上，所以这个缺口不是理论问题。
 * 2. 没有游标：02:00 进程不在（DSH web 常关）就永久丢一天，靠"日期"补不回来。
 * 3. 没有幂等：手动 /persona review 与定时任务可对同一天重复提交，产生两个 self_model 版本。
 *
 * 改成时刻区间后，时区问题自动消失：窗口是 [上次复盘时刻, 现在)，与日历日无关，
 * 凌晨三点的事件会被 02:00 那次之后的任意一次复盘覆盖到。
 *
 * 本模块把"窗口怎么算 / 什么时候推进游标"做成纯函数 + 一个执行协议，
 * 因为 index.ts 的 runDailyReview 是 cordis 闭包，无法单测；接线的判据放这里才能验。
 */
import type { PersonaEvent, ReviewOutput } from './types.js';
import type { KVStore } from './store.js';
/** 游标文件（store root 下；硬状态，用原子写） */
export declare const REVIEW_CURSOR_PATH = "review-state.json";
/**
 * 启动补跑的最小间隔（24h）。
 * 定时器每天一次；距上次复盘不足 24h 说明那次已经跑过（或用不着补），
 * 每次启动都补会白白多花一次 LLM 调用与一个 self_model 版本——DSH 一天可能启动十几次。TODO(calibrate)
 */
export declare const CATCH_UP_MIN_GAP_MS: number;
export interface ReviewCursor {
    version: 1;
    /** 上次复盘开始的时刻（ISO） */
    lastReviewAt: string;
    /** 上次复盘覆盖到的本地日期（仅展示/审计用，不参与窗口计算） */
    lastReviewDate?: string;
}
export type CursorLoadResult = {
    ok: true;
    cursor: ReviewCursor | null;
} | {
    ok: false;
    reason: string;
};
/**
 * 游标存储。
 * 读失败必须显式返回错误而不是 null：把"读不到"当成"没有游标"会让窗口退回当日零点，
 * 于是同一天被反复复盘（重复版本），或者游标被覆盖成空值。
 */
export declare class ReviewCursorStore {
    private readonly store;
    private readonly path;
    constructor(store: KVStore, path?: string);
    load(): Promise<CursorLoadResult>;
    save(cursor: ReviewCursor): Promise<void>;
}
/** 本地零点（毫秒）。刻意不用 toISOString 切片：UTC 切片的"今天"在本地 02:00 前后会指向前一天 */
export declare function localDayStart(now: Date): number;
/** 本地日期串 YYYY-MM-DD（只作标签/审计，不参与窗口计算） */
export declare function localDateString(now: Date): string;
/**
 * 复盘窗口：游标时刻（开区间）→ 现在。
 * 无游标（首次启用本机制）时退化为"本地当日 00:00 起"：
 * 没有游标就没有可靠的区间起点，用当日零点是最保守的近似（宁可漏掉升级前的历史，
 * 也不要把一年前的旧事件当成"今天发生的事"再复盘一遍）。
 * 时间戳不可解析的事件直接排除（无法确定它属于哪段窗口）。
 *
 * `until` 是可选的上界（开区间）。只有启动补跑会传它：补跑要补的是"进程不在期间"的缺口，
 * 不该把本次会话刚刚写入的事件也算进来（那既浪费一次 LLM 调用，又会和紧随其后的
 * 手动 /persona review 抢同一个窗口）。传上界时窗口变成 (from, until)，闭区间会让
 * "启动那一毫秒写入的事件"挤进补跑，因此这里取严格小于。
 */
export declare function selectReviewWindow(events: readonly PersonaEvent[], cursorAt: string | null, now: Date, until?: Date | null): PersonaEvent[];
/** 启动时是否该补跑：无游标（首次/升级后）或距上次复盘 ≥ 24h */
export declare function shouldCatchUpReview(cursorAt: string | null, now: Date, minGapMs?: number): boolean;
export type ReviewWindowOutcome = 
/** 成功复盘并推进游标 */
{
    kind: 'done';
    out: ReviewOutput;
    window: PersonaEvent[];
    startedAt: string;
    cursorWarning?: string;
}
/** 没有可复盘的事件（窗口为空 / 游标不可读）——不推进游标 */
 | {
    kind: 'skipped';
    reason: string;
    startedAt: string;
}
/** 复盘执行了但没有产出（门禁拦截或异常）——不推进游标 */
 | {
    kind: 'failed';
    reason: string;
    startedAt: string;
};
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
export declare function runReviewWithCursor(opts: {
    store: KVStore;
    allEvents: readonly PersonaEvent[];
    /** 实际复盘动作（返回 null 表示门禁拦截/未提交） */
    review: (input: {
        date: string;
        events: PersonaEvent[];
        startedAt: string;
        from: string | null;
    }) => Promise<ReviewOutput | null>;
    /** 注入时钟（测试用） */
    now?: Date;
    /** 窗口上界（启动补跑用）：只复盘 until 之前写入的事件 */
    until?: Date | null;
    /** 注入游标存储（测试可换成读失败实现） */
    cursorStore?: ReviewCursorStore;
}): Promise<ReviewWindowOutcome>;
//# sourceMappingURL=review-cursor.d.ts.map