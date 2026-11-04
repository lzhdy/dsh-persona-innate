import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
export class JsonStore {
    fs;
    root;
    /**
     * 同路径写串行化：app/ready 存在多个监听器并发触发同一文件（self-model.json）的
     * 首次创建，Windows 下第二个 open 会拿到 EPERM。按路径排队，成本可忽略。
     */
    writeLocks = new Map();
    constructor(fs, root) {
        this.fs = fs;
        this.root = root;
    }
    withPathLock(key, fn) {
        const prev = this.writeLocks.get(key) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        this.writeLocks.set(key, run.then(() => undefined, () => undefined));
        return run;
    }
    full(path) {
        return path.startsWith('/') ? path : `${this.root}/${path}`;
    }
    async ensureParent(target) {
        await this.fs.mkdir(dirname(target), { recursive: true });
    }
    async exists(path) {
        return this.fs.exists(this.full(path));
    }
    async readJson(path) {
        // DSH 网关的 readText 对不存在文件抛包装错误（无 ENOENT code），先 exists 守卫
        if (!(await this.fs.exists(this.full(path))))
            return null;
        let raw;
        try {
            raw = await this.fs.readText(this.full(path));
        }
        catch {
            return null; // 读不到（权限/瞬时）→ 降级为空
        }
        if (!raw)
            return null;
        return JSON.parse(raw); // JSON 损坏时抛错，不静默吞
    }
    async writeJson(path, data) {
        await this.writeTextAtomic(path, JSON.stringify(data, null, 2));
    }
    async writeJsonAtomic(path, data) {
        await this.writeTextAtomic(path, JSON.stringify(data, null, 2));
    }
    async readText(path) {
        const target = this.full(path);
        if (!(await this.fs.exists(target)))
            return '';
        // 读失败必须抛出：调用方据此判断"不可读"，而不是"空文件"
        return this.fs.readText(target);
    }
    async appendText(path, chunk) {
        const target = this.full(path);
        await this.withPathLock(target, async () => {
            await this.ensureParent(target);
            if (typeof this.fs.appendText === 'function') {
                await this.fs.appendText(target, chunk);
                return;
            }
            // 退化路径：读-拼-写。读失败必须抛出，否则会用空串覆盖既有日志
            const prev = await this.readText(path);
            await this.fs.writeText(target, prev + chunk);
        });
    }
    async writeTextAtomic(path, content) {
        const target = this.full(path);
        await this.withPathLock(target, async () => {
            await this.ensureParent(target);
            if (typeof this.fs.rename === 'function') {
                const tmp = `${target}.tmp`;
                await this.fs.writeText(tmp, content);
                await this.fs.rename(tmp, target);
                return;
            }
            // 无 rename：先留一份上一版，再覆盖。写入被截断时 .bak 仍可人工恢复
            if (await this.fs.exists(target)) {
                try {
                    const prev = await this.fs.readText(target);
                    if (prev)
                        await this.fs.writeText(`${target}.bak`, prev);
                }
                catch {
                    // 读不到上一版时不阻断主写（首次创建/权限受限），继续覆盖
                }
            }
            await this.fs.writeText(target, content);
        });
    }
    makeId() {
        return randomUUID().slice(0, 8);
    }
}
//# sourceMappingURL=store.js.map