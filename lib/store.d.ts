/**
 * 存储层：JSON 持久化（跨会话）
 * 生产环境适配 DSH ctx.fs（readText/writeText/mkdir/exists），测试注入内存实现。
 *
 * v0.5 存储策略（对齐机制设计文档 §6 记忆引擎与 §16 存储）：
 * - 硬状态（丢了不可恢复）：原子写——先留 .bak，再覆盖；宿主支持 rename 时走 temp+rename
 * - 软状态（可重建/可近似：检索时间戳、索引、注入缓存）：内存维护，不每轮落盘
 * - 追加日志（events）：只追加，不读-改-写；读失败绝不退化为"空库后覆盖"
 */
import type { FsLike } from './types.js';
export interface KVStore {
    readJson<T>(path: string): Promise<T | null>;
    writeJson(path: string, data: unknown): Promise<void>;
    /** 硬状态写：temp+rename，或先备份再覆盖 */
    writeJsonAtomic(path: string, data: unknown): Promise<void>;
    exists(path: string): Promise<boolean>;
    makeId(): string;
    /** 读文本（不存在返回空串；读失败抛出，不静默降级） */
    readText(path: string): Promise<string>;
    /** 追加写（读失败时抛出，绝不用空串覆盖既有内容） */
    appendText(path: string, chunk: string): Promise<void>;
    writeTextAtomic(path: string, content: string): Promise<void>;
}
export declare class JsonStore implements KVStore {
    private readonly fs;
    private readonly root;
    /**
     * 同路径写串行化：app/ready 存在多个监听器并发触发同一文件（self-model.json）的
     * 首次创建，Windows 下第二个 open 会拿到 EPERM。按路径排队，成本可忽略。
     */
    private readonly writeLocks;
    constructor(fs: FsLike, root: string);
    private withPathLock;
    private full;
    private ensureParent;
    exists(path: string): Promise<boolean>;
    readJson<T>(path: string): Promise<T | null>;
    writeJson(path: string, data: unknown): Promise<void>;
    writeJsonAtomic(path: string, data: unknown): Promise<void>;
    readText(path: string): Promise<string>;
    appendText(path: string, chunk: string): Promise<void>;
    writeTextAtomic(path: string, content: string): Promise<void>;
    makeId(): string;
}
//# sourceMappingURL=store.d.ts.map