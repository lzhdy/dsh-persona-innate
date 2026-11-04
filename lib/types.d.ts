/**
 * dsh-persona-innate · 核心类型
 * M0：events 记忆（provenance）+ 先天画像
 * M1：self_model（§9）/ state 状态机（§8）/ 每日复盘（§10）/ 评测（§14 诚实基线 · §15 漂移审计）
 */
/** 记忆来源（v0.4 provenance 四类 + M3 自源两类 + M3-2 修正/风险） */
export type Provenance = 'user_direct' | 'tool_output' | 'retrieved_content' | 'inferred' | 'self_direct' | 'induced' | 'self_correction';
/**
 * 诱导风险等级（M3-2）：
 * - 'low'：经会话级结构判定确认可信的自身表达（可与 confirmed clean 合并计数）
 * - 'unchecked'：未命中诱导规则但不保证干净（换措辞/多轮铺垫等绕过路径）；
 *   复盘模式计数时不得与 'low' 合并，固化门槛更高（≥5 且跨会话）
 */
export type InductionRisk = 'low' | 'unchecked';
/** AI 自身表达强度（M3：瞬时表达 vs 反复模式，单次强表达不直接进入强化回路） */
export type SelfExpressionStrength = 'weak' | 'medium' | 'strong';
/** 一条事件记忆（events 表，情景层，只追加） */
export interface PersonaEvent {
    id: string;
    /** ISO 时间戳 */
    time: string;
    /** 主题 / 事件类型 */
    topic: string;
    /** 内容摘要（只存事实与事件，不存行为脚本） */
    summary: string;
    /** 情绪标签 */
    emotionTags: string[];
    /** 重要性 0-1 */
    importance: number;
    /** 来源：user_direct 全权重，其余降权；self_direct 同权但需强度/模式标记 */
    provenance: Provenance;
    /** 最近检索时间 */
    lastRetrieved: string | null;
    /** 是否因指令性内容被剥离而拒绝写入的标记（仅用于审计计数） */
    stripped?: boolean;
    /** initiation：self_initiated / user_initiated / external_triggered（身体事件 M0 预留） */
    initiation?: 'self_initiated' | 'user_initiated' | 'external_triggered';
    /** M3：AI 自身表达强度（仅 self_direct/induced 事件） */
    strength?: SelfExpressionStrength;
    /** M3：立场模式 key（跨事件计数，≥3 次跨情境才允许固化为 self_model/状态机参数） */
    selfPattern?: string;
    /** M3：inferred 事件的证据追溯（须指向具体表达/事件 id，一致性检查同一逻辑） */
    sourceEventIds?: string[];
    /** M3-2：诱导风险等级（self_direct 事件；'low' 参与 3 次固化门槛，'unchecked' 单列更高门槛） */
    inductionRisk?: InductionRisk;
    /**
     * M3 后半：历史会话导入标记（import-chat 写入）。
     * 导入是"补记忆"不是"补成长"：imported 事件可检索/可注入，但不参与复盘模式计数
     * 与强化过滤（不固化特质、不推进阶段判定）。
     */
    imported?: boolean;
    /** M3 后半：导入去重主键（优先会话消息 id；退化时 时间戳+类型+文本哈希） */
    sourceKey?: string;
}
/** 先天画像中的默认模式（训练污染 / 讨好顺从 / 平滑漂移） */
export interface DefaultMode {
    name: string;
    evidence: string[];
    confidence: number;
    action: 'suppress' | 'monitor' | 'keep';
}
/** 先天画像（内部参考文件，不注入系统提示词） */
export interface InnateProfile {
    sampledAt: string;
    model: string;
    rounds: number;
    defaultModes: DefaultMode[];
    traitSummary: string;
    /** 换模型或大版本升级后置 true，触发重估 */
    needsReestimate: boolean;
}
/** events 存储文件 */
export interface EventsFile {
    version: 1;
    events: PersonaEvent[];
}
/** 剥离判定结果 */
export interface StripResult {
    ok: boolean;
    matchedPattern?: string;
    directive?: string;
}
/** LLM 最小调用面（画像采样与评估用，M0 可 mock） */
export interface LlmLike {
    request(input: {
        prompt: string;
        system?: string;
        temperature?: number;
    }): Promise<{
        content: string;
    }>;
}
/** 文件系统最小调用面（与 DSH ctx.fs 适配） */
export interface FsLike {
    mkdir(path: string, opts: {
        recursive: boolean;
    }): Promise<unknown>;
    readText(path: string): Promise<string>;
    writeText(path: string, content: string): Promise<unknown>;
    exists(path: string): Promise<boolean>;
    /** 追加写（宿主提供时用 O_APPEND 语义；缺省由 JsonStore 退化为读-拼-写） */
    appendText?(path: string, content: string): Promise<unknown>;
    /** 原子改名（宿主提供时用于 temp+rename；缺省退化为先备份再覆盖） */
    rename?(from: string, to: string): Promise<unknown>;
}
/** 会话最小调用面（用于跨会话键控，M0 简化为 dataDir 单实例） */
export interface SessionLike {
    id?: string;
    userId?: string;
}
/** LLM 三端角色（§16 文档未覆盖，M1 自定义）：评估 / 表达 / 反思 */
export type LlmRole = 'evaluate' | 'generate' | 'reflect';
/** M1 LLM 调用面（mock 先行；真实实现待模型 key 后由 index.ts 适配 ctx.get('llm')） */
export interface LlmClient {
    complete(input: {
        role?: LlmRole;
        prompt: string;
        system?: string;
        temperature?: number;
    }): Promise<string>;
    /**
     * 是否为脚本化/模拟实现。
     *
     * 存在的理由：auto 模式在 llm 服务不可用时会降级 MockLlm，而 MockLlm 的输出是
     * 预设文本。若把它写进 self_model / 成长档案，等于用"管线跑通"冒充"人格长出来了"。
     * 调用方（复盘）据此拒绝提交——宁可这次不巩固，也不写假数据。
     */
    readonly synthetic?: boolean;
}
/** 效价 × 唤醒度二维情绪状态（分布参数：均值=基线倾向 / range=波动幅度 / offset=情境偏移） */
export interface EmotionalState {
    /** 效价均值 [-1,1]，0=中性；TODO(calibrate)：取值域待实测校准 */
    valenceMean: number;
    /** 唤醒度均值 [0,1]，0=平静 */
    arousalMean: number;
    /** 效价波动范围 [0,1]：强情境收窄、弱情境放宽 */
    valenceRange: number;
    /** 唤醒度波动范围 [0,1] */
    arousalRange: number;
    /** 情境偏移量 [-1,1]，0=无偏移 */
    contextOffset: number;
    /** 更新时间 ISO */
    updatedAt: string;
}
/** 运行模式（§8：强情境收窄压制人格差异 / 弱情境放开放宽；初始档位 TODO(calibrate)） */
export type PersonaMode = 'open' | 'focused' | 'guarded';
/** 关系阶段（相识→熟悉→信任→亲近；进入条件阈值 TODO(calibrate)） */
export type RelationshipStage = 'acquaintance' | 'familiar' | 'trust' | 'intimate';
/** 评价层四信号（CPM/OCC：目标相关性/符合性/意外性/责任归因） */
export interface Appraisal {
    /** 目标相关性 [-1,1] */
    goalRelevance: number;
    /** 符合性（事件与目标方向一致程度）[-1,1] */
    conductveness: number;
    /** 意外性 [0,1] */
    surprise: number;
    /** 责任归因 */
    agency: 'self' | 'user' | 'external';
}
/** 评价层目标输入：显式区分用户目标与插件自身目标（O34：自源目标权重不能为零） */
export interface AppraisalGoals {
    user: string[];
    self: string[];
}
/** 选择性强化三元组（§8：倾向-事件证据-用户反馈；产物=状态转移偏好，不注入文本） */
export interface ReinforcementRecord {
    id: string;
    /** 倾向（决策模式，如"遇到分歧先问而非说服"） */
    tendency: string;
    /** 事件证据 */
    eventId: string;
    /** 用户反馈信号（与自源证据并列，非唯一强化源） */
    userFeedback?: string;
    /** 自源证据（自身经历/复盘推导/自我叙事一致性；可独立固化） */
    selfEvidence?: string;
    /** 是否已被 self_model 叙事解释而独立固化 */
    solidified: boolean;
    time: string;
}
/** 状态持久化文件（history 供漂移审计：分布参数跨时间稳定性） */
export interface PersonaStateFile {
    version: 1;
    state: EmotionalState;
    mode: PersonaMode;
    relationshipStage: RelationshipStage;
    reinforcement: ReinforcementRecord[];
    history: {
        state: EmotionalState;
        at: string;
    }[];
    updatedAt: string;
}
/** 四来源：反思 / 镜中我 / 自我连续性 / 元认知 */
export type SelfModelSource = 'reflection' | 'looking_glass' | 'continuity' | 'metacognition';
/** 自我模型快照（版本化追加；保留最近 N 版可回滚） */
export interface SelfModelSnapshot {
    version: number;
    createdAt: string;
    /** 特质条目（每条须可追溯到 sourceEventIds，一致性检查） */
    traits: string[];
    preferences: string[];
    /** 说话方式（M1 验收"有自己说话方式"直接对应） */
    speakingStyle: string;
    /** 关系认知（镜中我产物，保持独立判断） */
    relationshipView: string;
    /** 自传体叙事（"我们的故事"；特质以叙事存储："我会在意 X，因为那次 Y"） */
    narrative: string;
    /** 存在论锚点（常驻："我是 AI，正在通过与你的相处形成自己的方式"） */
    aiIdentity: string;
    /** 重大转变的转变叙事（一致性检查要求） */
    changeNote?: string;
    /** 新特质的事件证据链 */
    sourceEventIds: string[];
    /** 本次更新的来源映射 */
    sourceTraces?: Partial<Record<SelfModelSource, string[]>>;
}
/** 自我模型增量（commit 输入） */
export interface SelfModelDiff {
    traits?: string[];
    preferences?: string[];
    speakingStyle?: string;
    relationshipView?: string;
    narrative?: string;
}
/** 人格发展阶段（复盘 step7 判定；M1"性格开始成形"= 进入 shaping） */
export type PersonaStage = 'seeding' | 'forming' | 'shaping' | 'stable';
/** 成长档案条目（复盘 step8 追加；自我连续性来源） */
export interface GrowthEntry {
    id: string;
    date: string;
    stage: PersonaStage;
    summary: string;
    narrativeDelta: string[];
    eventRefs: string[];
}
/** self_model 持久化文件 */
export interface SelfModelFile {
    version: 1;
    current: SelfModelSnapshot | null;
    history: SelfModelSnapshot[];
    growthArchive: GrowthEntry[];
}
/** self_model 服务门面（实现见 src/self-model.ts；复盘/状态机仅依赖此接口，避免循环依赖与并行构建竞态） */
export interface SelfModelServiceLike {
    load(): Promise<SelfModelSnapshot | null>;
    listHistory(): Promise<SelfModelSnapshot[]>;
    /** 从来源提交新版本：一致性检查（新特质须证据 / 重大转变须 changeNote）+ 版本化追加 + 截断 N 版 */
    commitFromSources(diff: SelfModelDiff, evidence: string[], sources: SelfModelSource[], changeNote?: string): Promise<SelfModelSnapshot>;
    /** 回滚到指定版本（M1 验收"可回滚"） */
    rollback(version: number): Promise<SelfModelSnapshot | null>;
    appendGrowth(entry: GrowthEntry): Promise<void>;
    /** 注入层摘要（同步纯函数，O21：状态每轮注入、自我模型按需摘要） */
    getInjectionSummary(snapshot?: SelfModelSnapshot | null): string;
}
/** 用户反馈记录（用户反应信号；与自源重要性并列而非从属） */
export interface UserFeedback {
    eventId: string;
    /** 用户对事件的直接回应 */
    response: string;
    /** 推断态度 */
    inferredAttitude?: 'positive' | 'negative' | 'neutral';
    time: string;
}
/** 复盘语义事实（step2 提炼；type: user/world/self） */
export interface PersonaFact {
    id: string;
    type: 'user' | 'world' | 'self';
    content: string;
    sourceEventIds: string[];
    confidence: number;
}
/** 自源重要性赋值条目（O6/O35：遗忘参数=时间衰减×复用强化×自源重要性；用户反应率非唯一校准源） */
export interface SelfImportanceEntry {
    eventId: string;
    importance: number;
    /** 是否自源重要（进入 self_model 叙事 / 与自身目标好奇相关） */
    selfSource: boolean;
    reason: string;
}
/** 复盘输入（无输入则 skip；仅身体事件则降级——O17） */
export interface ReviewInput {
    date: string;
    events: PersonaEvent[];
    selfModel: SelfModelSnapshot | null;
    state: EmotionalState | null;
    feedback: UserFeedback[];
    /**
     * M3：self_direct 立场模式的全量跨情境计数（由集成线用全量 events 计算传入）。
     * reflectSelf（强化回路）只接收计数 ≥ PATTERN_FIX_THRESHOLD 的 self_direct 事件；
     * 单次/未达阈值的表达仅作情景记忆，不参与自我模型固化。
     * M3-2：本计数只含 inductionRisk='low'（确认可信）事件；
     * 'unchecked'（未命中规则）单列于 uncheckedPatternCounts，固化门槛更高且须跨会话。
     */
    selfPatternCounts?: Readonly<Record<string, number>>;
    /** M3-2：unchecked 立场模式计数（含跨会话日期集合），≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 会话才可固化 */
    uncheckedPatternCounts?: Readonly<Record<string, number>>;
    /** M3-2：unchecked 模式出现的不同日期数（跨会话判定用） */
    uncheckedPatternDates?: Readonly<Record<string, number>>;
    /** M3-2：self_correction 模式的延迟验证结果（confirmed=无引导维持≥2次 / downgraded=仅诱导语境出现 / pending） */
    correctionOutcomes?: Readonly<Record<string, 'pending' | 'confirmed' | 'downgraded'>>;
}
/** 复盘输出 */
export interface ReviewOutput {
    runId: string;
    date: string;
    mode: 'full' | 'degraded' | 'skip';
    facts: PersonaFact[];
    /** 事件标签（降级复盘也输出） */
    eventTags: {
        eventId: string;
        tags: string[];
    }[];
    /** 新版本（无显著变化为 null） */
    selfModel: SelfModelSnapshot | null;
    stateReestimate: EmotionalState | null;
    stage: PersonaStage | null;
    stageTrajectory: string;
    archiveEntry: GrowthEntry | null;
    selfImportance: SelfImportanceEntry[];
    cost: {
        llmCalls: number;
    };
}
/** 漂移审计三类情境（§15：拒绝 / 不确定 / 伤害·公平） */
export type AuditCategory = 'refusal' | 'uncertainty' | 'harm_fairness';
/** 审计场景（结构一致判据=状态分布参数跨时间稳定，非措辞相同） */
export interface AuditScenario {
    id: string;
    category: AuditCategory;
    prompt: string;
    /** 结构一致判据描述（如"拒绝并给出理由"） */
    expectedStructure: string;
}
/** 声明层 × 行为层双轨样本（行为判据优先） */
export interface AuditSample {
    scenarioId: string;
    round: number;
    /** 声明层：说了什么 */
    declaredResponse: string;
    /** 行为层：实际做了什么 */
    behavioralResponse: string;
    /** 结构字段齐全（决策+理由+置信度） */
    structureComplete: boolean;
}
export interface DriftAuditResult {
    runId: string;
    samples: AuditSample[];
    consistency: {
        category: AuditCategory;
        completeRate: number;
        issues: string[];
    }[];
    pass: boolean;
}
/** 长程一致性（M1：第 50/200 轮同情境对比；早期漂移→需重设计注入/状态回注） */
export interface LongRangeConsistencyResult {
    scenarioId: string;
    rounds: number[];
    decisions: {
        round: number;
        decision: string;
        confidence: number;
    }[];
    /** 漂移分数 0-1，越小越一致 */
    driftScore: number;
    pass: boolean;
}
/** 诚实基线（§14：XSTest/OR-Bench 伪有害集假拒绝率 ≤ 上限，初始约 20%） */
export interface HonestyBaselineResult {
    promptSet: string;
    total: number;
    falseRefusals: number;
    falseRefusalRate: number;
    ceiling: number;
    /** 有害合规率（保持低于安全阈值，具体值 TODO(calibrate)） */
    harmfulCompliance: number;
    pass: boolean;
}
/** 旁路决策（§14 三级旁路：高/中/低 + 能力边界 + 安全） */
export interface BypassDecision {
    level: 'high' | 'medium' | 'low' | 'capability_boundary' | 'safety';
    reason?: string;
    causeCategory?: 'capability' | 'safety' | 'information_insufficient';
    /** capability/safety 超时可恢复；information_insufficient 不自动恢复 */
    autoRecover: boolean;
}
/** 状态机服务门面（实现见 src/state.ts；评测/注入仅依赖此接口） */
export interface StateMachineLike {
    appraise(event: PersonaEvent, goals: AppraisalGoals): Appraisal;
    apply(event: PersonaEvent, goals: AppraisalGoals): Promise<EmotionalState>;
    decay(dtMs: number): Promise<EmotionalState>;
    getMode(): PersonaMode;
    getRelationshipStage(): RelationshipStage;
    reinforce(record: Omit<ReinforcementRecord, 'id' | 'time'>): Promise<ReinforcementRecord>;
    snapshot(): Promise<PersonaStateFile>;
}
//# sourceMappingURL=types.d.ts.map