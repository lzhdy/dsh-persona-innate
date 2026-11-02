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
import type {
  Appraisal,
  AppraisalGoals,
  EmotionalState,
  PersonaEvent,
  PersonaMode,
  PersonaStateFile,
  RelationshipStage,
  ReinforcementRecord,
} from './types.js';
import type { KVStore } from './store.js';

/** 关系阶段四档（相识→熟悉→信任→亲近） */
export const RELATIONSHIP_STAGES: RelationshipStage[] = ['acquaintance', 'familiar', 'trust', 'intimate'];

/** O34：用户目标为主 */
export const DEFAULT_USER_GOAL_WEIGHT = 0.7;
/** O34：自源目标为辅但不能为零 */
export const DEFAULT_SELF_GOAL_WEIGHT = 0.3;

/** 默认情绪状态：valenceMean 0 / arousalMean 0.3 / ranges 0.15 / offset 0 */
export function defaultEmotionalState(): EmotionalState {
  return {
    valenceMean: 0,
    arousalMean: 0.3,
    valenceRange: 0.15,
    arousalRange: 0.15,
    contextOffset: 0,
    updatedAt: new Date().toISOString(),
  };
}

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

/** 持久化文件路径（PersonaStateFile，version:1） */
const STATE_PATH = 'state.json';
/** history 上限（漂移审计窗口） */
const HISTORY_LIMIT = 200; // TODO(calibrate)
/** 默认衰减半衰期 24h */
const DEFAULT_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // TODO(calibrate)
/** 关系阶段推进阈值：进入下一档所需 user_direct 证据数 */
const STAGE_THRESHOLDS: Record<RelationshipStage, number> = {
  acquaintance: 0,
  familiar: 3,
  trust: 10,
  intimate: 30,
}; // TODO(calibrate)
/** 模式目标波动范围：强情境收窄压制人格差异，弱情境放开放宽 */
const MODE_TARGET_RANGE: Record<PersonaMode, { valence: number; arousal: number }> = {
  guarded: { valence: 0.06, arousal: 0.05 }, // TODO(calibrate)
  focused: { valence: 0.1, arousal: 0.08 }, // TODO(calibrate)
  open: { valence: 0.2, arousal: 0.18 }, // TODO(calibrate)
};
/** 强情境关键词（启发式，TODO(calibrate)） */
const CRISIS_WORDS = ['危机', '危险', '紧急', '求助', '救命', '崩溃']; // TODO(calibrate)
const TASK_WORDS = ['任务', '问题', '报错', 'bug', '解决', '需求', '帮我写', '调试']; // TODO(calibrate)
/** 符合性极性词（启发式，TODO(calibrate)） */
const POSITIVE_WORDS = ['开心', '谢谢', '喜欢', '成功', '完成', '棒', '有趣', '很好']; // TODO(calibrate)
const NEGATIVE_WORDS = ['糟糕', '生气', '失败', '害怕', '失望', '难过', '着急']; // TODO(calibrate)
/** 意外性词（启发式，TODO(calibrate)） */
const SURPRISE_WORDS = ['意外', '突然', '没想到', '惊讶', '居然']; // TODO(calibrate)

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export class PersonaStateMachine {
  private readonly userGoalWeight: number;
  private readonly selfGoalWeight: number;
  private readonly halfLifeMs: number;
  private readonly onRuleChange?: (rule: string, narrative: string, evidence: string[]) => Promise<void>;

  private state: EmotionalState;
  private mode: PersonaMode = 'open';
  private stage: RelationshipStage = 'acquaintance';
  private reinforcement: ReinforcementRecord[] = [];
  private history: { state: EmotionalState; at: string }[] = [];
  /** 证据计数：apply user_direct 事件累加；落盘 schema 冻结，加载时按当前阶段反推（推进单调） */
  private evidenceCount = 0; // TODO(calibrate)
  private loaded = false;

  constructor(
    private readonly store: KVStore,
    opts: StateMachineOptions = {},
  ) {
    this.userGoalWeight = opts.userGoalWeight ?? DEFAULT_USER_GOAL_WEIGHT;
    this.selfGoalWeight = opts.selfGoalWeight ?? DEFAULT_SELF_GOAL_WEIGHT;
    // O34：自源目标不能为零（含 NaN）
    if (!(this.selfGoalWeight > 0)) {
      throw new Error('O34: selfGoalWeight 不能为零（自源目标权重须为正数）');
    }
    this.halfLifeMs = opts.decayHalfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.onRuleChange = opts.onRuleChange;
    this.state = { ...defaultEmotionalState(), ...(opts.initial ?? {}) };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const file = await this.store.readJson<PersonaStateFile>(STATE_PATH);
    if (file) {
      this.state = file.state;
      this.mode = file.mode ?? 'open';
      this.stage = file.relationshipStage ?? 'acquaintance';
      this.reinforcement = file.reinforcement ?? [];
      this.history = file.history ?? [];
      this.evidenceCount = STAGE_THRESHOLDS[this.stage] ?? 0;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const file: PersonaStateFile = {
      version: 1,
      state: this.state,
      mode: this.mode,
      relationshipStage: this.stage,
      reinforcement: this.reinforcement,
      history: this.history,
      updatedAt: new Date().toISOString(),
    };
    await this.store.writeJson(STATE_PATH, file);
  }

  /** 跨会话加载：返回已持久化的情绪状态；无文件返回 null */
  async load(): Promise<EmotionalState | null> {
    await this.ensureLoaded();
    const exists = await this.store.exists(STATE_PATH);
    return exists ? { ...this.state } : null;
  }

  /**
   * 评价层：事件 → 四信号（CPM/OCC）
   * goalRelevance[-1,1] / conductveness[-1,1] / surprise[0,1] / agency
   * 启发式词面匹配，TODO(calibrate)：真实语义评价待 LLM evaluate 端接入后替换
   */
  appraise(event: PersonaEvent, goals: AppraisalGoals): Appraisal {
    const text = `${event.topic} ${event.summary}`.toLowerCase();
    const importance = clamp01(event.importance);

    // 目标相关性：粗略词面重叠 + 重要性基线，按 user/self 权重加权（O34）
    const overlap = (list: string[]): boolean =>
      list.some((g) => {
        const kw = g.trim().toLowerCase().slice(0, 6);
        return kw.length >= 2 && text.includes(kw);
      }); // TODO(calibrate)
    const userRel = goals.user.length ? (overlap(goals.user) ? 0.8 : 0.2 + importance * 0.3) : 0; // TODO(calibrate)
    const selfRel = goals.self.length ? (overlap(goals.self) ? 0.6 : 0.15 + importance * 0.2) : 0; // TODO(calibrate)
    const goalRelevance = clamp(this.userGoalWeight * userRel + this.selfGoalWeight * selfRel, -1, 1);

    // 符合性：情绪标签/关键词极性
    const tags = [...event.emotionTags, event.topic, event.summary].join(' ');
    let polarity = 0;
    for (const w of POSITIVE_WORDS) if (tags.includes(w)) polarity += 1;
    for (const w of NEGATIVE_WORDS) if (tags.includes(w)) polarity -= 1;
    const conductveness = clamp(polarity * (0.4 + importance * 0.6), -1, 1); // TODO(calibrate)

    // 意外性：关键词命中 + 重要性基线
    const surprised = SURPRISE_WORDS.some((w) => tags.includes(w));
    const surprise = clamp01((surprised ? 0.7 : 0.1) + importance * 0.2); // TODO(calibrate)

    // 责任归因：provenance / initiation 启发式
    const agency: Appraisal['agency'] =
      event.initiation === 'self_initiated' ? 'self' : event.provenance === 'user_direct' ? 'user' : 'external';

    return { goalRelevance, conductveness, surprise, agency };
  }

  /** 模式判定：求助/危机 → guarded，明确任务 → focused，闲聊/弱情境 → open */
  private classifyMode(event: PersonaEvent): PersonaMode {
    const text = `${event.topic} ${event.summary}`;
    if (CRISIS_WORDS.some((w) => text.includes(w))) return 'guarded';
    if (TASK_WORDS.some((w) => text.includes(w))) return 'focused';
    return 'open';
  }

  /** 关系阶段推进：证据达阈值即晋升；重大转变须经 onRuleChange 叙事解释（§8） */
  private async advanceStage(reason: string): Promise<void> {
    const next = RELATIONSHIP_STAGES[RELATIONSHIP_STAGES.indexOf(this.stage) + 1];
    if (next && this.evidenceCount >= STAGE_THRESHOLDS[next]) {
      this.stage = next;
      if (this.onRuleChange) {
        try {
          await this.onRuleChange(
            `relationship-stage:${this.stage}`,
            `关系阶段推进为「${this.stage}」：${reason}。转移规则随之调整（关系越近，允许更亲密的话题与更宽的波动）。`,
            [`stage:${this.stage}`, `evidence:${this.evidenceCount}`],
          );
        } catch {
          /* 叙事写入失败不打断主流程 */
        }
      }
    }
  }

  /**
   * apply：感知帧 → 状态转移
   * 效价 = 0.5×符合性 + 0.3×目标相关加权 + 0.2×意外修正；全程 try/catch，异常回退默认人格
   */
  async apply(event: PersonaEvent, goals: AppraisalGoals): Promise<EmotionalState> {
    try {
      await this.ensureLoaded();
      const app = this.appraise(event, goals);

      // 效价更新分布参数（均值）
      const valenceDelta =
        0.5 * app.conductveness + 0.3 * app.goalRelevance + 0.2 * (app.surprise - 0.5); // TODO(calibrate)
      this.state.valenceMean = clamp(this.state.valenceMean + valenceDelta * 0.5, -1, 1); // TODO(calibrate): 更新敏感度
      // 唤醒度：意外性与符合性强度拉升（TODO(calibrate)）
      const arousalDelta = 0.25 * app.surprise + 0.15 * Math.abs(app.conductveness) - 0.05; // TODO(calibrate)
      this.state.arousalMean = clamp(this.state.arousalMean + arousalDelta, 0, 1);
      // 情境偏移（TODO(calibrate)）
      this.state.contextOffset = clamp(app.goalRelevance * 0.3, -1, 1); // TODO(calibrate)

      // 强情境收窄波动、弱情境放宽：波动范围向模式目标平滑弛豫（TODO(calibrate): 弛豫速率）
      this.mode = this.classifyMode(event);
      const target = MODE_TARGET_RANGE[this.mode];
      this.state.valenceRange = this.state.valenceRange + (target.valence - this.state.valenceRange) * 0.5; // TODO(calibrate)
      this.state.arousalRange = this.state.arousalRange + (target.arousal - this.state.arousalRange) * 0.5; // TODO(calibrate)

      // 关系阶段：user_direct 证据积累推进
      if (event.provenance === 'user_direct') {
        this.evidenceCount += 1;
        await this.advanceStage(`user_direct 证据积累至 ${this.evidenceCount} 条`);
      }

      this.state.updatedAt = new Date().toISOString();
      // history 快照（漂移审计对象，上限 200 条）
      this.history.push({ state: { ...this.state }, at: this.state.updatedAt });
      if (this.history.length > HISTORY_LIMIT) {
        this.history = this.history.slice(this.history.length - HISTORY_LIMIT);
      }

      await this.save();
      return { ...this.state };
    } catch {
      // 异常回退默认人格：简单可靠优于复杂精确
      this.state = defaultEmotionalState();
      this.mode = 'open';
      try {
        await this.save();
      } catch {
        /* 落盘失败也不抛出，保证主流程不受影响 */
      }
      return { ...this.state };
    }
  }

  /** 情绪惯性：按半衰期把均值衰减回基线、波动范围放宽回基线 */
  async decay(dtMs: number): Promise<EmotionalState> {
    await this.ensureLoaded();
    if (!(dtMs > 0)) return { ...this.state };
    const f = Math.pow(0.5, dtMs / this.halfLifeMs);
    this.state.valenceMean = (this.state.valenceMean - 0) * f; // 效价基线 0
    this.state.arousalMean = 0.3 + (this.state.arousalMean - 0.3) * f; // 唤醒基线 0.3
    this.state.contextOffset *= f;
    // 波动范围向基线 0.15 弛豫（强情境收窄后随时间放宽）
    this.state.valenceRange = 0.15 + (this.state.valenceRange - 0.15) * f; // TODO(calibrate)
    this.state.arousalRange = 0.15 + (this.state.arousalRange - 0.15) * f; // TODO(calibrate)
    this.state.updatedAt = new Date().toISOString();
    await this.save();
    return { ...this.state };
  }

  /** 当前模式（open/focused/guarded） */
  getMode(): PersonaMode {
    return this.mode;
  }

  /** 当前关系阶段 */
  getRelationshipStage(): RelationshipStage {
    return this.stage;
  }

  /**
   * 选择性强化：记录"倾向-事件证据-用户反馈"三元组为状态转移偏好（产物不是注入文本）
   * 已固化（solidified=true，已被 self_model 叙事解释）→ 触发 onRuleChange 叙事解释
   */
  async reinforce(record: Omit<ReinforcementRecord, 'id' | 'time'>): Promise<ReinforcementRecord> {
    await this.ensureLoaded();
    const entry: ReinforcementRecord = {
      ...record,
      id: this.store.makeId(),
      time: new Date().toISOString(),
    };
    this.reinforcement.push(entry);
    await this.save();

    if (entry.solidified && this.onRuleChange) {
      try {
        await this.onRuleChange(
          `tendency:${entry.tendency}`,
          `选择性强化固化决策模式「${entry.tendency}」为状态转移偏好（用户反馈与自源证据并列确认）。`,
          [entry.eventId, entry.userFeedback ?? '', entry.selfEvidence ?? ''].filter(Boolean),
        );
      } catch {
        /* 叙事写入失败不打断主流程 */
      }
    }
    return entry;
  }

  /** 全量快照（含 history，漂移审计对象） */
  async snapshot(): Promise<PersonaStateFile> {
    await this.ensureLoaded();
    return {
      version: 1,
      state: { ...this.state },
      mode: this.mode,
      relationshipStage: this.stage,
      reinforcement: [...this.reinforcement],
      history: this.history.map((h) => ({ state: { ...h.state }, at: h.at })),
      updatedAt: this.state.updatedAt,
    };
  }
}
