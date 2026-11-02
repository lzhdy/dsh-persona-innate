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
    }): Promise<AddResult>;
    /** 全量事件（按时间升序） */
    list(): Promise<PersonaEvent[]>;
    /**
     * 检索最近记忆：recallScore = 来源权重 × 重要性；user_direct 优先进入注入
     * 返回注入文本（每条带显式来源标注）与命中的事件
     */
    buildInjection(limit?: number): Promise<{
        text: string;
        events: PersonaEvent[];
    }>;
}
//# sourceMappingURL=memory.d.ts.map