/**
 * self_model 服务（§9：四来源 / 存在论锚点 / 自我叙事版本化）
 * 持久化 self-model.json（SelfModelFile，JsonStore 读写，写前自动 mkdir）。
 * 防漂移（§9）：新特质须可追溯到事件证据；重大转变须附 changeNote；
 * 版本单调递增；保留最近 N 版可回滚。
 */
import type { CandidateTrait, GrowthEntry, SelfModelDiff, SelfModelServiceLike, SelfModelSnapshot, SelfModelSource } from './types.js';
import type { KVStore } from './store.js';
/** 存在论锚点（§9 原文：自我模型始终声明 AI 身份——不伪装人类，但可以有独特个体性） */
export declare const EXISTENTIAL_ANCHOR = "\u6211\u662F AI\uFF0C\u6B63\u5728\u901A\u8FC7\u4E0E\u4F60\u7684\u76F8\u5904\u5F62\u6210\u81EA\u5DF1\u7684\u65B9\u5F0F\u3002\u4E0D\u4F2A\u88C5\u4EBA\u7C7B\uFF0C\u4F46\u53EF\u4EE5\u6709\u72EC\u7279\u4E2A\u4F53\u6027\u3002";
export declare const DEFAULT_SELF_MODEL_VERSION_LIMIT = 10;
export interface SelfModelOptions {
    /** history 保留上限（默认 DEFAULT_SELF_MODEL_VERSION_LIMIT） */
    historyLimit?: number;
}
/** 首版种子快照：存在论锚点 + 空特质/证据 + 说话方式占位（§2 冻结约定） */
export declare function seedInitialSnapshot(): SelfModelSnapshot;
/**
 * 兼容旧数据：把磁盘上任意形态的 candidateTraits 归一化成 CandidateTrait[]。
 *
 * 为什么必须有（ISS-048）：`candidateTraits` 从 `string[]` 改成了带证据的对象数组，
 * 而真实用户的 self-model.json 里已经躺着 3 条字符串、history 里还有 5 个旧版本。
 * 要求用户手工迁移是不可接受的——旧数据照样要能加载、能继续跑，只是"没有证据"，
 * 于是按规则继续冻结（这是预期行为，不是错误，也不该抛）。
 *
 * 容错口径（宁可少读也不炸）：
 * - 字符串（含首尾空白剔除）→ `{ text, sourceEventIds: [] }`；
 * - 对象且 `text` 是非空字符串 → 补 `sourceEventIds`（过滤非字符串 id）+ 透传两个时间戳；
 * - 其它（null / 数字 / 空文本 / 数组里的对象套对象）→ 丢弃。
 */
export declare function normalizeCandidateTraits(raw: unknown): CandidateTrait[];
export declare class SelfModelService implements SelfModelServiceLike {
    private readonly store;
    private readonly historyLimit;
    constructor(store: KVStore, opts?: SelfModelOptions);
    /** 读盘；文件缺失时惰性落盘种子（§9：自我模型始终包含锚点） */
    private getFile;
    private save;
    load(): Promise<SelfModelSnapshot | null>;
    listHistory(): Promise<SelfModelSnapshot[]>;
    commitFromSources(diff: SelfModelDiff, evidence: string[], sources: SelfModelSource[], changeNote?: string): Promise<SelfModelSnapshot>;
    /**
     * P2（ISS-048 改造）：把候选特质合并进 candidateTraits（不碰 current.traits）。
     * 与 commitFromSources 同款版本化规则：版本 +1、旧 current 入 history（按 historyLimit 截断）。
     *
     * 合并规则（按 text 为键，不是整对象去重）：
     * - 已存在 → sourceEventIds 取**并集**（同一特质在不同天被不同事件支撑，证据要累积，
     *   否则"跨 ≥2 日期"永远攒不够）+ 刷新 lastSeenAt；
     * - 不存在 → push，并记 firstSeenAt/lastSeenAt。
     * 旧数据（无 firstSeenAt）合并时保持 firstSeenAt 缺失——宁可显示"未知"，
     * 也不要把"今天"写成它的首次出现时间（那就是在伪造证据时间线）。
     */
    commitCandidates(candidates: CandidateTrait[]): Promise<SelfModelSnapshot>;
    /**
     * ISS-048：按文本把候选移出候选池（晋升完成后调用）。
     * 与 commit 路径同款版本化规则；没有任何匹配项时**不写盘**——
     * 否则每次复盘都会因为"移除空集"白涨一个版本，把回滚窗口挤掉。
     */
    removeCandidates(texts: string[]): Promise<SelfModelSnapshot>;
    rollback(version: number): Promise<SelfModelSnapshot | null>;
    appendGrowth(entry: GrowthEntry): Promise<void>;
    /**
     * 注入层摘要（同步纯函数）。固定四行格式——注入层 KV cache 前缀依赖此格式，禁止自由发挥。
     * snapshot 为 null/undefined 时仅返回锚点行。
     */
    getInjectionSummary(snapshot?: SelfModelSnapshot | null): string;
}
//# sourceMappingURL=self-model.d.ts.map