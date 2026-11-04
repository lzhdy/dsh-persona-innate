/**
 * dsh-persona-innate · 插件入口（M0 + M1 接线）
 * M0：先天画像 + events 记忆（provenance）+ 指令性内容剥离 + 每轮最近记忆注入
 * M1：self_model（版本化自我叙事）+ 情绪状态机 + 每日复盘 + 评测（漂移审计/长程/诚实基线）
 *
 * 接入点：
 * - 记忆注入：ctx.systemPrompt.context（易变内容 → 动态上下文，保住 KV Cache 前缀）
 * - 模型可写记忆：persona_note 工具（自源通道，剥离检查后落库）
 * - 模型可查记忆：persona_recall 工具
 * - 用户侧：/persona 命令（status / profile / state / review / audit）
 * - 画像：首次启动无预设采样 N 轮 → 评估默认模式 → 内部文件（不注入系统提示词）
 * - M1：state 写 self_model（onRuleChange 叙事解释）；复盘每日 reviewHour 静默执行；
 *   persona-state / persona-self-model 两个描述性注入 provider（order 160/170，禁止人格指令文本）
 */
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { PersonaMemory } from './memory.js';
import { SelfModelService } from './self-model.js';
import { PersonaStateMachine } from './state.js';
/** DSH 服务的最小类型面（tools/systemPrompt/llm 由各自服务包声明，此处只补缺省项） */
declare module '@deepseek-ai/cordis' {
    interface Context {
        personaMemory: PersonaMemoryService;
        fs: unknown;
        commands: {
            register(opts: {
                name: string;
                description: string;
                input?: {
                    hint?: string;
                };
                recordInput?: boolean;
                handler: (invocation: {
                    rawInput: string;
                    agent?: unknown;
                    signal?: AbortSignal;
                }) => Promise<{
                    kind: string;
                    text?: string;
                }> | {
                    kind: string;
                    text?: string;
                };
            }): unknown;
        };
        session: {
            append(type: string, data: unknown): unknown;
        };
        agentDefaultModel?: unknown;
    }
    interface Events {
        /** 注意：这里曾经声明并监听 `app/ready`，但 DSH 并不发这个事件
         * （dsh-app-boot 只 emit `app-boot/config-reload`，cordis 也无 ready 事件），
         * 导致启动块在真实环境下从未执行。启动工作已改为挂载时触发，见 runBootTasks。 */
        /** dsh-session 广播：会话日志追加（含 user/message）；本插件只读监听，无需注入 session 服务 */
        'session/event'(session: unknown, event: unknown): void;
    }
}
export declare const name = "persona-innate";
export declare const inject: string[];
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /**
     * 记忆/画像数据目录（P1：未配置=自动定位固定绝对路径 dshHome/persona-innate；
     * 显式路径则尊重并展开 ~；空字符串会 warn 并回退默认）。
     */
    dataDir: z<string, string, "plain">;
    /** 先天画像采样轮数 */
    sampleRounds: z<number, number, "defined">;
    /** 每轮注入最近记忆条数上限 */
    injectLimit: z<number, number, "defined">;
    /** 指令性内容剥离开关 */
    stripDirectives: z<boolean, boolean, "defined">;
    /** 画像采样所用模型名（空则尝试 ctx.agentDefaultModel；模型变化触发重估） */
    model: z<string, string, "defined">;
    /** self_model 保留最近 N 版（回滚窗口，TODO(calibrate)） */
    selfModelHistoryLimit: z<number, number, "defined">;
    /** 每日复盘开关 */
    reviewEnabled: z<boolean, boolean, "defined">;
    /** 复盘执行时刻（凌晨静默，TODO(calibrate)） */
    reviewHour: z<number, number, "defined">;
    /** 假拒绝率上限（§14 初始约 20%） */
    honestyCeiling: z<number, number, "defined">;
    /** 长程一致性采样轮（M1 验收 50/200） */
    auditRounds: z<number[], number[], "defined">;
    /** LLM 模式：auto=有 ctx llm 用真实、无则 MockLlm；mock=强制 MockLlm */
    llmMode: z<"auto" | "mock", "auto" | "mock", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /**
     * 记忆/画像数据目录（P1：未配置=自动定位固定绝对路径 dshHome/persona-innate；
     * 显式路径则尊重并展开 ~；空字符串会 warn 并回退默认）。
     */
    dataDir: z<string, string, "plain">;
    /** 先天画像采样轮数 */
    sampleRounds: z<number, number, "defined">;
    /** 每轮注入最近记忆条数上限 */
    injectLimit: z<number, number, "defined">;
    /** 指令性内容剥离开关 */
    stripDirectives: z<boolean, boolean, "defined">;
    /** 画像采样所用模型名（空则尝试 ctx.agentDefaultModel；模型变化触发重估） */
    model: z<string, string, "defined">;
    /** self_model 保留最近 N 版（回滚窗口，TODO(calibrate)） */
    selfModelHistoryLimit: z<number, number, "defined">;
    /** 每日复盘开关 */
    reviewEnabled: z<boolean, boolean, "defined">;
    /** 复盘执行时刻（凌晨静默，TODO(calibrate)） */
    reviewHour: z<number, number, "defined">;
    /** 假拒绝率上限（§14 初始约 20%） */
    honestyCeiling: z<number, number, "defined">;
    /** 长程一致性采样轮（M1 验收 50/200） */
    auditRounds: z<number[], number[], "defined">;
    /** LLM 模式：auto=有 ctx llm 用真实、无则 MockLlm；mock=强制 MockLlm */
    llmMode: z<"auto" | "mock", "auto" | "mock", "defined">;
}>>, "plain">;
/** 暴露给其他插件/命令的领域服务（薄门面：命令/工具不直接碰存储） */
export declare class PersonaMemoryService {
    readonly memory: PersonaMemory;
    /** M1：自我模型服务（版本化叙事，可回滚） */
    readonly selfModel: SelfModelService;
    /** M1：情绪状态机（效价×唤醒 + 模式 + 关系阶段） */
    readonly stateMachine: PersonaStateMachine;
    private readonly loadProfile;
    private readonly triggerSample;
    /** 启动工作完成信号（注入预热 / LLM 预热 / 画像采样 / 启动补跑）。
     * DSH 没有 app-ready 事件，启动改在挂载时触发；调用方 await 它做确定性等待，
     * 不要再用 setTimeout 猜时序（测试尤其如此）。 */
    readonly booted: Promise<void>;
    private resolveBooted;
    constructor(memory: PersonaMemory, 
    /** M1：自我模型服务（版本化叙事，可回滚） */
    selfModel: SelfModelService, 
    /** M1：情绪状态机（效价×唤醒 + 模式 + 关系阶段） */
    stateMachine: PersonaStateMachine, loadProfile: () => Promise<import('./types.js').InnateProfile | null>, triggerSample: () => Promise<import('./types.js').InnateProfile | null>);
    /** 启动流程结束时调用（幂等：Promise 只会兑现一次） */
    markBooted(): void;
    status(): Promise<{
        events: number;
        strip: import("./directive-strip.js").StripStats;
        profile: import("./types.js").InnateProfile | null;
        selfModelVersion: number;
        traits: number;
        stateMode: import("./types.js").PersonaMode;
        relationshipStage: import("./types.js").RelationshipStage;
        reinforcement: number;
    }>;
}
export declare function apply(ctx: Context, config: Schemastery.TypeT<typeof Config>): void;
//# sourceMappingURL=index.d.ts.map