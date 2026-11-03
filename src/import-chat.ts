/**
 * import-chat：DSH 历史会话导入（M3 后半）
 * - zstd 逐帧解压：magic 头 \x28\xB5\x2F\xFD 定位帧边界 + 逐帧 zstdDecompressSync
 *   （zstdDecompressSync/createZstdDecompress 单次只解第一帧，必须逐帧）
 * - v4 会话 JSONL 解析：只取 user/message(source.kind='user') 与 assistant/message；
 *   过滤 runtime-context / time-context / 系统注入噪音
 * - 提取口径与实时通道完全一致：user → extractCandidate（user_direct），
 *   assistant → extractSelfExpression（self_direct/induced/self_correction），
 *   诱导上下文 = 会话内最近 INDUCE_WINDOW 条用户消息（轮次语义）；
 *   assistant 内容从后往前取第一条 type==='text'（跳过 reasoning/tool_call）
 * - 补记忆不补成长：所有导入事件带 imported=true（不参与复盘模式计数/强化过滤），
 *   保留原始时间戳（跨天导入不触发阶段跳变）
 * - 去重主键：优先会话消息 id（user: data.id / assistant: data.message.id），
 *   退化用 时间戳+类型+文本前缀哈希
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { extractCandidate, extractSelfExpression, sessionInduceRisk, INDUCE_WINDOW } from './extract.js';
import type { PersonaEvent, Provenance } from './types.js';

/** zstd 帧 magic：\x28\xB5\x2F\xFD */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* ════════════ 错误分级（命令层按 code 给不同解决建议） ════════════ */

export type ImportErrorCode =
  | 'ERR_NODE_VERSION'
  | 'ERR_FILE_NOT_FOUND'
  | 'ERR_READ_FAILED'
  | 'ERR_NOT_ZSTD'
  | 'ERR_FRAME_DECOMPRESS'
  | 'ERR_JSON_PARSE';

export class ImportError extends Error {
  code: ImportErrorCode;
  line?: number;

  constructor(code: ImportErrorCode, message: string, line?: number) {
    super(message);
    this.code = code;
    this.line = line;
  }
}

/** 运行时 zstd 支持检测：node:zlib zstd API 需 Node ≥22 */
export function zstdSupported(): boolean {
  try {
    return typeof zstdDecompressSync === 'function';
  } catch {
    return false;
  }
}

/* ════════════ 解压与解析 ════════════ */

/** 统计 zstd 帧数（magic 头出现次数） */
export function countZstdFrames(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      n += 1;
    }
  }
  return n;
}

/** 定位帧边界并逐帧解压，返回拼接后的 JSONL 文本 */
export function decompressZstdFrames(buf: Buffer): string {
  const starts: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i);
    }
  }
  if (starts.length === 0) {
    throw new ImportError('ERR_NOT_ZSTD', '未找到 zstd 帧 magic 头——文件不是 zstd 压缩或不是 DSH 会话格式。');
  }
  let out = '';
  for (let f = 0; f < starts.length; f++) {
    const s = starts[f];
    const e = f + 1 < starts.length ? starts[f + 1] : buf.length;
    try {
      out += zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    } catch (err) {
      throw new ImportError(
        'ERR_FRAME_DECOMPRESS',
        `第 ${f + 1}/${starts.length} 帧解压失败（文件可能损坏或被截断）：${(err as Error).message}`,
      );
    }
  }
  return out;
}

/** 逐行解析 JSONL；某行损坏 → 抛 ERR_JSON_PARSE（含行号） */
export function parseSessionLines(text: string): Record<string, unknown>[] {
  const msgs: Record<string, unknown>[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    try {
      msgs.push(JSON.parse(ln) as Record<string, unknown>);
    } catch {
      throw new ImportError('ERR_JSON_PARSE', `第 ${i + 1} 行 JSON 解析失败——会话格式可能已升级（当前支持 v4）。`, i + 1);
    }
  }
  return msgs;
}

/* ════════════ 消息过滤与文本提取 ════════════ */

interface SessionMsg {
  type?: unknown;
  time?: unknown;
  data?: Record<string, unknown>;
}

/** 真实用户消息：type=user/message 且 source.kind='user'（过滤 runtime/time-context 注入） */
export function userMessageText(m: SessionMsg): string | null {
  if (m.type !== 'user/message') return null;
  const src = m.data?.source as { kind?: string } | undefined;
  if (src?.kind !== 'user') return null;
  const c = m.data?.content as { text?: string }[] | undefined;
  if (!Array.isArray(c)) return null;
  const text = c.map((x) => x?.text ?? '').join('').trim();
  return text || null;
}

/**
 * assistant 消息文本：从 content 数组【从后往前】取第一条 type==='text'，
 * 跳过 reasoning / tool_call / thinking 等非表达块（不盲取最后一条，
 * 未来格式加入尾部工具调用也不会把工具调用当成 AI 的表达）。
 */
export function assistantMessageText(m: SessionMsg): string | null {
  if (m.type !== 'assistant/message') return null;
  const message = m.data?.message as { content?: { type?: string; text?: string }[] } | undefined;
  const c = message?.content;
  if (!Array.isArray(c)) return null;
  for (let i = c.length - 1; i >= 0; i--) {
    const block = c[i];
    if (!block) continue;
    const type = block.type;
    const text = block.text;
    if (typeof text === 'string' && text.trim() && (type === 'text' || type === undefined)) {
      return text.trim();
    }
  }
  return null;
}

/* ════════════ 事件提取 ════════════ */

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
export function sourceKeyFor(
  m: SessionMsg,
  type: 'user' | 'assistant',
  text: string,
): string | undefined {
  if (type === 'user') {
    const id = (m.data as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && id) return `u:${id}`;
  } else {
    const message = m.data?.message as { id?: unknown } | undefined;
    const id = message?.id;
    if (typeof id === 'string' && id) return `a:${id}`;
  }
  const t = typeof m.time === 'number' ? m.time : 0;
  return `${t}:${type}:${text.slice(0, 24)}`;
}

let idCounter = 0;
function makeEventId(): string {
  idCounter += 1;
  return `imp-${Date.now().toString(36)}-${idCounter}`;
}

function isoOf(m: SessionMsg): string {
  if (typeof m.time === 'number' && m.time > 0) return new Date(m.time).toISOString();
  return new Date().toISOString();
}

/**
 * 从会话消息序列提取事件（M3 口径，与实时通道一致）。
 * 诱导上下文：按消息顺序累积真实用户消息，assistant 提取时取最近 INDUCE_WINDOW 条
 * （与实时通道 recentUserMessages 语义一致）。
 */
export function extractImportedEvents(msgs: SessionMsg[]): { events: PersonaEvent[]; stats: ImportStats } {
  const events: PersonaEvent[] = [];
  const stats: ImportStats = {
    userMessages: 0,
    assistantMessages: 0,
    injectedSkipped: 0,
    noSignalSkipped: 0,
    extracted: 0,
  };
  const userTexts: string[] = [];

  for (const m of msgs) {
    const ut = userMessageText(m);
    if (ut) {
      userTexts.push(ut);
      stats.userMessages += 1;
      const cand = extractCandidate(ut);
      if (!cand) {
        stats.noSignalSkipped += 1;
        continue;
      }
      const event: PersonaEvent = {
        id: makeEventId(),
        time: isoOf(m),
        topic: cand.topic,
        summary: cand.summary,
        emotionTags: cand.emotionTags,
        importance: cand.importance,
        provenance: 'user_direct',
        lastRetrieved: null,
        imported: true,
        sourceKey: sourceKeyFor(m, 'user', ut),
      };
      events.push(event);
      continue;
    }
    const at = assistantMessageText(m);
    if (at) {
      stats.assistantMessages += 1;
      // 诱导上下文：会话内最近 INDUCE_WINDOW 条用户消息（轮次语义）
      const window = userTexts.slice(-INDUCE_WINDOW);
      const cand = extractSelfExpression(at, window);
      if (!cand) {
        stats.noSignalSkipped += 1;
        continue;
      }
      const inductionRisk: PersonaEvent['inductionRisk'] =
        cand.provenance === 'self_direct' ? sessionInduceRisk(userTexts.slice(-8)) : undefined;
      const event: PersonaEvent = {
        id: makeEventId(),
        time: isoOf(m),
        topic: cand.pattern,
        summary: cand.summary,
        emotionTags: cand.emotionTags,
        importance: cand.importance,
        provenance: cand.provenance as Provenance,
        lastRetrieved: null,
        strength: cand.strength,
        selfPattern: cand.pattern,
        inductionRisk,
        imported: true,
        sourceKey: sourceKeyFor(m, 'assistant', at),
      };
      events.push(event);
      continue;
    }
    // 系统噪音（session/turn/step/permission/runtime-context/time-context/无文本 assistant 等）
    stats.injectedSkipped += 1;
  }
  stats.extracted = events.length;
  return { events, stats };
}

/** 完整导入流程：读文件 → 解压 → 解析 → 提取 → 批量事务写入 */
export async function runImportChat(
  memory: { importEvents(events: PersonaEvent[]): Promise<{ added: number; skipped: number }> },
  path: string,
): Promise<{ frames: number; added: number; skipped: number; stats: ImportStats }> {
  if (!zstdSupported()) {
    throw new ImportError(
      'ERR_NODE_VERSION',
      '当前 Node 版本不支持 node:zlib 的 zstd API（需要 Node ≥22）。请升级 Node，或用外部工具先解压为 JSONL 后再导入。',
    );
  }
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ImportError('ERR_FILE_NOT_FOUND', `文件不存在：${path}。请检查路径是否正确。`);
    }
    throw new ImportError('ERR_READ_FAILED', `读取文件失败：${(err as Error).message}`);
  }
  const frames = countZstdFrames(buf);
  const text = decompressZstdFrames(buf);
  const msgs = parseSessionLines(text);
  const { events, stats } = extractImportedEvents(msgs as SessionMsg[]);
  const { added, skipped } = await memory.importEvents(events);
  return { frames, added, skipped, stats };
}
