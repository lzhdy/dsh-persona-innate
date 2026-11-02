/** 存在论锚点（§9 原文：自我模型始终声明 AI 身份——不伪装人类，但可以有独特个体性） */
export const EXISTENTIAL_ANCHOR = '我是 AI，正在通过与你的相处形成自己的方式。不伪装人类，但可以有独特个体性。';
// TODO(calibrate)：self_model 保留最近 N 版（回滚窗口），初始 10
export const DEFAULT_SELF_MODEL_VERSION_LIMIT = 10;
const SELF_MODEL_PATH = 'self-model.json';
function now() {
    return new Date().toISOString();
}
/** 首版种子快照：存在论锚点 + 空特质/证据 + 说话方式占位（§2 冻结约定） */
export function seedInitialSnapshot() {
    return {
        version: 1,
        createdAt: now(),
        traits: [],
        preferences: [],
        speakingStyle: '（未成形）',
        relationshipView: '',
        narrative: '',
        aiIdentity: EXISTENTIAL_ANCHOR,
        sourceEventIds: [],
        sourceTraces: { metacognition: [EXISTENTIAL_ANCHOR] },
    };
}
function emptyFile() {
    return { version: 1, current: seedInitialSnapshot(), history: [], growthArchive: [] };
}
export class SelfModelService {
    store;
    historyLimit;
    constructor(store, opts) {
        this.store = store;
        // TODO(calibrate)：historyLimit 默认 10（回滚窗口），后续按实测调整
        this.historyLimit = Math.max(1, opts?.historyLimit ?? DEFAULT_SELF_MODEL_VERSION_LIMIT);
    }
    /** 读盘；文件缺失时惰性落盘种子（§9：自我模型始终包含锚点） */
    async getFile() {
        const file = await this.store.readJson(SELF_MODEL_PATH);
        if (file === null) {
            const seeded = emptyFile();
            await this.store.writeJson(SELF_MODEL_PATH, seeded);
            return seeded;
        }
        if (file.current === null) {
            file.current = seedInitialSnapshot();
            await this.store.writeJson(SELF_MODEL_PATH, file);
        }
        return file;
    }
    async save(file) {
        await this.store.writeJson(SELF_MODEL_PATH, file);
    }
    async load() {
        const file = await this.getFile();
        return file.current;
    }
    async listHistory() {
        const file = await this.getFile();
        return [...file.history];
    }
    async commitFromSources(diff, evidence, sources, changeNote) {
        const file = await this.getFile();
        const current = file.current ?? seedInitialSnapshot();
        // ── 一致性检查（§9 防漂移；抛错前不落盘） ──
        // 1) diff 中新增 traits 但 evidence 为空
        const existing = new Set(current.traits);
        const newTraits = (diff.traits ?? []).filter((t) => !existing.has(t));
        if (newTraits.length > 0 && evidence.length === 0) {
            throw new Error('consistency: 新特质缺少事件证据');
        }
        // 2) narrative 有显著变化但无 changeNote
        if (diff.narrative !== undefined && diff.narrative !== current.narrative && !changeNote) {
            throw new Error('consistency: 重大转变缺少 changeNote');
        }
        const traits = [...new Set([...current.traits, ...(diff.traits ?? [])])];
        const preferences = [...new Set([...current.preferences, ...(diff.preferences ?? [])])];
        const sourceEventIds = [...new Set([...current.sourceEventIds, ...evidence])];
        const sourceTraces = {
            ...(current.sourceTraces ?? {}),
        };
        for (const s of sources) {
            sourceTraces[s] = [...new Set([...(sourceTraces[s] ?? []), ...evidence])];
        }
        const maxVersion = Math.max(current.version, ...file.history.map((h) => h.version));
        const snapshot = {
            version: maxVersion + 1,
            createdAt: now(),
            traits,
            preferences,
            speakingStyle: diff.speakingStyle ?? current.speakingStyle,
            relationshipView: diff.relationshipView ?? current.relationshipView,
            narrative: diff.narrative ?? current.narrative,
            aiIdentity: EXISTENTIAL_ANCHOR,
            changeNote,
            sourceEventIds,
            sourceTraces,
        };
        // 旧 current 入 history，按 historyLimit 截断（保留最近 N 版）
        const history = [...file.history, current].slice(-this.historyLimit);
        await this.save({ version: 1, current: snapshot, history, growthArchive: file.growthArchive });
        return snapshot;
    }
    async rollback(version) {
        const file = await this.getFile();
        const current = file.current ?? seedInitialSnapshot();
        const target = current.version === version ? current : file.history.find((h) => h.version === version);
        if (!target)
            return null;
        // 以目标版本的字段生成新快照（版本单调：max+1），而非覆盖 current
        const maxVersion = Math.max(current.version, ...file.history.map((h) => h.version));
        const sourceTraces = {
            ...(target.sourceTraces ?? {}),
        };
        sourceTraces.continuity = [
            ...new Set([...(sourceTraces.continuity ?? []), `回滚自 v${version}`]),
        ];
        const snapshot = {
            version: maxVersion + 1,
            createdAt: now(),
            traits: [...target.traits],
            preferences: [...target.preferences],
            speakingStyle: target.speakingStyle,
            relationshipView: target.relationshipView,
            narrative: target.narrative,
            aiIdentity: EXISTENTIAL_ANCHOR,
            changeNote: `rollback:${version}`,
            sourceEventIds: [...target.sourceEventIds],
            sourceTraces,
        };
        const history = [...file.history, current].slice(-this.historyLimit);
        await this.save({ version: 1, current: snapshot, history, growthArchive: file.growthArchive });
        return snapshot;
    }
    async appendGrowth(entry) {
        const file = await this.getFile();
        file.growthArchive.push(entry);
        await this.save(file);
    }
    /**
     * 注入层摘要（同步纯函数）。固定四行格式——注入层 KV cache 前缀依赖此格式，禁止自由发挥。
     * snapshot 为 null/undefined 时仅返回锚点行。
     */
    getInjectionSummary(snapshot) {
        if (snapshot === null || snapshot === undefined) {
            return EXISTENTIAL_ANCHOR;
        }
        const style = snapshot.speakingStyle.trim() || '未成形';
        // 叙事取首句（首个换行或句号前）
        let narrative = snapshot.narrative.trim();
        const cut = narrative.search(/[\n。]/);
        if (cut >= 0)
            narrative = narrative.slice(0, cut + (narrative[cut] === '。' ? 1 : 0));
        narrative = narrative || '无';
        const relation = snapshot.relationshipView.trim() || '无';
        return [
            '【自我模型（摘要）】',
            `说话方式：${style}`,
            `叙事：${narrative}`,
            `关系认知：${relation}`,
            `AI 身份：${snapshot.aiIdentity}`,
        ].join('\n');
    }
}
//# sourceMappingURL=self-model.js.map