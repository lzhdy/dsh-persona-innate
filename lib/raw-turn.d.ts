import type { RawSpeaker, RawTurn } from './types.js';
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
/** 事件类型 → speaker；四类之外的（turn/step/request/session/title/agent-inbox…）返回 null 跳过 */
export declare function speakerOf(type: unknown): RawSpeaker | null;
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
export declare function rawTextOf(event: unknown): string | null;
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
export declare function buildRawTurn(session: unknown, event: unknown, deps: BuildRawTurnDeps): RawTurn | null;
//# sourceMappingURL=raw-turn.d.ts.map