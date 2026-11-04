import type { MemoryFactStats, PersonaAttribute, PersonaEvent, PersonaThread } from './types.js';
import type { KVStore } from './store.js';
/**
 * open thread 多久没被提及就收敛为 expired（天）。
 *
 * 30 天是起步值，TODO(calibrate)：
 * - 太短会把"下个月才出结果的事"（考研、体检复查）误杀，用户再提时状态得重新开；
 * - 太长了等于不收敛，open 槽会被一堆僵尸线索占满，注入里永远是那几件旧事。
 * 先取 30 天（覆盖多数"周/月"量级的生活事件），观察期后按实际复用率调整。
 */
export declare const THREAD_EXPIRY_DAYS = 30;
/** 同一 attribute 每次被重复确认时加的置信度（增长慢，避免两次提及就"确信"） */
export declare const ATTRIBUTE_CONFIDENCE_STEP = 0.1;
/**
 * 稳定短哈希 id：同一 seed 永远得到同一 id，跨天/跨进程/跨机器一致。
 *
 * 不用 store.makeId()（randomUUID）：thread 要能"同 key 跨天合并"，
 * id 必须由 key 推导而不是随机生成，否则每天都会新建一条同名 thread。
 */
export declare function stableId(prefix: string, seed: string): string;
/** thread id：只由 key 推导（同 key = 同一件事） */
export declare function threadId(key: string): string;
/** attribute id：由 key + value 推导（同 key 不同 value 必须是两条，否则取代链指不到新条目） */
export declare function attributeId(key: string, value: string): string;
/**
 * 归一化主题 key：去首尾空白、压缩内部空白、统一小写。
 * 小写对中文无影响，但对英文 key（Pet / pet）是必需的——否则同一件事会分裂成两条 thread。
 */
export declare function normalizeFactKey(raw: unknown): string;
/** 读结果：读失败必须有明确标记，不能让调用方误当空库 */
export type FactLoad<T> = {
    ok: true;
    items: T[];
} | {
    ok: false;
    reason: string;
};
/**
 * threads / attributes 的存储门面。
 *
 * 为什么不用 store.readJson：它在读失败时静默返回 null，调用方无法区分
 * "首次运行（没有文件）"与"文件读不到"——后者若被当成空库，下一次写入就把全库覆盖。
 * 所以这里只用 readText（读失败会抛出）+ 显式区分三态。
 */
export declare class MemoryFactStore {
    private readonly store;
    private readonly dir;
    constructor(store: KVStore, dir?: string);
    get threadsPath(): string;
    get attributesPath(): string;
    /**
     * 读一个 { version, [key]: T[] } 结构。
     * 三态：文件不存在 → 空库（正常首次运行）；读失败/解析失败/结构不符 → ok:false。
     */
    private readList;
    loadThreads(): Promise<FactLoad<PersonaThread>>;
    loadAttributes(): Promise<FactLoad<PersonaAttribute>>;
    /** 原子写（temp+rename / 先备份再覆盖）；不用 writeText，硬状态不允许截断即丢 */
    saveThreads(threads: readonly PersonaThread[]): Promise<void>;
    saveAttributes(attributes: readonly PersonaAttribute[]): Promise<void>;
    /**
     * 注入侧读取：open thread → { threadId: sourceEventIds }。
     *
     * 这里刻意把读失败吞成空 map：注入是每轮热路径，读不到派生层只该意味着
     * "这轮少一个槽位"，不该让整轮对话报错。写路径（复盘）则相反——读失败必须停手。
     */
    loadOpenThreads(): Promise<ReadonlyMap<string, readonly string[]>>;
}
/**
 * open thread → 未结槽输入（threadId → 证据事件 id）。
 * 只取 open：resolved/expired 的事再被提起就是"翻旧账"，那不是此刻要想起的事。
 */
export declare function openThreadEventMap(threads: readonly PersonaThread[]): Map<string, readonly string[]>;
/**
 * 把长期未被提及的 open thread 收敛为 expired（原地修改并返回收敛条数）。
 *
 * 为什么要收敛而不是永久 open：open 槽每轮只出一个名额，
 * 不收敛的话最早那几件事会永久占位（与 v0.5 修掉的"检索冻结"是同一类故障）。
 */
export declare function expireStaleThreads(threads: PersonaThread[], nowMs: number): number;
/** LLM 返回的 thread 候选（全部字段不可信，逐字段校验） */
export interface RawThreadCandidate {
    op?: unknown;
    key?: unknown;
    title?: unknown;
    status?: unknown;
    sourceEventIds?: unknown;
    dueHint?: unknown;
}
/** LLM 返回的 attribute 候选 */
export interface RawAttributeCandidate {
    op?: unknown;
    key?: unknown;
    value?: unknown;
    confidence?: unknown;
    sourceEventIds?: unknown;
    supersedesKey?: unknown;
}
/** LLM 返回的整体结构 */
export interface RawMemoryFactOutput {
    threads?: unknown;
    attributes?: unknown;
}
export interface DeriveInput {
    /** LLM 原始 JSON（parseJsonLoose 的结果） */
    raw: RawMemoryFactOutput | null;
    /** 全量事件 id（sourceEventIds 存在性校验的唯一依据） */
    knownEventIds: ReadonlySet<string>;
    existingThreads: readonly PersonaThread[];
    existingAttributes: readonly PersonaAttribute[];
    /** 派生时刻 ISO（测试可注入） */
    now: string;
}
export interface DeriveResult {
    threads: PersonaThread[];
    attributes: PersonaAttribute[];
    stats: MemoryFactStats;
    /** threads 是否需要落盘 */
    threadsDirty: boolean;
    /** attributes 是否需要落盘 */
    attributesDirty: boolean;
}
/** 造一份零值统计（调用方可覆盖部分字段） */
export declare function emptyMemoryFactStats(patch?: Partial<MemoryFactStats>): MemoryFactStats;
/**
 * 把 LLM 输出派生为 threads / attributes（纯函数，无 I/O，可单测）。
 *
 * 门禁顺序（先便宜后昂贵，且丢弃原因要能解释）：
 * 1. 字段形状（key/title/value/status）→ 'invalid'
 * 2. stripCheck（不许 LLM 给自己写行为脚本）→ 'strip'
 * 3. sourceEventIds 存在性 → 'no-source' / 'unknown-source'
 * 4. 合并（只有全部门禁通过的条目才有资格改库）
 */
export declare function deriveMemoryFacts(input: DeriveInput): DeriveResult;
/** 供外部（测试/命令）读全量事件 id 后直接构造集合 */
export declare function eventIdSet(events: readonly PersonaEvent[]): Set<string>;
//# sourceMappingURL=memory-facts.d.ts.map