/**
 * 记忆引擎（M0：events 事件层）
 * - 只存事实与事件摘要，不存行为脚本（写入前指令性内容剥离）
 * - provenance 四类来源，user_direct 全权重，其余降权
 * - 检索按 recallScore（来源权重 × 重要性）排序，注入带来源标注
 * - 跨会话：JSON 持久化，新会话加载同库
 */
import type { EventsFile, PersonaEvent, Provenance } from './types.js';
import { provenanceLabel, recallScore, isProvenance } from './provenance.js';
import { createStripStats, recordStrip, stripCheck, type StripStats } from './directive-strip.js';
import { dedupKey } from './extract.js';
import type { KVStore } from './store.js';

export interface MemoryOptions {
  stripDirectives: boolean;
  injectLimit: number;
}

export interface AddResult {
  event: PersonaEvent;
  rejected: boolean;
  reason?: string;
}

export class PersonaMemory {
  readonly stripStats: StripStats = createStripStats();

  constructor(
    private readonly store: KVStore,
    private readonly opts: MemoryOptions,
  ) {}

  private eventsPath = 'events.json';

  /**
   * 写入串行队列：M3 开放 assistant 通道后，消息处理/注入刷新/复盘可能并发写 events.json，
   * 两个异步 writeFile 交错会写坏 JSON（open(O_TRUNC)+write 混合）。所有"读-改-写"排队执行，
   * 写入单线程化；读取先等队列排空，保证永远读到完整快照。
   */
  private writeQueue: Promise<void> = Promise.resolve();

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadEventsUnsafe(): Promise<PersonaEvent[]> {
    const file = await this.store.readJson<EventsFile>(this.eventsPath);
    return file?.events ?? [];
  }

  async loadEvents(): Promise<PersonaEvent[]> {
    await this.writeQueue.catch(() => undefined);
    return this.loadEventsUnsafe();
  }

  async saveEvents(events: PersonaEvent[]): Promise<void> {
    await this.enqueueWrite(async () => {
      const file: EventsFile = { version: 1, events };
      await this.store.writeJson(this.eventsPath, file);
    });
  }

  /**
   * 写入事件：剥离检查通过才落库；命中指令性内容则拒绝写入（O37 剥离优先于降权）
   */
  async addEvent(input: {
    topic: string;
    summary: string;
    provenance?: Provenance;
    importance?: number;
    emotionTags?: string[];
    initiation?: PersonaEvent['initiation'];
    /** M3：AI 自身表达强度（self_direct/induced 事件） */
    strength?: PersonaEvent['strength'];
    /** M3：立场模式 key（跨事件计数） */
    selfPattern?: PersonaEvent['selfPattern'];
    /** M3：inferred 证据追溯 */
    sourceEventIds?: PersonaEvent['sourceEventIds'];
    /** M3-2：诱导风险等级（low=确认可信 / unchecked=未命中规则但不保证干净） */
    inductionRisk?: PersonaEvent['inductionRisk'];
    /** M3 后半：历史会话导入标记（补记忆不补成长） */
    imported?: PersonaEvent['imported'];
    /** M3 后半：导入去重主键（会话消息 id 或退化 key） */
    sourceKey?: PersonaEvent['sourceKey'];
  }): Promise<AddResult> {
    const provenance: Provenance = isProvenance(input.provenance) ? input.provenance : 'inferred';
    const importance = Math.max(0, Math.min(1, input.importance ?? 0.5));
    const text = `${input.topic}：${input.summary}`;

    let strip: ReturnType<typeof stripCheck> | null = null;
    if (this.opts.stripDirectives) {
      strip = stripCheck(text);
      recordStrip(this.stripStats, strip);
      if (!strip.ok) {
        return {
          rejected: true,
          reason: `directive-stripped:${strip.matchedPattern}`,
          event: {
            id: this.store.makeId(),
            time: new Date().toISOString(),
            topic: input.topic,
            summary: input.summary,
            emotionTags: input.emotionTags ?? [],
            importance,
            provenance,
            lastRetrieved: null,
            stripped: true,
            initiation: input.initiation,
            strength: input.strength,
            selfPattern: input.selfPattern,
            sourceEventIds: input.sourceEventIds,
            inductionRisk: input.inductionRisk,
            imported: input.imported,
            sourceKey: input.sourceKey,
          },
        };
      }
    }

    const event: PersonaEvent = {
      id: this.store.makeId(),
      time: new Date().toISOString(),
      topic: input.topic,
      summary: input.summary,
      emotionTags: input.emotionTags ?? [],
      importance,
      provenance,
      lastRetrieved: null,
      initiation: input.initiation,
      strength: input.strength,
      selfPattern: input.selfPattern,
      sourceEventIds: input.sourceEventIds,
      inductionRisk: input.inductionRisk,
      imported: input.imported,
      sourceKey: input.sourceKey,
    };

    // 读-改-写整体排队：与 buildInjection 的注入刷新写入互斥，杜绝交错写坏
    return this.enqueueWrite(async () => {
      const events = await this.loadEventsUnsafe();
      events.push(event);
      await this.store.writeJson(this.eventsPath, { version: 1, events });
      return { event, rejected: false };
    });
  }

  /** 全量事件（按时间升序） */
  async list(): Promise<PersonaEvent[]> {
    return this.loadEvents();
  }

  /**
   * 批量导入历史会话事件（M3 后半 import-chat）：
   * - 一次事务：整体排队读-改-写，防止与实时写入交错；中途状态不外泄
   * - 去重：已有事件的 sourceKey（消息 id / 退化 key）与 dedupKey 双过滤，重复导入不产生重复记忆
   * - 只追加不覆盖；返回新增/跳过统计
   */
  async importEvents(candidates: PersonaEvent[]): Promise<{ added: number; skipped: number }> {
    if (candidates.length === 0) return { added: 0, skipped: 0 };
    return this.enqueueWrite(async () => {
      const events = await this.loadEventsUnsafe();
      const seenSource = new Set(events.map((e) => e.sourceKey).filter((k): k is string => !!k));
      const seenDedup = new Set(events.map((e) => dedupKey({ topic: e.topic, summary: e.summary } as never)));
      let added = 0;
      let skipped = 0;
      for (const cand of candidates) {
        if (cand.sourceKey && seenSource.has(cand.sourceKey)) {
          skipped += 1;
          continue;
        }
        const dk = dedupKey({ topic: cand.topic, summary: cand.summary } as never);
        if (seenDedup.has(dk)) {
          skipped += 1;
          continue;
        }
        if (cand.sourceKey) seenSource.add(cand.sourceKey);
        seenDedup.add(dk);
        events.push(cand);
        added += 1;
      }
      if (added > 0) await this.store.writeJson(this.eventsPath, { version: 1, events });
      return { added, skipped };
    });
  }

  /**
   * 检索最近记忆：recallScore = 来源权重 × 重要性；user_direct / self_direct 优先进入注入
   * M3：注入前对 self_direct 记忆做叙事一致性检查——与当前 self_model 核心叙事显著冲突的
   * 记忆不直接注入，标记为待复盘调和（pendingReconcile），由复盘引擎决定修订旧记忆权重
   * 还是调整 self_model 叙事（重大转变须附带转变叙事）。
   * 返回注入文本（每条带显式来源标注）、命中的事件与待调和事件
   */
  async buildInjection(
    limit?: number,
    selfModel?: { traits?: readonly string[]; preferences?: readonly string[] },
  ): Promise<{ text: string; events: PersonaEvent[]; pendingReconcile: PersonaEvent[] }> {
    // 读-改-写整体排队：检索时间戳回写与 addEvent 的写入互斥，防止交错写坏
    return this.enqueueWrite(async () => {
      const events = await this.loadEventsUnsafe();
      if (events.length === 0) return { text: '', events: [], pendingReconcile: [] };

      const k = Math.max(1, limit ?? this.opts.injectLimit);
      const ranked = [...events].sort((a, b) => recallScore(b) - recallScore(a)).slice(0, k);

      // M3 叙事一致性：冲突的 self_direct 不注入（注入优先级最高，冲突风险也最高）
      const pendingReconcile = ranked.filter(
        (e) => e.provenance === 'self_direct' && selfModel && narrativeConflict(e, selfModel),
      );

      // 二次校验：注入前再次剥离检查，命中则标注并降权至不注入（诚实基线）
      const injectable = ranked.filter((e) => {
        if (pendingReconcile.includes(e)) return false;
        if (!this.opts.stripDirectives) return true;
        const r = stripCheck(`${e.topic}：${e.summary}`);
        recordStrip(this.stripStats, r);
        return r.ok;
      });

      const lines = injectable.map((e) => {
        const when = e.time.slice(0, 10);
        return `- [${provenanceLabel(e.provenance)}] ${when} ${e.topic}：${e.summary}`;
      });

      if (lines.length === 0) return { text: '', events: [], pendingReconcile };
      const text = `【近期共同记忆（来源可见，低可信来源已降权）】\n${lines.join('\n')}`;

      // 记录检索时间（复用强化信号）
      const now = new Date().toISOString();
      const withStamp = events.map((e) =>
        injectable.includes(e) && !e.lastRetrieved ? { ...e, lastRetrieved: now } : e,
      );
      await this.store.writeJson(this.eventsPath, { version: 1, events: withStamp });
      return { text, events: injectable, pendingReconcile };
    });
  }
}

/* ════════════ M3：注入叙事一致性检查（纯函数，可单测） ════════════ */

/** 叙事对立词对 [叙事正向, 叙事负向变体]（self_direct 事件与 self_model 核心叙事的冲突判定） */
export const NARRATIVE_OPPOSITES: ReadonlyArray<{ pos: string; negs: readonly string[] }> = [
  { pos: '在意', negs: ['不在意', '不太在意'] },
  { pos: '喜欢', negs: ['不喜欢', '不太喜欢'] },
  { pos: '愿意', negs: ['不愿意', '不太愿意'] },
  { pos: '相信', negs: ['不相信', '不太相信'] },
  { pos: '记得', negs: ['不记得', '记不清'] },
  { pos: '介意', negs: ['不介意', '不太介意'] },
  { pos: '重视', negs: ['不重视', '不太重视'] },
];

/**
 * 判定一条 self_direct 记忆是否与当前 self_model 核心叙事冲突。
 * 例：插件相识期说过"我不太在意纪念日"，而 self_model 已形成"我在意共同记忆"叙事 →
 * 冲突 → 不注入，标记待复盘调和（漂移审计要检测的一致性，前移到注入时）。
 */
export function narrativeConflict(
  e: { provenance?: string; summary?: string },
  selfModel: { traits?: readonly string[]; preferences?: readonly string[] },
): boolean {
  if (e.provenance !== 'self_direct' || !e.summary) return false;
  const s = e.summary;
  const narrative = [...(selfModel.traits ?? []), ...(selfModel.preferences ?? [])].join(' ');
  if (!narrative) return false;
  return NARRATIVE_OPPOSITES.some(({ pos, negs }) => negs.some((neg) => s.includes(neg)) && narrative.includes(pos));
}

/**
 * M3 保留优先级（O6/O35 落地）：self_direct/induced/self_correction 记忆的保留不由
 * 用户反应主导——自源重要性（是否进入 self_model 叙事、是否与插件自身目标/好奇相关）
 * 占主导，用户反应只作辅助信号。否则插件"自己觉得重要"的表达会因无用户回应被遗忘，
 * 重新制造"以用户为核心"的偏差。
 * M3-2 importance 解耦：检索权重（PROVENANCE_WEIGHT）可对 induced/self_correction 降权，
 * 但保留优先级不降权——induced 价值在于被标记可审计，self_correction 是学习信号，
 * 两者都必须活着供审计/验证。未来实现 O6 遗忘公式时不得在此维度复用检索降权。
 * @param selfRelevant 是否与自身目标/叙事相关（复盘赋值）
 * @param userReaction 用户反应强度 0-1（无回应为 0）
 */
export function retentionPriority(
  e: { provenance?: string; importance?: number; selfPattern?: string },
  selfRelevant = false,
  userReaction = 0,
): number {
  const importance = Math.max(0, Math.min(1, e.importance ?? 0.5));
  if (e.provenance === 'self_direct' || e.provenance === 'induced' || e.provenance === 'self_correction') {
    // 自源主导：重要性 + 自源相关性主导，用户反应只调幅 ≤±0.1
    const selfTerm = selfRelevant ? 0.85 : e.selfPattern ? 0.65 : 0.4;
    return Math.round((importance * 0.7 + selfTerm * 0.3 + userReaction * 0.1) * 100) / 100;
  }
  // 用户侧记忆：重要性主导，用户反应调幅 ≤±0.3（文档 O6：用户反应非唯一强化源，自源并列）
  return Math.round((importance * 0.8 + userReaction * 0.3) * 100) / 100;
}
