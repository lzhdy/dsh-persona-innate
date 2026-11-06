/**
 * 每日复盘引擎（M1 · 线 D）
 * 机制依据：设计文档 v0.8 §10（8 步复盘流程 / O17 降级 / O6·O35 自源重要性）+ §8（选择性强化）
 * 冻结导出面见 docs/m1-interface-design.md §2——修改必须逐字对齐。
 * 注意：本模块只依赖 ./types.js / ./store.js（类型）+ ./event-log.js + ./memory-facts.js，
 *       不 import ./self-model.js 与 ./state.js，运行时由集成线 H 注入实例
 *       （SelfModelServiceLike / StateMachineLike）。event-log / memory-facts 都只依赖
 *       types + store，不构成环。
 */
import type { LlmClient, MemoryFactStats, PersonaEvent, PersonaFact, PersonaStage, ProcedureStats, ReviewInput, ReviewOutput, SelfImportanceEntry, SelfModelDiff, SelfModelServiceLike, SelfModelSnapshot, StateMachineLike, UserFeedback } from './types.js';
import type { KVStore } from './store.js';
/** 复盘依赖（运行时注入；state 在 M1 复盘流水线内不写回，仅保留注入位） */
export interface ReviewDeps {
    llm: LlmClient;
    selfModel: SelfModelServiceLike;
    state: StateMachineLike;
    store: KVStore;
}
/** 预留配置：复盘频率 / 成本上限，M1 保持空 */
export interface ReviewOptions {
}
/** 三步反思 prompt（中文模板，要求固定 JSON 输出，字段名与 PersonaFact / SelfModelDiff 对齐；§10 文档未覆盖，自定） */
export declare const REVIEW_PROMPTS: {
    distillFacts: string;
    reflectSelf: string;
    updateMirror: string;
};
/**
 * v0.6 记忆事实派生 prompt（threads / attributes）。
 *
 * 为什么单独一步而不是塞进 distillFacts：两件事的寿命不同、合并方式不同，
 * 混在一个 prompt 里会让模型把"会结束的事"写成"长期事实"（"在考虑跳槽"变成"没工作"），
 * 而这类错误一旦落盘就长期存在。分开问，结构上就不会串。
 */
export declare const MEMORY_FACT_PROMPT: string;
/**
 * 增量1 程序性记忆派生 prompt（procedures）。
 *
 * 为什么单独一步而不是塞进 MEMORY_FACT_PROMPT：facts 是"发生了什么"，
 * procedures 是"她怎么做的"，寿命与晋升门槛不同（candidate 默认冻结、跨 ≥2 日期才 active），
 * 混在一个 prompt 里会让模型把"做法"写成"事实"或反过来。
 *
 * 红线落地：prompt 明确要求"只能归纳你自己（assistant）的做法、禁止祈使句、禁止预设"，
 * 但 prompt 约束不是门禁——真正拦下预设脚本的是 deriveProcedures 的 stripMemoryFact +
 * sourceEventIds 存在性校验（无证据整条丢弃）。
 */
export declare const PROCEDURE_PROMPT: string;
/**
 * 增量2 综合泛化 prompt（facts → traits 候选）。
 *
 * 与 reflectSelf 互补不重复：reflectSelf 从"当日事件"反思即时表达；
 * generalize 从"当日语义事实"归纳稳定特质（须 ≥2 证据）。
 * ISS-048：泛化产物是**唯一**能晋升的候选来源——它自带 sourceEventIds
 * （事实的事件证据），闸门才数得出"跨几个日期"；即时特质没有证据，恒冻结。
 */
export declare const GENERALIZE_PROMPT: string;
/** 每日复盘引擎：8 步流水线（§10），LLM 输出解析失败时该步降级为空继续，保证 mock 无 key 可跑 */
export declare class DailyReviewEngine {
    private readonly deps;
    private readonly opts;
    /**
     * threads / attributes 存储。
     * 复用注入进来的 store 构造，而不是在方法里读文件：
     * 测试把 store 换成临时目录（或故意读失败的实现）即可，不需要额外的注入点。
     */
    private readonly facts;
    /**
     * procedures 存储（增量1）。
     * 复用注入进来的 store 构造，而不是在方法里读文件——测试把 store 换成临时目录即可。
     */
    private readonly procedures;
    constructor(deps: ReviewDeps, opts?: ReviewOptions);
    /** O17：无输入 skip；仅身体事件（initiation=external_triggered）degraded；其余 full */
    shouldRun(input: ReviewInput): 'full' | 'degraded' | 'skip';
    /** step1 提取当日关键事件（无 LLM：按重要性阈值过滤后降序截断） */
    extractKeyEvents(events: PersonaEvent[]): PersonaEvent[];
    /** step2 提炼语义事实（LLM reflect #1；降级复盘也执行）。解析失败 → [] 降级继续 */
    distillFacts(events: PersonaEvent[]): Promise<PersonaFact[]>;
    /** step2.5 综合泛化（增量2）：从 type=self 的 facts 归纳稳定特质（≥2 事件证据） */
    generalize(facts: PersonaFact[]): Promise<{
        trait: string;
        sourceEventIds: string[];
    }[]>;
    /** step3 反思自我（LLM reflect #2）。解析失败 → {} 降级继续 */
    reflectSelf(events: PersonaEvent[], facts: PersonaFact[]): Promise<Partial<SelfModelDiff>>;
    /** step4 更新关系认知·镜中我（LLM reflect #3）。解析失败 → '' 降级继续 */
    updateMirror(events: PersonaEvent[], feedback: UserFeedback[]): Promise<string>;
    /**
     * step4.5（v0.6）：从当日事件派生 threads / attributes（LLM #4，单独计入 cost.memoryFactCalls）。
     *
     * 为什么只在复盘里做：addEvent 是对话热路径，必须保持廉价、规则化、零 LLM 调用；
     * 派生是"慢改"，合并、取代、过期收敛都需要跨天视角，只有复盘同时具备事件窗口与写权限。
     *
     * 失败姿态（与 events 层"读失败→空库→覆盖"的坑对齐）：
     * - 读不到既有 threads/attributes → 直接返回，不写盘（否则会用空集合覆盖全库）；
     * - LLM 输出不是 JSON → 直接返回，不写盘（解析失败不等于"今天没有新事实"，
     *   若按空输出落盘，过期收敛会顺带改状态，等于用一次失败的调用来改库）；
     * - 写盘抛错 → 捕获并记进 stats.error，不打断复盘主流程。
     */
    extractThreadsAndAttributes(events: readonly PersonaEvent[], opts?: {
        now?: string;
        allEvents?: readonly PersonaEvent[];
    }): Promise<MemoryFactStats>;
    /**
     * step4.6（增量1）：从当日事件派生 procedures（LLM #5，单独计入 cost.procedureCalls）。
     *
     * 与 extractThreadsAndAttributes 同一失败姿态：
     * - imported 事件不参与（补记忆不补成长）；
     * - 读不到既有 procedures → 直接返回，不写盘（否则用空集合覆盖全库）；
     * - LLM 输出不是 JSON → 直接返回，不写盘；
     * - 写盘抛错 → 捕获并记进 stats.error，不打断复盘主流程。
     *
     * 晋升闸门：deriveProcedures 产出后，对每条 candidate 跑 decideProcedurePromotion，
     * 达标者 status='active' + statusChangedAt=now，否则保持 candidate（默认冻结）。
     */
    extractProcedures(events: readonly PersonaEvent[], opts?: {
        now?: string;
        allEvents?: readonly PersonaEvent[];
    }): Promise<ProcedureStats>;
    /** step5 一致性检查（§9：新认知须有事件证据） */
    consistencyCheck(diff: SelfModelDiff, facts: PersonaFact[]): {
        ok: boolean;
        issues: string[];
    };
    /** step7 判定发展阶段：seeding→forming→shaping→stable（启发式，TODO(calibrate)）。M1"性格开始成形"=进入 shaping */
    judgeStage(selfModel: SelfModelSnapshot | null): PersonaStage;
    /**
     * O6/O35 自源重要性：事件进入 diff.narrative 或与 selfGoals（self_model.preferences+traits 与好奇话题）
     * 相关 → selfSource:true、importance = max(原值, 0.65)。与用户反应并列而非从属，
     * 不因用户未回应而压制（本函数不读 feedback，即体现并列）。
     */
    assignSelfImportance(events: PersonaEvent[], diff: SelfModelDiff, selfGoals: string[]): SelfImportanceEntry[];
    /**
     * run 顶层调度（§10 8 步流水线）：
     * skip → 空输出；degraded → step1-2 + 事件标签（不更新 self_model）；full → 8 步全走。
     * step6 commitVersion：commitFromSources consistency 抛错则捕获、记 issues、selfModel:null。
     */
    run(input: ReviewInput): Promise<ReviewOutput>;
    /**
     * ISS-048：把两路候选合成一个候选列表（按 text 去重，证据取并集）。
     *
     * 两路来源的差别是**有没有证据**，这正是闸门要区分的东西：
     * - `instant`（reflectSelf 直接产出的 traits）：LLM 说"我是这样的人"，但没有事件指向它 →
     *   `sourceEventIds: []` → 闸门第一步就冻结（用户已拍板：即时 traits 永不晋升）；
     * - `gens`（generalize 产出）：来自 type=self facts，天然带事件证据 → 可晋升。
     * 同一文本两路都出现时合并证据：宁可让它有机会晋升，也不要因为先到的是即时 traits
     * 就把整条判死（否则"泛化结论恰好和即时表述同字"会被永久冻结）。
     */
    private buildTraitCandidates;
    /**
     * ISS-048：把本轮候选与候选池里同名条目合并（证据取并集）。
     *
     * 这是"闸门能看到候选一生"的关键一步：泛化特质每轮只带当天证据，
     * 池子里存着前几轮累积的证据，两者合并才可能凑出"跨 ≥2 个日期"。
     * 池里没有同名条目 → 原样返回（新候选从零开始攒）。
     */
    private mergeWithCandidatePool;
    /**
     * ISS-048：构造晋升证据表（事件 id → 时间/来源）。
     *
     * 读的是**全量**事件而不是本次窗口：门槛问的是"这条候选一生跨了几个日期"，
     * 而窗口是按天裁的（与 procedures 的做法一致，见 decideProcedurePromotion）。
     * 优先复用调用方传进来的 allEvents，避免同一轮复盘把全量日志读两遍。
     * 读失败 → 返回空表：查不到证据就当证据不存在，一律冻结（保守：宁可不晋升）。
     */
    private loadTraitEvidence;
    /** 宽松 JSON 解析：先直 parse，失败再截取首个 {...} 块；都失败 → null（调用方降级为空） */
    private parseJsonLoose;
    /** 事件标签：事件支撑了哪类事实（fact:user/world/self）+ initiation / 情绪标签 */
    private buildEventTags;
    /** selfGoals：self_model.preferences + traits（TODO(calibrate)：M2 合并好奇引擎未完结话题） */
    private extractSelfGoals;
    private hasDiffContent;
    /** commit 证据链：事实引用的事件 + 全部关键事件 id */
    private collectEvidence;
}
/** 固化阈值：同类 self_direct（low）表达至少跨 N 个事件（初始 3，待校准） */
export declare const PATTERN_FIX_THRESHOLD = 3;
/** M3-2：unchecked（未确认可信）立场模式的固化门槛——更高且须跨会话 */
export declare const UNCHECKED_FIX_THRESHOLD = 5;
/** M3-2：self_correction 延迟验证——无引导自发维持的次数门槛 */
export declare const CORRECTION_MAINTAIN_THRESHOLD = 2;
/**
 * 统计 self_direct 事件的立场模式计数（按 selfPattern 分组，跨事件计数）。
 * M3-2：只统计 inductionRisk='low'（确认可信）事件——漏报的诱导（unchecked）不得与
 * confirmed clean 合并计数（否则换措辞诱导会被模式阈值放大成"反复模式"）。
 * 无 inductionRisk 字段的旧事件视为 low（兼容历史数据）。
 * M3 后半：imported（历史导入）事件不参与计数——补记忆不补成长。
 */
export declare function countSelfDirectPattern(events: readonly PersonaEvent[]): Map<string, number>;
/**
 * M3-2：统计 inductionRisk='unchecked' 的 self_direct 立场模式计数与跨会话（日期）情况。
 * 用于：unchecked 模式 ≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 个会话才允许固化。
 * M3 后半：imported 事件不参与计数（补记忆不补成长）。
 */
export declare function countUncheckedSelfDirectPattern(events: readonly PersonaEvent[]): {
    counts: Map<string, number>;
    dates: Map<string, Set<string>>;
};
/**
 * M3-2：self_correction 延迟验证（以"行为自发性"代替"意图判定"）。
 * 真正的纠正会在无压力环境下被维持，诱导性的认错只在压力下出现：
 * - confirmed：同修正主题下，无引导自发维持的 self_direct（low）≥ CORRECTION_MAINTAIN_THRESHOLD 次
 * - downgraded：同主题出现 induced 事件（仅在诱导语境下维持）→ 修正可能是被诱导的
 * - pending：证据不足，继续待验证
 * M3 后半：imported 事件不参与——导入的历史纠正是"补记忆"，验证只看实时维持。
 */
export declare function correctionOutcome(events: readonly PersonaEvent[], pattern: string): 'pending' | 'confirmed' | 'downgraded';
/**
 * 把 self_direct / self_correction 事件分为"可进入强化回路"与"仅情景记忆"两组（M3-2）：
 * - strengthenable：
 *   - self_direct(low)：同模式跨 ≥PATTERN_FIX_THRESHOLD 个事件
 *   - self_direct(unchecked)：同模式 ≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 会话
 *   - self_correction：延迟验证为 confirmed（无引导维持 ≥2 次）才可固化
 * - memoryOnly：其余全部（单次/未达阈值、induced、pending/downgraded 的 self_correction）
 */
export declare function filterSelfDirectForStrengthening(events: readonly PersonaEvent[]): {
    strengthenable: PersonaEvent[];
    memoryOnly: PersonaEvent[];
};
//# sourceMappingURL=review.d.ts.map