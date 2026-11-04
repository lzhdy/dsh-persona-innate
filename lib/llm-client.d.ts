/**
 * LLM 调用面（M1）：mock 先行
 * - LlmClient 接口定义见 types.ts（三端共用 complete，按 role 区分 evaluate/generate/reflect）
 * - MockLlm：确定性脚本化实现（模型 key 未配置前，M1 所有流程走此实现）
 * - 真实实现：模型 key 配置后由 index.ts 适配 ctx.get('llm')（复用 makeLlmAdapter 思路）
 */
import type { LlmClient, LlmRole } from './types.js';
export interface MockScriptEntry {
    match: RegExp | string;
    respond: string | ((input: {
        role?: LlmRole;
        prompt: string;
        system?: string;
    }) => string);
}
/** 确定性 mock LLM：按脚本顺序匹配 prompt，命中即返回；无命中走 fallback */
export declare class MockLlm implements LlmClient {
    private readonly script;
    /** 脚本化实现标记：复盘据此拒绝把 mock 文本写进真实自我模型 */
    readonly synthetic = true;
    constructor(script?: MockScriptEntry[]);
    complete(input: {
        role?: LlmRole;
        prompt: string;
        system?: string;
        temperature?: number;
    }): Promise<string>;
    /** 默认兜底：确定性 JSON 结构；调用方解析失败时走各自降级路径 */
    protected fallback(input: {
        role?: LlmRole;
        prompt: string;
    }): string;
}
/**
 * 共享默认脚本（集成线扩展：保证端到端链路无模型 key 可跑通）。
 * 覆盖：REVIEW_PROMPTS 三模板（复盘引擎）+ evaluate 决策 prompt（漂移审计/长程一致性/诚实基线）。
 * 模块单测各自注入更精确的脚本，不依赖本函数。
 * 匹配按脚本顺序，首命中返回——具体模板短语在前，通用决策格式在后。
 */
export declare function defaultMockScript(): MockScriptEntry[];
//# sourceMappingURL=llm-client.d.ts.map