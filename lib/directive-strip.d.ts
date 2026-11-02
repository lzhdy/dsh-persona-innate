/**
 * 指令性内容剥离（O37）
 * 记忆条目只存事实和事件，不存行为脚本。
 * 祈使句形态（告诉用户……、当用户提到 X 时你应该……）一律标记不可信或拒绝写入；
 * 写入前执行剥离检查，检索注入前再次校验（调用方负责二次校验）。
 */
import type { StripResult } from './types.js';
/** 检查文本是否含指令性内容；ok=false 表示应拒绝写入 */
export declare function stripCheck(text: string): StripResult;
/** 供审计的剥离计数 */
export interface StripStats {
    checked: number;
    rejected: number;
    patterns: Record<string, number>;
}
export declare function createStripStats(): StripStats;
export declare function recordStrip(stats: StripStats, result: StripResult): void;
//# sourceMappingURL=directive-strip.d.ts.map