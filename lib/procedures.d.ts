/**
 * 程序性记忆层（增量1）：procedures（"遇到什么情况、怎么做"）
 *
 * 机制依据：《记忆架构最终设计 v1.1》§16.1（增量1）+ §4.4（晋升门槛）+ §4.7（七态状态机）。
 * 红线：procedures 只能长出来、不能写进去——必须是 AI 从自身经历归纳的做法
 * （epistemicType 固定 'ai_inference'、默认 candidate、sourceEventIds 非空且真实）。
 * 无证据的 procedure = 预设脚本 → 整条丢弃。
 *
 * 本文件不含 LLM 调用，全部是纯函数 + 存储；调用点只有复盘引擎（写入路径必须零 LLM 调用）。
 * 复用 memory-facts.ts 的存储与校验模式：只 import 已导出的纯函数与类型
 * （stableId / normalizeFactKey / evidenceGroupId / FactLoad），
 * normalizeIds / checkIds / latestEventTime 等校验小工具在模块内自实现，
 * 避免依赖其私有实现（不改 facts 现有逻辑）。
 */
import type { PersonaProcedure, ProcedureStats } from './types.js';
import { type FactLoad } from './memory-facts.js';
import type { KVStore } from './store.js';
/** procedure id：只由 trigger 推导（同 trigger = 同一做法，跨天合并） */
export declare function procedureId(trigger: string): string;
/** 结构性校验（只拦明显坏数据，不改语义；坏条目不静默"修复"成别的值） */
export declare function isProcedureShaped(v: unknown): v is PersonaProcedure;
/**
 * procedures 的存储门面。
 *
 * 为什么不用 store.readJson：与 memory-facts 同一理由——readJson 读失败静默返回 null，
 * 调用方无法区分"首次运行（没有文件）"与"文件读不到"，后者被当成空库会在下次写入覆盖全库。
 * 所以只用 readText（读失败抛出）+ 显式区分三态。
 */
export declare class ProcedureStore {
    private readonly store;
    constructor(store: KVStore);
    get proceduresPath(): string;
    /**
     * 读 { version, procedures: T[] } 结构。
     * 三态：文件不存在 → 空库（正常首次运行）；读失败/解析失败/结构不符 → ok:false。
     */
    loadProcedures(): Promise<FactLoad<PersonaProcedure>>;
    /** 原子写（temp+rename / 先备份再覆盖）；不用 writeText，硬状态不允许截断即丢 */
    saveProcedures(procedures: readonly PersonaProcedure[]): Promise<void>;
}
/** LLM 返回的 procedure 候选（全部字段不可信，逐字段校验） */
export interface RawProcedureCandidate {
    trigger?: unknown;
    action?: unknown;
    rationale?: unknown;
    sourceEventIds?: unknown;
}
/** LLM 返回的整体结构 */
export interface RawProcedureOutput {
    procedures?: unknown;
}
export interface DeriveProceduresInput {
    /** LLM 原始 JSON（parseJsonLoose 的结果） */
    raw: RawProcedureOutput | null;
    /** 全量事件 id（sourceEventIds 存在性校验的唯一依据） */
    knownEventIds: ReadonlySet<string>;
    existingProcedures: readonly PersonaProcedure[];
    /** 派生时刻 ISO（测试可注入） */
    now: string;
    /** eventId → 该事件 ISO time（assertedAt 用；缺省回退 undefined） */
    eventTimes?: ReadonlyMap<string, string>;
}
export interface DeriveProceduresResult {
    procedures: PersonaProcedure[];
    stats: ProcedureStats;
    /** procedures 是否需要落盘 */
    dirty: boolean;
}
/** 造一份零值统计（调用方可覆盖部分字段） */
export declare function emptyProcedureStats(patch?: Partial<ProcedureStats>): ProcedureStats;
/**
 * 把 LLM 输出派生为 procedures（纯函数，无 I/O，可单测）。
 *
 * 门禁顺序（先便宜后昂贵，且丢弃原因要能解释）：
 * 1. 字段形状（trigger/action/rationale 非空）→ 'invalid'
 * 2. stripMemoryFact（trigger/action/rationale 任一含祈使句即整条丢弃）→ 'strip'
 * 3. sourceEventIds 存在性 → 'no-source' / 'unknown-source'
 * 4. 合并（同 id 更新，否则新建 candidate）
 */
export declare function deriveProcedures(input: DeriveProceduresInput): DeriveProceduresResult;
//# sourceMappingURL=procedures.d.ts.map