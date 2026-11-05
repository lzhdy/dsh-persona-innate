/**
 * P1 raw_turns 原始层 · 追加日志（按月分片 JSONL）
 *
 * 复用 EventLog（src/event-log.ts）的按月分片 JSONL 追加**模式**，但独立成类：
 * - 零改动现有 EventLog（红线：不重构 event-log.ts）；
 * - raw_turns 是纯新增文件，删除 `raw-turns/` 目录即物理回滚；
 * - 未来可能需要不同的字段与谱系删除逻辑，独立类便于演进。
 *
 * 分片目录：`raw-turns/`（store root 下），文件名 `YYYY-MM.jsonl`，`manifest.json` 记录月份。
 * 写路径：`store.appendText()` 追加（O_APPEND 语义，与 EventLog 一致）。
 */
import type { RawTurn } from './types.js';
import type { KVStore } from './store.js';

const MONTH_PATTERN = /^(\d{4})-(\d{2})/;

/** 话语所属月份分片。时间戳不可解析时退回当前月（宁可写进当月，也不丢话轮）。 */
function monthKeyOf(iso: string, now: Date = new Date()): string {
  const m = MONTH_PATTERN.exec(String(iso ?? ''));
  if (m) return `${m[1]}-${m[2]}`;
  const t = Date.parse(String(iso ?? ''));
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 7);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export interface RawTurnLogOptions {
  /** 分片目录（相对 store root），默认 'raw-turns' */
  dir?: string;
}

export interface RawTurnLogStats {
  months: number;
  total: number;
  /** 被跳过的坏行数（JSON 解析失败 / 缺 event_id） */
  skippedLines: number;
}

export class RawTurnLog {
  readonly stats: RawTurnLogStats = { months: 0, total: 0, skippedLines: 0 };

  private cache: RawTurn[] | null = null;
  private loadedMonths: string[] = [];
  /** 正在进行的首次加载；并发调用共享同一个 promise（与 EventLog 同理由） */
  private loading: Promise<RawTurn[]> | null = null;

  private readonly dir: string;

  constructor(
    private readonly store: KVStore,
    opts: RawTurnLogOptions = {},
  ) {
    this.dir = opts.dir ?? 'raw-turns';
  }

  private pathOf(month: string): string {
    return `${this.dir}/${month}.jsonl`;
  }

  private get manifestPath(): string {
    return `${this.dir}/manifest.json`;
  }

  /* ───────────── 加载 ───────────── */

  async load(): Promise<RawTurn[]> {
    if (this.cache) return this.cache;
    if (!this.loading) {
      this.loading = this.doLoad().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async doLoad(): Promise<RawTurn[]> {
    if (this.cache) return this.cache;
    const months = await this.listMonths();
    const turns: RawTurn[] = [];

    for (const month of months) {
      let raw = '';
      try {
        raw = await this.store.readText(this.pathOf(month));
      } catch {
        continue; // 单月不可读不阻断整体
      }
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        const text = line.trim();
        if (!text) continue;
        try {
          const parsed = JSON.parse(text) as RawTurn;
          if (parsed && typeof parsed.event_id === 'string') {
            turns.push(parsed);
          } else {
            this.stats.skippedLines += 1;
          }
        } catch {
          this.stats.skippedLines += 1;
        }
      }
    }

    this.loadedMonths = months;
    this.stats.months = months.length;
    this.stats.total = turns.length;
    this.cache = turns;
    return turns;
  }

  /** 只读快照（返回副本数组）——供测试/审计读；P1 生产热路径不调用 */
  async list(): Promise<RawTurn[]> {
    return [...(await this.load())];
  }

  /* ───────────── 写入 ───────────── */

  /** 追加一条话轮：只写当月分片，绝不重写历史月份 */
  async append(turn: RawTurn): Promise<void> {
    const list = await this.load();
    const month = monthKeyOf(turn.asserted_at);
    await this.store.appendText(this.pathOf(month), `${JSON.stringify(turn)}\n`);
    await this.noteMonth(month);
    const target = this.cache ?? list;
    target.push(turn);
    this.stats.total = target.length;
  }

  /* ───────────── 分片发现 ───────────── */

  private async readManifest(): Promise<string[] | null> {
    try {
      const file = await this.store.readJson<{ months?: string[] }>(this.manifestPath);
      if (!file) return null;
      const months = file.months;
      return Array.isArray(months) ? months.filter((m): m is string => typeof m === 'string') : null;
    } catch {
      return null;
    }
  }

  private async writeManifest(months: readonly string[]): Promise<void> {
    await this.store.writeJsonAtomic(this.manifestPath, { version: 1, months: [...months].sort() });
  }

  private async noteMonth(month: string): Promise<void> {
    if (this.loadedMonths.includes(month)) return;
    this.loadedMonths = [...this.loadedMonths, month].sort();
    this.stats.months = this.loadedMonths.length;
    await this.writeManifest(this.loadedMonths);
  }

  private async listMonths(): Promise<string[]> {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const fromManifest = await this.readManifest();
    if (fromManifest) {
      const set = new Set(fromManifest);
      set.add(current);
      return [...set].sort();
    }

    // 无 manifest（新库/损坏）：只补当前月。raw_turns 没有历史迁移负担，
    // 也不做有界回溯探查（避免每个实例启动都做多次 stat）。
    return [current];
  }
}
