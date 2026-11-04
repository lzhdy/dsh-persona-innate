/**
 * events 追加日志（按月分片 JSONL）
 *
 * 为什么不再用单个 events.json：
 * - 只追加的层应该用只追加的形态。整文件读-改-写让单条事件（约 640 B）触发全库重写，
 *   一年后写放大约 7000×，而它还是每轮对话的热路径。
 * - 读失败不再等于空库。旧实现 readJson 读不到 → []，下一次写入就把全库覆盖；
 *   分片追加下，读不到某月只是少读一段，追加永远只写当月，不会波及历史。
 * - 损坏被限制在一行/一月。单行 JSON 坏掉只跳这一行，同月其余事件仍可读。
 * - 封存即归档。月份分片天然是压缩/归档/删除的边界。
 */
import type { PersonaEvent } from './types.js';
import type { KVStore } from './store.js';

const MONTH_PATTERN = /^(\d{4})-(\d{2})/;
/** 启动时除 manifest 外，向前探查多少个月的分片（无目录列举能力时的兜底） */
const SCAN_BACK_MONTHS = 24;

/**
 * 事件所属月份分片。时间戳不可解析时退回当前月（宁可写进当月，也不丢事件）。
 */
export function monthKeyOf(iso: string, now: Date = new Date()): string {
  const m = MONTH_PATTERN.exec(String(iso ?? ''));
  if (m) return `${m[1]}-${m[2]}`;
  const t = Date.parse(String(iso ?? ''));
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 7);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export interface EventLogStats {
  /** 已加载的分片月数 */
  months: number;
  /** 已加载的事件条数 */
  total: number;
  /** 被跳过的坏行数（JSON 解析失败/缺 id） */
  skippedLines: number;
  /** 读取失败被跳过的月份（不阻断其它月份） */
  unreadableMonths: string[];
  /** 发生过旧格式迁移时记录来源路径 */
  migratedFrom?: string;
  /** 旧文件与现存分片并存、未自动合并（已留档，需人工确认） */
  legacySkipped?: boolean;
}

export interface EventLogOptions {
  /** 分片目录（相对 store root） */
  dir?: string;
  /** 旧单文件路径，用于一次性迁移 */
  legacyPath?: string;
}

export class EventLog {
  readonly stats: EventLogStats = {
    months: 0,
    total: 0,
    skippedLines: 0,
    unreadableMonths: [],
  };

  private cache: PersonaEvent[] | null = null;
  private loadedMonths: string[] = [];
  private migrationChecked = false;

  private readonly dir: string;
  private readonly legacyPath: string;

  constructor(
    private readonly store: KVStore,
    opts: EventLogOptions = {},
  ) {
    this.dir = opts.dir ?? 'events';
    this.legacyPath = opts.legacyPath ?? 'events.json';
  }

  private pathOf(month: string): string {
    return `${this.dir}/${month}.jsonl`;
  }

  private get manifestPath(): string {
    return `${this.dir}/manifest.json`;
  }

  /* ───────────── 加载 ───────────── */

  async load(): Promise<PersonaEvent[]> {
    if (this.cache) return this.cache;
    await this.ensureMigrated();

    const months = await this.listMonths();
    const events: PersonaEvent[] = [];
    const unreadable: string[] = [];

    for (const month of months) {
      let raw = '';
      try {
        raw = await this.store.readText(this.pathOf(month));
      } catch {
        unreadable.push(month); // 单月不可读不阻断整体
        continue;
      }
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        const text = line.trim();
        if (!text) continue;
        try {
          const parsed = JSON.parse(text) as PersonaEvent;
          if (parsed && typeof parsed.id === 'string') {
            events.push(parsed);
          } else {
            this.stats.skippedLines += 1;
          }
        } catch {
          this.stats.skippedLines += 1;
        }
      }
    }

    events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

    this.loadedMonths = months;
    this.stats.months = months.length;
    this.stats.total = events.length;
    this.stats.unreadableMonths = unreadable;
    this.cache = events;
    return events;
  }

  /** 只读快照（返回副本数组，元素仍为内部引用） */
  async list(): Promise<PersonaEvent[]> {
    return [...(await this.load())];
  }

  /* ───────────── 写入 ───────────── */

  /** 追加一条事件：只写当月分片，O(1)，绝不重写历史月份 */
  async append(event: PersonaEvent): Promise<void> {
    const list = await this.load();
    const month = monthKeyOf(event.time);
    await this.store.appendText(this.pathOf(month), `${JSON.stringify(event)}\n`);
    await this.noteMonth(month);
    list.push(event);
    this.stats.total = list.length;
  }

  /** 批量追加（import-chat）：按月聚合，一次写一片 */
  async appendMany(events: readonly PersonaEvent[]): Promise<void> {
    if (events.length === 0) return;
    const list = await this.load();

    const byMonth = new Map<string, string[]>();
    for (const e of events) {
      const month = monthKeyOf(e.time);
      const lines = byMonth.get(month);
      if (lines) lines.push(JSON.stringify(e));
      else byMonth.set(month, [JSON.stringify(e)]);
    }

    for (const [month, lines] of byMonth) {
      await this.store.appendText(this.pathOf(month), `${lines.join('\n')}\n`);
      await this.noteMonth(month);
    }

    list.push(...events);
    this.stats.total = list.length;
  }

  /**
   * 全量重写（仅供压缩/归档/测试构造使用，不在对话热路径调用）。
   * 会按新集合重算各月内容；不再有事件的月份写成空分片。
   */
  async rewriteAll(events: readonly PersonaEvent[]): Promise<void> {
    await this.load();
    const byMonth = new Map<string, PersonaEvent[]>();
    for (const e of events) {
      const month = monthKeyOf(e.time);
      const bucket = byMonth.get(month);
      if (bucket) bucket.push(e);
      else byMonth.set(month, [e]);
    }

    const targets = new Set<string>([...this.loadedMonths, ...byMonth.keys()]);
    for (const month of targets) {
      const bucket = byMonth.get(month) ?? [];
      const content = bucket.length ? `${bucket.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
      await this.store.writeTextAtomic(this.pathOf(month), content);
    }

    const sorted = [...events].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    this.loadedMonths = [...targets].sort();
    this.cache = sorted;
    this.stats.months = this.loadedMonths.length;
    this.stats.total = sorted.length;
    await this.writeManifest(this.loadedMonths);
  }

  /* ───────────── 分片发现与迁移 ───────────── */

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

  /**
   * 分片清单：有 manifest 就信任它（+ 当月），缺失时才有界探查近 24 个月。
   * 探查是 25 次 stat，启动期每个实例都做一次代价太高；manifest 是正常的快路径。
   */
  /**
   * 是否已存在任何分片文件。
   *
   * 注意不能写成 `(await this.listMonths()).length > 0`：listMonths 在无 manifest 时
   * 总是自动补入当前月，长度恒 ≥ 1，那样判断会让迁移分支永远不执行。
   */
  private async hasAnyShard(): Promise<boolean> {
    const fromManifest = await this.readManifest();
    if (fromManifest && fromManifest.length > 0) return true;

    const now = new Date();
    for (let i = 0; i < SCAN_BACK_MONTHS; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (await this.store.exists(this.pathOf(key))) return true;
    }
    return false;
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

    const set = new Set<string>([current]);
    for (let i = 1; i < SCAN_BACK_MONTHS; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (await this.store.exists(this.pathOf(key))) set.add(key);
    }
    return [...set].sort();
  }

  /**
   * 旧 events.json → 分片的一次性迁移。
   * 幂等：已有任何分片则不迁移；迁移后旧文件留指针，完整旧数据存 events.json.migrated。
   */
  private async ensureMigrated(): Promise<void> {
    if (this.migrationChecked) return;
    this.migrationChecked = true;

    if (!(await this.store.exists(this.legacyPath))) return;

    let legacy: { events?: PersonaEvent[] } | null = null;
    try {
      legacy = await this.store.readJson<{ events?: PersonaEvent[] }>(this.legacyPath);
    } catch {
      return; // 旧文件损坏：不迁移、不删除，交给人工处理
    }
    const events = Array.isArray(legacy?.events) ? legacy.events : [];
    if (events.length === 0) return;

    if (await this.hasAnyShard()) {
      // 已有分片却还留着旧事件：可能是上次迁移中断，或用户手工拷贝过。
      // 不静默 return（那会让人以为迁完了、老数据却还在旧文件里），
      // 而是留档 + 指明原因，让"哪份是活的"这件事有据可查。
      await this.store.writeTextAtomic(`${this.legacyPath}.migrated`, JSON.stringify(legacy, null, 2));
      await this.store.writeTextAtomic(
        this.legacyPath,
        JSON.stringify(
          {
            version: 1,
            events: [],
            migratedAt: new Date().toISOString(),
            note:
              '检测到 events/*.jsonl 已存在，旧数据未自动合并；' +
              '完整旧数据见 events.json.migrated，如需合并请人工处理',
          },
          null,
          2,
        ),
      );
      this.stats.legacySkipped = true;
      return;
    }

    for (const e of events) {
      const month = monthKeyOf(e.time);
      await this.store.appendText(this.pathOf(month), `${JSON.stringify(e)}\n`);
    }
    const months = [...new Set(events.map((e) => monthKeyOf(e.time)))].sort();
    await this.writeManifest(months);

    await this.store.writeTextAtomic(`${this.legacyPath}.migrated`, JSON.stringify(legacy, null, 2));
    await this.store.writeTextAtomic(
      this.legacyPath,
      JSON.stringify(
        {
          version: 1,
          events: [],
          migratedAt: new Date().toISOString(),
          note: '已迁移至 events/*.jsonl（按月分片）；完整旧数据见 events.json.migrated',
        },
        null,
        2,
      ),
    );

    this.loadedMonths = months;
    this.stats.migratedFrom = this.legacyPath;
  }
}

export const MS_PER_DAY = 86_400_000;
