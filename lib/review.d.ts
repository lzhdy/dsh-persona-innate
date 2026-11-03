/**
 * 每日复盘引擎（M1 · 线 D）
 * 机制依据：设计文档 v0.8 §10（8 步复盘流程 / O17 降级 / O6·O35 自源重要性）+ §8（选择性强化）
 * 冻结导出面见 docs/m1-interface-design.md §2——修改必须逐字对齐。
 * 注意：本模块只依赖 ./types.js / ./store.js（类型），不 import ./self-model.js 与 ./state.js，
 *       运行时由集成线 H 注入实例（SelfModelServiceLike / StateMachineLike）。
 */
import type { LlmClient, PersonaEvent, PersonaFact, PersonaStage, ReviewInput, ReviewOutput, SelfImportanceEntry, SelfModelDiff, SelfModelServiceLike, SelfModelSnapshot, StateMachineLike, UserFeedback } from './types.js';
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
/** 每日复盘引擎：8 步流水线（§10），LLM 输出解析失败时该步降级为空继续，保证 mock 无 key 可跑 */
export declare class DailyReviewEngine {
    private readonly deps;
    private readonly opts;
    constructor(deps: ReviewDeps, opts?: ReviewOptions);
    /** O17：无输入 skip；仅身体事件（initiation=external_triggered）degraded；其余 full */
    shouldRun(input: ReviewInput): 'full' | 'degraded' | 'skip';
    /** step1 提取当日关键事件（无 LLM：按重要性阈值过滤后降序截断） */
    extractKeyEvents(events: PersonaEvent[]): PersonaEvent[];
    /** step2 提炼语义事实（LLM reflect #1；降级复盘也执行）。解析失败 → [] 降级继续 */
    distillFacts(events: PersonaEvent[]): Promise<PersonaFact[]>;
    /** step3 反思自我（LLM reflect #2）。解析失败 → {} 降级继续 */
    reflectSelf(events: PersonaEvent[], facts: PersonaFact[]): Promise<Partial<SelfModelDiff>>;
    /** step4 更新关系认知·镜中我（LLM reflect #3）。解析失败 → '' 降级继续 */
    updateMirror(events: PersonaEvent[], feedback: UserFeedback[]): Promise<string>;
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