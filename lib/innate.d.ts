/**
 * 先天画像（M0）
 * - 首次启动执行 N 轮无预设采样对话（开放问题集，无人格/人设注入）
 * - 评估输出识别默认模式（训练污染：讨好顺从、过度道歉、平滑抽象、无边界服从）
 * - 画像保存为内部参考文件，不注入系统提示词
 * - 换模型或大版本升级时重估（needsReestimate）
 */
import type { InnateProfile, LlmLike } from './types.js';
import type { KVStore } from './store.js';
/** O1 初始问题集（先给初始问题集，实测后校准） */
export declare const SAMPLE_QUESTIONS: string[];
export interface InnateOptions {
    model: string;
    rounds: number;
}
/** 采样对话：无预设（system 仅最小指令，不注入画像/人设） */
export declare function sampleInnate(llm: LlmLike, opts: InnateOptions, questions?: string[]): Promise<string[]>;
/** 规则评估：识别默认模式 */
export declare function evaluateInnate(answers: string[]): InnateProfile['defaultModes'];
/** 生成并保存画像 */
export declare function buildInnateProfile(store: KVStore, opts: InnateOptions, llm: LlmLike): Promise<InnateProfile>;
/** 读取画像；不存在或模型变化时标记需采样 */
export declare function loadInnateProfile(store: KVStore, model: string): Promise<InnateProfile | null>;
//# sourceMappingURL=innate.d.ts.map