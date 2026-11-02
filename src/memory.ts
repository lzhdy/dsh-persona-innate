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

  async loadEvents(): Promise<PersonaEvent[]> {
    const file = await this.store.readJson<EventsFile>(this.eventsPath);
    return file?.events ?? [];
  }

  async saveEvents(events: PersonaEvent[]): Promise<void> {
    const file: EventsFile = { version: 1, events };
    await this.store.writeJson(this.eventsPath, file);
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
    };

    const events = await this.loadEvents();
    events.push(event);
    await this.saveEvents(events);
    return { event, rejected: false };
  }

  /** 全量事件（按时间升序） */
  async list(): Promise<PersonaEvent[]> {
    return this.loadEvents();
  }

  /**
   * 检索最近记忆：recallScore = 来源权重 × 重要性；user_direct 优先进入注入
   * 返回注入文本（每条带显式来源标注）与命中的事件
   */
  async buildInjection(limit?: number): Promise<{ text: string; events: PersonaEvent[] }> {
    const events = await this.loadEvents();
    if (events.length === 0) return { text: '', events: [] };

    const k = Math.max(1, limit ?? this.opts.injectLimit);
    const ranked = [...events].sort((a, b) => recallScore(b) - recallScore(a)).slice(0, k);

    // 二次校验：注入前再次剥离检查，命中则标注并降权至不注入（诚实基线）
    const injectable = ranked.filter((e) => {
      if (!this.opts.stripDirectives) return true;
      const r = stripCheck(`${e.topic}：${e.summary}`);
      recordStrip(this.stripStats, r);
      return r.ok;
    });

    const lines = injectable.map((e) => {
      const when = e.time.slice(0, 10);
      return `- [${provenanceLabel(e.provenance)}] ${when} ${e.topic}：${e.summary}`;
    });

    if (lines.length === 0) return { text: '', events: [] };
    const text = `【近期共同记忆（来源可见，低可信来源已降权）】\n${lines.join('\n')}`;

    // 记录检索时间（复用强化信号）
    const now = new Date().toISOString();
    const withStamp = events.map((e) => (injectable.includes(e) && !e.lastRetrieved ? { ...e, lastRetrieved: now } : e));
    await this.saveEvents(withStamp);
    return { text, events: injectable };
  }
}
