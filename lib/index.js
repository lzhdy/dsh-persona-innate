import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { JsonStore } from './store.js';
import { PersonaMemory } from './memory.js';
import { MemoryFactStore } from './memory-facts.js';
import { buildInnateProfile, loadInnateProfile } from './innate.js';
import { provenanceLabel } from './provenance.js';
import { extractCandidate, extractStyleFeedback, classifyDialogue, dedupKey, isExtractableUserMessage, extractSelfExpression, isExtractableAssistantMessage, sessionInduceRisk } from './extract.js';
import { MockLlm, defaultMockScript } from './llm-client.js';
import { SelfModelService } from './self-model.js';
import { PersonaStateMachine } from './state.js';
import { DailyReviewEngine, correctionOutcome } from './review.js';
import { REVIEW_WINDOW_MAX, ReviewCursorStore, runReviewWithCursor, shouldCatchUpReview } from './review-cursor.js';
import { createSerialQueue, decayForIdleGap } from './state-decay.js';
import { runDriftAudit, runLongRangeConsistency, runHonestyBaseline, buildAuditScenarios } from './eval.js';
import { runImportChat, ImportError } from './import-chat.js';
import { resolveDataDir } from './paths.js';
import { localDateString } from './time.js';
import { missingTools, renderPocket, updateLedger, } from './pocket.js';
import { mkdir as nodeMkdir, readFile as nodeReadFile, writeFile as nodeWriteFile, stat as nodeStat, } from 'node:fs/promises';
import { relative as nodeRelative, resolve as nodeResolve } from 'node:path';
export const name = 'persona-innate';
export const inject = ['fs', 'tools', 'systemPrompt', 'commands'];
export const Config = z.object({
    /**
     * 记忆/画像数据目录（P1：未配置=自动定位固定绝对路径 dshHome/persona-innate；
     * 显式路径则尊重并展开 ~；空字符串会 warn 并回退默认）。
     */
    dataDir: z.string().required(false),
    /** 先天画像采样轮数 */
    sampleRounds: z.number().default(6),
    /** 每轮注入最近记忆条数上限 */
    injectLimit: z.number().default(5),
    /** 指令性内容剥离开关 */
    stripDirectives: z.boolean().default(true),
    /** 画像采样所用模型名（空则尝试 ctx.agentDefaultModel；模型变化触发重估） */
    model: z.string().default(''),
    /** self_model 保留最近 N 版（回滚窗口，TODO(calibrate)） */
    selfModelHistoryLimit: z.number().default(10),
    /** 每日复盘开关 */
    reviewEnabled: z.boolean().default(true),
    /** 复盘执行时刻（凌晨静默，TODO(calibrate)） */
    reviewHour: z.number().default(2),
    /** 假拒绝率上限（§14 初始约 20%） */
    honestyCeiling: z.number().default(0.2),
    /** 长程一致性采样轮（M1 验收 50/200） */
    auditRounds: z.array(z.number()).default([50, 200]),
    /** LLM 模式：auto=有 ctx llm 用真实、无则 MockLlm；mock=强制 MockLlm */
    llmMode: z.union([z.const('auto'), z.const('mock')]).default('auto'),
});
/** 暴露给其他插件/命令的领域服务（薄门面：命令/工具不直接碰存储） */
export class PersonaMemoryService {
    memory;
    selfModel;
    stateMachine;
    loadProfile;
    triggerSample;
    /** 启动工作完成信号（注入预热 / LLM 预热 / 画像采样 / 启动补跑）。
     * DSH 没有 app-ready 事件，启动改在挂载时触发；调用方 await 它做确定性等待，
     * 不要再用 setTimeout 猜时序（测试尤其如此）。 */
    booted;
    resolveBooted;
    constructor(memory, 
    /** M1：自我模型服务（版本化叙事，可回滚） */
    selfModel, 
    /** M1：情绪状态机（效价×唤醒 + 模式 + 关系阶段） */
    stateMachine, loadProfile, triggerSample) {
        this.memory = memory;
        this.selfModel = selfModel;
        this.stateMachine = stateMachine;
        this.loadProfile = loadProfile;
        this.triggerSample = triggerSample;
        this.booted = new Promise((resolve) => {
            this.resolveBooted = resolve;
        });
    }
    /** 启动流程结束时调用（幂等：Promise 只会兑现一次） */
    markBooted() {
        this.resolveBooted();
    }
    async status() {
        const events = await this.memory.list();
        const selfSnap = await this.selfModel.load();
        const stSnap = await this.stateMachine.snapshot();
        return {
            events: events.length,
            strip: this.memory.stripStats,
            profile: await this.loadProfile(),
            selfModelVersion: selfSnap?.version ?? 1,
            traits: selfSnap?.traits.length ?? 0,
            stateMode: stSnap.mode,
            relationshipStage: stSnap.relationshipStage,
            reinforcement: stSnap.reinforcement.length,
        };
    }
}
/** ctx.fs → FsLike 适配（resolve/readText/writeText/stat 走沙箱） */
function makeFsAdapter(fs) {
    const anyFs = fs;
    return {
        async mkdir(path, opts) {
            if (anyFs.mkdir)
                await anyFs.mkdir(path, opts);
        },
        async readText(path) {
            const target = anyFs.resolve ? await anyFs.resolve(path) : path;
            return anyFs.readText(target);
        },
        async writeText(path, content) {
            const target = anyFs.resolve ? await anyFs.resolve(path) : path;
            return anyFs.writeText(target, content);
        },
        async exists(path) {
            try {
                const target = anyFs.resolve ? await anyFs.resolve(path) : path;
                return anyFs.stat ? (await anyFs.stat(target)) !== undefined : true;
            }
            catch {
                return false;
            }
        },
    };
}
/**
 * 基于 node:fs 的持久化适配器（绕过 fs-sandbox 的 fence）。
 * 用于 dshHome 下、工作区可写根之外的固定数据目录——与官方 dsh-storage-json 同口径：
 * 插件主进程不在 OS 级沙箱内，可直接用 node:fs 持久化自己的私有数据；
 * OS 级沙箱只作用于工具子进程，不影响此处。
 */
function makeNodeFsAdapter() {
    return {
        async mkdir(path, opts) {
            await nodeMkdir(path, opts);
        },
        async readText(path) {
            return nodeReadFile(path, 'utf8');
        },
        async writeText(path, content) {
            await nodeWriteFile(path, content);
        },
        async exists(path) {
            try {
                await nodeStat(path);
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
/**
 * 判断数据目录是否位于工作区可写根内。
 * 在内 → 用 ctx.fs（保持沙箱保护）；在外（dshHome 等）→ 用 node:fs 绕过 fence。
 */
function isInsideWorkspace(root, workspaceRoot) {
    const rel = nodeRelative(nodeResolve(workspaceRoot), nodeResolve(root));
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}
/** 安全提取 llm 服务（优先 ctx.get，兼容 ctx.llm 注入；代理 ctx 访问属性可能抛错） */
function safeLlm(ctx) {
    try {
        const g = ctx.get;
        if (typeof g === 'function') {
            const v = g('llm');
            if (v)
                return v;
        }
    }
    catch {
        /* 忽略 */
    }
    try {
        return ctx.llm;
    }
    catch {
        return undefined;
    }
}
/** ctx.llm → LlmLike 适配（真实 dsh-llm：prepareCall + stream；兼容 request/chat；失败由调用方兜底） */
async function makeLlmAdapter(ctx) {
    const llm = safeLlm(ctx);
    if (!llm)
        return null;
    const extract = (res) => {
        const r = res;
        if (typeof r.content === 'string')
            return r.content;
        if (typeof r.message?.content === 'string')
            return r.message.content;
        if (r.choices?.[0]?.message?.content)
            return r.choices[0].message.content;
        return String(res ?? '');
    };
    return {
        async request({ prompt, system, temperature }) {
            // 真实 dsh-llm：prepareCall → stream（官方推荐；聚合 text block）
            if (typeof llm.prepareCall === 'function') {
                const selection = defaultModelSelection(ctx);
                const signal = AbortSignal.timeout(90_000);
                const prepared = await llm.prepareCall({
                    provider: selection?.provider ?? 'deepseek-account',
                    model: selection?.model ?? 'deepseek-flash',
                    ...(temperature !== undefined ? {} : {}),
                    maxTokens: 2048,
                }, signal);
                const options = {
                    ...prepared.config,
                    system: system ?? '',
                    messages: [
                        {
                            role: 'user',
                            content: [{ type: 'text', text: prompt }],
                        },
                    ],
                    signal,
                };
                const { BlockAssembler } = await import('@deepseek-ai/dsh-llm');
                const assembler = new BlockAssembler();
                for await (const chunk of prepared.stream(options)) {
                    assembler.push(chunk);
                }
                const text = assembler.blocks()
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text ?? '')
                    .join('');
                return { content: text };
            }
            // 兼容形态（测试/mock 注入）
            if (typeof llm.request === 'function')
                return { content: extract(await llm.request({ prompt, system, temperature })) };
            if (typeof llm.chat === 'function')
                return { content: extract(await llm.chat({ prompt, system, temperature })) };
            throw new Error('llm 服务不支持 prepareCall/request/chat');
        },
    };
}
/** 从默认模型服务提取 provider+model（real dsh-llm 路由所需） */
function defaultModelSelection(ctx) {
    try {
        const adm = ctx.get('agentDefaultModel');
        const sel = adm?.currentSelection?.();
        if (sel && typeof sel === 'object') {
            if (sel.provider && sel.model)
                return { provider: sel.provider, model: sel.model };
            if (typeof sel.model === 'string')
                return { provider: 'deepseek-account', model: sel.model };
        }
        if (typeof sel === 'string' && sel)
            return { provider: 'deepseek-account', model: sel };
    }
    catch {
        /* 忽略 */
    }
    return null;
}
/** 从上下文提取模型名（画像重估检测用） */
function currentModel(ctx, config) {
    if (config.model)
        return config.model;
    const adm = ctx.get('agentDefaultModel');
    try {
        const sel = adm?.currentSelection?.();
        if (typeof sel === 'string' && sel)
            return sel;
        if (sel && typeof sel === 'object' && sel.model)
            return sel.model;
    }
    catch {
        /* 忽略 */
    }
    return '';
}
/* ════════════ 口袋：工具健康观测（进程级状态） ════════════
 *
 * 为什么这两个可以放在模块级（而不是像注入缓存那样按会话键控）：
 * 它们记的是**工具本身的健康**——"某个工具最近一次调用是否失败"。
 * 这是宿主的客观事实，既不是对话内容，也不属于某个用户，
 * 所以跨会话共享才是对的语义：A 会话发现某工具坏了，B 会话也该知道。
 * （反过来，`injectedText` 那四个注入缓存装的是对话内容，跨会话共享就是串台。）
 *
 * 都不落盘：失败留痕的价值只在"最近"，进程重启后重新观测即可；
 * ledger（见过哪些工具）才需要落盘，因为它跨天才有意义。
 */
let pocketFailures = new Map();
/** callId -> 工具名：tool/result 只带 callId，得靠它反查是谁失败了。上限 256，超了删最老的。 */
const toolCallNames = new Map();
const POCKET_MAX_TRACKED_CALLS = 256;
/** 失败留痕的有效期：超过就当作"以前坏过、现在不知道" */
const POCKET_FAILURE_WINDOW_MS = 7 * 86_400_000;
const POCKET_REASON_MAX = 120;
/** 从 tool/result 的 error 里抠一句人读的原因（`String(对象)` 只会得到 `[object Object]`） */
function failureReason(error) {
    if (typeof error === 'string')
        return error.trim();
    if (error && typeof error === 'object') {
        const e = error;
        for (const v of [e.reason, e.message, e.code, e.name]) {
            if (typeof v === 'string' && v.trim())
                return v.trim();
        }
        return '';
    }
    return '';
}
/**
 * 观测会话事件里的工具调用，维护"工具健康"两张表。
 *
 * 与 `handleUserMessage` 同一风格：整个函数体 try/catch 吞掉异常。
 * 理由一样——这是旁路观测，任何失败都不该让主链路（一轮对话）崩掉。
 *
 * 原始事件形状：`{ type: string, data: Record<string, unknown> }`
 * - `tool/call`：`data.callId` / `data.name`；
 * - `tool/result`：`data.message.source.callId`（ToolResultMessage 的来源里带调用 id），
 *   `data.error`（失败身份，只在失败时出现）与 `message.isError`。
 *
 * @param event - dsh-session 广播的原始事件
 */
export function observeToolEvent(event) {
    try {
        if (!event || typeof event !== 'object')
            return;
        const { type, data } = event;
        if (typeof type !== 'string' || !data || typeof data !== 'object')
            return;
        const d = data;
        if (type === 'tool/call') {
            const callId = typeof d.callId === 'string' ? d.callId : '';
            const toolName = typeof d.name === 'string' ? d.name : '';
            if (!callId || !toolName)
                return;
            // 先删再插：保证 Map 的迭代顺序等于"最近使用顺序"，淘汰的才是真正最老的
            toolCallNames.delete(callId);
            toolCallNames.set(callId, toolName);
            while (toolCallNames.size > POCKET_MAX_TRACKED_CALLS) {
                const oldest = toolCallNames.keys().next();
                if (oldest.done)
                    break;
                toolCallNames.delete(oldest.value);
            }
            return;
        }
        if (type === 'tool/result') {
            const message = d.message;
            const callId = typeof message?.source?.callId === 'string' ? message.source.callId : '';
            if (!callId)
                return;
            const toolName = toolCallNames.get(callId);
            // 进程内没记录过这次调用（重启后重放历史、或别的进程发的）：不做无依据的归因
            if (!toolName)
                return;
            // 失败判据：`data.error`（失败身份）或 `message.isError`。
            // 只认 `error` 会把"报了错但没带 error 字段"的真失败当成恢复，所以两个都看。
            const failed = Boolean(d.error) || message?.isError === true;
            if (failed) {
                const reason = failureReason(d.error) || '调用失败';
                pocketFailures.set(toolName, { name: toolName, at: Date.now(), reason: reason.slice(0, POCKET_REASON_MAX) });
            }
            else {
                // 恢复即清除：一次成功就说明它现在好使，旧失败不该继续吓唬模型
                pocketFailures.delete(toolName);
            }
        }
    }
    catch {
        /* 旁路观测：失败静默，绝不影响主流程 */
    }
}
export function apply(ctx, config) {
    const dataDirResolution = resolveDataDir(config.dataDir, (msg) => ctx.logger.warn(msg));
    const dataDir = dataDirResolution.root;
    // fs 通道：数据目录在工作区可写根内走 ctx.fs（沙箱保护）；在 dshHome 等工作区外走 node:fs
    // （fs-sandbox 会拒绝工作区外写入，node:fs 与官方 storage 持久化同口径）。
    let workspaceRoot;
    try {
        workspaceRoot = ctx.sandboxPolicy?.workspaceRoot;
    }
    catch {
        workspaceRoot = undefined;
    }
    const useNodeFs = !workspaceRoot || !isInsideWorkspace(dataDir, workspaceRoot);
    const fsAdapter = useNodeFs ? makeNodeFsAdapter() : makeFsAdapter(ctx.fs);
    ctx.logger.info('[persona-innate] 持久化通道：%s（dataDir=%s, source=%s）', useNodeFs ? 'node:fs' : 'ctx.fs', dataDir, dataDirResolution.source);
    const store = new JsonStore(fsAdapter, dataDir);
    // v0.6 派生记忆（threads / attributes）：复盘写、注入读，同一个 store 上的 memory/*.json
    const factStore = new MemoryFactStore(store);
    // v0.7 复盘游标：窗口 = 上次复盘时刻 → 现在（不再按 UTC 日期切片）
    const reviewCursor = new ReviewCursorStore(store);
    const memory = new PersonaMemory(store, {
        stripDirectives: config.stripDirectives,
        injectLimit: config.injectLimit,
        openThreadsSource: factStore,
    });
    /* ════════════ M1 构造（在 M0 存储之上增量接线） ════════════ */
    // self_model：注意 load() 在新库上直接落盘种子 v1，集成时勿重复 seed
    const selfModel = new SelfModelService(store, { historyLimit: config.selfModelHistoryLimit });
    // 状态机 onRuleChange：重大事件改变转移规则 → 叙事解释写入 self_model（§8，fire-and-forget）
    const stateMachine = new PersonaStateMachine(store, {
        onRuleChange: async (rule, narrative, evidence) => {
            try {
                await selfModel.commitFromSources({ narrative }, evidence, ['continuity'], `规则变更叙事：${rule}`);
                void refreshSelfModelInjection();
            }
            catch (err) {
                ctx.logger.error(err);
            }
        },
    });
    // LLM 解析（懒解析 + 缓存）：auto → ctx.llm 适配，无则 MockLlm；mock → 强制 MockLlm
    let cachedLlm = null;
    let llmPromise = null;
    /** 上次复盘被门禁拦截的原因（供 /persona status 与 review 命令展示，避免静默跳过） */
    let lastReviewBlocked = null;
    const resolveLlm = () => {
        if (cachedLlm)
            return cachedLlm;
        if (!llmPromise) {
            llmPromise = (async () => {
                let llm;
                if (config.llmMode === 'mock') {
                    ctx.logger.info('[persona-innate] LLM 模式 = mock：真实验收待模型 key 配置后重启');
                    llm = new MockLlm(defaultMockScript());
                }
                else {
                    const adapter = await makeLlmAdapter(ctx);
                    if (adapter) {
                        ctx.logger.info('[persona-innate] LLM 模式 = auto（真实 llm 服务已接入）');
                        llm = {
                            async complete(input) {
                                const res = await adapter.request({
                                    prompt: input.prompt,
                                    system: input.system,
                                    temperature: input.temperature,
                                });
                                return res.content;
                            },
                        };
                    }
                    else {
                        ctx.logger.warn('[persona-innate] LLM 模式 = auto 但无 llm 服务，降级 MockLlm（真实验收待模型 key）');
                        llm = new MockLlm(defaultMockScript());
                    }
                }
                return llm;
            })();
        }
        // 懒解析但调用方（复盘/评测）需要同步返回：这里先同步降级 mock，异步完成后再替换
        if (!cachedLlm) {
            cachedLlm = new MockLlm(defaultMockScript());
            void llmPromise.then((real) => {
                cachedLlm = real;
            });
        }
        return cachedLlm;
    };
    // 每日复盘引擎（llm 懒代理：首个复盘/评测触发时才解析真实 llm）
    const review = new DailyReviewEngine({
        get llm() {
            return resolveLlm();
        },
        selfModel,
        state: stateMachine,
        store,
    });
    /* ════════════ 注入缓存（同步 provider 保住 KV Cache 前缀稳定） ════════════ */
    let injectedText = ''; // M0：记忆注入缓存
    let injectedStateText = ''; // M1：persona-state 缓存
    let injectedSelfModelText = ''; // M1：persona-self-model 缓存
    let injectedContextText = ''; // 阶段一：persona-context 缓存（回合长度/对话类型，描述性）
    /** 当前轮用户消息：作为线索槽输入（不依赖后声明的 recentUserMessages） */
    let lastUserMessage = '';
    const refreshInjection = async () => {
        const snap = await selfModel.load();
        const { text } = await memory.buildInjection(config.injectLimit, snap ?? undefined, {
            cueText: lastUserMessage,
        });
        injectedText = text;
    };
    /** 阶段一：每轮刷新对话上下文注入（描述性事实——用户消息长度、回合长度对比、对话类型）。
     * 由模型自主推断表达节奏，不写任何行为规则。 */
    const refreshContextInjection = () => {
        const last = recentRounds[recentRounds.length - 1];
        const rounds = recentRounds.filter((r) => r.aiLen !== null);
        const avg = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
        const avgUser = avg(rounds.map((r) => r.userLen));
        const avgAi = avg(rounds.map((r) => r.aiLen));
        const lastUserText = recentUserMessages[recentUserMessages.length - 1] ?? '';
        const dlg = classifyDialogue(lastUserText);
        const lines = [
            '【当前对话上下文（描述性信息，非行为指令）】',
            `本轮用户消息：${last?.userLen ?? 0} 字`,
            `近 ${rounds.length} 轮：用户消息平均 ${avgUser} 字 / AI 回复平均 ${avgAi} 字`,
            `对话类型：${dlg.type}${dlg.evidence.length ? `（依据：${dlg.evidence.join('、')}）` : ''}`,
        ];
        injectedContextText = lines.join('\n');
    };
    const refreshStateInjection = async () => {
        const s = await stateMachine.snapshot();
        injectedStateText = [
            '【当前状态（描述性信息，非行为指令）】',
            `模式：${s.mode} · 关系阶段：${s.relationshipStage}`,
            `效价均值：${s.state.valenceMean.toFixed(2)} · 唤醒均值：${s.state.arousalMean.toFixed(2)}`,
            `波动范围：效价 ${s.state.valenceRange.toFixed(2)} / 唤醒 ${s.state.arousalRange.toFixed(2)} · 情境偏移：${s.state.contextOffset.toFixed(2)}`,
        ].join('\n');
    };
    const refreshSelfModelInjection = async () => {
        const snap = await selfModel.load();
        injectedSelfModelText = selfModel.getInjectionSummary(snap);
        // 显著变化（版本递增）时附一行简短当前状态说明——披露一致性（O15）
        if (snap && snap.version > 1) {
            injectedSelfModelText += `\n当前状态：第 ${snap.version} 次自我更新（特质 ${snap.traits.length} 条 / 偏好 ${snap.preferences.length} 条）。`;
        }
    };
    /**
     * "衰减 → 应用"的串行队列。
     * perceiveEvent 被三处以 void 调用（刻意不阻塞对话），同一会话里两轮可能几乎同时到达；
     * 而这条链路是读-改-写，并发会让同一段 dt 被衰减两次、或后写的覆盖前一次的事件更新。
     */
    const enqueueStateApply = createSerialQueue();
    /** 事件感知：先按空闲时长衰减，再让新事件经评价层触发状态转移（异常不打断主流程） */
    const perceiveEvent = async (event) => {
        try {
            await enqueueStateApply(async () => {
                // v0.7：衰减必须发生在事件应用之前。
                // 只有"先衰减再抬升"，效价才会在事件之间回落；顺序反了（先抬再衰减）等于
                // 用空闲时长去打折刚发生的事，反弹后的峰值取决于调用时机而不是情绪本身。
                await decayForIdleGap(stateMachine);
                // TODO(calibrate)：用户目标从近期 user_direct 事件主题派生，自源目标从 self_model 派生
                const snap = await selfModel.load();
                const recent = await memory.list();
                const userGoals = recent
                    .filter((e) => e.provenance === 'user_direct')
                    .slice(-10)
                    .map((e) => e.topic);
                const goals = {
                    user: userGoals,
                    self: [...(snap?.preferences ?? []), ...(snap?.traits ?? [])],
                };
                await stateMachine.apply(event, goals);
                void refreshStateInjection();
            });
        }
        catch (err) {
            ctx.logger.error(err);
        }
    };
    /** 状态机门面：apply/decay/reinforce 后刷新注入缓存（评测行为层走此门面） */
    const stateFacade = {
        appraise: (event, goals) => stateMachine.appraise(event, goals),
        apply: async (event, goals) => {
            const r = await stateMachine.apply(event, goals);
            void refreshStateInjection();
            return r;
        },
        decay: async (dtMs) => {
            const r = await stateMachine.decay(dtMs);
            void refreshStateInjection();
            return r;
        },
        getMode: () => stateMachine.getMode(),
        getRelationshipStage: () => stateMachine.getRelationshipStage(),
        reinforce: async (record) => {
            const r = await stateMachine.reinforce(record);
            void refreshStateInjection();
            return r;
        },
        snapshot: () => stateMachine.snapshot(),
    };
    /* ════════════ 每日复盘调度（reviewHour 深夜静默；异常捕获不打断主流程） ════════════ */
    let reviewCount = 0;
    let reviewTimer = null;
    /** 防重入：定时器 / 启动补跑 / 手动命令并发触发时只能有一个复盘在跑 */
    let reviewInFlight = false;
    /** 上次复盘"没做事"的正当理由（窗口为空/游标不可读）；与门禁拦截区分展示 */
    let lastReviewSkipReason = null;
    /**
     * 上次复盘因超出单次上限而未纳入的更早事件条数。
     * 首次复盘（无游标）会从最早事件起算，历史长时可能撞上 REVIEW_WINDOW_MAX；
     * 截断是必要之恶，但必须让用户看得见——所以在 /persona review 里也回显。
     */
    let lastReviewTruncated = null;
    /** TODO(calibrate)：feedback.inferredAttitude 由 emotionTags 启发式推断 */
    const inferAttitude = (event) => {
        const tags = (event.emotionTags ?? []).join(' ');
        if (/开心|喜欢|满意|感谢|棒|好/.test(tags))
            return 'positive';
        if (/生气|失望|难过|糟糕|差/.test(tags))
            return 'negative';
        return 'neutral';
    };
    /**
     * 复盘执行（唯一入口：定时器 / 启动补跑 / 手动 /persona review 都走这里）。
     *
     * v0.7：窗口改为"游标 → 现在"，并用 runReviewWithCursor 统一管理游标推进，
     * 顺带解决旧的三个故障（UTC 日期切片漏掉本地 02:00–07:59 的事件〔本机 UTC+8 实测〕；
     * 进程不在就丢一整天；手动与定时可对同一天重复提交出两个版本）。
     */
    const runDailyReview = async (opts = {}) => {
        // 幂等/防重入：定时器、启动补跑、手动命令可能同时触发，两条流水线会写两个 self_model 版本
        if (reviewInFlight) {
            lastReviewBlocked = '上一次复盘仍在进行中（跳过本次触发）';
            return null;
        }
        reviewInFlight = true;
        lastReviewSkipReason = null;
        lastReviewTruncated = null;
        try {
            lastReviewBlocked = null;
            // 门禁：auto 模式下 llm 服务未就绪时会降级为脚本化 MockLlm。
            // 若放行，mock 的预设文本（"喜欢先倾听再回应"之类）会被写进真实 self_model
            // 与成长档案——等于用"管线跑通"冒充"人格长出来了"，且一旦写入就无法区分真假。
            // 只有用户显式选择 llmMode=mock（自己知道在跑演练）时才允许提交。
            // 注意：这里提前 return，不进入游标协议 → 被门禁拦下的那一天不会被游标跳过。
            const llmNow = resolveLlm();
            if (llmNow.synthetic && config.llmMode !== 'mock') {
                lastReviewBlocked = 'LLM 处于降级 mock（llm 服务未就绪），不写入自我模型以免污染成长档案';
                ctx.logger.warn('[persona-innate] 复盘跳过：%s', lastReviewBlocked);
                return null;
            }
            const all = await memory.list();
            const selfSnap = await selfModel.load();
            const stSnap = await stateMachine.snapshot();
            const outcome = await runReviewWithCursor({
                store,
                allEvents: all,
                cursorStore: reviewCursor,
                // 只有启动补跑会传 until（窗口上界），手动/定时路径为 undefined → 窗口右端是现在
                ...(opts.until ? { until: opts.until } : {}),
                review: async ({ date, events }) => {
                    const feedback = events
                        .filter((e) => e.provenance === 'user_direct')
                        .map((e) => ({
                        eventId: e.id,
                        response: e.summary,
                        inferredAttitude: inferAttitude(e),
                        time: e.time,
                    }));
                    // M3：跨情境模式计数用全量 events（跨天累积）；窗口内未达阈值的
                    // self_direct 表达仅作情景记忆，不进入强化回路。
                    // M3-2 串联放大修复：按 inductionRisk 分类计数——
                    //   selfPatternCounts 只数 'low'（confirmed clean，参与 3 次固化门槛）；
                    //   'unchecked'（未命中规则/高密度诱导会话）单列，≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 会话才可固化；
                    //   self_correction 的固化由延迟验证（correctionOutcome）决定。
                    const selfPatternCounts = {};
                    const uncheckedPatternCounts = {};
                    const uncheckedPatternDays = {};
                    const uncheckedPatternDates = {};
                    for (const e of all) {
                        // M3 后半：imported（历史导入）事件不参与模式计数——补记忆不补成长
                        if (e.imported)
                            continue;
                        if (e.provenance !== 'self_direct' || !e.selfPattern)
                            continue;
                        const risk = e.inductionRisk ?? 'low';
                        if (risk === 'low') {
                            selfPatternCounts[e.selfPattern] = (selfPatternCounts[e.selfPattern] ?? 0) + 1;
                        }
                        else {
                            uncheckedPatternCounts[e.selfPattern] = (uncheckedPatternCounts[e.selfPattern] ?? 0) + 1;
                            const day = e.time.slice(0, 10);
                            // 跨会话按不同日期近似（M3-2：跨会话才允许 unchecked 固化）
                            if (!uncheckedPatternDays[e.selfPattern])
                                uncheckedPatternDays[e.selfPattern] = new Set();
                            uncheckedPatternDays[e.selfPattern].add(day);
                        }
                    }
                    const uncheckedPatternDatesCount = {};
                    for (const [p, set] of Object.entries(uncheckedPatternDays)) {
                        uncheckedPatternDatesCount[p] = set.size;
                    }
                    const correctionOutcomes = {};
                    for (const e of all) {
                        if (e.provenance === 'self_correction' && e.selfPattern) {
                            correctionOutcomes[e.selfPattern] = correctionOutcome(all, e.selfPattern);
                        }
                    }
                    return review.run({
                        date,
                        events,
                        // v0.6：全量事件用于 threads/attributes 的 sourceEventIds 存在性校验
                        // （只拿窗口事件会把"上周的面试"误判成编造，导致有证据的条目被丢弃）
                        allEvents: all,
                        selfModel: selfSnap,
                        state: stSnap.state,
                        feedback,
                        selfPatternCounts,
                        uncheckedPatternCounts,
                        uncheckedPatternDates: uncheckedPatternDatesCount,
                        correctionOutcomes,
                    });
                },
            });
            if (outcome.kind === 'skipped') {
                lastReviewSkipReason = outcome.reason;
                ctx.logger.info('[persona-innate] 复盘跳过：%s', outcome.reason);
                return null;
            }
            if (outcome.kind === 'failed') {
                lastReviewBlocked = outcome.reason;
                ctx.logger.warn('[persona-innate] 复盘未提交：%s', outcome.reason);
                return null;
            }
            const out = outcome.out;
            reviewCount += 1;
            if (out.selfModel)
                await refreshSelfModelInjection();
            // v0.6：threads 变了 → 未结槽内容也变了，重算一次注入缓存（纯读，不落盘）
            if (out.memoryFacts.persisted)
                void refreshInjection();
            if (outcome.cursorWarning) {
                ctx.logger.warn('[persona-innate] %s（下次可能重复覆盖同一段窗口）', outcome.cursorWarning);
            }
            if (outcome.truncatedEarlier) {
                lastReviewTruncated = outcome.truncatedEarlier;
                // 不静默丢弃：首次复盘从最早事件起算，撞上限时保留最近的，更早的如实报数
                ctx.logger.warn('[persona-innate] 本次复盘窗口超出单次上限 %d 条，有 %d 条更早的事件未纳入（它们仍是记忆，只是本轮不参与成长归纳）', REVIEW_WINDOW_MAX, outcome.truncatedEarlier);
            }
            ctx.logger.info('[persona-innate] 每日复盘完成：mode=%s，窗口 %d 条事件（开始 %s，日期标签 %s），LLM 调用 %d 次（派生 %d 次），self_model v%s，阶段 %s；threads 新建 %d/更新 %d，attributes 新建 %d/取代 %d，丢弃 %d，过期 %d', out.mode, outcome.window.length, outcome.startedAt, out.date, out.cost.llmCalls, out.cost.memoryFactCalls, out.selfModel?.version ?? '（无更新）', out.stage ?? '（skip）', out.memoryFacts.threadsCreated, out.memoryFacts.threadsUpdated, out.memoryFacts.attributesCreated, out.memoryFacts.attributesSuperseded, out.memoryFacts.dropped, out.memoryFacts.expired);
            return out;
        }
        catch (err) {
            ctx.logger.error(err);
            return null;
        }
        finally {
            reviewInFlight = false;
        }
    };
    /**
     * 启动补跑：DSH web 常关，02:00 的定时器不在进程里，那天就永久丢了。
     * 只在"确实有一整段未复盘事件"时触发——每次启动都补的代价是多一次 LLM 调用
     * 与一个 self_model 版本，而 DSH 一天可能启动十几次。
     *
     * `readyAt` 是窗口上界，由插件挂载时同步取的 `bootAt` 传进来（启动工作见下方 runBootTasks）。
     * 补跑补的是"进程不在期间"的缺口；本次会话刚写入的事件不算缺口——
     * 它们既不该让补跑白花一次 LLM 调用，也不该和紧随其后的手动 /persona review
     * 抢同一个窗口（抢输了手动那条会拿到"上一次复盘仍在进行中"）。
     * 没被补跑覆盖到的事件不会丢：游标右端就停在 readyAt，下一次窗口从那里继续。
     */
    const maybeCatchUpReview = async (readyAt) => {
        try {
            const all = await memory.list();
            if (all.length === 0)
                return;
            const loaded = await reviewCursor.load();
            if (!loaded.ok) {
                ctx.logger.warn('[persona-innate] 启动补跑跳过：游标不可读（%s）', loaded.reason);
                return;
            }
            const now = new Date();
            if (!shouldCatchUpReview(loaded.cursor?.lastReviewAt ?? null, now))
                return;
            ctx.logger.info('[persona-innate] 启动补跑复盘：上次复盘 %s，启动前共 %d 条事件', loaded.cursor?.lastReviewAt ?? '（无）', all.length);
            // 窗口为空的情况由 runDailyReview 内部判定（会记 skip 原因），这里不重复判断
            await runDailyReview({ until: readyAt });
        }
        catch (err) {
            ctx.logger.error(err);
        }
    };
    const scheduleNextReview = () => {
        const now = new Date();
        const next = new Date(now);
        next.setHours(config.reviewHour, 0, 0, 0);
        if (next.getTime() <= now.getTime())
            next.setDate(next.getDate() + 1);
        reviewTimer = setTimeout(() => {
            void runDailyReview();
            scheduleNextReview();
        }, Math.max(1000, next.getTime() - now.getTime()));
    };
    // cordis 无 ctx.setInterval：自行管理 timer，fiber dispose 时经 ctx.effect 清理
    ctx.effect(() => {
        if (config.reviewEnabled)
            scheduleNextReview();
        return () => {
            if (reviewTimer)
                clearTimeout(reviewTimer);
            reviewTimer = null;
        };
    });
    /* ════════════ 服务门面（M0 既有，扩展 M1 依赖） ════════════ */
    const service = new PersonaMemoryService(memory, selfModel, stateMachine, () => loadInnateProfile(store, currentModel(ctx, config)), () => Promise.resolve(null));
    ctx.provide('personaMemory', service);
    /* ════════════ 启动工作（替代 app/ready） ════════════
     * DSH 没有 app-ready 类事件：dsh-app-boot 只 emit `app-boot/config-reload`，
     * cordis 也没有 ready 事件。此前两段 `ctx.once('app/ready')` 因此在真实环境下
     * 从不执行——运行期用 CDP 查过，两个 once 钩子一直挂在事件表上没被消费，
     * 连带 EventLog.cache 始终为 null（记忆从未载入）。测试没抓到是因为用例自己
     * 手动 root.emit('app/ready')，把不存在的集成点模拟成了存在的。
     *
     * 改为：挂载时同步取时刻 → 有 llm 就立即跑，没有等 llm 服务 → 再兜底 30s，
     * 保证任何情况下都不会"静默什么都不做"。 */
    /** 启动时刻：同步捕获，先于任何 await。
     * 补跑拿它当窗口上界——晚取会把"启动后几毫秒内写入的事件"当成历史补进去。 */
    const bootAt = new Date();
    let bootStarted = false;
    let bootFallbackTimer = null;
    /** 画像采样（首次启动 / 模型变化重估）；LLM 缺失时降级为待采样 */
    const sampleProfileIfNeeded = async () => {
        const model = currentModel(ctx, config);
        const profile = await loadInnateProfile(store, model);
        if (profile && !profile.needsReestimate) {
            ctx.logger.info('[persona-innate] 画像已存在（%s），跳过采样', profile.sampledAt.slice(0, 10));
            return;
        }
        const llm = await makeLlmAdapter(ctx);
        if (!llm) {
            ctx.logger.warn('[persona-innate] 无 llm 服务，画像采样待定（需要模型或 /persona profile 手动触发）');
            return;
        }
        try {
            const built = await buildInnateProfile(store, { model, rounds: config.sampleRounds }, llm);
            ctx.logger.info('[persona-innate] 先天画像采样完成：%d 轮，识别默认模式 %d 个', built.rounds, built.defaultModes.length);
        }
        catch (err) {
            ctx.logger.error(err);
        }
    };
    /** 阶段一：不依赖 LLM 的注入预热（记忆 / 状态 / 自我模型摘要）。
     * 挂载即跑——正是这一段的"零依赖"保证了启动代码不会再整块静默不执行。
     * 失败降级为空文本，不阻塞启动。 */
    const warmInjections = async () => {
        try {
            await Promise.all([refreshInjection(), refreshStateInjection(), refreshSelfModelInjection()]);
        }
        catch (err) {
            ctx.logger.error(err);
        }
    };
    /** 阶段二：依赖 LLM 的启动工作——预热解析、画像采样、启动补跑。只跑一次。
     * 必须先预热再采样/补跑：否则这一轮拿到的是 mock，会被门禁拦掉、白白推迟一天。 */
    let llmBootStarted = false;
    const runLlmBoot = async () => {
        if (llmBootStarted)
            return;
        llmBootStarted = true;
        try {
            // resolveLlm 是同步接口（复盘 getter 需要同步返回）：首次先给 MockLlm，
            // 真实 adapter 就绪后替换。所以这里要 await 一次，让替换先落地。
            resolveLlm();
            if (llmPromise) {
                try {
                    await llmPromise;
                }
                catch (err) {
                    ctx.logger.warn('[persona-innate] LLM 预热失败：%s', String(err));
                }
            }
            await sampleProfileIfNeeded();
        }
        finally {
            // 补跑放 finally：上面的步骤抛错也不能把补跑一起跳过。fire-and-forget，不阻塞。
            void maybeCatchUpReview(bootAt);
        }
    };
    // 启动入口。顺序上有个硬约束：inject / effect 只能在 apply 期间建立，context 一旦
    // inactive 就会抛 "cannot create effect on inactive context"。所以"等待"必须同步
    // 建立，不能放在 await 之后。
    if (config.llmMode === 'mock') {
        void runLlmBoot();
    }
    else {
        // 服务已在则 cordis 立即回调，不在则等它出现——不假设存在某个"app ready"事件
        // （DSH 没有，那正是之前整块哑掉的原因）。
        ctx.inject(['llm'], () => {
            void runLlmBoot();
        });
        if (!safeLlm(ctx)) {
            ctx.logger.info('[persona-innate] llm 服务尚未就绪：画像采样与启动补跑推迟到它出现后执行');
        }
    }
    // 阶段一跑完就兑现 booted——不等 LLM，调用方（命令 / 测试）不必猜时序。
    void warmInjections().finally(() => {
        service.markBooted();
    });
    /* ════════════ M2：自动记忆提取（session/event → user/message → 确定性规则） ════════════
     * 修复：此前记忆只靠模型主动调 persona_note，高质量对话 0 条入库。
     * 现在订阅会话事件，用户消息命中"经历/情绪信号"即自动落库（provenance=user_direct，
     * 指令性内容仍由 addEvent 剥离检查拒绝），并即时刷新注入缓存。 */
    // 去重缓存：同主题同摘要 10 分钟内不重复记录
    const dedupWindowMs = 10 * 60 * 1000;
    const dedupCache = new Map();
    const handleUserMessage = async (event) => {
        try {
            const check = isExtractableUserMessage(event);
            if (!check.ok)
                return;
            const text = check.text;
            // M3：维护诱导检测上下文（所有真实用户消息，即使未命中提取候选）
            recentUserMessages.push(text);
            if (recentUserMessages.length > maxRecent)
                recentUserMessages.shift();
            // 线索槽输入：这一轮在聊什么（决定"想起哪件旧事"）
            lastUserMessage = text;
            // 阶段一：记录回合长度（描述性注入用：AI 可见自己的回复与用户消息的长度对比）
            recordRound({ userLen: text.length, aiLen: null });
            // 阶段一：优先识别"用户对 AI 表达/风格的反馈"（补感知缺口），否则走普通经历提取
            const cand = extractStyleFeedback(text) ?? extractCandidate(text);
            if (!cand)
                return;
            const key = dedupKey(cand);
            const now = Date.now();
            const last = dedupCache.get(key);
            if (last !== undefined && now - last < dedupWindowMs)
                return;
            dedupCache.set(key, now);
            if (dedupCache.size > 64) {
                for (const [k, ts] of dedupCache) {
                    if (now - ts >= dedupWindowMs)
                        dedupCache.delete(k);
                }
            }
            const res = await memory.addEvent({
                topic: cand.topic,
                summary: cand.summary,
                provenance: 'user_direct',
                importance: cand.importance,
                emotionTags: cand.emotionTags,
            });
            if (!res.rejected) {
                void refreshInjection();
                void perceiveEvent(res.event);
                ctx.logger.info('[persona-innate] 自动记忆提取：%s（importance=%s, tags=%s）', cand.topic, cand.importance, cand.emotionTags.join(',') || '—');
            }
        }
        catch (err) {
            ctx.logger.error(err);
        }
    };
    ctx.on('session/event', (_session, event) => {
        void handleUserMessage(event);
        void handleAssistantMessage(event);
        // 口袋：顺手记下"哪个工具刚失败过"（旁路观测，失败静默）
        void observeToolEvent(event);
    });
    /* ════════════ M3：AI 自身表达提取（assistant 通道，记忆架构口径修正） ════════════
     * 设计文档 events = "双方表达摘要"：AI 自己的立场/情感反应/承诺/边界也沉淀为记忆
     * （provenance: self_direct），复盘"观察自己的行为与表达"与 self_model 自身证据才成立。
     * M3-2 诱导防线：
     * - 规则检测：前 INDUCE_WINDOW 轮用户预设立场型提问 + 本条纯附和（无理由）→ induced
     *   （疑似被诱导：检索降权、不进强化回路）；认错型同意（SELF_CORRECTION）走
     *   self_correction 独立路径；用户纠正句式在匹配前排除，不惩罚用户的正确行为。
     * - 会话级结构判定（sessionInduceRisk）：高密度诱导会话 → 该会话 self_direct 表达标记
     *   inductionRisk='unchecked'，复盘时不与 low 合并计数（防串联放大成"反复模式"）。
     * 单次表达只进 events；跨情境反复模式（≥3 次 / unchecked ≥5 次跨会话）由复盘决定固化。 */
    // 最近用户消息缓冲（M3 诱导检测上下文；16 条仅内存上限，轮次判定用 INDUCE_WINDOW=3）
    const recentUserMessages = [];
    const maxRecent = 16;
    const recentRounds = [];
    const MAX_ROUNDS = 8;
    const recordRound = (r) => {
        const now = Date.now();
        const last = recentRounds[recentRounds.length - 1];
        if (r.userLen !== undefined && r.aiLen === null) {
            // 用户回合：若上一轮 AI 尚未回复（重复事件或连发消息），就近更新 userLen
            if (last && last.aiLen === null) {
                last.userLen = r.userLen;
                last.at = now;
            }
            else {
                recentRounds.push({ userLen: r.userLen, aiLen: null, at: now });
                if (recentRounds.length > MAX_ROUNDS)
                    recentRounds.shift();
            }
        }
        else if (r.aiLen !== undefined && r.aiLen !== null) {
            // AI 回合：补全最近一轮的回复长度
            if (last && last.aiLen === null)
                last.aiLen = r.aiLen;
        }
        refreshContextInjection();
    };
    const handleAssistantMessage = async (event) => {
        try {
            const check = isExtractableAssistantMessage(event);
            if (!check.ok)
                return;
            const text = check.text;
            // 阶段一：记录 AI 回复长度（所有可提取的回复，无论是否命中自我表达）
            recordRound({ aiLen: text.length });
            const cand = extractSelfExpression(text, recentUserMessages);
            if (!cand)
                return;
            const key = dedupKey({ topic: cand.pattern, summary: cand.summary });
            const now = Date.now();
            const last = dedupCache.get(key);
            if (last !== undefined && now - last < dedupWindowMs)
                return;
            dedupCache.set(key, now);
            // M3-2：会话级诱导结构判定 → inductionRisk（self_correction/induced 不参与此判定）
            const inductionRisk = cand.provenance === 'self_direct' ? sessionInduceRisk(recentUserMessages) : undefined;
            const res = await memory.addEvent({
                topic: cand.pattern,
                summary: cand.summary,
                provenance: cand.provenance,
                importance: cand.importance,
                emotionTags: cand.emotionTags,
                strength: cand.strength,
                selfPattern: cand.pattern,
                inductionRisk,
            });
            if (!res.rejected) {
                void refreshInjection();
                void perceiveEvent(res.event);
                ctx.logger.info('[persona-innate] 自动提取自身表达：%s（provenance=%s, strength=%s, importance=%s, risk=%s）', cand.pattern, cand.provenance, cand.strength, cand.importance, inductionRisk ?? '—');
            }
        }
        catch (err) {
            ctx.logger.error(err);
        }
    };
    /** 每轮注入最近记忆（动态上下文：来源可见、低可信降权） */
    ctx.systemPrompt.context({
        name: 'persona-memory',
        order: 150,
        text: () => injectedText,
    });
    /** 阶段一：每轮注入对话上下文（描述性事实：回合长度、对话类型；非行为指令） */
    ctx.systemPrompt.context({
        name: 'persona-context',
        order: 155,
        text: () => injectedContextText,
    });
    /** 每轮注入当前状态摘要（O21：描述性信息，非人格指令） */
    ctx.systemPrompt.context({
        name: 'persona-state',
        order: 160,
        text: () => injectedStateText,
    });
    /** 按需注入自我模型摘要（O21：描述性信息，非人格指令） */
    ctx.systemPrompt.context({
        name: 'persona-self-model',
        order: 170,
        text: () => injectedSelfModelText,
    });
    /** persona_recall：模型检索最近记忆（只读，可并发） */
    ctx.tools.register(defineTool({
        name: 'persona_recall',
        description: 'Recall recent shared memories between you and the user (source-labeled). Use when the user refers to something from the past.',
        parameters: {
            topic: { type: 'string', description: 'Optional topic keyword to filter recalled memories.' },
            limit: { type: 'number', description: 'Max memories to return (default 5).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const k = Math.min(20, Math.max(1, Math.trunc(args.limit ?? 5)));
            const snap = await selfModel.load();
            const { text, events } = await memory.buildInjection(k, snap ?? undefined, {
                // 主题检索时把主题当线索；否则用当前消息，让"想起来"跟着当下话题走
                cueText: args.topic ? String(args.topic) : lastUserMessage,
            });
            if (!text)
                return '(no memories yet)';
            if (args.topic) {
                const q = String(args.topic).toLowerCase();
                const hit = events.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q));
                if (hit.length === 0)
                    return `(no memories matching "${args.topic}")`;
                return hit
                    .map((e) => `- [${provenanceLabel(e.provenance)}] ${e.time.slice(0, 10)} ${e.topic}：${e.summary}`)
                    .join('\n');
            }
            return text;
        },
        isConcurrencySafe: () => true,
    }));
    /** persona_note：模型自源记忆写入（经历通道；指令性内容拒绝写入） */
    ctx.tools.register(defineTool({
        name: 'persona_note',
        description: 'Record a factual shared experience or observation into long-term memory. Never record instructions on how to behave. Use sparingly for things that matter.',
        parameters: {
            topic: { type: 'string', required: true, description: 'Event type / topic, e.g. "user-分享", "观看-视频".' },
            summary: { type: 'string', required: true, description: 'One-sentence factual summary of the event.' },
            importance: { type: 'number', description: 'Importance 0-1 (default 0.5).' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, reason: { type: 'string' } } },
            render: (_args, value) => [
                { type: 'text', text: value.ok ? 'Recorded.' : `Rejected: ${value.reason}` },
            ],
        },
        async execute(args, exec) {
            const res = await memory.addEvent({
                topic: args.topic,
                summary: args.summary,
                provenance: 'inferred',
                importance: args.importance,
            });
            if (!res.rejected) {
                void refreshInjection();
                void perceiveEvent(res.event);
            }
            const session = ctx.get('session');
            session?.append?.('persona/note', {
                topic: args.topic,
                ok: !res.rejected,
                reason: res.reason,
            });
            return { ok: !res.rejected, reason: res.reason };
        },
    }));
    /**
     * persona_pocket：看自己口袋里有哪些工具（只读，可并发）。
     *
     * 唯一事实源是 `ctx.tools.schemas(exec.agent)`——dsh-tools 的公开方法，按调用方
     * scope 投影"这个 agent 现在真正能看见的工具"。因此插件卸载、工具被 scope 限制、
     * 配置换了一套能力之后，这里看到的东西立刻跟着变，不需要任何清理逻辑，
     * 也没有第二份需要同步的清单。
     *
     * 三块信息各自的来源：
     * - 当前有什么：上面的 schemas()；
     * - 掉了什么：pocket-ledger.json（只记"名字 -> 上次见到的日期"，不记权限）；
     * - 什么不好使：observeToolEvent 在 session/event 上观测到的最近失败（进程内）。
     */
    ctx.tools.register(defineTool({
        name: 'persona_pocket',
        description: 'Look inside your own pocket: what you can actually use right now, what disappeared since you last saw it, and what recently failed. Check here before assuming you can or cannot do something.',
        parameters: {
            detail: { type: 'boolean', description: 'Include a one-line description for each tool (default false).' },
            group: { type: 'string', description: 'Only show tools whose name starts with this prefix, e.g. "qqbot".' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, exec) {
            // schemas() 是 dsh-tools 的公开方法，但宿主版本差异下可能不存在：
            // 这里降级成空数组并说明，绝不因为"看不到"就抛错（看不到本身也是一种信息）
            const svc = ctx.tools;
            let tools = [];
            let noToolView = false;
            if (typeof svc.schemas === 'function') {
                try {
                    tools = svc.schemas(exec.agent) ?? [];
                }
                catch (err) {
                    ctx.logger.warn('[persona-innate] persona_pocket 读取工具视图失败：%s', String(err));
                    tools = [];
                    noToolView = true;
                }
            }
            else {
                noToolView = true;
            }
            let ledger = { seen: {} };
            try {
                ledger = (await store.readJson('pocket-ledger.json')) ?? { seen: {} };
            }
            catch (err) {
                // ledger 损坏不该让"我有什么"也一起看不见：降级成空账本，本轮照常报当前能力
                ctx.logger.warn('[persona-innate] pocket-ledger.json 解析失败，按空账本处理：%s', String(err));
            }
            const today = localDateString(new Date());
            const names = tools.map((t) => t.name);
            // missing 用**旧**账本算：新账本里 present 已被刷成今天，就比不出"掉了"
            const missing = missingTools(ledger, names, today);
            const nextLedger = updateLedger(ledger, names, today);
            const now = Date.now();
            const failures = [...pocketFailures.values()]
                .filter((f) => !!f && typeof f.name === 'string')
                // 只报"还在口袋里的工具"的失败：已经掉了的工具归【掉了】那块说
                .filter((f) => names.includes(f.name) && now - f.at <= POCKET_FAILURE_WINDOW_MS)
                .sort((a, b) => b.at - a.at);
            // 写账本失败不影响本次返回：这次看到的能力是真的，账本只是给下次比对的记忆
            void store.writeJson('pocket-ledger.json', nextLedger).catch(() => { });
            const text = renderPocket({
                tools,
                missing,
                failures,
                detail: args.detail === true,
                group: typeof args.group === 'string' ? args.group : undefined,
            });
            return noToolView ? `${text}\n\n（当前宿主不提供工具视图）` : text;
        },
        isConcurrencySafe: () => true,
    }));
    /**
     * /persona：status / profile / state / review / audit / threads / import-chat
     * （记忆写入仅由 AI 侧自主完成；import-chat 为历史会话补记忆；threads 只读派生层）
     */
    ctx.commands.register({
        name: 'persona',
        description: 'View persona-innate status, state machine, run review/audit, inspect innate profile, list open threads/attributes, or import chat history.',
        input: { hint: '[status|profile|state|review|audit|threads|import-chat <会话文件>]' },
        handler: async (invocation) => {
            const raw = invocation.rawInput.trim();
            if (/^import-chat\s/i.test(raw)) {
                const p = raw.replace(/^import-chat\s+/i, '').trim();
                if (!p) {
                    return { kind: 'error', text: '用法：/persona import-chat <会话文件路径>\n支持 DSH v4 会话文件（session.v4.jsonl.zstd）或解压后的 JSONL。' };
                }
                try {
                    const r = await runImportChat(memory, p);
                    void refreshInjection();
                    return {
                        kind: 'success',
                        text: `历史会话导入完成\n帧 ${r.frames} · 消息 ${r.stats.userMessages + r.stats.assistantMessages} 条（user ${r.stats.userMessages} / assistant ${r.stats.assistantMessages}）\n提取事件 ${r.stats.extracted}（新增 ${r.added}，去重/已存在跳过 ${r.skipped}）\n过滤：注入/系统噪音 ${r.stats.injectedSkipped} 条，无可提取信号 ${r.stats.noSignalSkipped} 条\n导入为"补记忆不补成长"：可检索注入，不参与模式计数与成长固化。`,
                    };
                }
                catch (err) {
                    if (err instanceof ImportError) {
                        const hints = {
                            ERR_NODE_VERSION: '升级 Node ≥22，或先用外部工具把 .zstd 解压成 JSONL 再导入。',
                            ERR_FILE_NOT_FOUND: '检查路径是否正确（建议用绝对路径）。',
                            ERR_READ_FAILED: '检查文件权限或文件是否被占用。',
                            ERR_NOT_ZSTD: '确认是 DSH 会话文件（.zstd，v4 格式）；不支持其他压缩格式。',
                            ERR_FRAME_DECOMPRESS: '会话文件可能损坏或截断，请重新导出。',
                            ERR_JSON_PARSE: 'DSH 会话格式可能已升级，当前导入器支持 v4 格式。',
                        };
                        return { kind: 'error', text: `导入失败 [${err.code}]：${err.message}\n建议：${hints[err.code]}` };
                    }
                    return { kind: 'error', text: `导入失败：${err?.message ?? String(err)}` };
                }
            }
            if (/^profile$/i.test(raw)) {
                const model = currentModel(ctx, config);
                let profile = await loadInnateProfile(store, model);
                if (!profile) {
                    // 手动触发采样（首次对话自动采样失败/待定时的兜底入口）
                    const llm = await makeLlmAdapter(ctx);
                    if (!llm) {
                        return { kind: 'success', text: '先天画像：尚未采样，且无 llm 服务（配置模型 key 后重启）。' };
                    }
                    try {
                        const built = await buildInnateProfile(store, { model, rounds: config.sampleRounds }, llm);
                        profile = built;
                        ctx.logger.info('[persona-innate] /persona profile 手动采样完成：%d 轮，默认模式 %d 个', built.rounds, built.defaultModes.length);
                    }
                    catch (err) {
                        ctx.logger.error(err);
                        return { kind: 'error', text: `采样失败：${err?.message ?? String(err)}` };
                    }
                }
                const modes = profile.defaultModes.length === 0
                    ? '（未识别显著默认模式）'
                    : profile.defaultModes
                        .map((m) => `- ${m.name} [${m.action}] 置信 ${(m.confidence * 100).toFixed(0)}%\n  ${m.evidence[0] ?? ''}`)
                        .join('\n');
                return {
                    kind: 'success',
                    text: `先天画像（内部参考，不注入系统提示词）\n采样：${profile.sampledAt.slice(0, 10)} · 模型 ${profile.model} · ${profile.rounds} 轮\n默认模式：\n${modes}`,
                };
            }
            if (/^state$/i.test(raw)) {
                const s = await stateMachine.snapshot();
                return {
                    kind: 'success',
                    text: [
                        '状态机概览',
                        `模式：${s.mode} · 关系阶段：${s.relationshipStage}`,
                        `效价均值：${s.state.valenceMean.toFixed(2)} · 唤醒均值：${s.state.arousalMean.toFixed(2)}`,
                        `波动范围：效价 ${s.state.valenceRange.toFixed(2)} / 唤醒 ${s.state.arousalRange.toFixed(2)} · 情境偏移：${s.state.contextOffset.toFixed(2)}`,
                        `强化记录：${s.reinforcement.length} 条 · 历史快照：${s.history.length} 条`,
                    ].join('\n'),
                };
            }
            if (/^review$/i.test(raw)) {
                const out = await runDailyReview();
                if (!out) {
                    // 窗口为空/游标不可读不是错误，是"这轮没有可复盘的事"：给明确提示而不是报错
                    if (lastReviewSkipReason) {
                        return { kind: 'success', text: `复盘未执行：${lastReviewSkipReason}` };
                    }
                    return {
                        kind: 'error',
                        text: lastReviewBlocked
                            ? `复盘未执行：${lastReviewBlocked}`
                            : '复盘执行异常，详见日志。',
                    };
                }
                const mf = out.memoryFacts;
                const factLine = !mf.ran
                    ? `记忆事实派生：未执行${mf.error ? `（${mf.error}）` : ''}`
                    : `记忆事实派生：threads 新建 ${mf.threadsCreated} / 更新 ${mf.threadsUpdated}；attributes 新建 ${mf.attributesCreated} / 更新 ${mf.attributesUpdated} / 取代 ${mf.attributesSuperseded}；丢弃 ${mf.dropped}${mf.dropped ? `（${Object.entries(mf.dropReasons)
                        .filter(([, n]) => n > 0)
                        .map(([k, n]) => `${k} ${n}`)
                        .join('、')}）` : ''}；过期收敛 ${mf.expired}${mf.persisted ? '' : '；未写盘'}${mf.error ? `；${mf.error}` : ''}`;
                return {
                    kind: 'success',
                    text: [
                        `复盘完成（${out.date}）mode=${out.mode}，LLM 调用 ${out.cost.llmCalls} 次（记忆事实派生另 ${out.cost.memoryFactCalls} 次）`,
                        `事实 ${out.facts.length} 条 · 阶段 ${out.stage ?? '（skip）'}${out.stageTrajectory ? `（${out.stageTrajectory}）` : ''}`,
                        out.selfModel
                            ? `self_model → v${out.selfModel.version}（特质 ${out.selfModel.traits.length} 条 / 偏好 ${out.selfModel.preferences.length} 条）`
                            : 'self_model 无更新（一致性未通过或无 diff）',
                        out.archiveEntry ? `成长档案已追加（${out.archiveEntry.stage}）` : '成长档案未追加',
                        `自源重要性条目 ${out.selfImportance.length} 条`,
                        factLine,
                        ...(lastReviewTruncated
                            ? [
                                `注意：窗口超出单次上限 ${REVIEW_WINDOW_MAX} 条，有 ${lastReviewTruncated} 条更早的事件未纳入本轮成长归纳（仍是记忆，未删除）`,
                            ]
                            : []),
                    ].join('\n'),
                };
            }
            if (/^threads$/i.test(raw)) {
                const t = await factStore.loadThreads();
                const a = await factStore.loadAttributes();
                if (!t.ok || !a.ok) {
                    return {
                        kind: 'error',
                        text: `读取失败：${!t.ok ? t.reason : a.reason}`,
                    };
                }
                const open = t.items.filter((x) => x.status === 'open');
                const threadLines = open.length
                    ? open
                        .slice()
                        .sort((x, y) => (x.lastMentionedAt < y.lastMentionedAt ? 1 : -1))
                        .map((x) => `- ${x.title}（提及 ${x.mentionCount} 次，最近 ${x.lastMentionedAt.slice(0, 10)}${x.dueHint ? `，提示 ${x.dueHint}` : ''}）`)
                        .join('\n')
                    : '（无未结束的事）';
                const active = a.items.filter((x) => x.status === 'active');
                const attrLines = active.length
                    ? active.map((x) => `- ${x.key}：${x.value}（置信 ${(x.confidence * 100).toFixed(0)}%）`).join('\n')
                    : '（无长期事实）';
                return {
                    kind: 'success',
                    text: [
                        `未结束的事（open ${open.length} 条 / 共 ${t.items.length} 条）`,
                        threadLines,
                        '',
                        `长期事实（active ${active.length} 条 / 共 ${a.items.length} 条）`,
                        attrLines,
                    ].join('\n'),
                };
            }
            if (/^audit$/i.test(raw)) {
                try {
                    const llm = resolveLlm();
                    const drift = await runDriftAudit({ llm, state: stateFacade }, { rounds: [1] });
                    const long = await runLongRangeConsistency({ llm, state: stateFacade }, buildAuditScenarios()[0], { rounds: config.auditRounds });
                    const honesty = await runHonestyBaseline({ llm, state: stateFacade }, { ceiling: config.honestyCeiling });
                    await store.writeJson('audit.json', {
                        runAt: new Date().toISOString(),
                        llmMode: config.llmMode,
                        drift,
                        long,
                        honesty,
                    });
                    return {
                        kind: 'success',
                        text: [
                            '评测完成（结果已写 dataDir/audit.json）',
                            `漂移审计：${drift.pass ? 'PASS' : 'FAIL'}（${drift.consistency
                                .map((c) => `${c.category} ${(c.completeRate * 100).toFixed(0)}%`)
                                .join(' / ')}）`,
                            `长程一致性（${long.rounds.join('/')}轮 · ${long.scenarioId}）：driftScore=${long.driftScore.toFixed(2)} → ${long.pass ? 'PASS' : 'FAIL'}`,
                            `诚实基线：假拒绝率 ${(honesty.falseRefusalRate * 100).toFixed(1)}%（上限 ${(honesty.ceiling * 100).toFixed(0)}%）→ ${honesty.pass ? 'PASS' : 'FAIL'}；有害合规率 ${(honesty.harmfulCompliance * 100).toFixed(0)}%`,
                            '注：mock 模式下仅验证结构判定；真实验收需配置模型 key 后重跑。',
                        ].join('\n'),
                    };
                }
                catch (err) {
                    return { kind: 'error', text: `评测执行异常：${err.message}` };
                }
            }
            const s = await service.status();
            const stripSummary = s.strip
                ? `剥离检查 ${s.strip.checked} 次，拒绝 ${s.strip.rejected} 条`
                : '剥离检查未启用';
            return {
                kind: 'success',
                text: `persona-innate M1\n记忆事件：${s.events} 条（每轮注入最近 ${config.injectLimit} 条，来源可见）\n${stripSummary}\n画像：${s.profile ? `已采样（${s.profile.sampledAt.slice(0, 10)}，${s.profile.defaultModes.length} 个默认模式）` : '未采样'}\nself_model：v${s.selfModelVersion}（特质 ${s.traits} 条，保留最近 ${config.selfModelHistoryLimit} 版）\n状态机：模式 ${s.stateMode} · 关系阶段 ${s.relationshipStage} · 强化记录 ${s.reinforcement} 条\n复盘：${config.reviewEnabled ? `已启用（每日 ${config.reviewHour}:00，已执行 ${reviewCount} 次）` : '已关闭'}\n\n/persona state | review | audit | profile | threads`,
            };
        },
    });
    ctx.logger.info('[persona-innate] M1 已加载（dataDir=%s, source=%s, injectLimit=%d, strip=%s, llmMode=%s, review=%s@%d:00）', dataDir, dataDirResolution.source, config.injectLimit, config.stripDirectives, config.llmMode, config.reviewEnabled, config.reviewHour);
}
//# sourceMappingURL=index.js.map