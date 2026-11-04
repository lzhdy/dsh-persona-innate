/**
 * 复盘游标（v0.7）：把复盘窗口从"日期切片"改成"上次复盘时刻 → 现在"
 *
 * 旧实现的问题（index.ts 里 `new Date().toISOString().slice(0,10)` + 日期等值过滤）：
 * 1. toISOString 是 UTC。本地 02:00 执行时切片是"UTC 的前一天"，窗口实际覆盖
 *    本地前一天 08:00 → 当天 07:59；本地 00:00–08:00 发生的事件永远不被任何一次复盘看到
 *    —— 正好是深夜陪伴高峰。
 * 2. 没有游标：02:00 进程不在（DSH web 常关）就永久丢一天，靠"日期"补不回来。
 * 3. 没有幂等：手动 /persona review 与定时任务可对同一天重复提交，产生两个 self_model 版本。
 *
 * 改成时刻区间后，时区问题自动消失：窗口是 [上次复盘时刻, 现在)，与日历日无关，
 * 凌晨三点的事件会被 02:00 那次之后的任意一次复盘覆盖到。
 *
 * 本模块把"窗口怎么算 / 什么时候推进游标"做成纯函数 + 一个执行协议，
 * 因为 index.ts 的 runDailyReview 是 cordis 闭包，无法单测；接线的判据放这里才能验。
 */
import type { PersonaEvent, ReviewOutput } from './types.js';
import type { KVStore } from './store.js';

/** 游标文件（store root 下；硬状态，用原子写） */
export const REVIEW_CURSOR_PATH = 'review-state.json';

/**
 * 启动补跑的最小间隔（24h）。
 * 定时器每天一次；距上次复盘不足 24h 说明那次已经跑过（或用不着补），
 * 每次启动都补会白白多花一次 LLM 调用与一个 self_model 版本——DSH 一天可能启动十几次。TODO(calibrate)
 */
export const CATCH_UP_MIN_GAP_MS = 24 * 60 * 60 * 1000;

export interface ReviewCursor {
  version: 1;
  /** 上次复盘开始的时刻（ISO） */
  lastReviewAt: string;
  /** 上次复盘覆盖到的本地日期（仅展示/审计用，不参与窗口计算） */
  lastReviewDate?: string;
}

export type CursorLoadResult =
  | { ok: true; cursor: ReviewCursor | null }
  | { ok: false; reason: string };

/**
 * 游标存储。
 * 读失败必须显式返回错误而不是 null：把"读不到"当成"没有游标"会让窗口退回当日零点，
 * 于是同一天被反复复盘（重复版本），或者游标被覆盖成空值。
 */
export class ReviewCursorStore {
  constructor(
    private readonly store: KVStore,
    private readonly path: string = REVIEW_CURSOR_PATH,
  ) {}

  async load(): Promise<CursorLoadResult> {
    let raw: string;
    try {
      raw = await this.store.readText(this.path);
    } catch (err) {
      return { ok: false, reason: `${this.path} 读取失败：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!raw.trim()) return { ok: true, cursor: null }; // 首次运行：没有游标
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `${this.path} JSON 损坏（不按"无游标"处理，避免重复复盘）` };
    }
    const c = parsed as Partial<ReviewCursor> | null;
    if (!c || typeof c.lastReviewAt !== 'string' || !c.lastReviewAt) {
      return { ok: false, reason: `${this.path} 缺少 lastReviewAt` };
    }
    return {
      ok: true,
      cursor: {
        version: 1,
        lastReviewAt: c.lastReviewAt,
        ...(typeof c.lastReviewDate === 'string' ? { lastReviewDate: c.lastReviewDate } : {}),
      },
    };
  }

  async save(cursor: ReviewCursor): Promise<void> {
    await this.store.writeTextAtomic(this.path, JSON.stringify(cursor, null, 2));
  }
}

/** 本地零点（毫秒）。刻意不用 toISOString 切片：UTC 切片的"今天"在本地 00:00–08:00 是前一天 */
export function localDayStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 本地日期串 YYYY-MM-DD（只作标签/审计，不参与窗口计算） */
export function localDateString(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 复盘窗口：游标时刻（开区间）→ 现在。
 * 无游标（首次启用本机制）时退化为"本地当日 00:00 起"：
 * 没有游标就没有可靠的区间起点，用当日零点是最保守的近似（宁可漏掉升级前的历史，
 * 也不要把一年前的旧事件当成"今天发生的事"再复盘一遍）。
 * 时间戳不可解析的事件直接排除（无法确定它属于哪段窗口）。
 */
export function selectReviewWindow(
  events: readonly PersonaEvent[],
  cursorAt: string | null,
  now: Date,
): PersonaEvent[] {
  const parsedCursor = cursorAt ? Date.parse(cursorAt) : Number.NaN;
  const from = Number.isFinite(parsedCursor) ? parsedCursor : localDayStart(now);
  return events.filter((e) => {
    const t = Date.parse(e.time);
    return Number.isFinite(t) && t > from;
  });
}

/** 启动时是否该补跑：无游标（首次/升级后）或距上次复盘 ≥ 24h */
export function shouldCatchUpReview(
  cursorAt: string | null,
  now: Date,
  minGapMs: number = CATCH_UP_MIN_GAP_MS,
): boolean {
  if (!cursorAt) return true;
  const t = Date.parse(cursorAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= minGapMs;
}

export type ReviewWindowOutcome =
  /** 成功复盘并推进游标 */
  | { kind: 'done'; out: ReviewOutput; window: PersonaEvent[]; startedAt: string; cursorWarning?: string }
  /** 没有可复盘的事件（窗口为空 / 游标不可读）——不推进游标 */
  | { kind: 'skipped'; reason: string; startedAt: string }
  /** 复盘执行了但没有产出（门禁拦截或异常）——不推进游标 */
  | { kind: 'failed'; reason: string; startedAt: string };

/**
 * 复盘执行协议（游标推进的唯一合法路径）。
 *
 * 三条规矩，每条都对应一个具体故障：
 * 1. 窗口为空 → 不推进。否则会把"没有新事件"记成"已复盘到此刻"，把之后的事件吞掉。
 * 2. 复盘没产出（门禁/异常）→ 不推进。否则那天永远不会再复盘（游标跳过了它）。
 * 3. 成功 → 推进到"本次开始时刻"，不是结束时刻：复盘期间新写入的事件必须落在下一次窗口里。
 */
export async function runReviewWithCursor(opts: {
  store: KVStore;
  allEvents: readonly PersonaEvent[];
  /** 实际复盘动作（返回 null 表示门禁拦截/未提交） */
  review: (input: {
    date: string;
    events: PersonaEvent[];
    startedAt: string;
    from: string | null;
  }) => Promise<ReviewOutput | null>;
  /** 注入时钟（测试用） */
  now?: Date;
  /** 注入游标存储（测试可换成读失败实现） */
  cursorStore?: ReviewCursorStore;
}): Promise<ReviewWindowOutcome> {
  const startedAt = opts.now ?? new Date();
  const startedIso = startedAt.toISOString();
  const cursorStore = opts.cursorStore ?? new ReviewCursorStore(opts.store);

  const loaded = await cursorStore.load();
  if (!loaded.ok) {
    // 读不到游标就不复盘：要么重复提交同一天（多一个版本），要么把游标覆盖掉
    return { kind: 'skipped', reason: `复盘游标不可读，本次不执行：${loaded.reason}`, startedAt: startedIso };
  }

  const from = loaded.cursor?.lastReviewAt ?? null;
  const window = selectReviewWindow(opts.allEvents, from, startedAt);
  if (window.length === 0) {
    return {
      kind: 'skipped',
      reason: from
        ? `上次复盘（${from}）之后没有新事件，跳过`
        : '还没有可复盘的记忆事件，跳过',
      startedAt: startedIso,
    };
  }

  const date = localDateString(startedAt);
  let out: ReviewOutput | null;
  try {
    out = await opts.review({ date, events: window, startedAt: startedIso, from });
  } catch (err) {
    return {
      kind: 'failed',
      reason: `复盘执行异常：${err instanceof Error ? err.message : String(err)}`,
      startedAt: startedIso,
    };
  }
  if (!out) {
    return { kind: 'failed', reason: '复盘未产出结果（门禁拦截或异常），游标不推进', startedAt: startedIso };
  }

  let cursorWarning: string | undefined;
  try {
    await cursorStore.save({ version: 1, lastReviewAt: startedIso, lastReviewDate: date });
  } catch (err) {
    // 游标写失败不改判"复盘成功"这个事实（内容已经提交了），但必须留痕：
    // 下一次会重复覆盖同一段窗口，值得在日志里看见。
    cursorWarning = `游标写入失败：${err instanceof Error ? err.message : String(err)}`;
  }

  return { kind: 'done', out, window, startedAt: startedIso, ...(cursorWarning ? { cursorWarning } : {}) };
}
