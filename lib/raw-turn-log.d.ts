/**
 * P1 raw_turns 原始层 · 追加日志（按月分片 JSONL）
 *
 * 复用 EventLog（src/event-log.ts）的按月分片 JSONL 追加**模式**，但独立成类：
 * - 零改动现有 EventLog（红线：不重构 event-log.ts）；
 * - raw_turns 是纯新增文件，删除 `raw-turns/` 目录即物理回滚；
 * - 未来可能需要不同的字段与谱系删除逻辑，独立类便于演进。
 *
 * 分片目录：`raw-turns/`（store root 下），文件名 `YYYY-MM.jsonl`，`manifest.json` 记录月份。
 * 写路径：`store.appendText()` 追加（O_APPEND 语义，与 EventLog 一致）。
 */
import type { RawTurn } from './types.js';
import type { KVStore } from './store.js';
export interface RawTurnLogOptions {
    /** 分片目录（相对 store root），默认 'raw-turns' */
    dir?: string;
}
export interface RawTurnLogStats {
    months: number;
    total: number;
    /** 被跳过的坏行数（JSON 解析失败 / 缺 event_id） */
    skippedLines: number;
}
export declare class RawTurnLog {
    private readonly store;
    readonly stats: RawTurnLogStats;
    private cache;
    private loadedMonths;
    /** 正在进行的首次加载；并发调用共享同一个 promise（与 EventLog 同理由） */
    private loading;
    private readonly dir;
    constructor(store: KVStore, opts?: RawTurnLogOptions);
    private pathOf;
    private get manifestPath();
    load(): Promise<RawTurn[]>;
    private doLoad;
    /** 只读快照（返回副本数组）——供测试/审计读；P1 生产热路径不调用 */
    list(): Promise<RawTurn[]>;
    /** 追加一条话轮：只写当月分片，绝不重写历史月份 */
    append(turn: RawTurn): Promise<void>;
    private readManifest;
    private writeManifest;
    private noteMonth;
    private listMonths;
}
//# sourceMappingURL=raw-turn-log.d.ts.map