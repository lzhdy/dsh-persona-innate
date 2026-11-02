import { provenanceLabel, recallScore, isProvenance } from './provenance.js';
import { createStripStats, recordStrip, stripCheck } from './directive-strip.js';
export class PersonaMemory {
    store;
    opts;
    stripStats = createStripStats();
    constructor(store, opts) {
        this.store = store;
        this.opts = opts;
    }
    eventsPath = 'events.json';
    async loadEvents() {
        const file = await this.store.readJson(this.eventsPath);
        return file?.events ?? [];
    }
    async saveEvents(events) {
        const file = { version: 1, events };
        await this.store.writeJson(this.eventsPath, file);
    }
    /**
     * 写入事件：剥离检查通过才落库；命中指令性内容则拒绝写入（O37 剥离优先于降权）
     */
    async addEvent(input) {
        const provenance = isProvenance(input.provenance) ? input.provenance : 'inferred';
        const importance = Math.max(0, Math.min(1, input.importance ?? 0.5));
        const text = `${input.topic}：${input.summary}`;
        let strip = null;
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
        const event = {
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
    async list() {
        return this.loadEvents();
    }
    /**
     * 检索最近记忆：recallScore = 来源权重 × 重要性；user_direct 优先进入注入
     * 返回注入文本（每条带显式来源标注）与命中的事件
     */
    async buildInjection(limit) {
        const events = await this.loadEvents();
        if (events.length === 0)
            return { text: '', events: [] };
        const k = Math.max(1, limit ?? this.opts.injectLimit);
        const ranked = [...events].sort((a, b) => recallScore(b) - recallScore(a)).slice(0, k);
        // 二次校验：注入前再次剥离检查，命中则标注并降权至不注入（诚实基线）
        const injectable = ranked.filter((e) => {
            if (!this.opts.stripDirectives)
                return true;
            const r = stripCheck(`${e.topic}：${e.summary}`);
            recordStrip(this.stripStats, r);
            return r.ok;
        });
        const lines = injectable.map((e) => {
            const when = e.time.slice(0, 10);
            return `- [${provenanceLabel(e.provenance)}] ${when} ${e.topic}：${e.summary}`;
        });
        if (lines.length === 0)
            return { text: '', events: [] };
        const text = `【近期共同记忆（来源可见，低可信来源已降权）】\n${lines.join('\n')}`;
        // 记录检索时间（复用强化信号）
        const now = new Date().toISOString();
        const withStamp = events.map((e) => (injectable.includes(e) && !e.lastRetrieved ? { ...e, lastRetrieved: now } : e));
        await this.saveEvents(withStamp);
        return { text, events: injectable };
    }
}
//# sourceMappingURL=memory.js.map