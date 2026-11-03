/**
 * 自动记忆提取（M2：session/event 驱动的确定性规则）
 * - 从用户消息中识别"值得记住的经历/情绪分享"，零 LLM 成本、可复算
 * - 命中返回 { topic, summary, importance, emotionTags }，未命中返回 null
 * - 只提取事实与经历，不提取指令（指令性内容由 memory.addEvent 统一剥离）
 * - 保守原则：宁可漏、不可错——无时间/第一人称/情绪信号的抽象讨论不提取
 */
export interface ExtractCandidate {
    topic: string;
    summary: string;
    importance: number;
    emotionTags: string[];
}
/**
 * 从一条用户消息文本中提取记忆候选。
 * 返回 null 表示不值得记录（命令、过短、纯抽象讨论）。
 */
export declare function extractCandidate(text: string): ExtractCandidate | null;
/** 去重键：topic + summary（用于短窗口去重） */
export declare function dedupKey(c: ExtractCandidate): string;
/**
 * 判定一条 session/event 是否是可提取的真实用户消息（M2 真机修复）：
 * - 事件类型必须是 user/message
 * - 来源必须为真实用户（source.kind === 'user'）；DSH 会把运行时上下文等系统注入
 *   拼成 user 角色消息广播，来源非 'user'，必须过滤
 * - 内容级双保险：跳过 DSH 运行时上下文注入（来源字段缺失时兜底）
 * - 返回聚合后的纯文本；不可提取返回 { ok: false }
 */
export declare function isExtractableUserMessage(ev: unknown): {
    ok: true;
    text: string;
} | {
    ok: false;
};
//# sourceMappingURL=extract.d.ts.map