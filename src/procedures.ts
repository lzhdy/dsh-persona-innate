/**
 * 程序性记忆层（增量1）：procedures（"遇到什么情况、怎么做"）
 *
 * 机制依据：《记忆架构最终设计 v1.1》§16.1（增量1）+ §4.4（晋升门槛）+ §4.7（七态状态机）。
 * 红线：procedures 只能长出来、不能写进去——必须是 AI 从自身经历归纳的做法
 * （epistemicType 固定 'ai_inference'、默认 candidate、sourceEventIds 非空且真实）。
 * 无证据的 procedure = 预设脚本 → 整条丢弃。
 *
 * 本文件不含 LLM 调用，全部是纯函数 + 存储；调用点只有复盘引擎（写入路径必须零 LLM 调用）。
 * 复用 memory-facts.ts 的存储与校验模式：只 import 已导出的纯函数与类型
 * （stableId / normalizeFactKey / evidenceGroupId / FactLoad），
 * normalizeIds / checkIds / latestEventTime 等校验小工具在模块内自实现，
 * 避免依赖其私有实现（不改 facts 现有逻辑）。
 */
import type {
  FactDropReason,
  PersonaProcedure,
  ProceduresFile,
  ProcedureStats,
} from './types.js';
import {
  evidenceGroupId,
  normalizeFactKey,
  stableId,
  type FactLoad,
} from './memory-facts.js';
import { stripMemoryFact } from './directive-strip.js';
import type { KVStore } from './store.js';

/* ══════════════════════ 常量 ══════════════════════ */

/** procedures 存储目录（相对 store root） */
const PROCEDURES_DIR = 'memory';

/** 新 procedure 的默认置信度（LLM 未给值时；与 attribute 默认值一致） */
const DEFAULT_PROCEDURE_CONFIDENCE = 0.5;

/* ══════════════════════ 稳定 id ══════════════════════ */

/** procedure id：只由 trigger 推导（同 trigger = 同一做法，跨天合并） */
export function procedureId(trigger: string): string {
  return stableId('pr_', normalizeFactKey(trigger));
}

/* ══════════════════════ 结构校验 ══════════════════════ */

/** facts 七态状态机（§4.7）；与 attributes 校验共用同一合法集 */
const FACT_STATUSES: ReadonlySet<string> = new Set([
  'candidate', 'active', 'quarantined', 'disputed',
  'superseded', 'retracted', 'expired',
]);

/** 认识论类型三态（§4.3）；epistemicType 只认这三个合法值 */
const EPISTEMIC_TYPES: ReadonlySet<string> = new Set([
  'direct_observation', 'user_statement', 'ai_inference',
]);

/** 结构性校验（只拦明显坏数据，不改语义；坏条目不静默"修复"成别的值） */
export function isProcedureShaped(v: unknown): v is PersonaProcedure {
  const p = v as Partial<PersonaProcedure> | null;
  return (
    !!p &&
    typeof p.id === 'string' &&
    typeof p.trigger === 'string' &&
    typeof p.action === 'string' &&
    typeof p.rationale === 'string' &&
    typeof p.speaker === 'string' &&
    typeof p.status === 'string' &&
    FACT_STATUSES.has(p.status) &&
    typeof p.epistemicType === 'string' &&
    EPISTEMIC_TYPES.has(p.epistemicType) &&
    Array.isArray(p.sourceEventIds)
  );
}

/* ══════════════════════ 存储 ══════════════════════ */

/**
 * procedures 的存储门面。
 *
 * 为什么不用 store.readJson：与 memory-facts 同一理由——readJson 读失败静默返回 null，
 * 调用方无法区分"首次运行（没有文件）"与"文件读不到"，后者被当成空库会在下次写入覆盖全库。
 * 所以只用 readText（读失败抛出）+ 显式区分三态。
 */
export class ProcedureStore {
  constructor(private readonly store: KVStore) {}

  get proceduresPath(): string {
    return `${PROCEDURES_DIR}/procedures.json`;
  }

  /**
   * 读 { version, procedures: T[] } 结构。
   * 三态：文件不存在 → 空库（正常首次运行）；读失败/解析失败/结构不符 → ok:false。
   */
  async loadProcedures(): Promise<FactLoad<PersonaProcedure>> {
    let raw: string;
    try {
      raw = await this.store.readText(this.proceduresPath);
    } catch (err) {
      return { ok: false, reason: `${this.proceduresPath} 读取失败：${errorMessage(err)}` };
    }
    if (!raw.trim()) return { ok: true, items: [] }; // 首次运行：没有文件，或文件为空
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `${this.proceduresPath} JSON 损坏（不按空库处理，避免下次写入覆盖）` };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: `${this.proceduresPath} 结构非法（顶层不是对象）` };
    }
    const list = (parsed as Record<string, unknown>).procedures;
    if (!Array.isArray(list)) {
      return { ok: false, reason: `${this.proceduresPath} 缺少 procedures 数组` };
    }
    return { ok: true, items: (list as PersonaProcedure[]).filter(isProcedureShaped) };
  }

  /** 原子写（temp+rename / 先备份再覆盖）；不用 writeText，硬状态不允许截断即丢 */
  async saveProcedures(procedures: readonly PersonaProcedure[]): Promise<void> {
    const file: ProceduresFile = { version: 1, procedures: [...procedures] };
    await this.store.writeTextAtomic(this.proceduresPath, JSON.stringify(file, null, 2));
  }
}

/* ══════════════════════ 派生（LLM 输出 → 可信条目） ══════════════════════ */

/** LLM 返回的 procedure 候选（全部字段不可信，逐字段校验） */
export interface RawProcedureCandidate {
  trigger?: unknown;
  action?: unknown;
  rationale?: unknown;
  sourceEventIds?: unknown;
}

/** LLM 返回的整体结构 */
export interface RawProcedureOutput {
  procedures?: unknown;
}

export interface DeriveProceduresInput {
  /** LLM 原始 JSON（parseJsonLoose 的结果） */
  raw: RawProcedureOutput | null;
  /** 全量事件 id（sourceEventIds 存在性校验的唯一依据） */
  knownEventIds: ReadonlySet<string>;
  existingProcedures: readonly PersonaProcedure[];
  /** 派生时刻 ISO（测试可注入） */
  now: string;
  /** eventId → 该事件 ISO time（assertedAt 用；缺省回退 undefined） */
  eventTimes?: ReadonlyMap<string, string>;
}

export interface DeriveProceduresResult {
  procedures: PersonaProcedure[];
  stats: ProcedureStats;
  /** procedures 是否需要落盘 */
  dirty: boolean;
}

/** 造一份零值统计（调用方可覆盖部分字段） */
export function emptyProcedureStats(patch: Partial<ProcedureStats> = {}): ProcedureStats {
  return {
    ran: false,
    persisted: false,
    proceduresCreated: 0,
    proceduresUpdated: 0,
    proceduresPromoted: 0,
    dropped: 0,
    dropReasons: { 'no-source': 0, 'unknown-source': 0, strip: 0, invalid: 0 },
    ...patch,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function drop(stats: ProcedureStats, reason: FactDropReason): void {
  stats.dropped += 1;
  stats.dropReasons[reason] = (stats.dropReasons[reason] ?? 0) + 1;
}

/** 规整 sourceEventIds：只留非空字符串并去重（LLM 常给重复 id） */
function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** 取 ids 对应事件里 Date.parse 最大的 time；映射缺失/无合法时间 → undefined */
function latestEventTime(ids: readonly string[], eventTimes?: ReadonlyMap<string, string>): string | undefined {
  if (!eventTimes || ids.length === 0) return undefined;
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const t = eventTimes.get(id);
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = t; }
  }
  return best;
}

/**
 * sourceEventIds 校验：非空 + 每个 id 都必须在 events 里真实存在。
 * 不通过就整条丢弃——"补一个空数组"等于放行一条无证据的 procedure（预设脚本）。
 */
function checkIds(
  ids: readonly string[],
  knownEventIds: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: FactDropReason } {
  if (ids.length === 0) return { ok: false, reason: 'no-source' };
  for (const id of ids) {
    if (!knownEventIds.has(id)) return { ok: false, reason: 'unknown-source' };
  }
  return { ok: true };
}

/**
 * 把 LLM 输出派生为 procedures（纯函数，无 I/O，可单测）。
 *
 * 门禁顺序（先便宜后昂贵，且丢弃原因要能解释）：
 * 1. 字段形状（trigger/action/rationale 非空）→ 'invalid'
 * 2. stripMemoryFact（trigger/action/rationale 任一含祈使句即整条丢弃）→ 'strip'
 * 3. sourceEventIds 存在性 → 'no-source' / 'unknown-source'
 * 4. 合并（同 id 更新，否则新建 candidate）
 */
export function deriveProcedures(input: DeriveProceduresInput): DeriveProceduresResult {
  const stats = emptyProcedureStats({ ran: true });
  const procedures: PersonaProcedure[] = input.existingProcedures.map((p) => ({ ...p }));
  const now = input.now;
  let dirty = false;

  const rawProcedures = Array.isArray(input.raw?.procedures)
    ? (input.raw?.procedures as RawProcedureCandidate[])
    : [];
  for (const cand of rawProcedures) {
    if (!cand || typeof cand !== 'object') {
      drop(stats, 'invalid');
      continue;
    }
    const trigger = typeof cand.trigger === 'string' ? cand.trigger.trim() : '';
    const action = typeof cand.action === 'string' ? cand.action.trim() : '';
    const rationale = typeof cand.rationale === 'string' ? cand.rationale.trim() : '';
    if (!trigger || !action || !rationale) {
      drop(stats, 'invalid');
      continue;
    }
    // 门禁：trigger/action/rationale 任一含祈使句（行为脚本）即整条丢弃
    if (!stripMemoryFact(trigger).ok || !stripMemoryFact(action).ok || !stripMemoryFact(rationale).ok) {
      drop(stats, 'strip');
      continue;
    }
    const ids = normalizeIds(cand.sourceEventIds);
    const idCheck = checkIds(ids, input.knownEventIds);
    if (!idCheck.ok) {
      drop(stats, idCheck.reason);
      continue;
    }

    const id = procedureId(trigger);
    const existing = procedures.find((p) => p.id === id);

    if (!existing) {
      procedures.push({
        id,
        trigger,
        action,
        rationale,
        speaker: 'assistant',
        epistemicType: 'ai_inference',
        status: 'candidate',
        confidence: DEFAULT_PROCEDURE_CONFIDENCE,
        sourceEventIds: [...ids],
        assertedAt: latestEventTime(ids, input.eventTimes),
        ingestedAt: now,
        statusChangedAt: now,
        validFrom: null,
        validTo: null,
        evidenceGroupId: evidenceGroupId(ids),
        firstSeenAt: now,
        updatedAt: now,
      });
      stats.proceduresCreated += 1;
      dirty = true;
      continue;
    }

    // 更新（同 id = 同 trigger）：允许做法细化（action/rationale），合并证据；
    // status 不变（candidate 仍是 candidate，晋升走 decideProcedurePromotion 闸门）。
    existing.action = action;
    existing.rationale = rationale;
    const assertedAt = latestEventTime(ids, input.eventTimes);
    if (assertedAt) existing.assertedAt = assertedAt;
    const added = ids.filter((i) => !existing.sourceEventIds.includes(i));
    if (added.length > 0) {
      existing.sourceEventIds = [...existing.sourceEventIds, ...added];
      existing.evidenceGroupId = evidenceGroupId(existing.sourceEventIds);
    }
    existing.updatedAt = now;
    stats.proceduresUpdated += 1;
    dirty = true;
  }

  return { procedures, stats, dirty };
}
