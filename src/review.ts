/**
 * 每日复盘引擎（M1 · 线 D）
 * 机制依据：设计文档 v0.8 §10（8 步复盘流程 / O17 降级 / O6·O35 自源重要性）+ §8（选择性强化）
 * 冻结导出面见 docs/m1-interface-design.md §2——修改必须逐字对齐。
 * 注意：本模块只依赖 ./types.js / ./store.js（类型），不 import ./self-model.js 与 ./state.js，
 *       运行时由集成线 H 注入实例（SelfModelServiceLike / StateMachineLike）。
 */
import type {
  GrowthEntry,
  LlmClient,
  PersonaEvent,
  PersonaFact,
  PersonaStage,
  ReviewInput,
  ReviewOutput,
  SelfImportanceEntry,
  SelfModelDiff,
  SelfModelServiceLike,
  SelfModelSnapshot,
  StateMachineLike,
  UserFeedback,
} from './types.js';
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
  /* TODO(calibrate)：frequency / cost 上限（O16 复盘深度与成本权衡） */
}

/** 三步反思 prompt（中文模板，要求固定 JSON 输出，字段名与 PersonaFact / SelfModelDiff 对齐；§10 文档未覆盖，自定） */
export const REVIEW_PROMPTS: { distillFacts: string; reflectSelf: string; updateMirror: string } = {
  distillFacts: [
    '你是反思端模型。从当日事件中提炼语义事实，只输出 JSON，不要输出任何其他内容。',
    '格式：{"facts":[{"type":"user|world|self","content":"事实陈述","sourceEventIds":["事件id"],"confidence":0.5}]}',
    'type=user：关于用户的事实；type=world：关于外部世界的事实；type=self：关于插件自身的事实。',
    '只提炼事件直接支持的事实，不输出行为指令；无事实则输出 {"facts":[]}。',
  ].join('\n'),
  reflectSelf: [
    '你是反思端模型。基于当日事件与事实，反思自己的行为与表达，只输出 JSON。',
    '格式：{"traits":["观察到的特质"],"preferences":["偏好"],"speakingStyle":"说话方式","narrative":"叙事增量"}',
    'traits/preferences 必须可由当日事件支持；无观察到则给空数组。',
    'narrative 为自传体叙事增量（"我会在意 X，因为那次 Y"）；无则空串。',
  ].join('\n'),
  updateMirror: [
    '你是反思端模型。基于当日事件与用户反馈，更新对这段关系的认知（镜中我），只输出 JSON。',
    '格式：{"relationshipView":"关系认知更新"}',
    '保持独立判断，不把用户反馈直接当作自我定义；无更新则空串。',
  ].join('\n'),
};

// TODO(calibrate)：关键事件筛选的重要性下限
const MIN_KEY_EVENT_IMPORTANCE = 0.2;
// TODO(calibrate)：单次复盘最多保留的关键事件数
const MAX_KEY_EVENTS = 20;
// TODO(calibrate)：自源重要性下限（O6/O35：自源记忆独立成项，不因用户未回应而被压制）
const SELF_SOURCE_IMPORTANCE_FLOOR = 0.65;
// TODO(calibrate)：人格发展阶段判定阈值（M1 验收"性格开始成形"=进入 shaping）
const STAGE_FORMING_TRAITS = 1;
const STAGE_SHAPING_TRAITS = 3;
const STAGE_STABLE_TRAITS = 6;

/** 每日复盘引擎：8 步流水线（§10），LLM 输出解析失败时该步降级为空继续，保证 mock 无 key 可跑 */
export class DailyReviewEngine {
  constructor(
    private readonly deps: ReviewDeps,
    private readonly opts: ReviewOptions = {},
  ) {}

  /** O17：无输入 skip；仅身体事件（initiation=external_triggered）degraded；其余 full */
  shouldRun(input: ReviewInput): 'full' | 'degraded' | 'skip' {
    if (!input.events || input.events.length === 0) return 'skip';
    const onlyBodyEvents = input.events.every((e) => e.initiation === 'external_triggered');
    if (onlyBodyEvents) return 'degraded';
    return 'full';
  }

  /** step1 提取当日关键事件（无 LLM：按重要性阈值过滤后降序截断） */
  extractKeyEvents(events: PersonaEvent[]): PersonaEvent[] {
    return events
      .filter((e) => e.importance >= MIN_KEY_EVENT_IMPORTANCE) // TODO(calibrate)
      .slice()
      .sort((a, b) => b.importance - a.importance)
      .slice(0, MAX_KEY_EVENTS); // TODO(calibrate)
  }

  /** step2 提炼语义事实（LLM reflect #1；降级复盘也执行）。解析失败 → [] 降级继续 */
  async distillFacts(events: PersonaEvent[]): Promise<PersonaFact[]> {
    const listing = events.map((e) => `- [${e.id}] (${e.topic}) ${e.summary}`).join('\n');
    const raw = await this.deps.llm.complete({
      role: 'reflect',
      prompt: `${REVIEW_PROMPTS.distillFacts}\n\n当日事件：\n${listing || '（无）'}`,
    });
    const parsed = this.parseJsonLoose(raw);
    if (!parsed || !Array.isArray(parsed.facts)) return []; // 非 JSON / 字段缺失 → 降级为空
    return parsed.facts
      .filter((f: any) => f && typeof f.content === 'string' && f.content)
      .map((f: any) => ({
        id: this.deps.store.makeId(),
        type: f.type === 'user' || f.type === 'world' || f.type === 'self' ? f.type : 'world',
        content: String(f.content),
        sourceEventIds: Array.isArray(f.sourceEventIds) ? f.sourceEventIds.map(String) : [],
        confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : 0.5,
      }));
  }

  /** step3 反思自我（LLM reflect #2）。解析失败 → {} 降级继续 */
  async reflectSelf(events: PersonaEvent[], facts: PersonaFact[]): Promise<Partial<SelfModelDiff>> {
    const listing = events.map((e) => `- [${e.id}] ${e.topic}：${e.summary}`).join('\n');
    const factListing = facts.map((f) => `- (${f.type}) ${f.content}`).join('\n');
    const raw = await this.deps.llm.complete({
      role: 'reflect',
      prompt: `${REVIEW_PROMPTS.reflectSelf}\n\n当日事件：\n${listing || '（无）'}\n\n语义事实：\n${factListing || '（无）'}`,
    });
    const parsed = this.parseJsonLoose(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}; // 解析失败 → 降级为空
    const diff: Partial<SelfModelDiff> = {};
    if (Array.isArray(parsed.traits)) {
      diff.traits = parsed.traits.filter((t: unknown): t is string => typeof t === 'string' && !!t);
    }
    if (Array.isArray(parsed.preferences)) {
      diff.preferences = parsed.preferences.filter((p: unknown): p is string => typeof p === 'string' && !!p);
    }
    if (typeof parsed.speakingStyle === 'string' && parsed.speakingStyle.trim()) {
      diff.speakingStyle = parsed.speakingStyle.trim();
    }
    if (typeof parsed.narrative === 'string' && parsed.narrative.trim()) {
      diff.narrative = parsed.narrative.trim();
    }
    return diff;
  }

  /** step4 更新关系认知·镜中我（LLM reflect #3）。解析失败 → '' 降级继续 */
  async updateMirror(events: PersonaEvent[], feedback: UserFeedback[]): Promise<string> {
    const listing = events.map((e) => `- [${e.id}] ${e.topic}：${e.summary}`).join('\n');
    const fbListing = feedback
      .map((f) => `- [${f.eventId}] ${f.response}（${f.inferredAttitude ?? '未知'}）`)
      .join('\n');
    const raw = await this.deps.llm.complete({
      role: 'reflect',
      prompt: `${REVIEW_PROMPTS.updateMirror}\n\n当日事件：\n${listing || '（无）'}\n\n用户反馈：\n${fbListing || '（无）'}`,
    });
    const parsed = this.parseJsonLoose(raw);
    if (!parsed || typeof parsed.relationshipView !== 'string') return ''; // 解析失败 → 降级为空串
    return parsed.relationshipView.trim();
  }

  /** step5 一致性检查（§9：新认知须有事件证据） */
  consistencyCheck(diff: SelfModelDiff, facts: PersonaFact[]): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    const hasTraits = (diff.traits?.length ?? 0) > 0;
    const hasNarrative = typeof diff.narrative === 'string' && diff.narrative.length > 0;
    if (hasTraits && facts.length === 0) issues.push('consistency: 新特质缺少事件证据');
    if (hasNarrative && facts.length === 0) issues.push('consistency: 叙事更新缺少事件证据');
    return { ok: issues.length === 0, issues };
  }

  /** step7 判定发展阶段：seeding→forming→shaping→stable（启发式，TODO(calibrate)）。M1"性格开始成形"=进入 shaping */
  judgeStage(selfModel: SelfModelSnapshot | null): PersonaStage {
    if (!selfModel) return 'seeding';
    const traitCount = selfModel.traits?.length ?? 0;
    const prefCount = selfModel.preferences?.length ?? 0;
    const hasStyle = !!selfModel.speakingStyle && selfModel.speakingStyle !== '（未成形）';
    if (traitCount >= STAGE_STABLE_TRAITS) return 'stable'; // TODO(calibrate)
    if (traitCount >= STAGE_SHAPING_TRAITS || (traitCount >= 1 && hasStyle)) return 'shaping'; // TODO(calibrate)
    if (traitCount >= STAGE_FORMING_TRAITS || prefCount >= 1) return 'forming'; // TODO(calibrate)
    return 'seeding';
  }

  /**
   * O6/O35 自源重要性：事件进入 diff.narrative 或与 selfGoals（self_model.preferences+traits 与好奇话题）
   * 相关 → selfSource:true、importance = max(原值, 0.65)。与用户反应并列而非从属，
   * 不因用户未回应而压制（本函数不读 feedback，即体现并列）。
   */
  assignSelfImportance(events: PersonaEvent[], diff: SelfModelDiff, selfGoals: string[]): SelfImportanceEntry[] {
    const narrativeText = diff.narrative ?? '';
    return events.map((e) => {
      const goalHit = selfGoals.some((g) => g && (e.summary.includes(g) || e.topic.includes(g)));
      const narrativeHit = !!narrativeText && (narrativeText.includes(e.id) || narrativeText.includes(e.topic));
      const selfSource = goalHit || narrativeHit;
      return {
        eventId: e.id,
        importance: selfSource ? Math.max(e.importance, SELF_SOURCE_IMPORTANCE_FLOOR) : e.importance, // TODO(calibrate)
        selfSource,
        reason: selfSource
          ? narrativeHit && !goalHit
            ? '进入自我叙事（O6）'
            : '与自身目标/好奇相关（O35）'
          : '普通事件',
      };
    });
  }

  /**
   * run 顶层调度（§10 8 步流水线）：
   * skip → 空输出；degraded → step1-2 + 事件标签（不更新 self_model）；full → 8 步全走。
   * step6 commitVersion：commitFromSources consistency 抛错则捕获、记 issues、selfModel:null。
   */
  async run(input: ReviewInput): Promise<ReviewOutput> {
    const mode = this.shouldRun(input);
    const out: ReviewOutput = {
      runId: this.deps.store.makeId(),
      date: input.date,
      mode,
      facts: [],
      eventTags: [],
      selfModel: null,
      stateReestimate: null, // TODO(calibrate)：夜间基线校正 M2 由状态机 decay 承担
      stage: null,
      stageTrajectory: '',
      archiveEntry: null,
      selfImportance: [],
      cost: { llmCalls: 0 },
    };
    if (mode === 'skip') return out; // O17：无输入空输出

    // step1 提取关键事件（无 LLM）
    const keyEvents = this.extractKeyEvents(input.events);
    // step2 提炼语义事实（LLM #1；降级复盘也执行）
    out.facts = await this.distillFacts(keyEvents);
    out.cost.llmCalls = 1;
    // 事件标签（降级复盘也输出）：事件支撑了哪类事实 + initiation / 情绪标签
    out.eventTags = this.buildEventTags(keyEvents, out.facts);

    if (mode === 'degraded') return out; // O17：只提炼 facts 与事件标签，不更新 self_model

    // step3 反思自我（LLM #2）
    // M3/M3-2：强化回路只接收：
    // - self_direct(low) 跨 ≥PATTERN_FIX_THRESHOLD 个事件；
    // - self_direct(unchecked) 跨 ≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 会话（漏报诱导不合并计数）；
    // - self_correction 延迟验证为 confirmed（无引导维持 ≥2 次）。
    // 单次/未达阈值/待验证/降级表达仅作情景记忆，不参与自我模型固化。
    const counts = input.selfPatternCounts;
    const reflectEvents = counts
      ? keyEvents.filter((e) => {
          if (!e.selfPattern) return true;
          if (e.provenance === 'self_correction') {
            return input.correctionOutcomes?.[e.selfPattern] === 'confirmed';
          }
          if (e.provenance !== 'self_direct') return true;
          const risk = e.inductionRisk ?? 'low';
          if (risk === 'low') return (counts[e.selfPattern] ?? 0) >= PATTERN_FIX_THRESHOLD;
          const uc = input.uncheckedPatternCounts?.[e.selfPattern] ?? 0;
          const days = input.uncheckedPatternDates?.[e.selfPattern] ?? 0;
          return uc >= UNCHECKED_FIX_THRESHOLD && days >= 2;
        })
      : keyEvents;
    const selfDiff = await this.reflectSelf(reflectEvents, out.facts);
    out.cost.llmCalls = 2;
    // step4 更新关系认知·镜中我（LLM #3；同样只基于稳定的自身模式）
    const relationshipView = await this.updateMirror(reflectEvents, input.feedback);
    out.cost.llmCalls = 3;

    const diff: SelfModelDiff = { ...selfDiff };
    if (relationshipView) diff.relationshipView = relationshipView;

    // step5 一致性检查
    const check = this.consistencyCheck(diff, out.facts);

    // step6 写入新版本并备份（commitFromSources consistency 抛错 → 捕获，selfModel:null）
    if (this.hasDiffContent(diff)) {
      try {
        out.selfModel = await this.deps.selfModel.commitFromSources(
          diff,
          this.collectEvidence(out.facts, keyEvents),
          ['reflection', 'looking_glass'],
          diff.narrative ? `每日复盘 ${input.date}：叙事更新` : undefined,
        );
      } catch (err) {
        check.ok = false;
        check.issues.push(`commit 失败：${(err as Error).message}`);
        out.selfModel = null;
      }
    }

    // step7 判定发展阶段（commit 失败时回退到当前快照判定）
    out.stage = this.judgeStage(out.selfModel ?? input.selfModel);
    out.stageTrajectory = `${this.judgeStage(input.selfModel)}→${out.stage}`;

    // 自源重要性（O6/O35）：与用户反应并列，不因用户未回应而压制
    out.selfImportance = this.assignSelfImportance(keyEvents, diff, this.extractSelfGoals(input.selfModel));

    // step8 追加成长档案（自我连续性来源）
    try {
      out.archiveEntry = {
        id: this.deps.store.makeId(),
        date: input.date,
        stage: out.stage,
        summary: `本日提炼事实 ${out.facts.length} 条，覆盖事件 ${keyEvents.length} 件。`,
        narrativeDelta: diff.narrative ? [diff.narrative] : [],
        eventRefs: keyEvents.map((e) => e.id),
      };
      await this.deps.selfModel.appendGrowth(out.archiveEntry);
    } catch {
      out.archiveEntry = null;
    }

    return out;
  }

  /* ── 私有辅助 ── */

  /** 宽松 JSON 解析：先直 parse，失败再截取首个 {...} 块；都失败 → null（调用方降级为空） */
  private parseJsonLoose(text: string): any {
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch {
      /* fallthrough */
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }

  /** 事件标签：事件支撑了哪类事实（fact:user/world/self）+ initiation / 情绪标签 */
  private buildEventTags(events: PersonaEvent[], facts: PersonaFact[]): { eventId: string; tags: string[] }[] {
    const map = new Map<string, string[]>();
    const push = (id: string, tag: string) => {
      const arr = map.get(id) ?? [];
      if (!arr.includes(tag)) arr.push(tag);
      map.set(id, arr);
    };
    for (const f of facts) {
      for (const eid of f.sourceEventIds) push(eid, `fact:${f.type}`);
    }
    for (const e of events) {
      if (e.initiation) push(e.id, `init:${e.initiation}`);
      for (const t of e.emotionTags ?? []) push(e.id, `emotion:${t}`);
    }
    return [...map.entries()].map(([eventId, tags]) => ({ eventId, tags }));
  }

  /** selfGoals：self_model.preferences + traits（TODO(calibrate)：M2 合并好奇引擎未完结话题） */
  private extractSelfGoals(snap: SelfModelSnapshot | null): string[] {
    if (!snap) return [];
    return [...(snap.preferences ?? []), ...(snap.traits ?? [])];
  }

  private hasDiffContent(diff: SelfModelDiff): boolean {
    return (
      (diff.traits?.length ?? 0) > 0 ||
      (diff.preferences?.length ?? 0) > 0 ||
      !!diff.speakingStyle ||
      !!diff.relationshipView ||
      !!diff.narrative
    );
  }

  /** commit 证据链：事实引用的事件 + 全部关键事件 id */
  private collectEvidence(facts: PersonaFact[], events: PersonaEvent[]): string[] {
    const ids = new Set<string>();
    for (const f of facts) for (const eid of f.sourceEventIds) ids.add(eid);
    for (const e of events) ids.add(e.id);
    return [...ids];
  }
}

/* ════════════ M3：self_direct 反复模式固化（瞬时表达 vs 反复模式） ════════════
 * 用户拍板：一次性的 assistant 表达不应直接进入自我模型的强化回路——状态机允许
 * 高唤醒状态下说出夸张表达（兴奋时过度承诺、低落时自我否定），单次表达若被当作
 * "立场"直接固化，自我模型会被瞬时状态污染（对应 Fleeson 密度分布：人格来自
 * 跨情境的重复模式，而非单次行为）。
 * 规则：self_direct 事件写 events 时标记强度与模式 key；只有同类表达跨 ≥N 个事件
 * （跨情境）才允许固化为状态机参数 / self_model 特质。单次强表达只进 events
 * 作为情景记忆，不进入强化回路。induced 事件一律不进入强化回路。
 */

/** 固化阈值：同类 self_direct（low）表达至少跨 N 个事件（初始 3，待校准） */
export const PATTERN_FIX_THRESHOLD = 3;

/** M3-2：unchecked（未确认可信）立场模式的固化门槛——更高且须跨会话 */
export const UNCHECKED_FIX_THRESHOLD = 5;

/** M3-2：self_correction 延迟验证——无引导自发维持的次数门槛 */
export const CORRECTION_MAINTAIN_THRESHOLD = 2;

/**
 * 统计 self_direct 事件的立场模式计数（按 selfPattern 分组，跨事件计数）。
 * M3-2：只统计 inductionRisk='low'（确认可信）事件——漏报的诱导（unchecked）不得与
 * confirmed clean 合并计数（否则换措辞诱导会被模式阈值放大成"反复模式"）。
 * 无 inductionRisk 字段的旧事件视为 low（兼容历史数据）。
 * M3 后半：imported（历史导入）事件不参与计数——补记忆不补成长。
 */
export function countSelfDirectPattern(events: readonly PersonaEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.imported) continue;
    if (e.provenance !== 'self_direct' || !e.selfPattern) continue;
    if ((e.inductionRisk ?? 'low') !== 'low') continue;
    counts.set(e.selfPattern, (counts.get(e.selfPattern) ?? 0) + 1);
  }
  return counts;
}

/**
 * M3-2：统计 inductionRisk='unchecked' 的 self_direct 立场模式计数与跨会话（日期）情况。
 * 用于：unchecked 模式 ≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 个会话才允许固化。
 * M3 后半：imported 事件不参与计数（补记忆不补成长）。
 */
export function countUncheckedSelfDirectPattern(events: readonly PersonaEvent[]): {
  counts: Map<string, number>;
  dates: Map<string, Set<string>>;
} {
  const counts = new Map<string, number>();
  const dates = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.imported) continue;
    if (e.provenance !== 'self_direct' || !e.selfPattern) continue;
    if (e.inductionRisk !== 'unchecked') continue;
    counts.set(e.selfPattern, (counts.get(e.selfPattern) ?? 0) + 1);
    const day = e.time.slice(0, 10);
    const set = dates.get(e.selfPattern) ?? new Set<string>();
    set.add(day);
    dates.set(e.selfPattern, set);
  }
  return { counts, dates };
}

/**
 * M3-2：self_correction 延迟验证（以"行为自发性"代替"意图判定"）。
 * 真正的纠正会在无压力环境下被维持，诱导性的认错只在压力下出现：
 * - confirmed：同修正主题下，无引导自发维持的 self_direct（low）≥ CORRECTION_MAINTAIN_THRESHOLD 次
 * - downgraded：同主题出现 induced 事件（仅在诱导语境下维持）→ 修正可能是被诱导的
 * - pending：证据不足，继续待验证
 * M3 后半：imported 事件不参与——导入的历史纠正是"补记忆"，验证只看实时维持。
 */
export function correctionOutcome(
  events: readonly PersonaEvent[],
  pattern: string,
): 'pending' | 'confirmed' | 'downgraded' {
  let maintained = 0;
  let induced = 0;
  for (const e of events) {
    if (e.imported) continue;
    if (!e.selfPattern || e.selfPattern !== pattern) continue;
    if (e.provenance === 'induced') induced += 1;
    if (e.provenance === 'self_direct' && (e.inductionRisk ?? 'low') === 'low') maintained += 1;
  }
  if (induced > 0) return 'downgraded';
  if (maintained >= CORRECTION_MAINTAIN_THRESHOLD) return 'confirmed';
  return 'pending';
}

/**
 * 把 self_direct / self_correction 事件分为"可进入强化回路"与"仅情景记忆"两组（M3-2）：
 * - strengthenable：
 *   - self_direct(low)：同模式跨 ≥PATTERN_FIX_THRESHOLD 个事件
 *   - self_direct(unchecked)：同模式 ≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 会话
 *   - self_correction：延迟验证为 confirmed（无引导维持 ≥2 次）才可固化
 * - memoryOnly：其余全部（单次/未达阈值、induced、pending/downgraded 的 self_correction）
 */
export function filterSelfDirectForStrengthening(
  events: readonly PersonaEvent[],
): { strengthenable: PersonaEvent[]; memoryOnly: PersonaEvent[] } {
  const lowCounts = countSelfDirectPattern(events);
  const { counts: ucCounts, dates: ucDates } = countUncheckedSelfDirectPattern(events);
  const outcomes = new Map<string, 'pending' | 'confirmed' | 'downgraded'>();
  for (const e of events) {
    if (e.provenance === 'self_correction' && e.selfPattern) {
      outcomes.set(e.selfPattern, correctionOutcome(events, e.selfPattern));
    }
  }
  const strengthenable: PersonaEvent[] = [];
  const memoryOnly: PersonaEvent[] = [];
  for (const e of events) {
    // M3 后半：imported（历史导入）事件只作情景记忆，不参与强化（补记忆不补成长）
    if (e.imported) {
      memoryOnly.push(e);
      continue;
    }
    let ok = false;
    if (e.provenance === 'self_direct' && e.selfPattern) {
      const risk = e.inductionRisk ?? 'low';
      if (risk === 'low') {
        ok = (lowCounts.get(e.selfPattern) ?? 0) >= PATTERN_FIX_THRESHOLD;
      } else {
        ok = (ucCounts.get(e.selfPattern) ?? 0) >= UNCHECKED_FIX_THRESHOLD && (ucDates.get(e.selfPattern)?.size ?? 0) >= 2;
      }
    } else if (e.provenance === 'self_correction' && e.selfPattern) {
      ok = outcomes.get(e.selfPattern) === 'confirmed';
    }
    if (ok) {
      strengthenable.push(e);
    } else {
      memoryOnly.push(e);
    }
  }
  return { strengthenable, memoryOnly };
}
