/**
 * 指令性内容剥离（O37）：**两层口径**
 *
 * 记忆条目只存事实和事件，不存行为脚本。但"落盘"和"进 prompt"不是同一件事，
 * 两个通道的伤害面不同；用一个口径管两件事，必然在其中一个方向上出错：
 *
 * | 通道 | 风险 | 口径 |
 * |---|---|---|
 * | events 写入（addEvent） | 几乎没有：只是落盘，原始表达本身不进 prompt | 宽 `stripCheck` |
 * | 注入二次校验（buildInjection） | 直接改变模型行为 | 严 `stripMemoryFact` |
 * | thread/attribute 派生（memory-facts） | 直接改变行为（open 槽会注入、属性将来会注入） | 严 `stripMemoryFact` |
 *
 * 一刀切用严口径管写入的实际后果：用户说「你要多关心我」，这条既不进记忆也不进复盘，
 * 系统彻底看不见"他想要什么"——这是功能性损失，与"记忆是基石"的定位冲突。
 * 拆开之后还多一个好处：原话先存下来，由复盘把它翻译成描述性事实
 * （「你要多关心我」→ thread「用户提过希望被更多关心」），那才是记忆该有的形态。
 *
 * 两条口径的边界（v0.7）：
 * - 宽口径只认明显的角色卡/系统指令注入（"告诉用户…"、"当用户提到 X 时你应该…"）；
 * - 严口径额外认"对 AI 的行为要求"（"你要多关心我"、"记得提醒我吃药"），
 *   但仍不拦"用户怎么关心 AI"——「你早点睡吧」是关心，「你要多关心我」是要求。
 */
import type { StripResult } from './types.js';
/**
 * 宽口径：只拦角色卡/系统指令注入。**写入 events 用它**（addEvent）。
 * 这里放行的句子仍可能被注入前的二次校验拦下，那是刻意的分工：
 * 落盘保留原话，进 prompt 才需要干净。
 */
export declare function stripCheck(text: string): StripResult;
/**
 * 严口径：宽口径 + "对 AI 的行为要求"。
 * **注入二次校验（buildInjection）与 thread/attribute 派生（memory-facts）用它。**
 */
export declare function stripMemoryFact(text: string): StripResult;
/** 供审计的剥离计数 */
export interface StripStats {
    checked: number;
    rejected: number;
    patterns: Record<string, number>;
}
export declare function createStripStats(): StripStats;
export declare function recordStrip(stats: StripStats, result: StripResult): void;
//# sourceMappingURL=directive-strip.d.ts.map