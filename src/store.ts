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
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

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

export class JsonStore implements KVStore {
  /**
   * 同路径写串行化：app/ready 存在多个监听器并发触发同一文件（self-model.json）的
   * 首次创建，Windows 下第二个 open 会拿到 EPERM。按路径排队，成本可忽略。
   */
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fs: FsLike,
    private readonly root: string,
  ) {}

  private withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.writeLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private full(path: string): string {
    return path.startsWith('/') ? path : `${this.root}/${path}`;
  }

  private async ensureParent(target: string): Promise<void> {
    await this.fs.mkdir(dirname(target), { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    return this.fs.exists(this.full(path));
  }

  async readJson<T>(path: string): Promise<T | null> {
    // DSH 网关的 readText 对不存在文件抛包装错误（无 ENOENT code），先 exists 守卫
    if (!(await this.fs.exists(this.full(path)))) return null;
    let raw: string;
    try {
      raw = await this.fs.readText(this.full(path));
    } catch {
      return null; // 读不到（权限/瞬时）→ 降级为空
    }
    if (!raw) return null;
    return JSON.parse(raw) as T; // JSON 损坏时抛错，不静默吞
  }

  async writeJson(path: string, data: unknown): Promise<void> {
    await this.writeTextAtomic(path, JSON.stringify(data, null, 2));
  }

  async writeJsonAtomic(path: string, data: unknown): Promise<void> {
    await this.writeTextAtomic(path, JSON.stringify(data, null, 2));
  }

  async readText(path: string): Promise<string> {
    const target = this.full(path);
    if (!(await this.fs.exists(target))) return '';
    // 读失败必须抛出：调用方据此判断"不可读"，而不是"空文件"
    return this.fs.readText(target);
  }

  async appendText(path: string, chunk: string): Promise<void> {
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

  async writeTextAtomic(path: string, content: string): Promise<void> {
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
          if (prev) await this.fs.writeText(`${target}.bak`, prev);
        } catch {
          // 读不到上一版时不阻断主写（首次创建/权限受限），继续覆盖
        }
      }
      await this.fs.writeText(target, content);
    });
  }

  makeId(): string {
    return randomUUID().slice(0, 8);
  }
}
