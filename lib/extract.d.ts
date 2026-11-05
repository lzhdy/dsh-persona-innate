/**
 * 自动记忆提取（M2：session/event 驱动的确定性规则）
 * - 从用户消息中识别"值得记住的经历/情绪分享"，零 LLM 成本、可复算
 * - 命中返回 { topic, summary, importance, emotionTags }，未命中返回 null
 * - 只提取事实与经历，不提取指令（指令性内容由 memory.addEvent 统一剥离）
 * - 保守原则：宁可漏、不可错——无时间/第一人称/情绪信号的抽象讨论不提取
 * - 阶段一：新增"用户对 AI 表达/风格的反馈"识别（extractStyleFeedback）与
 *   对话类型启发式分类（classifyDialogue）——补全成长闭环的感知缺口，
 *   只记录事实，不注入行为规则
 * - M3-3：表达风格认错走 self_correction 独立路径（方案 B，双证据判定，见下）
 */
export interface ExtractCandidate {
    topic: string;
    summary: string;
    importance: number;
    emotionTags: string[];
}
/**
 * 提取文本中出现的全部时间信号词。
 * 规则：
 * 1. 先用 ZHOU_TIME_RE 整体识别星期/周末词并记录字符区间；
 * 2. 再用最长优先匹配普通时间词，跳过与已命中区间重叠的位置（词边界锚定），
 *    因此「下周一」命中「周一」而非「下周」，「周末」整体命中、不被拆。
 * 返回命中词数组（按出现位置），无命中返回空数组。
 */
export declare function matchTimeWords(text: string): string[];
/**
 * 从一条用户消息文本中提取记忆候选。
 * 返回 null 表示不值得记录（命令、过短、纯抽象讨论）。
 */
export declare function extractCandidate(text: string): ExtractCandidate | null;
/** 去重键：topic + summary（用于短窗口去重） */
export declare function dedupKey(c: ExtractCandidate): string;
/**
 * 识别"用户对 AI 表达/风格的反馈"，命中返回记忆候选（topic=关系-风格反馈）。
 * 未命中返回 null。与 extractCandidate 正交：风格反馈不要求时间/第一人称/事件词。
 */
export declare function extractStyleFeedback(text: string): ExtractCandidate | null;
/**
 * 对话类型启发式分类：求助/任务 vs 闲聊/分享。
 * 输出描述性标签（供注入层使用），不构成对 AI 的行为指令。
 */
export declare function classifyDialogue(text: string): {
    type: '求助/任务' | '闲聊/分享';
    evidence: string[];
};
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
/** M3 自身表达候选 */
export interface SelfExpressionCandidate {
    provenance: 'self_direct' | 'induced' | 'self_correction';
    strength: 'weak' | 'medium' | 'strong';
    /** 立场模式 key（跨事件计数用，如 '立场-纪念日'、'边界-隐私'、'修正-*'） */
    pattern: string;
    summary: string;
    importance: number;
    emotionTags: string[];
}
/** 用户预设立场型诱导提问（M3-2 收紧：排除开放征询"你觉得呢"，无预设答案的征询不算诱导） */
export declare const INDUCE_PROBES: readonly string[];
/** 诱导检测窗口：按"用户-助手往返轮次"计（每轮恰 1 条用户消息，slice(-N) 即最近 N 轮） */
export declare const INDUCE_WINDOW = 3;
/**
 * 会话级诱导结构判定（M3-2 串联放大修复）：不依赖单句措辞，看会话结构——
 * 近窗口内问句比例 + 连续施压轮数。高密度 → 该会话产出的 self_direct 表达标记
 * inductionRisk='unchecked'（不参与 3 次固化门槛合并计数，须 ≥5 且跨会话）。
 * 对"换措辞、多轮铺垫、AI 主动复述"类绕过更鲁棒。阈值待校准。
 */
export declare function sessionInduceRisk(recentUserMessages: readonly string[]): 'low' | 'unchecked';
/** 从一条 assistant 消息文本中提取"AI 自身表达"候选（M3 / M3-2） */
export declare function extractSelfExpression(text: string, recentUserMessages?: readonly string[]): SelfExpressionCandidate | null;
/**
 * 从 assistant content 块数组【从后往前】取最后一条 type==='text'（或 type undefined）的文本，
 * 跳过 reasoning / tool_call / thinking 等非表达块——与 import-chat 的 assistantMessageText 同口径。
 * 未来格式在尾部加入工具调用也不会把工具调用当成 AI 的表达。
 */
export declare function assistantTextFromBlocks(blocks: readonly {
    type?: string;
    text?: string;
}[] | undefined): string | null;
/**
 * 判定一条 session/event 是否为可提取的真实 assistant 消息（M3；P0 修正事件路径）。
 * 真实 DSH 事件的表达内容在 data.message.content，兼容旧/直挂结构 data.content。
 */
export declare function isExtractableAssistantMessage(ev: unknown): {
    ok: true;
    text: string;
} | {
    ok: false;
};
//# sourceMappingURL=extract.d.ts.map