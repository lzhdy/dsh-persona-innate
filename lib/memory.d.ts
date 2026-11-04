/**
 * 记忆引擎（M0：events 事件层）
 * - 只存事实与事件摘要，不存行为脚本（写入前指令性内容剥离）
 * - provenance 七类来源；可信度权重与显著性权重分离（提不提 ≠ 留不留）
 * - 检索：五槽装配（近因/未结/线索/自我/轮廓），注入带来源与时间标注
 * - 存储：按月分片 JSONL 追加日志，读失败不再退化为"空库后覆盖"
 * - 软状态（lastRetrieved）只在内存维护，不每轮落盘
 */
import type { PersonaEvent, Provenance } from './types.js';
import { type StripStats } from './directive-strip.js';
import { EventLog } from './event-log.js';
import { type RecallSlot } from './recall.js';
import type { KVStore } from './store.js';
export interface MemoryOptions {
    stripDirectives: boolean;
    injectLimit: number;
}
export interface AddResult {
    event: PersonaEvent;
    rejected: boolean;
    reason?: string;
}
/** 注入装配的可选输入（向后兼容：不传等价于旧行为 + 无时间项） */
export interface BuildInjectionOptions {
    /** 当前用户消息，供线索槽使用 */
    cueText?: string;
    /** 注入时刻（毫秒），测试可注入 */
    now?: number;
    /** 未结线索：thread key → 事件 id（M4 复盘产出后接入） */
    openThreads?: ReadonlyMap<string, readonly string[]>;
    /**
     * 注入文本字符预算。按条数限流会让"一条 118 字的自述"和"一条 60 字的用户事实"
     * 占同一个名额（实测摘要长度 60–118 字，近 2 倍差），预算应按体量算。
     */
    maxChars?: number;
}
/** 默认注入字符预算（约等于 400–500 token） */
export declare const DEFAULT_INJECTION_MAX_CHARS = 700;
/** 折叠换行与连续空白为单空格（只用于注入渲染，不改存储原文） */
export declare function oneLine(text: string): string;
export interface InjectionResult {
    text: string;
    events: PersonaEvent[];
    pendingReconcile: PersonaEvent[];
    /** 每条注入记忆来自哪个槽位（归因用，不进入注入文本） */
    slots: Array<{
        id: string;
        slot: RecallSlot;
        score: number;
    }>;
}
export declare class PersonaMemory {
    private readonly store;
    private readonly opts;
    readonly stripStats: StripStats;
    private readonly log;
    /** 软状态：本次会话内的检索时间（不落盘，flush 时随分片重写顺带持久化） */
    private softDirty;
    constructor(store: KVStore, opts: MemoryOptions);
    loadEvents(): Promise<PersonaEvent[]>;
    /** 全量事件（按时间升序）。返回数组副本，元素为内部引用 */
    list(): Promise<PersonaEvent[]>;
    /**
     * 全量重写（压缩/归档/测试构造用，不在对话热路径调用）。
     */
    saveEvents(events: PersonaEvent[]): Promise<void>;
    /** 分片存储统计（坏行、不可读月份、迁移来源） */
    get storageStats(): EventLog['stats'];
    /**
     * 写入事件：剥离检查通过才落库；命中指令性内容则拒绝写入（O37 剥离优先于降权）
     */
    addEvent(input: {
        topic: string;
        summary: string;
        provenance?: Provenance;
        importance?: number;
        emotionTags?: string[];
        initiation?: PersonaEvent['initiation'];
        /** M3：AI 自身表达强度（self_direct/induced 事件） */
        strength?: PersonaEvent['strength'];
        /** M3：立场模式 key（跨事件计数） */
        selfPattern?: PersonaEvent['selfPattern'];
        /** M3：inferred 证据追溯 */
        sourceEventIds?: PersonaEvent['sourceEventIds'];
        /** M3-2：诱导风险等级（low=确认可信 / unchecked=未命中规则但不保证干净） */
        inductionRisk?: PersonaEvent['inductionRisk'];
        /** M3 后半：历史会话导入标记（补记忆不补成长） */
        imported?: PersonaEvent['imported'];
        /** M3 后半：导入去重主键（会话消息 id 或退化 key） */
        sourceKey?: PersonaEvent['sourceKey'];
    }): Promise<AddResult>;
    /**
     * 批量导入历史会话事件（M3 后半 import-chat）：
     * - 一次事务：按月聚合批量追加，中途状态不外泄
     * - 去重：已有事件的 sourceKey（消息 id / 退化 key）与 dedupKey 双过滤
     * - 只追加不覆盖；返回新增/跳过统计
     */
    importEvents(candidates: PersonaEvent[]): Promise<{
        added: number;
        skipped: number;
    }>;
    /**
     * 检索装配注入：五槽各取至多一条（近因/未结/线索/自我/轮廓），剩余按显著性补足。
     * 不再为 lastRetrieved 写盘——它是软状态，只在内存更新。
     */
    buildInjection(limit?: number, selfModel?: {
        traits?: readonly string[];
        preferences?: readonly string[];
    }, opts?: BuildInjectionOptions): Promise<InjectionResult>;
    /**
     * 择机落盘软状态（会话结束/进程退出前调用）。
     * 不放在每轮注入里：那会让一次纯读操作触发全库重写。
     */
    flushSoftState(): Promise<boolean>;
}
/** 叙事对立词对 [叙事正向, 叙事负向变体]（self_direct 事件与 self_model 核心叙事的冲突判定） */
export declare const NARRATIVE_OPPOSITES: ReadonlyArray<{
    pos: string;
    negs: readonly string[];
}>;
/**
 * 判定一条 self_direct 记忆是否与当前 self_model 核心叙事冲突。
 * 例：插件相识期说过"我不太在意纪念日"，而 self_model 已形成"我在意共同记忆"叙事 →
 * 冲突 → 不注入，标记待复盘调和（漂移审计要检测的一致性，前移到注入时）。
 */
export declare function narrativeConflict(e: {
    provenance?: string;
    summary?: string;
}, selfModel: {
    traits?: readonly string[];
    preferences?: readonly string[];
}): boolean;
/**
 * M3 保留优先级（O6/O35 落地）：self_direct/induced/self_correction 记忆的保留不由
 * 用户反应主导——自源重要性（是否进入 self_model 叙事、是否与插件自身目标/好奇相关）
 * 占主导，用户反应只作辅助信号。否则插件"自己觉得重要"的表达会因无用户回应被遗忘，
 * 重新制造"以用户为核心"的偏差。
 *
 * 注意与 SALIENCE_WEIGHT（提不提）的分工：本函数回答"留不留"，不参与注入排序。
 * self_direct 的正确姿态是「高保留、低提及」。
 *
 * M3-2 importance 解耦：检索权重（PROVENANCE_WEIGHT）可对 induced/self_correction 降权，
 * 但保留优先级不降权——induced 价值在于被标记可审计，self_correction 是学习信号，
 * 两者都必须活着供审计/验证。未来实现 O6 遗忘公式时不得在此维度复用检索降权。
 * @param selfRelevant 是否与自身目标/叙事相关（复盘赋值）
 * @param userReaction 用户反应强度 0-1（无回应为 0）
 */
export declare function retentionPriority(e: {
    provenance?: string;
    importance?: number;
    selfPattern?: string;
}, selfRelevant?: boolean, userReaction?: number): number;
//# sourceMappingURL=memory.d.ts.map