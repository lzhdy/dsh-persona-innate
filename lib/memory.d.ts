/**
 * 记忆引擎（M0：events 事件层）
 * - 只存事实与事件摘要，不存行为脚本（写入前指令性内容剥离）
 * - provenance 四类来源，user_direct 全权重，其余降权
 * - 检索按 recallScore（来源权重 × 重要性）排序，注入带来源标注
 * - 跨会话：JSON 持久化，新会话加载同库
 */
import type { PersonaEvent, Provenance } from './types.js';
import { type StripStats } from './directive-strip.js';
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
export declare class PersonaMemory {
    private readonly store;
    private readonly opts;
    readonly stripStats: StripStats;
    constructor(store: KVStore, opts: MemoryOptions);
    private eventsPath;
    /**
     * 写入串行队列：M3 开放 assistant 通道后，消息处理/注入刷新/复盘可能并发写 events.json，
     * 两个异步 writeFile 交错会写坏 JSON（open(O_TRUNC)+write 混合）。所有"读-改-写"排队执行，
     * 写入单线程化；读取先等队列排空，保证永远读到完整快照。
     */
    private writeQueue;
    private enqueueWrite;
    private loadEventsUnsafe;
    loadEvents(): Promise<PersonaEvent[]>;
    saveEvents(events: PersonaEvent[]): Promise<void>;
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
    /** 全量事件（按时间升序） */
    list(): Promise<PersonaEvent[]>;
    /**
     * 批量导入历史会话事件（M3 后半 import-chat）：
     * - 一次事务：整体排队读-改-写，防止与实时写入交错；中途状态不外泄
     * - 去重：已有事件的 sourceKey（消息 id / 退化 key）与 dedupKey 双过滤，重复导入不产生重复记忆
     * - 只追加不覆盖；返回新增/跳过统计
     */
    importEvents(candidates: PersonaEvent[]): Promise<{
        added: number;
        skipped: number;
    }>;
    /**
     * 检索最近记忆：recallScore = 来源权重 × 重要性；user_direct / self_direct 优先进入注入
     * M3：注入前对 self_direct 记忆做叙事一致性检查——与当前 self_model 核心叙事显著冲突的
     * 记忆不直接注入，标记为待复盘调和（pendingReconcile），由复盘引擎决定修订旧记忆权重
     * 还是调整 self_model 叙事（重大转变须附带转变叙事）。
     * 返回注入文本（每条带显式来源标注）、命中的事件与待调和事件
     */
    buildInjection(limit?: number, selfModel?: {
        traits?: readonly string[];
        preferences?: readonly string[];
    }): Promise<{
        text: string;
        events: PersonaEvent[];
        pendingReconcile: PersonaEvent[];
    }>;
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