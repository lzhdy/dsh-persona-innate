const MONTH_PATTERN = /^(\d{4})-(\d{2})/;
/** 话语所属月份分片。时间戳不可解析时退回当前月（宁可写进当月，也不丢话轮）。 */
function monthKeyOf(iso, now = new Date()) {
    const m = MONTH_PATTERN.exec(String(iso ?? ''));
    if (m)
        return `${m[1]}-${m[2]}`;
    const t = Date.parse(String(iso ?? ''));
    if (Number.isFinite(t))
        return new Date(t).toISOString().slice(0, 7);
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
export class RawTurnLog {
    store;
    stats = { months: 0, total: 0, skippedLines: 0 };
    cache = null;
    loadedMonths = [];
    /** 正在进行的首次加载；并发调用共享同一个 promise（与 EventLog 同理由） */
    loading = null;
    dir;
    constructor(store, opts = {}) {
        this.store = store;
        this.dir = opts.dir ?? 'raw-turns';
    }
    pathOf(month) {
        return `${this.dir}/${month}.jsonl`;
    }
    get manifestPath() {
        return `${this.dir}/manifest.json`;
    }
    /* ───────────── 加载 ───────────── */
    async load() {
        if (this.cache)
            return this.cache;
        if (!this.loading) {
            this.loading = this.doLoad().finally(() => {
                this.loading = null;
            });
        }
        return this.loading;
    }
    async doLoad() {
        if (this.cache)
            return this.cache;
        const months = await this.listMonths();
        const turns = [];
        for (const month of months) {
            let raw = '';
            try {
                raw = await this.store.readText(this.pathOf(month));
            }
            catch {
                continue; // 单月不可读不阻断整体
            }
            if (!raw)
                continue;
            for (const line of raw.split('\n')) {
                const text = line.trim();
                if (!text)
                    continue;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed.event_id === 'string') {
                        turns.push(parsed);
                    }
                    else {
                        this.stats.skippedLines += 1;
                    }
                }
                catch {
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
    async list() {
        return [...(await this.load())];
    }
    /* ───────────── 写入 ───────────── */
    /** 追加一条话轮：只写当月分片，绝不重写历史月份 */
    async append(turn) {
        const list = await this.load();
        const month = monthKeyOf(turn.asserted_at);
        await this.store.appendText(this.pathOf(month), `${JSON.stringify(turn)}\n`);
        await this.noteMonth(month);
        const target = this.cache ?? list;
        target.push(turn);
        this.stats.total = target.length;
    }
    /* ───────────── 分片发现 ───────────── */
    async readManifest() {
        try {
            const file = await this.store.readJson(this.manifestPath);
            if (!file)
                return null;
            const months = file.months;
            return Array.isArray(months) ? months.filter((m) => typeof m === 'string') : null;
        }
        catch {
            return null;
        }
    }
    async writeManifest(months) {
        await this.store.writeJsonAtomic(this.manifestPath, { version: 1, months: [...months].sort() });
    }
    async noteMonth(month) {
        if (this.loadedMonths.includes(month))
            return;
        this.loadedMonths = [...this.loadedMonths, month].sort();
        this.stats.months = this.loadedMonths.length;
        await this.writeManifest(this.loadedMonths);
    }
    async listMonths() {
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
//# sourceMappingURL=raw-turn-log.js.map