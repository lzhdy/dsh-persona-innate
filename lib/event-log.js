const MONTH_PATTERN = /^(\d{4})-(\d{2})/;
/** 启动时除 manifest 外，向前探查多少个月的分片（无目录列举能力时的兜底） */
const SCAN_BACK_MONTHS = 24;
/**
 * 事件所属月份分片。时间戳不可解析时退回当前月（宁可写进当月，也不丢事件）。
 */
export function monthKeyOf(iso, now = new Date()) {
    const m = MONTH_PATTERN.exec(String(iso ?? ''));
    if (m)
        return `${m[1]}-${m[2]}`;
    const t = Date.parse(String(iso ?? ''));
    if (Number.isFinite(t))
        return new Date(t).toISOString().slice(0, 7);
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
export class EventLog {
    store;
    stats = {
        months: 0,
        total: 0,
        skippedLines: 0,
        unreadableMonths: [],
    };
    cache = null;
    loadedMonths = [];
    migrationChecked = false;
    /** 正在进行的首次加载；并发调用共享同一个 promise（见 load 的注释） */
    loading = null;
    dir;
    legacyPath;
    constructor(store, opts = {}) {
        this.store = store;
        this.dir = opts.dir ?? 'events';
        this.legacyPath = opts.legacyPath ?? 'events.json';
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
        // 并发首次加载必须共享同一个 promise。
        // 否则两个 load 各扫一份（此时磁盘上还没有新事件），各自 `this.cache = 自己的数组`；
        // 后赋值的那个会让另一次 append 刚 push 进去的数组变成孤儿——事件在磁盘上、进程内却看不见。
        // append 的写法是 `const list = await this.load(); ...; list.push(event)`，
        // 所以"看不见"会一直持续到进程重启：注入漏掉它，复盘窗口也是空的。
        // （实测：25 次真实装配里有 1 次触发，表现是 /persona review 报"还没有可复盘的记忆事件"。）
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
        await this.ensureMigrated();
        const months = await this.listMonths();
        const events = [];
        const unreadable = [];
        for (const month of months) {
            let raw = '';
            try {
                raw = await this.store.readText(this.pathOf(month));
            }
            catch {
                unreadable.push(month); // 单月不可读不阻断整体
                continue;
            }
            if (!raw)
                continue;
            for (const line of raw.split('\n')) {
                const text = line.trim();
                if (!text)
                    continue;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed.id === 'string') {
                        events.push(parsed);
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
        events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
        this.loadedMonths = months;
        this.stats.months = months.length;
        this.stats.total = events.length;
        this.stats.unreadableMonths = unreadable;
        this.cache = events;
        return events;
    }
    /** 只读快照（返回副本数组，元素仍为内部引用） */
    async list() {
        return [...(await this.load())];
    }
    /* ───────────── 写入 ───────────── */
    /** 追加一条事件：只写当月分片，O(1)，绝不重写历史月份 */
    async append(event) {
        const list = await this.load();
        const month = monthKeyOf(event.time);
        await this.store.appendText(this.pathOf(month), `${JSON.stringify(event)}\n`);
        await this.noteMonth(month);
        // push 到"当前 cache"而不是 load 返回的那个引用：写入期间（appendText/noteMonth 都是 await）
        // cache 有可能被换过，push 到已作废的数组等于这条事件在进程内不存在。
        const target = this.cache ?? list;
        target.push(event);
        this.stats.total = target.length;
    }
    /** 批量追加（import-chat）：按月聚合，一次写一片 */
    async appendMany(events) {
        if (events.length === 0)
            return;
        const list = await this.load();
        const byMonth = new Map();
        for (const e of events) {
            const month = monthKeyOf(e.time);
            const lines = byMonth.get(month);
            if (lines)
                lines.push(JSON.stringify(e));
            else
                byMonth.set(month, [JSON.stringify(e)]);
        }
        for (const [month, lines] of byMonth) {
            await this.store.appendText(this.pathOf(month), `${lines.join('\n')}\n`);
            await this.noteMonth(month);
        }
        const target = this.cache ?? list;
        target.push(...events);
        this.stats.total = target.length;
    }
    /**
     * 全量重写（仅供压缩/归档/测试构造使用，不在对话热路径调用）。
     * 会按新集合重算各月内容；不再有事件的月份写成空分片。
     */
    async rewriteAll(events) {
        await this.load();
        const byMonth = new Map();
        for (const e of events) {
            const month = monthKeyOf(e.time);
            const bucket = byMonth.get(month);
            if (bucket)
                bucket.push(e);
            else
                byMonth.set(month, [e]);
        }
        const targets = new Set([...this.loadedMonths, ...byMonth.keys()]);
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
    async hasAnyShard() {
        const fromManifest = await this.readManifest();
        if (fromManifest && fromManifest.length > 0)
            return true;
        const now = new Date();
        for (let i = 0; i < SCAN_BACK_MONTHS; i += 1) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (await this.store.exists(this.pathOf(key)))
                return true;
        }
        return false;
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
        const set = new Set([current]);
        for (let i = 1; i < SCAN_BACK_MONTHS; i += 1) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (await this.store.exists(this.pathOf(key)))
                set.add(key);
        }
        return [...set].sort();
    }
    /**
     * 旧 events.json → 分片的一次性迁移。
     * 幂等：已有任何分片则不迁移；迁移后旧文件留指针，完整旧数据存 events.json.migrated。
     */
    async ensureMigrated() {
        if (this.migrationChecked)
            return;
        this.migrationChecked = true;
        if (!(await this.store.exists(this.legacyPath)))
            return;
        let legacy = null;
        try {
            legacy = await this.store.readJson(this.legacyPath);
        }
        catch {
            return; // 旧文件损坏：不迁移、不删除，交给人工处理
        }
        const events = Array.isArray(legacy?.events) ? legacy.events : [];
        if (events.length === 0)
            return;
        if (await this.hasAnyShard()) {
            // 已有分片却还留着旧事件：可能是上次迁移中断，或用户手工拷贝过。
            // 不静默 return（那会让人以为迁完了、老数据却还在旧文件里），
            // 而是留档 + 指明原因，让"哪份是活的"这件事有据可查。
            await this.store.writeTextAtomic(`${this.legacyPath}.migrated`, JSON.stringify(legacy, null, 2));
            await this.store.writeTextAtomic(this.legacyPath, JSON.stringify({
                version: 1,
                events: [],
                migratedAt: new Date().toISOString(),
                note: '检测到 events/*.jsonl 已存在，旧数据未自动合并；' +
                    '完整旧数据见 events.json.migrated，如需合并请人工处理',
            }, null, 2));
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
        await this.store.writeTextAtomic(this.legacyPath, JSON.stringify({
            version: 1,
            events: [],
            migratedAt: new Date().toISOString(),
            note: '已迁移至 events/*.jsonl（按月分片）；完整旧数据见 events.json.migrated',
        }, null, 2));
        this.loadedMonths = months;
        this.stats.migratedFrom = this.legacyPath;
    }
}
export const MS_PER_DAY = 86_400_000;
//# sourceMappingURL=event-log.js.map