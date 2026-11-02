/**
 * 存储层：JSON 持久化（跨会话）
 * 生产环境适配 DSH ctx.fs（readText/writeText/mkdir/exists），测试注入内存实现。
 */
import type { FsLike } from './types.js';
export interface KVStore {
    readJson<T>(path: string): Promise<T | null>;
    writeJson(path: string, data: unknown): Promise<void>;
    exists(path: string): Promise<boolean>;
    makeId(): string;
}
export declare class JsonStore implements KVStore {
    private readonly fs;
    private readonly root;
    constructor(fs: FsLike, root: string);
    private full;
    exists(path: string): Promise<boolean>;
    readJson<T>(path: string): Promise<T | null>;
    writeJson(path: string, data: unknown): Promise<void>;
    makeId(): string;
}
//# sourceMappingURL=store.d.ts.map