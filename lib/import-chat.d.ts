import type { PersonaEvent } from './types.js';
export type ImportErrorCode = 'ERR_NODE_VERSION' | 'ERR_FILE_NOT_FOUND' | 'ERR_READ_FAILED' | 'ERR_NOT_ZSTD' | 'ERR_FRAME_DECOMPRESS' | 'ERR_JSON_PARSE';
export declare class ImportError extends Error {
    code: ImportErrorCode;
    line?: number;
    constructor(code: ImportErrorCode, message: string, line?: number);
}
/** 运行时 zstd 支持检测：node:zlib zstd API 需 Node ≥22 */
export declare function zstdSupported(): boolean;
/** 统计 zstd 帧数（magic 头出现次数） */
export declare function countZstdFrames(buf: Buffer): number;
/** 定位帧边界并逐帧解压，返回拼接后的 JSONL 文本 */
export declare function decompressZstdFrames(buf: Buffer): string;
/** 逐行解析 JSONL；某行损坏 → 抛 ERR_JSON_PARSE（含行号） */
export declare function parseSessionLines(text: string): Record<string, unknown>[];
interface SessionMsg {
    type?: unknown;
    time?: unknown;
    data?: Record<string, unknown>;
}
/** 真实用户消息：type=user/message 且 source.kind='user'（过滤 runtime/time-context 注入） */
export declare function userMessageText(m: SessionMsg): string | null;
/**
 * assistant 消息文本：从 content 数组【从后往前】取第一条 type==='text'，
 * 跳过 reasoning / tool_call / thinking 等非表达块（不盲取最后一条，
 * 未来格式加入尾部工具调用也不会把工具调用当成 AI 的表达）。
 */
export declare function assistantMessageText(m: SessionMsg): string | null;
export interface ImportStats {
    /** 真实 user 消息条数 */
    userMessages: number;
    /** assistant 消息条数 */
    assistantMessages: number;
    /** 过滤掉的注入/系统噪音条数 */
    injectedSkipped: number;
    /** 无可提取信号条数 */
    noSignalSkipped: number;
    /** 提取事件条数 */
    extracted: number;
}
/** 消息级 id → 去重主键；无 id 时退化 时间戳+类型+文本前缀 */
export declare function sourceKeyFor(m: SessionMsg, type: 'user' | 'assistant', text: string): string | undefined;
/**
 * 从会话消息序列提取事件（M3 口径，与实时通道一致）。
 * 诱导上下文：按消息顺序累积真实用户消息，assistant 提取时取最近 INDUCE_WINDOW 条
 * （与实时通道 recentUserMessages 语义一致）。
 */
export declare function extractImportedEvents(msgs: SessionMsg[]): {
    events: PersonaEvent[];
    stats: ImportStats;
};
/** 完整导入流程：读文件 → 解压 → 解析 → 提取 → 批量事务写入 */
export declare function runImportChat(memory: {
    importEvents(events: PersonaEvent[]): Promise<{
        added: number;
        skipped: number;
    }>;
}, path: string): Promise<{
    frames: number;
    added: number;
    skipped: number;
    stats: ImportStats;
}>;
export {};
//# sourceMappingURL=import-chat.d.ts.map