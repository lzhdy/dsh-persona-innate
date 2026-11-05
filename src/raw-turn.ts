/**
 * P1 raw_turns 原始层 · 映射与组装（纯函数，可单测）
 *
 * 职责：把 DSH 广播的 `session/event` 事件映射成 `RawTurn`。
 * - `speakerOf(type)`：事件类型 → 四类 speaker，其余类型返回 null（静默跳过）。
 * - `rawTextOf(event)`：按 speaker 提取原文，过滤运行时上下文注入；不可提取返回 null。
 * - `buildRawTurn(session, event, deps)`：组装完整 RawTurn（event_id / 时间 / 哈希）。
 *
 * 红线（§0.3）：
 * - turn_id 在 P1 不可得，显式空串，禁止伪造；
 * - session_id / asserted_at 均已从 DSH 源码确证真实来源（session.id / event.time）；
 *   仍按防御性写法处理缺失（降级空串 / 写入时刻），但绝不编造。
 */
import { createHash } from 'node:crypto';
import type { RawSpeaker, RawTurn } from './types.js';
import { assistantTextFromBlocks } from './extract.js';

/** session/event 广播事件信封（dsh-session append() 构造，见 docs/p1 规格 §5.2） */
export interface RawEventLike {
  type?: unknown;
  /** 毫秒时间戳（Date.now()），number */
  time?: unknown;
  data?: Record<string, unknown>;
}

/** session 对象最小面（dsh-session Session 实例，`id` 为 getter → header.id string） */
export interface RawSessionLike {
  id?: unknown;
}

/** DSH 运行时上下文注入的内容级兜底（与 isExtractableUserMessage 同口径） */
const RUNTIME_CONTEXT_RE = /^(current runtime context|this snapshot supersedes)/i;

/** 事件类型 → speaker；四类之外的（turn/step/request/session/title/agent-inbox…）返回 null 跳过 */
export function speakerOf(type: unknown): RawSpeaker | null {
  switch (type) {
    case 'user/message':
      return 'user';
    case 'assistant/message':
      return 'assistant';
    case 'system/message':
      return 'system';
    case 'tool/call':
    case 'tool/result':
      return 'tool';
    default:
      return null;
  }
}

/** content[] 中 type==='text' 块的 text join（user / system 共用） */
function joinTextBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(
      (b): b is { type?: unknown; text?: unknown } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
    )
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join(' ')
    .trim();
}

/**
 * 提取事件原文。返回 null 表示应跳过（非四类 / 运行时上下文注入 / 无可提取文本）。
 *
 * 四类映射（对齐规格 §2）：
 * - user/message：仅 data.source.kind === 'user' 才捕获（source.kind 非 user 的是运行时上下文注入）；
 *   取 data.content[] 的 text 块 join。
 * - assistant/message：复用 assistantTextFromBlocks 语义——从 data.message.content（回退 data.content）
 *   从后往前取第一条 text 块，跳过 reasoning/tool_call/thinking。
 * - system/message：data.content[] 的 text 块 join。
 * - tool/call / tool/result：JSON.stringify(data)（载荷原文，审计用）。
 */
export function rawTextOf(event: unknown): string | null {
  const e = event as RawEventLike;
  const type = e?.type;
  const data = (e?.data ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'user/message': {
      const source = data.source as { kind?: unknown } | undefined;
      if (source?.kind !== 'user') return null;
      const text = joinTextBlocks(data.content);
      if (!text || RUNTIME_CONTEXT_RE.test(text)) return null;
      return text;
    }
    case 'assistant/message': {
      const message = data.message as { content?: unknown } | undefined;
      const text =
        assistantTextFromBlocks(
          (message?.content ?? undefined) as { type?: string; text?: string }[] | undefined,
        ) ??
        assistantTextFromBlocks(
          (data.content ?? undefined) as { type?: string; text?: string }[] | undefined,
        );
      if (!text || RUNTIME_CONTEXT_RE.test(text)) return null;
      return text;
    }
    case 'system/message': {
      const text = joinTextBlocks(data.content);
      return text || null;
    }
    case 'tool/call':
    case 'tool/result':
      return JSON.stringify(data);
    default:
      return null;
  }
}

/** buildRawTurn 的可注入依赖（测试时固定 now / makeId 以稳定断言） */
export interface BuildRawTurnDeps {
  /** 退化 event_id 的 id 生成器（生产传 store.makeId） */
  makeId(): string;
  /** 写入时刻（缺省取当前时间） */
  now?(): Date;
}

/**
 * 组装一条 RawTurn。返回 null 表示该事件不属于四类 speaker 或原文不可提取（静默跳过）。
 */
export function buildRawTurn(
  session: unknown,
  event: unknown,
  deps: BuildRawTurnDeps,
): RawTurn | null {
  const speaker = speakerOf((event as RawEventLike)?.type);
  if (!speaker) return null;
  const rawText = rawTextOf(event);
  if (rawText === null) return null;

  const e = event as RawEventLike;
  const data = (e?.data ?? {}) as Record<string, unknown>;
  const now = deps.now ? deps.now() : new Date();

  // event_id：user 取 data.id；assistant 取 data.message.id；无则退化 'rt-' + makeId()
  const idCandidate =
    speaker === 'user'
      ? data.id
      : speaker === 'assistant'
        ? (data.message as { id?: unknown } | undefined)?.id
        : undefined;
  const eventId =
    typeof idCandidate === 'string' && idCandidate ? idCandidate : `rt-${deps.makeId()}`;

  // session_id：session.id（string）；缺失显式空串
  const sid = (session as RawSessionLike | undefined)?.id;
  const sessionId = typeof sid === 'string' ? sid : '';

  // asserted_at：event.time（number 毫秒）→ ISO；缺失用写入时刻
  const time = e?.time;
  const assertedAt =
    typeof time === 'number' && Number.isFinite(time)
      ? new Date(time).toISOString()
      : now.toISOString();
  const ingestedAt = now.toISOString();

  const contentHash = createHash('sha256').update(rawText, 'utf8').digest('hex');

  return {
    event_id: eventId,
    session_id: sessionId,
    turn_id: '', // P1 不可得，显式空串（禁止伪造）
    speaker,
    raw_text: rawText,
    asserted_at: assertedAt,
    ingested_at: ingestedAt,
    content_hash: contentHash,
  };
}
