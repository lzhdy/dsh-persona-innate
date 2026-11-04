/**
 * events 追加日志（按月分片 JSONL）
 *
 * 为什么不再用单个 events.json：
 * - 只追加的层应该用只追加的形态。整文件读-改-写让单条事件（约 640 B）触发全库重写，
 *   一年后写放大约 7000×，而它还是每轮对话的热路径。
 * - 读失败不再等于空库。旧实现 readJson 读不到 → []，下一次写入就把全库覆盖；
 *   分片追加下，读不到某月只是少读一段，追加永远只写当月，不会波及历史。
 * - 损坏被限制在一行/一月。单行 JSON 坏掉只跳这一行，同月其余事件仍可读。
 * - 封存即归档。月份分片天然是压缩/归档/删除的边界。
 */
import type { PersonaEvent } from './types.js';
import type { KVStore } from './store.js';
/**
 * 事件所属月份分片。时间戳不可解析时退回当前月（宁可写进当月，也不丢事件）。
 */
export declare function monthKeyOf(iso: string, now?: Date): string;
export interface EventLogStats {
    /** 已加载的分片月数 */
    months: number;
    /** 已加载的事件条数 */
    total: number;
    /** 被跳过的坏行数（JSON 解析失败/缺 id） */
    skippedLines: number;
    /** 读取失败被跳过的月份（不阻断其它月份） */
    unreadableMonths: string[];
    /** 发生过旧格式迁移时记录来源路径 */
    migratedFrom?: string;
    /** 旧文件与现存分片并存、未自动合并（已留档，需人工确认） */
    legacySkipped?: boolean;
}
export interface EventLogOptions {
    /** 分片目录（相对 store root） */
    dir?: string;
    /** 旧单文件路径，用于一次性迁移 */
    legacyPath?: string;
}
export declare class EventLog {
    private readonly store;
    readonly stats: EventLogStats;
    private cache;
    private loadedMonths;
    private migrationChecked;
    private readonly dir;
    private readonly legacyPath;
    constructor(store: KVStore, opts?: EventLogOptions);
    private pathOf;
    private get manifestPath();
    load(): Promise<PersonaEvent[]>;
    /** 只读快照（返回副本数组，元素仍为内部引用） */
    list(): Promise<PersonaEvent[]>;
    /** 追加一条事件：只写当月分片，O(1)，绝不重写历史月份 */
    append(event: PersonaEvent): Promise<void>;
    /** 批量追加（import-chat）：按月聚合，一次写一片 */
    appendMany(events: readonly PersonaEvent[]): Promise<void>;
    /**
     * 全量重写（仅供压缩/归档/测试构造使用，不在对话热路径调用）。
     * 会按新集合重算各月内容；不再有事件的月份写成空分片。
     */
    rewriteAll(events: readonly PersonaEvent[]): Promise<void>;
    private readManifest;
    private writeManifest;
    private noteMonth;
    /**
     * 分片清单：有 manifest 就信任它（+ 当月），缺失时才有界探查近 24 个月。
     * 探查是 25 次 stat，启动期每个实例都做一次代价太高；manifest 是正常的快路径。
     */
    /**
     * 是否已存在任何分片文件。
     *
     * 注意不能写成 `(await this.listMonths()).length > 0`：listMonths 在无 manifest 时
     * 总是自动补入当前月，长度恒 ≥ 1，那样判断会让迁移分支永远不执行。
     */
    private hasAnyShard;
    private listMonths;
    /**
     * 旧 events.json → 分片的一次性迁移。
     * 幂等：已有任何分片则不迁移；迁移后旧文件留指针，完整旧数据存 events.json.migrated。
     */
    private ensureMigrated;
}
export declare const MS_PER_DAY = 86400000;
//# sourceMappingURL=event-log.d.ts.map