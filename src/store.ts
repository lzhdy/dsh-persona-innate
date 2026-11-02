/**
 * 存储层：JSON 持久化（跨会话）
 * 生产环境适配 DSH ctx.fs（readText/writeText/mkdir/exists），测试注入内存实现。
 */
import type { FsLike } from './types.js';
import { randomUUID } from 'node:crypto';

export interface KVStore {
  readJson<T>(path: string): Promise<T | null>;
  writeJson(path: string, data: unknown): Promise<void>;
  exists(path: string): Promise<boolean>;
  makeId(): string;
}

export class JsonStore implements KVStore {
  constructor(
    private readonly fs: FsLike,
    private readonly root: string,
  ) {}

  private full(path: string): string {
    return path.startsWith('/') ? path : `${this.root}/${path}`;
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
    await this.fs.mkdir(this.root, { recursive: true });
    await this.fs.writeText(this.full(path), JSON.stringify(data, null, 2));
  }

  makeId(): string {
    return randomUUID().slice(0, 8);
  }
}
