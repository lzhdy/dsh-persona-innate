/**
 * self_model 服务（§9：四来源 / 存在论锚点 / 自我叙事版本化）
 * 持久化 self-model.json（SelfModelFile，JsonStore 读写，写前自动 mkdir）。
 * 防漂移（§9）：新特质须可追溯到事件证据；重大转变须附 changeNote；
 * 版本单调递增；保留最近 N 版可回滚。
 */
import type {
  CandidateTrait,
  GrowthEntry,
  SelfModelDiff,
  SelfModelFile,
  SelfModelServiceLike,
  SelfModelSnapshot,
  SelfModelSource,
} from './types.js';
import type { KVStore } from './store.js';

/** 存在论锚点（§9 原文：自我模型始终声明 AI 身份——不伪装人类，但可以有独特个体性） */
export const EXISTENTIAL_ANCHOR =
  '我是 AI，正在通过与你的相处形成自己的方式。不伪装人类，但可以有独特个体性。';

// TODO(calibrate)：self_model 保留最近 N 版（回滚窗口），初始 10
export const DEFAULT_SELF_MODEL_VERSION_LIMIT = 10;

export interface SelfModelOptions {
  /** history 保留上限（默认 DEFAULT_SELF_MODEL_VERSION_LIMIT） */
  historyLimit?: number;
}

const SELF_MODEL_PATH = 'self-model.json';

function now(): string {
  return new Date().toISOString();
}

/** 首版种子快照：存在论锚点 + 空特质/证据 + 说话方式占位（§2 冻结约定） */
export function seedInitialSnapshot(): SelfModelSnapshot {
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

function emptyFile(): SelfModelFile {
  return { version: 1, current: seedInitialSnapshot(), history: [], growthArchive: [] };
}

/**
 * 兼容旧数据：把磁盘上任意形态的 candidateTraits 归一化成 CandidateTrait[]。
 *
 * 为什么必须有（ISS-048）：`candidateTraits` 从 `string[]` 改成了带证据的对象数组，
 * 而真实用户的 self-model.json 里已经躺着 3 条字符串、history 里还有 5 个旧版本。
 * 要求用户手工迁移是不可接受的——旧数据照样要能加载、能继续跑，只是"没有证据"，
 * 于是按规则继续冻结（这是预期行为，不是错误，也不该抛）。
 *
 * 容错口径（宁可少读也不炸）：
 * - 字符串（含首尾空白剔除）→ `{ text, sourceEventIds: [] }`；
 * - 对象且 `text` 是非空字符串 → 补 `sourceEventIds`（过滤非字符串 id）+ 透传两个时间戳；
 * - 其它（null / 数字 / 空文本 / 数组里的对象套对象）→ 丢弃。
 */
export function normalizeCandidateTraits(raw: unknown): CandidateTrait[] {
  if (!Array.isArray(raw)) return [];
  const out: CandidateTrait[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) out.push({ text, sourceEventIds: [] });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Partial<CandidateTrait>;
      const text = typeof obj.text === 'string' ? obj.text.trim() : '';
      if (!text) continue;
      out.push({
        text,
        sourceEventIds: Array.isArray(obj.sourceEventIds)
          ? obj.sourceEventIds.filter((id): id is string => typeof id === 'string')
          : [],
        ...(typeof obj.firstSeenAt === 'string' ? { firstSeenAt: obj.firstSeenAt } : {}),
        ...(typeof obj.lastSeenAt === 'string' ? { lastSeenAt: obj.lastSeenAt } : {}),
      });
    }
  }
  // 文本去重（保留首次出现的证据并集）：旧数据可能因为多次 commit 出现重复文本
  const byText = new Map<string, CandidateTrait>();
  for (const c of out) {
    const prev = byText.get(c.text);
    if (!prev) {
      byText.set(c.text, c);
      continue;
    }
    prev.sourceEventIds = [...new Set([...prev.sourceEventIds, ...c.sourceEventIds])];
    if (c.firstSeenAt && (!prev.firstSeenAt || c.firstSeenAt < prev.firstSeenAt)) prev.firstSeenAt = c.firstSeenAt;
    if (c.lastSeenAt && (!prev.lastSeenAt || c.lastSeenAt > prev.lastSeenAt)) prev.lastSeenAt = c.lastSeenAt;
  }
  return [...byText.values()];
}

export class SelfModelService implements SelfModelServiceLike {
  private readonly historyLimit: number;

  constructor(private readonly store: KVStore, opts?: SelfModelOptions) {
    // TODO(calibrate)：historyLimit 默认 10（回滚窗口），后续按实测调整
    this.historyLimit = Math.max(1, opts?.historyLimit ?? DEFAULT_SELF_MODEL_VERSION_LIMIT);
  }

  /** 读盘；文件缺失时惰性落盘种子（§9：自我模型始终包含锚点） */
  private async getFile(): Promise<SelfModelFile> {
    const file = await this.store.readJson<SelfModelFile>(SELF_MODEL_PATH);
    if (file === null) {
      const seeded = emptyFile();
      await this.store.writeJson(SELF_MODEL_PATH, seeded);
      return seeded;
    }
    if (file.current === null) {
      file.current = seedInitialSnapshot();
      await this.store.writeJson(SELF_MODEL_PATH, file);
    }
    // 旧格式（string[]）在这里统一归一化：current 与每一版 history 都要过，
    // 否则 rollback 到旧版本后 candidateTraits 又会变成字符串数组（类型上不报错，
    // 运行时 `c.sourceEventIds` 全是 undefined，闸门静默失效）。
    file.current = { ...file.current, candidateTraits: normalizeCandidateTraits(file.current.candidateTraits) };
    file.history = file.history.map((h) => ({ ...h, candidateTraits: normalizeCandidateTraits(h.candidateTraits) }));
    return file;
  }

  private async save(file: SelfModelFile): Promise<void> {
    await this.store.writeJson(SELF_MODEL_PATH, file);
  }

  async load(): Promise<SelfModelSnapshot | null> {
    const file = await this.getFile();
    return file.current;
  }

  async listHistory(): Promise<SelfModelSnapshot[]> {
    const file = await this.getFile();
    return [...file.history];
  }

  async commitFromSources(
    diff: SelfModelDiff,
    evidence: string[],
    sources: SelfModelSource[],
    changeNote?: string,
  ): Promise<SelfModelSnapshot> {
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

    // ISS-048：晋升成功的特质必须离开候选池。放在 commit 里做（而不是只靠调用方），
    // 因为"同一文本同时出现在 traits 与 candidateTraits"是数据自相矛盾，
    // 任何写入路径都不该产出这种状态。
    const nowStable = new Set(diff.traits ?? []);
    const candidateTraits = (current.candidateTraits ?? []).filter((c) => !nowStable.has(c.text));

    const sourceTraces: Partial<Record<SelfModelSource, string[]>> = {
      ...(current.sourceTraces ?? {}),
    };
    for (const s of sources) {
      sourceTraces[s] = [...new Set([...(sourceTraces[s] ?? []), ...evidence])];
    }

    const maxVersion = Math.max(current.version, ...file.history.map((h) => h.version));
    const snapshot: SelfModelSnapshot = {
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
      candidateTraits,
    };

    // 旧 current 入 history，按 historyLimit 截断（保留最近 N 版）
    const history = [...file.history, current].slice(-this.historyLimit);
    await this.save({ version: 1, current: snapshot, history, growthArchive: file.growthArchive });
    return snapshot;
  }

  /**
   * P2（ISS-048 改造）：把候选特质合并进 candidateTraits（不碰 current.traits）。
   * 与 commitFromSources 同款版本化规则：版本 +1、旧 current 入 history（按 historyLimit 截断）。
   *
   * 合并规则（按 text 为键，不是整对象去重）：
   * - 已存在 → sourceEventIds 取**并集**（同一特质在不同天被不同事件支撑，证据要累积，
   *   否则"跨 ≥2 日期"永远攒不够）+ 刷新 lastSeenAt；
   * - 不存在 → push，并记 firstSeenAt/lastSeenAt。
   * 旧数据（无 firstSeenAt）合并时保持 firstSeenAt 缺失——宁可显示"未知"，
   * 也不要把"今天"写成它的首次出现时间（那就是在伪造证据时间线）。
   */
  async commitCandidates(candidates: CandidateTrait[]): Promise<SelfModelSnapshot> {
    const file = await this.getFile();
    const current = file.current ?? seedInitialSnapshot();
    const at = now();

    const merged = new Map<string, CandidateTrait>();
    for (const c of current.candidateTraits ?? []) {
      merged.set(c.text, { ...c, sourceEventIds: [...c.sourceEventIds] });
    }
    for (const c of candidates ?? []) {
      const text = typeof c?.text === 'string' ? c.text.trim() : '';
      if (!text) continue;
      const ids = Array.isArray(c.sourceEventIds) ? c.sourceEventIds.filter((id) => typeof id === 'string') : [];
      const prev = merged.get(text);
      if (prev) {
        prev.sourceEventIds = [...new Set([...prev.sourceEventIds, ...ids])];
        prev.lastSeenAt = at;
        continue;
      }
      merged.set(text, { text, sourceEventIds: [...new Set(ids)], firstSeenAt: at, lastSeenAt: at });
    }
    const candidateTraits = [...merged.values()];

    const maxVersion = Math.max(current.version, ...file.history.map((h) => h.version));
    const snapshot: SelfModelSnapshot = {
      ...current,
      version: maxVersion + 1,
      createdAt: at,
      candidateTraits,
      changeNote: `晋升隔离：${candidateTraits.length} 条候选特质待验证`,
    };

    const history = [...file.history, current].slice(-this.historyLimit);
    await this.save({ version: 1, current: snapshot, history, growthArchive: file.growthArchive });
    return snapshot;
  }

  /**
   * ISS-048：按文本把候选移出候选池（晋升完成后调用）。
   * 与 commit 路径同款版本化规则；没有任何匹配项时**不写盘**——
   * 否则每次复盘都会因为"移除空集"白涨一个版本，把回滚窗口挤掉。
   */
  async removeCandidates(texts: string[]): Promise<SelfModelSnapshot> {
    const file = await this.getFile();
    const current = file.current ?? seedInitialSnapshot();
    const drop = new Set((texts ?? []).map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean));
    const before = current.candidateTraits ?? [];
    const candidateTraits = before.filter((c) => !drop.has(c.text));
    if (candidateTraits.length === before.length) return current;

    const at = now();
    const maxVersion = Math.max(current.version, ...file.history.map((h) => h.version));
    const snapshot: SelfModelSnapshot = {
      ...current,
      version: maxVersion + 1,
      createdAt: at,
      candidateTraits,
      changeNote: `候选晋升：移出 ${before.length - candidateTraits.length} 条（已进 stable）`,
    };

    const history = [...file.history, current].slice(-this.historyLimit);
    await this.save({ version: 1, current: snapshot, history, growthArchive: file.growthArchive });
    return snapshot;
  }

  async rollback(version: number): Promise<SelfModelSnapshot | null> {
    const file = await this.getFile();
    const current = file.current ?? seedInitialSnapshot();
    const target =
      current.version === version ? current : file.history.find((h) => h.version === version);
    if (!target) return null;

    // 以目标版本的字段生成新快照（版本单调：max+1），而非覆盖 current
    const maxVersion = Math.max(current.version, ...file.history.map((h) => h.version));
    const sourceTraces: Partial<Record<SelfModelSource, string[]>> = {
      ...(target.sourceTraces ?? {}),
    };
    sourceTraces.continuity = [
      ...new Set([...(sourceTraces.continuity ?? []), `回滚自 v${version}`]),
    ];

    const snapshot: SelfModelSnapshot = {
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
      // 深拷贝一层：history 里的对象与 current 共享引用会让后续合并污染历史版本
      candidateTraits: (target.candidateTraits ?? []).map((c) => ({ ...c, sourceEventIds: [...c.sourceEventIds] })),
    };

    const history = [...file.history, current].slice(-this.historyLimit);
    await this.save({ version: 1, current: snapshot, history, growthArchive: file.growthArchive });
    return snapshot;
  }

  async appendGrowth(entry: GrowthEntry): Promise<void> {
    const file = await this.getFile();
    file.growthArchive.push(entry);
    await this.save(file);
  }

  /**
   * 注入层摘要（同步纯函数）。固定四行格式——注入层 KV cache 前缀依赖此格式，禁止自由发挥。
   * snapshot 为 null/undefined 时仅返回锚点行。
   */
  getInjectionSummary(snapshot?: SelfModelSnapshot | null): string {
    if (snapshot === null || snapshot === undefined) {
      return EXISTENTIAL_ANCHOR;
    }
    const style = snapshot.speakingStyle.trim() || '未成形';
    // 叙事取首句（首个换行或句号前）
    let narrative = snapshot.narrative.trim();
    const cut = narrative.search(/[\n。]/);
    if (cut >= 0) narrative = narrative.slice(0, cut + (narrative[cut] === '。' ? 1 : 0));
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
