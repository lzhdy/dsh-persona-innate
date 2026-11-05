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
    /** P2：候选特质（未过 §4.4 晋升门槛，只保留不注入） */
    candidateTraits?: string[];
}
/** 自我模型增量（commit 输入） */
export interface SelfModelDiff {
    traits?: string[];
    preferences?: string[];
    speakingStyle?: string;
    relationshipView?: string;
    narrative?: string;
}
/** P2：traits 晋升/隔离决策（可审计） */
export interface PromotionDecision {
    /** 是否允许这批 traits 晋升为 stable */
    promote: boolean;
    /** 可审计的决策理由（无论晋升与否都必须非空） */
    reason: string;
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
    /** P2：把候选特质去重合并进 candidateTraits（不碰 stable traits），版本 +1、旧 current 入 history */
    commitCandidates(candidates: string[]): Promise<SelfModelSnapshot>;
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
    /**
     * v0.6：全量事件（跨天累积）。
     * threads / attributes 的 sourceEventIds 必须指向真实存在的事件，而存在性只能在全量里判；
     * 只拿当日窗口判会把"上周的面试"误判成编造。缺省时由复盘引擎从 store 读全量。
     */
    allEvents?: readonly PersonaEvent[];
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
    /** v0.6：threads / attributes 派生统计（供 /persona review 展示；降级/skip 时为未执行） */
    memoryFacts: MemoryFactStats;
    /** P2：本次 traits 晋升/隔离决策 */
    promotion?: {
        decision: PromotionDecision;
        candidateCount: number;
    };
    cost: {
        /** 核心三步（distillFacts / reflectSelf / updateMirror）的 LLM 调用数——口径不变 */
        llmCalls: number;
        /**
         * v0.6：记忆事实派生这一步的 LLM 调用数，单独计。
         * 不并入 llmCalls 的理由：llmCalls 的口径是"复盘三步流水线"，
         * 既有观测与断言都按这个口径读；混进去会把"核心复盘变贵了"和"多了一步派生"混为一谈。
         */
        memoryFactCalls: number;
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
export type ThreadStatus = 'open' | 'resolved' | 'expired';
/** 未结束/已结束的一件事（情景层的"索引卡"，仍指向具体事件证据） */
export interface PersonaThread {
    /** 'th_' + 稳定短哈希（由 key 推导，同 key 跨天合并不新建） */
    id: string;
    /** 归一化主题，用于跨天合并，如 '面试'、'母亲住院' */
    key: string;
    /** 描述性标题，如 '周四的面试' */
    title: string;
    status: ThreadStatus;
    /** ISO */
    openedAt: string;
    /** ISO：最近一次被提及 */
    lastMentionedAt: string;
    mentionCount: number;
    /** 必须非空且真实存在于 events（校验不通过整条丢弃，不补空数组） */
    sourceEventIds: string[];
    /** 可选：从时间词推出的提示，如 '周四' */
    dueHint?: string;
    resolvedAt?: string;
    expiredAt?: string;
}
/** facts 七态状态机（§4.7） */
export type FactStatus = 'candidate' | 'active' | 'quarantined' | 'disputed' | 'superseded' | 'retracted' | 'expired';
/** 认识论类型（§4.3）：谁以何种方式提出该主张 */
export type EpistemicType = 'direct_observation' | 'user_statement' | 'ai_inference';
/** 不过期的长期事实（用户属性/世界事实），只提置信度或被取代 */
export interface PersonaAttribute {
    /**
     * 'at_' + 稳定短哈希。
     * 与 thread 不同，这里必须由 key + value 共同推导：同 key 不同 value 要新建一条，
     * 若只按 key 哈希，新旧两条会撞同一个 id，supersededBy 就指不到新条目、取代链断掉。
     */
    id: string;
    /** '工作单位'、'居住城市'、'宠物' */
    key: string;
    /** '杭州某电商公司做后端' */
    value: string;
    status: FactStatus;
    /** 0..1 */
    confidence: number;
    sourceEventIds: string[];
    firstSeenAt: string;
    updatedAt: string;
    /** 指向取代它的新 attribute id */
    supersededBy?: string;
    supersededAt?: string;
    /** 谁提出该主张（§4.3 speaker；'user' | 'assistant' | 'system' | 'tool'，未知留空） */
    speaker?: string;
    /** 说谁/说什么（§4.3 subject；禁止由 speaker 推断，未知留空） */
    subject?: string;
    /** 最小结构化主张的谓词（§4.3 predicate；本轮不推导，留空） */
    predicate?: string;
    /** 认识论类型（§4.3；从事件 provenance 推导） */
    epistemicType?: EpistemicType;
    /** 何时说的（§4.8；= 最新 sourceEvent 的 time，不可得留空） */
    assertedAt?: string;
    /** 系统何时写入（§4.8；= 派生时刻） */
    ingestedAt?: string;
    /** 内容所指有效区间（§4.8；本轮不推导，null=未知） */
    validFrom?: string | null;
    validTo?: string | null;
    /** 系统何时改变该版本状态（§4.8；写入时 = ingestedAt） */
    statusChangedAt?: string;
    /** 同源去重标识（§4.9；从 sourceEventIds 稳定推导） */
    evidenceGroupId?: string;
}
/** threads 存储文件（单文件，数百条以内，不分片） */
export interface ThreadsFile {
    version: 1;
    threads: PersonaThread[];
}
/** attributes 存储文件 */
export interface AttributesFile {
    version: 1;
    attributes: PersonaAttribute[];
}
/** 派生条目被丢弃的原因分类（复盘统计要能解释"为什么少了"） */
export type FactDropReason = 
/** sourceEventIds 为空 */
'no-source'
/** sourceEventIds 指向不存在的事件（编造/已归档） */
 | 'unknown-source'
/** 含祈使句/行为规则（stripCheck 拦下） */
 | 'strip'
/** 字段缺失或非法（无 key / 无 title / status 非法） */
 | 'invalid';
/** threads / attributes 派生统计（ReviewOutput.memoryFacts） */
export interface MemoryFactStats {
    /** 是否发起了派生（含 LLM 调用与读盘） */
    ran: boolean;
    /** 本次是否真的写了盘 */
    persisted: boolean;
    threadsCreated: number;
    threadsUpdated: number;
    attributesCreated: number;
    attributesUpdated: number;
    attributesSuperseded: number;
    /** 被丢弃的条目总数（= dropReasons 之和） */
    dropped: number;
    dropReasons: Record<FactDropReason, number>;
    /**
     * 被门禁剥掉的**字段**数（v0.7）。
     * 与 dropped 分开计数：dueHint 这类可选装饰字段不过门禁时只丢字段、保留条目本身，
     * 把它算进"条目丢弃"会让 dropped 与 dropReasons 对不上，也会让"整条丢弃"的语义贬值。
     */
    fieldsStripped: number;
    /** 本次收敛为 expired 的 thread 数 */
    expired: number;
    /** 未能完成的原因（读盘失败 / 解析失败 / 写盘失败），供 /persona review 展示 */
    error?: string;
}
/** 谁在说（raw_turns 四类 speaker；其余事件类型静默跳过） */
export type RawSpeaker = 'user' | 'assistant' | 'system' | 'tool';
/**
 * 一条原始话轮（append-only，回答"谁在何时说过什么"）。
 * P1 只写不读：不接入任何注入/检索/复盘路径。
 */
export interface RawTurn {
    /** 全局稳定 ID：DSH 消息自带 id 优先（user 取 data.id / assistant 取 data.message.id）；无 id 时才退化为 'rt-' + makeId() */
    event_id: string;
    /** 会话定位：DSH session id（session.id）；不可得时显式空串 */
    session_id: string;
    /** 轮次定位：turn 号（P1 不可得，显式空串而非伪造） */
    turn_id: string;
    /** 谁在说 */
    speaker: RawSpeaker;
    /** 原话全文（不用摘要替代）；工具载荷另列于 raw_text */
    raw_text: string;
    /** 话语实际发出时间（ISO，来自 event.time 毫秒时间戳） */
    asserted_at: string;
    /** 系统获知并写入时间（ISO） */
    ingested_at: string;
    /** 内容哈希（sha256 raw_text，hex），谱系定位用；非真实性证明 */
    content_hash: string;
}
//# sourceMappingURL=types.d.ts.map