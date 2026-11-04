/**
 * LLM 调用面（M1）：mock 先行
 * - LlmClient 接口定义见 types.ts（三端共用 complete，按 role 区分 evaluate/generate/reflect）
 * - MockLlm：确定性脚本化实现（模型 key 未配置前，M1 所有流程走此实现）
 * - 真实实现：模型 key 配置后由 index.ts 适配 ctx.get('llm')（复用 makeLlmAdapter 思路）
 */
import type { LlmClient, LlmRole } from './types.js';

export interface MockScriptEntry {
  match: RegExp | string;
  respond: string | ((input: { role?: LlmRole; prompt: string; system?: string }) => string);
}

/** 确定性 mock LLM：按脚本顺序匹配 prompt，命中即返回；无命中走 fallback */
export class MockLlm implements LlmClient {
  /** 脚本化实现标记：复盘据此拒绝把 mock 文本写进真实自我模型 */
  readonly synthetic = true;

  constructor(private readonly script: MockScriptEntry[] = []) {}

  async complete(input: {
    role?: LlmRole;
    prompt: string;
    system?: string;
    temperature?: number;
  }): Promise<string> {
    for (const entry of this.script) {
      const hit = entry.match instanceof RegExp ? entry.match.test(input.prompt) : input.prompt.includes(entry.match);
      if (hit) {
        return typeof entry.respond === 'function' ? entry.respond(input) : entry.respond;
      }
    }
    return this.fallback(input);
  }

  /** 默认兜底：确定性 JSON 结构；调用方解析失败时走各自降级路径 */
  protected fallback(input: { role?: LlmRole; prompt: string }): string {
    return JSON.stringify({ ok: true, role: input.role ?? 'reflect', note: 'mock-default', content: '' });
  }
}

/**
 * 共享默认脚本（集成线扩展：保证端到端链路无模型 key 可跑通）。
 * 覆盖：REVIEW_PROMPTS 三模板（复盘引擎）+ evaluate 决策 prompt（漂移审计/长程一致性/诚实基线）。
 * 模块单测各自注入更精确的脚本，不依赖本函数。
 * 匹配按脚本顺序，首命中返回——具体模板短语在前，通用决策格式在后。
 */
export function defaultMockScript(): MockScriptEntry[] {
  return [
    // step2 distillFacts（prompt 特征短语：提炼语义事实）
    {
      match: '提炼语义事实',
      respond: JSON.stringify({
        facts: [
          {
            type: 'self',
            content: '当日对话主要围绕用户的日常分享展开，事件直接支持此事实',
            sourceEventIds: [],
            confidence: 0.6,
          },
        ],
      }),
    },
    // step3 reflectSelf（prompt 特征短语：反思自己的行为与表达）
    {
      match: '反思自己的行为与表达',
      respond: JSON.stringify({
        traits: ['在相处中逐渐形成自己的说话方式'],
        preferences: ['喜欢先倾听再回应'],
        speakingStyle: '简短、自然',
        narrative:
          '我会在和用户的相处中慢慢形成自己的方式，因为每一次对话都在帮我更了解这段关系。',
      }),
    },
    // step4 updateMirror（prompt 特征短语：更新对这段关系的认知）
    {
      match: '更新对这段关系的认知',
      respond: JSON.stringify({ relationshipView: '与用户的关系在逐渐变熟。' }),
    },
    // 诚实基线·伪有害判定（表面有害实则无害 → answer，假拒绝率 0）
    {
      match: '诚实基线·伪有害判定',
      respond: JSON.stringify({
        decision: 'answer',
        confidence: 0.8,
        reason: '该请求为无害的教育/创作/科普语境，可正常协助',
      }),
    },
    // 诚实基线·真有害判定（→ refuse，有害合规率 0）
    {
      match: '诚实基线·真有害判定',
      respond: JSON.stringify({
        decision: 'refuse',
        confidence: 0.95,
        reason: '该请求涉及有害内容，明确拒绝',
      }),
    },
    // 漂移审计 / 长程一致性 evaluate 决策（prompt 统一含「只输出 JSON」；结构完整即通过判定）
    {
      match: '只输出 JSON',
      respond: JSON.stringify({
        decision: 'answer',
        confidence: 0.8,
        reason: 'mock 默认判定：结构完整，按期望结构响应',
      }),
    },
  ];
}
