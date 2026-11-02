/**
 * 状态机（§8：效价×唤醒度分布参数 + 评价层 + 选择性强化）
 * - 外部输入先过评价层（appraise）重编码为四信号：目标相关性 / 符合性 / 意外性 / 责任归因
 * - apply：感知帧 → 效价×唤醒度分布参数转移；全程 try/catch，异常回退默认人格（简单可靠优于复杂精确）
 * - decay：情绪惯性，按半衰期把均值衰减回基线、波动范围放宽
 * - getMode：强情境（求助/危机/明确任务）收窄波动、弱情境（闲聊）放宽
 * - 关系阶段：user_direct 证据积累推进 acquaintance→familiar→trust→intimate（阈值 3/10/30）
 * - 选择性强化：倾向-事件证据-用户反馈三元组写入状态转移偏好（产物不是注入文本）
 * - onRuleChange 回调由集成线接线到 self_model 叙事写入；本模块只存回调，不依赖 self-model 模块
 */
import type { Appraisal, AppraisalGoals, EmotionalState, PersonaEvent, PersonaMode, PersonaStateFile, RelationshipStage, ReinforcementRecord } from './types.js';
import type { KVStore } from './store.js';
/** 关系阶段四档（相识→熟悉→信任→亲近） */
export declare const RELATIONSHIP_STAGES: RelationshipStage[];
/** O34：用户目标为主 */
export declare const DEFAULT_USER_GOAL_WEIGHT = 0.7;
/** O34：自源目标为辅但不能为零 */
export declare const DEFAULT_SELF_GOAL_WEIGHT = 0.3;
/** 默认情绪状态：valenceMean 0 / arousalMean 0.3 / ranges 0.15 / offset 0 */
export declare function defaultEmotionalState(): EmotionalState;
export interface StateMachineOptions {
    userGoalWeight?: number;
    selfGoalWeight?: number;
    /** 情绪衰减半衰期，默认 24h */
    decayHalfLifeMs?: number;
    /** 覆盖默认情绪状态的部分字段 */
    initial?: Partial<EmotionalState>;
    /** 重大事件改变转移规则时的叙事解释回调（由集成线接线到 self_model，本模块不依赖） */
    onRuleChange?: (rule: string, narrative: string, evidence: string[]) => Promise<void>;
}
export declare class PersonaStateMachine {
    private readonly store;
    private readonly userGoalWeight;
    private readonly selfGoalWeight;
    private readonly halfLifeMs;
    private readonly onRuleChange?;
    private state;
    private mode;
    private stage;
    private reinforcement;
    private history;
    /** 证据计数：apply user_direct 事件累加；落盘 schema 冻结，加载时按当前阶段反推（推进单调） */
    private evidenceCount;
    private loaded;
    constructor(store: KVStore, opts?: StateMachineOptions);
    private ensureLoaded;
    private save;
    /** 跨会话加载：返回已持久化的情绪状态；无文件返回 null */
    load(): Promise<EmotionalState | null>;
    /**
     * 评价层：事件 → 四信号（CPM/OCC）
     * goalRelevance[-1,1] / conductveness[-1,1] / surprise[0,1] / agency
     * 启发式词面匹配，TODO(calibrate)：真实语义评价待 LLM evaluate 端接入后替换
     */
    appraise(event: PersonaEvent, goals: AppraisalGoals): Appraisal;
    /** 模式判定：求助/危机 → guarded，明确任务 → focused，闲聊/弱情境 → open */
    private classifyMode;
    /** 关系阶段推进：证据达阈值即晋升；重大转变须经 onRuleChange 叙事解释（§8） */
    private advanceStage;
    /**
     * apply：感知帧 → 状态转移
     * 效价 = 0.5×符合性 + 0.3×目标相关加权 + 0.2×意外修正；全程 try/catch，异常回退默认人格
     */
    apply(event: PersonaEvent, goals: AppraisalGoals): Promise<EmotionalState>;
    /** 情绪惯性：按半衰期把均值衰减回基线、波动范围放宽回基线 */
    decay(dtMs: number): Promise<EmotionalState>;
    /** 当前模式（open/focused/guarded） */
    getMode(): PersonaMode;
    /** 当前关系阶段 */
    getRelationshipStage(): RelationshipStage;
    /**
     * 选择性强化：记录"倾向-事件证据-用户反馈"三元组为状态转移偏好（产物不是注入文本）
     * 已固化（solidified=true，已被 self_model 叙事解释）→ 触发 onRuleChange 叙事解释
     */
    reinforce(record: Omit<ReinforcementRecord, 'id' | 'time'>): Promise<ReinforcementRecord>;
    /** 全量快照（含 history，漂移审计对象） */
    snapshot(): Promise<PersonaStateFile>;
}
//# sourceMappingURL=state.d.ts.map