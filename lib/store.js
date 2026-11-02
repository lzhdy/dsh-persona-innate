import { randomUUID } from 'node:crypto';
export class JsonStore {
    fs;
    root;
    constructor(fs, root) {
        this.fs = fs;
        this.root = root;
    }
    full(path) {
        return path.startsWith('/') ? path : `${this.root}/${path}`;
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
        await this.fs.mkdir(this.root, { recursive: true });
        await this.fs.writeText(this.full(path), JSON.stringify(data, null, 2));
    }
    makeId() {
        return randomUUID().slice(0, 8);
    }
}
//# sourceMappingURL=store.js.map