/**
 * 检索装配（v0.5）：从"排序取 top-k"改为"配额装配"
 *
 * 为什么不再用 top-k：
 * - top-k 优化的是"相关"，人格需要的是"这一轮该想起哪几件事"，优化的是构成。
 * - 旧实现 recallScore = 来源权重 × 重要性 不含时间项，且用户侧 importance 只有
 *   0.6/0.7/0.8 三档 → 大量并列；Array.sort 稳定 → 同分按写入顺序 → 最早的 N 条
 *   永久占位，检索退化成常量函数（新记忆永远进不来）。
 * - 五槽各取至多一条：多样性由构造保证，不需要调 MMR；每槽可单独归因（可证伪）；
 *   token 预算固定，不随记忆增长膨胀。
 */
import type { PersonaEvent } from './types.js';
/** 一天的毫秒数（从 time.ts 转出：memory-facts 等模块从这里取，保持引用面不变） */
export { MS_PER_DAY } from './time.js';
/** 时间衰减半衰期（天）。起步值，待观察期校准 */
export declare const DEFAULT_TAU_DAYS = 14;
/** 近因槽窗口（小时） */
export declare const RECENT_WINDOW_HOURS = 72;
/** 轮廓槽最小年龄（天）：久未提取但仍重要的记忆 */
export declare const OUTLINE_MIN_AGE_DAYS = 60;
/** 线索槽最低相似度与最少共享内容词元数（中文一句话里通常只共享一个词，不能要求 2 个） */
export declare const CUE_MIN_SIMILARITY = 0.04;
export declare const CUE_MIN_SHARED_TOKENS = 1;
export type RecallSlot = 'recent' | 'open' | 'cue' | 'self' | 'outline' | 'fill';
export interface RecallItem {
    event: PersonaEvent;
    slot: RecallSlot;
    score: number;
}
export interface RecallOptions {
    /** 当前时刻（毫秒），测试可注入 */
    now?: number;
    /** 当前用户消息，用于线索槽（线索依赖提取） */
    cueText?: string;
    tauDays?: number;
    /**
     * 未结线索：thread key → 事件 id。
     * M4 之前由复盘产出，当前为空；槽位先留好，接入时不需要改装配器。
     */
    openThreads?: ReadonlyMap<string, readonly string[]>;
}
export interface RecallResult {
    items: RecallItem[];
    /** 因数据不足而空置的槽位（用于观测"占位率"） */
    emptySlots: RecallSlot[];
}
/** 0.5^(Δt/τ)：14 天半衰，60 天后约 5% */
export declare function recencyFactor(e: PersonaEvent, now: number, tauDays?: number): number;
/**
 * 显著性 = 来源显著性 × 重要性 × 衰减项。
 * 衰减不把旧记忆压到 0，而是压到 DECAY_FLOOR，保证"很久以前但很重要"仍能被轮廓槽取到。
 */
export declare function salienceScore(e: PersonaEvent, now: number, tauDays?: number): number;
/**
 * 词元集合：中文按二元组切分，英文/数字按词切分。
 * 不引分词依赖：二元组对中文句子相似度足够，且对错别字/语序更鲁棒。
 */
export declare function cueTokens(text: string): Set<string>;
/** 余弦相似度 + 共享内容词元数（单字与停用词元不计入 shared） */
export declare function cueSimilarity(a: string, b: string): {
    score: number;
    shared: number;
};
/**
 * 相对时间描述（注入用描述性事实，不是指令）。
 *
 * 口径：**本地日历日之差**，不是"经过的 24 小时"。
 * 旧实现用 `Math.floor((now - t) / MS_PER_DAY)`，于是"昨晚 21:14"在今天下午 15:03
 * 注入时只过了 17.8 小时，被标成「今天」——模型会把昨天下午的事当成刚发生的。
 * 判定口径与 `review-cursor` 的复盘窗口统一到 `time.ts`。
 */
export declare function relativeDayLabel(iso: string, now: number): string;
/**
 * 五槽装配：近因 / 未结 / 线索 / 自我 / 轮廓，各至多一条，剩余名额按显著性补足。
 */
export declare function assembleRecall(events: readonly PersonaEvent[], limit: number, opts?: RecallOptions): RecallResult;
//# sourceMappingURL=recall.d.ts.map