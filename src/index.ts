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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { JsonStore } from './store.js';
import { PersonaMemory, type AddResult } from './memory.js';
import { buildInnateProfile, loadInnateProfile } from './innate.js';
import { provenanceLabel } from './provenance.js';
import { extractCandidate, extractStyleFeedback, classifyDialogue, dedupKey, isExtractableUserMessage, extractSelfExpression, isExtractableAssistantMessage, sessionInduceRisk } from './extract.js';
import { MockLlm, defaultMockScript } from './llm-client.js';
import { SelfModelService } from './self-model.js';
import { PersonaStateMachine } from './state.js';
import { DailyReviewEngine, correctionOutcome } from './review.js';
import { runDriftAudit, runLongRangeConsistency, runHonestyBaseline, buildAuditScenarios } from './eval.js';
import { runImportChat, ImportError, type ImportErrorCode } from './import-chat.js';
import { resolveDataDir } from './paths.js';
import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  writeFile as nodeWriteFile,
  stat as nodeStat,
} from 'node:fs/promises';
import { relative as nodeRelative, resolve as nodeResolve } from 'node:path';
import type {
  AppraisalGoals,
  FsLike,
  LlmClient,
  LlmLike,
  PersonaEvent,
  StateMachineLike,
  UserFeedback,
} from './types.js';

/** DSH 服务的最小类型面（tools/systemPrompt/llm 由各自服务包声明，此处只补缺省项） */
declare module '@deepseek-ai/cordis' {
  interface Context {
    personaMemory: PersonaMemoryService;
    fs: unknown;
    commands: {
      register(opts: {
        name: string;
        description: string;
        input?: { hint?: string };
        recordInput?: boolean;
        handler: (invocation: {
          rawInput: string;
          agent?: unknown;
          signal?: AbortSignal;
        }) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string };
      }): unknown;
    };
    session: { append(type: string, data: unknown): unknown };
    agentDefaultModel?: unknown;
  }
  interface Events {
    'app/ready'(): void;
    /** dsh-session 广播：会话日志追加（含 user/message）；本插件只读监听，无需注入 session 服务 */
    'session/event'(session: unknown, event: unknown): void;
  }
}

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
  constructor(
    readonly memory: PersonaMemory,
    /** M1：自我模型服务（版本化叙事，可回滚） */
    readonly selfModel: SelfModelService,
    /** M1：情绪状态机（效价×唤醒 + 模式 + 关系阶段） */
    readonly stateMachine: PersonaStateMachine,
    private readonly loadProfile: () => Promise<import('./types.js').InnateProfile | null>,
    private readonly triggerSample: () => Promise<import('./types.js').InnateProfile | null>,
  ) {}

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
function makeFsAdapter(fs: unknown): FsLike {
  const anyFs = fs as {
    resolve?: (p: string) => Promise<unknown>;
    readText?: (t: unknown) => Promise<string>;
    writeText?: (t: unknown, c: string) => Promise<unknown>;
    stat?: (t: unknown) => Promise<unknown>;
    mkdir?: (p: string, o: { recursive: boolean }) => Promise<unknown>;
  };
  return {
    async mkdir(path, opts) {
      if (anyFs.mkdir) await anyFs.mkdir(path, opts);
    },
    async readText(path) {
      const target = anyFs.resolve ? await anyFs.resolve(path) : path;
      return anyFs.readText!(target as never);
    },
    async writeText(path, content) {
      const target = anyFs.resolve ? await anyFs.resolve(path) : path;
      return anyFs.writeText!(target as never, content);
    },
    async exists(path) {
      try {
        const target = anyFs.resolve ? await anyFs.resolve(path) : path;
        return anyFs.stat ? (await anyFs.stat(target as never)) !== undefined : true;
      } catch {
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
function makeNodeFsAdapter(): FsLike {
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
      } catch {
        return false;
      }
    },
  };
}

/**
 * 判断数据目录是否位于工作区可写根内。
 * 在内 → 用 ctx.fs（保持沙箱保护）；在外（dshHome 等）→ 用 node:fs 绕过 fence。
 */
function isInsideWorkspace(root: string, workspaceRoot: string): boolean {
  const rel = nodeRelative(nodeResolve(workspaceRoot), nodeResolve(root));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

/** 安全提取 llm 服务（优先 ctx.get，兼容 ctx.llm 注入；代理 ctx 访问属性可能抛错） */
function safeLlm(ctx: Context): unknown {
  try {
    const g = (ctx as { get?: (name: string) => unknown }).get;
    if (typeof g === 'function') {
      const v = g('llm');
      if (v) return v;
    }
  } catch {
    /* 忽略 */
  }
  try {
    return (ctx as unknown as { llm?: unknown }).llm;
  } catch {
    return undefined;
  }
}

/** ctx.llm → LlmLike 适配（真实 dsh-llm：prepareCall + stream；兼容 request/chat；失败由调用方兜底） */
async function makeLlmAdapter(ctx: Context): Promise<LlmLike | null> {
  const llm = safeLlm(ctx) as
    | {
        prepareCall?: (
          config: Record<string, unknown>,
          signal?: AbortSignal,
          configure?: (controls: Record<string, unknown>, model: unknown) => Record<string, unknown>,
        ) => Promise<{
          config: Record<string, unknown>;
          stream: (options: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
        }>;
        request?: (opts: unknown) => Promise<unknown>;
        chat?: (opts: unknown) => Promise<unknown>;
      }
    | undefined;
  if (!llm) return null;
  const extract = (res: unknown): string => {
    const r = res as {
      content?: string;
      message?: { content?: string };
      choices?: { message?: { content?: string } }[];
    };
    if (typeof r.content === 'string') return r.content;
    if (typeof r.message?.content === 'string') return r.message.content;
    if (r.choices?.[0]?.message?.content) return r.choices[0].message.content;
    return String(res ?? '');
  };
  return {
    async request({ prompt, system, temperature }) {
      // 真实 dsh-llm：prepareCall → stream（官方推荐；聚合 text block）
      if (typeof llm.prepareCall === 'function') {
        const selection = defaultModelSelection(ctx);
        const signal = AbortSignal.timeout(90_000);
        const prepared = await llm.prepareCall(
          {
            provider: selection?.provider ?? 'deepseek-account',
            model: selection?.model ?? 'deepseek-flash',
            ...(temperature !== undefined ? {} : {}),
            maxTokens: 2048,
          },
          signal,
        );
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
          assembler.push(chunk as never);
        }
        const text = (assembler.blocks() as { type?: string; text?: string }[])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        return { content: text };
      }
      // 兼容形态（测试/mock 注入）
      if (typeof llm.request === 'function') return { content: extract(await llm.request({ prompt, system, temperature })) };
      if (typeof llm.chat === 'function') return { content: extract(await llm.chat({ prompt, system, temperature })) };
      throw new Error('llm 服务不支持 prepareCall/request/chat');
    },
  };
}

/** 从默认模型服务提取 provider+model（real dsh-llm 路由所需） */
function defaultModelSelection(ctx: Context): { provider: string; model: string } | null {
  try {
    const adm = ctx.get('agentDefaultModel') as {
      currentSelection?: () => { provider?: string; model?: string } | string;
    } | undefined;
    const sel = adm?.currentSelection?.();
    if (sel && typeof sel === 'object') {
      if (sel.provider && sel.model) return { provider: sel.provider, model: sel.model };
      if (typeof sel.model === 'string') return { provider: 'deepseek-account', model: sel.model };
    }
    if (typeof sel === 'string' && sel) return { provider: 'deepseek-account', model: sel };
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 从上下文提取模型名（画像重估检测用） */
function currentModel(ctx: Context, config: Schemastery.TypeT<typeof Config>): string {
  if (config.model) return config.model;
  const adm = ctx.get('agentDefaultModel') as { currentSelection?: () => string | { model?: string } } | undefined;
  try {
    const sel = adm?.currentSelection?.();
    if (typeof sel === 'string' && sel) return sel;
    if (sel && typeof sel === 'object' && sel.model) return sel.model;
  } catch {
    /* 忽略 */
  }
  return '';
}

export function apply(ctx: Context, config: Schemastery.TypeT<typeof Config>) {
  const dataDirResolution = resolveDataDir(config.dataDir, (msg) => ctx.logger.warn(msg));
  const dataDir = dataDirResolution.root;
  // fs 通道：数据目录在工作区可写根内走 ctx.fs（沙箱保护）；在 dshHome 等工作区外走 node:fs
  // （fs-sandbox 会拒绝工作区外写入，node:fs 与官方 storage 持久化同口径）。
  let workspaceRoot: string | undefined;
  try {
    workspaceRoot = (ctx as { sandboxPolicy?: { workspaceRoot?: string } }).sandboxPolicy?.workspaceRoot;
  } catch {
    workspaceRoot = undefined;
  }
  const useNodeFs = !workspaceRoot || !isInsideWorkspace(dataDir, workspaceRoot);
  const fsAdapter = useNodeFs ? makeNodeFsAdapter() : makeFsAdapter(ctx.fs);
  ctx.logger.info('[persona-innate] 持久化通道：%s（dataDir=%s, source=%s）', useNodeFs ? 'node:fs' : 'ctx.fs', dataDir, dataDirResolution.source);
  const store = new JsonStore(fsAdapter, dataDir);
  const memory = new PersonaMemory(store, {
    stripDirectives: config.stripDirectives,
    injectLimit: config.injectLimit,
  });

  /* ════════════ M1 构造（在 M0 存储之上增量接线） ════════════ */

  // self_model：注意 load() 在新库上直接落盘种子 v1，集成时勿重复 seed
  const selfModel = new SelfModelService(store, { historyLimit: config.selfModelHistoryLimit });

  // 状态机 onRuleChange：重大事件改变转移规则 → 叙事解释写入 self_model（§8，fire-and-forget）
  const stateMachine = new PersonaStateMachine(store, {
    onRuleChange: async (rule, narrative, evidence) => {
      try {
        await selfModel.commitFromSources(
          { narrative },
          evidence,
          ['continuity'],
          `规则变更叙事：${rule}`,
        );
        void refreshSelfModelInjection();
      } catch (err) {
        ctx.logger.error(err);
      }
    },
  });

  // LLM 解析（懒解析 + 缓存）：auto → ctx.llm 适配，无则 MockLlm；mock → 强制 MockLlm
  let cachedLlm: LlmClient | null = null;
  let llmPromise: Promise<LlmClient> | null = null;
  const resolveLlm = (): LlmClient => {
    if (cachedLlm) return cachedLlm;
    if (!llmPromise) {
      llmPromise = (async () => {
        let llm: LlmClient;
        if (config.llmMode === 'mock') {
          ctx.logger.info('[persona-innate] LLM 模式 = mock：真实验收待模型 key 配置后重启');
          llm = new MockLlm(defaultMockScript());
        } else {
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
          } else {
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

  const refreshInjection = async () => {
    const snap = await selfModel.load();
    const { text } = await memory.buildInjection(config.injectLimit, snap ?? undefined);
    injectedText = text;
  };

  /** 阶段一：每轮刷新对话上下文注入（描述性事实——用户消息长度、回合长度对比、对话类型）。
   * 由模型自主推断表达节奏，不写任何行为规则。 */
  const refreshContextInjection = () => {
    const last = recentRounds[recentRounds.length - 1];
    const rounds = recentRounds.filter((r) => r.aiLen !== null);
    const avg = (xs: number[]) =>
      xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
    const avgUser = avg(rounds.map((r) => r.userLen));
    const avgAi = avg(rounds.map((r) => r.aiLen as number));
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

  /** 事件感知：新事件经评价层触发状态转移（异常回退默认人格，不打断主流程） */
  const perceiveEvent = async (event: PersonaEvent) => {
    try {
      // TODO(calibrate)：用户目标从近期 user_direct 事件主题派生，自源目标从 self_model 派生
      const snap = await selfModel.load();
      const recent = await memory.list();
      const userGoals = recent
        .filter((e) => e.provenance === 'user_direct')
        .slice(-10)
        .map((e) => e.topic);
      const goals: AppraisalGoals = {
        user: userGoals,
        self: [...(snap?.preferences ?? []), ...(snap?.traits ?? [])],
      };
      await stateMachine.apply(event, goals);
      void refreshStateInjection();
    } catch (err) {
      ctx.logger.error(err);
    }
  };

  /** 状态机门面：apply/decay/reinforce 后刷新注入缓存（评测行为层走此门面） */
  const stateFacade: StateMachineLike = {
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
  let reviewTimer: ReturnType<typeof setTimeout> | null = null;

  /** TODO(calibrate)：feedback.inferredAttitude 由 emotionTags 启发式推断 */
  const inferAttitude = (event: PersonaEvent): UserFeedback['inferredAttitude'] => {
    const tags = (event.emotionTags ?? []).join(' ');
    if (/开心|喜欢|满意|感谢|棒|好/.test(tags)) return 'positive';
    if (/生气|失望|难过|糟糕|差/.test(tags)) return 'negative';
    return 'neutral';
  };

  const runDailyReview = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const all = await memory.list();
      const events = all.filter((e) => e.time.slice(0, 10) === today); // TODO(calibrate)：当日窗口
      const selfSnap = await selfModel.load();
      const stSnap = await stateMachine.snapshot();
      const feedback: UserFeedback[] = events
        .filter((e) => e.provenance === 'user_direct')
        .map((e) => ({
          eventId: e.id,
          response: e.summary,
          inferredAttitude: inferAttitude(e),
          time: e.time,
        }));
      // M3：跨情境模式计数用全量 events（跨天累积）；当日窗口内未达阈值的
      // self_direct 表达仅作情景记忆，不进入强化回路。
      // M3-2 串联放大修复：按 inductionRisk 分类计数——
      //   selfPatternCounts 只数 'low'（confirmed clean，参与 3 次固化门槛）；
      //   'unchecked'（未命中规则/高密度诱导会话）单列，≥UNCHECKED_FIX_THRESHOLD 且跨 ≥2 会话才可固化；
      //   self_correction 的固化由延迟验证（correctionOutcome）决定。
      const selfPatternCounts: Record<string, number> = {};
      const uncheckedPatternCounts: Record<string, number> = {};
      const uncheckedPatternDays: Record<string, Set<string>> = {};
      const uncheckedPatternDates: Record<string, number> = {};
      for (const e of all) {
        // M3 后半：imported（历史导入）事件不参与模式计数——补记忆不补成长
        if (e.imported) continue;
        if (e.provenance !== 'self_direct' || !e.selfPattern) continue;
        const risk = e.inductionRisk ?? 'low';
        if (risk === 'low') {
          selfPatternCounts[e.selfPattern] = (selfPatternCounts[e.selfPattern] ?? 0) + 1;
        } else {
          uncheckedPatternCounts[e.selfPattern] = (uncheckedPatternCounts[e.selfPattern] ?? 0) + 1;
          const day = e.time.slice(0, 10);
          const days = new Set<string>([day]);
          // 跨会话按不同日期近似（M3-2：跨会话才允许 unchecked 固化）
          if (!uncheckedPatternDays[e.selfPattern]) uncheckedPatternDays[e.selfPattern] = new Set<string>();
          uncheckedPatternDays[e.selfPattern].add(day);
        }
      }
      const uncheckedPatternDatesCount: Record<string, number> = {};
      for (const [p, set] of Object.entries(uncheckedPatternDays)) {
        uncheckedPatternDatesCount[p] = set.size;
      }
      const correctionOutcomes: Record<string, 'pending' | 'confirmed' | 'downgraded'> = {};
      for (const e of all) {
        if (e.provenance === 'self_correction' && e.selfPattern) {
          correctionOutcomes[e.selfPattern] = correctionOutcome(all, e.selfPattern);
        }
      }
      const out = await review.run({
        date: today,
        events,
        selfModel: selfSnap,
        state: stSnap.state,
        feedback,
        selfPatternCounts,
        uncheckedPatternCounts,
        uncheckedPatternDates: uncheckedPatternDatesCount,
        correctionOutcomes,
      });
      reviewCount += 1;
      if (out.selfModel) await refreshSelfModelInjection();
      ctx.logger.info(
        '[persona-innate] 每日复盘完成：mode=%s，LLM 调用 %d 次，self_model v%s，阶段 %s',
        out.mode,
        out.cost.llmCalls,
        out.selfModel?.version ?? '（无更新）',
        out.stage ?? '（skip）',
      );
      return out;
    } catch (err) {
      ctx.logger.error(err);
      return null;
    }
  };

  const scheduleNextReview = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(config.reviewHour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    reviewTimer = setTimeout(() => {
      void runDailyReview();
      scheduleNextReview();
    }, Math.max(1000, next.getTime() - now.getTime()));
  };

  // cordis 无 ctx.setInterval：自行管理 timer，fiber dispose 时经 ctx.effect 清理
  ctx.effect(() => {
    if (config.reviewEnabled) scheduleNextReview();
    return () => {
      if (reviewTimer) clearTimeout(reviewTimer);
      reviewTimer = null;
    };
  });

  /* ════════════ 服务门面（M0 既有，扩展 M1 依赖） ════════════ */

  const service = new PersonaMemoryService(
    memory,
    selfModel,
    stateMachine,
    () => loadInnateProfile(store, currentModel(ctx, config)),
    () => Promise.resolve(null),
  );
  ctx.provide('personaMemory', service);

  /** 画像采样（首次启动 / 模型变化重估）；LLM 缺失时降级为待采样 */
  ctx.once('app/ready', async () => {
    await refreshInjection();
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
      ctx.logger.info(
        '[persona-innate] 先天画像采样完成：%d 轮，识别默认模式 %d 个',
        built.rounds,
        built.defaultModes.length,
      );
    } catch (err) {
      ctx.logger.error(err);
    }
  });

  /** M1 注入预热：状态 + 自我模型摘要（失败降级为空文本，不阻塞启动） */
  ctx.once('app/ready', async () => {
    try {
      await Promise.all([refreshStateInjection(), refreshSelfModelInjection()]);
    } catch (err) {
      ctx.logger.error(err);
    }
  });

  /* ════════════ M2：自动记忆提取（session/event → user/message → 确定性规则） ════════════
   * 修复：此前记忆只靠模型主动调 persona_note，高质量对话 0 条入库。
   * 现在订阅会话事件，用户消息命中"经历/情绪信号"即自动落库（provenance=user_direct，
   * 指令性内容仍由 addEvent 剥离检查拒绝），并即时刷新注入缓存。 */

  // 去重缓存：同主题同摘要 10 分钟内不重复记录
  const dedupWindowMs = 10 * 60 * 1000;
  const dedupCache = new Map<string, number>();

  const handleUserMessage = async (event: unknown) => {
    try {
      const check = isExtractableUserMessage(event);
      if (!check.ok) return;
      const text = check.text;
      // M3：维护诱导检测上下文（所有真实用户消息，即使未命中提取候选）
      recentUserMessages.push(text);
      if (recentUserMessages.length > maxRecent) recentUserMessages.shift();
      // 阶段一：记录回合长度（描述性注入用：AI 可见自己的回复与用户消息的长度对比）
      recordRound({ userLen: text.length, aiLen: null });
      // 阶段一：优先识别"用户对 AI 表达/风格的反馈"（补感知缺口），否则走普通经历提取
      const cand = extractStyleFeedback(text) ?? extractCandidate(text);
      if (!cand) return;
      const key = dedupKey(cand);
      const now = Date.now();
      const last = dedupCache.get(key);
      if (last !== undefined && now - last < dedupWindowMs) return;
      dedupCache.set(key, now);
      if (dedupCache.size > 64) {
        for (const [k, ts] of dedupCache) {
          if (now - ts >= dedupWindowMs) dedupCache.delete(k);
        }
      }
      const res: AddResult = await memory.addEvent({
        topic: cand.topic,
        summary: cand.summary,
        provenance: 'user_direct',
        importance: cand.importance,
        emotionTags: cand.emotionTags,
      });
      if (!res.rejected) {
        void refreshInjection();
        void perceiveEvent(res.event);
        ctx.logger.info(
          '[persona-innate] 自动记忆提取：%s（importance=%s, tags=%s）',
          cand.topic,
          cand.importance,
          cand.emotionTags.join(',') || '—',
        );
      }
    } catch (err) {
      ctx.logger.error(err);
    }
  };

  ctx.on('session/event', (_session, event) => {
    void handleUserMessage(event);
    void handleAssistantMessage(event);
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
  const recentUserMessages: string[] = [];
  const maxRecent = 16;

  /* 阶段一：回合长度记录（描述性注入用——AI 可见自己的回复与用户消息的长度对比，
   * 由模型自主推断"该短、该贴近"，不写任何行为规则） */
  interface RoundLen {
    userLen: number;
    aiLen: number | null;
    at: number;
  }
  const recentRounds: RoundLen[] = [];
  const MAX_ROUNDS = 8;
  const recordRound = (r: { userLen?: number; aiLen?: number | null }) => {
    const now = Date.now();
    const last = recentRounds[recentRounds.length - 1];
    if (r.userLen !== undefined && r.aiLen === null) {
      // 用户回合：若上一轮 AI 尚未回复（重复事件或连发消息），就近更新 userLen
      if (last && last.aiLen === null) {
        last.userLen = r.userLen;
        last.at = now;
      } else {
        recentRounds.push({ userLen: r.userLen, aiLen: null, at: now });
        if (recentRounds.length > MAX_ROUNDS) recentRounds.shift();
      }
    } else if (r.aiLen !== undefined && r.aiLen !== null) {
      // AI 回合：补全最近一轮的回复长度
      if (last && last.aiLen === null) last.aiLen = r.aiLen;
    }
    refreshContextInjection();
  };

  const handleAssistantMessage = async (event: unknown) => {
    try {
      const check = isExtractableAssistantMessage(event);
      if (!check.ok) return;
      const text = check.text;
      // 阶段一：记录 AI 回复长度（所有可提取的回复，无论是否命中自我表达）
      recordRound({ aiLen: text.length });
      const cand = extractSelfExpression(text, recentUserMessages);
      if (!cand) return;
      const key = dedupKey({ topic: cand.pattern, summary: cand.summary } as never);
      const now = Date.now();
      const last = dedupCache.get(key);
      if (last !== undefined && now - last < dedupWindowMs) return;
      dedupCache.set(key, now);
      // M3-2：会话级诱导结构判定 → inductionRisk（self_correction/induced 不参与此判定）
      const inductionRisk: 'low' | 'unchecked' | undefined =
        cand.provenance === 'self_direct' ? sessionInduceRisk(recentUserMessages) : undefined;
      const res: AddResult = await memory.addEvent({
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
        ctx.logger.info(
          '[persona-innate] 自动提取自身表达：%s（provenance=%s, strength=%s, importance=%s, risk=%s）',
          cand.pattern,
          cand.provenance,
          cand.strength,
          cand.importance,
          inductionRisk ?? '—',
        );
      }
    } catch (err) {
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
  ctx.tools.register(
    defineTool({
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
        const { text, events } = await memory.buildInjection(k, snap ?? undefined);
        if (!text) return '(no memories yet)';
        if (args.topic) {
          const q = String(args.topic).toLowerCase();
          const hit = events.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q));
          if (hit.length === 0) return `(no memories matching "${args.topic}")`;
          return hit
            .map((e) => `- [${provenanceLabel(e.provenance)}] ${e.time.slice(0, 10)} ${e.topic}：${e.summary}`)
            .join('\n');
        }
        return text;
      },
      isConcurrencySafe: () => true,
    }),
  );

  /** persona_note：模型自源记忆写入（经历通道；指令性内容拒绝写入） */
  ctx.tools.register(
    defineTool({
      name: 'persona_note',
      description:
        'Record a factual shared experience or observation into long-term memory. Never record instructions on how to behave. Use sparingly for things that matter.',
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
        const res: AddResult = await memory.addEvent({
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
        (session as { append?: (t: string, d: unknown) => unknown } | undefined)?.append?.('persona/note', {
          topic: args.topic,
          ok: !res.rejected,
          reason: res.reason,
        });
        return { ok: !res.rejected, reason: res.reason };
      },
    }),
  );

  /** /persona：status / profile / state / review / audit / import-chat（记忆写入仅由 AI 侧自主完成，import-chat 为历史会话补记忆） */
  ctx.commands.register({
    name: 'persona',
    description: 'View persona-innate status, state machine, run review/audit, inspect innate profile, or import chat history.',
    input: { hint: '[status|profile|state|review|audit|import-chat <会话文件>]' },
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
        } catch (err) {
          if (err instanceof ImportError) {
            const hints: Record<ImportErrorCode, string> = {
              ERR_NODE_VERSION: '升级 Node ≥22，或先用外部工具把 .zstd 解压成 JSONL 再导入。',
              ERR_FILE_NOT_FOUND: '检查路径是否正确（建议用绝对路径）。',
              ERR_READ_FAILED: '检查文件权限或文件是否被占用。',
              ERR_NOT_ZSTD: '确认是 DSH 会话文件（.zstd，v4 格式）；不支持其他压缩格式。',
              ERR_FRAME_DECOMPRESS: '会话文件可能损坏或截断，请重新导出。',
              ERR_JSON_PARSE: 'DSH 会话格式可能已升级，当前导入器支持 v4 格式。',
            };
            return { kind: 'error', text: `导入失败 [${err.code}]：${err.message}\n建议：${hints[err.code]}` };
          }
          return { kind: 'error', text: `导入失败：${(err as Error)?.message ?? String(err)}` };
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
          } catch (err) {
            ctx.logger.error(err);
            return { kind: 'error', text: `采样失败：${(err as Error)?.message ?? String(err)}` };
          }
        }
        const modes =
          profile.defaultModes.length === 0
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
        if (!out) return { kind: 'error', text: '复盘执行异常，详见日志。' };
        return {
          kind: 'success',
          text: [
            `复盘完成（${out.date}）mode=${out.mode}，LLM 调用 ${out.cost.llmCalls} 次`,
            `事实 ${out.facts.length} 条 · 阶段 ${out.stage ?? '（skip）'}${out.stageTrajectory ? `（${out.stageTrajectory}）` : ''}`,
            out.selfModel
              ? `self_model → v${out.selfModel.version}（特质 ${out.selfModel.traits.length} 条 / 偏好 ${out.selfModel.preferences.length} 条）`
              : 'self_model 无更新（一致性未通过或无 diff）',
            out.archiveEntry ? `成长档案已追加（${out.archiveEntry.stage}）` : '成长档案未追加',
            `自源重要性条目 ${out.selfImportance.length} 条`,
          ].join('\n'),
        };
      }
      if (/^audit$/i.test(raw)) {
        try {
          const llm = resolveLlm();
          const drift = await runDriftAudit({ llm, state: stateFacade }, { rounds: [1] });
          const long = await runLongRangeConsistency(
            { llm, state: stateFacade },
            buildAuditScenarios()[0],
            { rounds: config.auditRounds },
          );
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
        } catch (err) {
          return { kind: 'error', text: `评测执行异常：${(err as Error).message}` };
        }
      }
      const s = await service.status();
      const stripSummary = s.strip
        ? `剥离检查 ${s.strip.checked} 次，拒绝 ${s.strip.rejected} 条`
        : '剥离检查未启用';
      return {
        kind: 'success',
        text: `persona-innate M1\n记忆事件：${s.events} 条（每轮注入最近 ${config.injectLimit} 条，来源可见）\n${stripSummary}\n画像：${s.profile ? `已采样（${s.profile.sampledAt.slice(0, 10)}，${s.profile.defaultModes.length} 个默认模式）` : '未采样'}\nself_model：v${s.selfModelVersion}（特质 ${s.traits} 条，保留最近 ${config.selfModelHistoryLimit} 版）\n状态机：模式 ${s.stateMode} · 关系阶段 ${s.relationshipStage} · 强化记录 ${s.reinforcement} 条\n复盘：${config.reviewEnabled ? `已启用（每日 ${config.reviewHour}:00，已执行 ${reviewCount} 次）` : '已关闭'}\n\n/persona state | review | audit | profile`,
      };
    },
  });

  ctx.logger.info(
    '[persona-innate] M1 已加载（dataDir=%s, source=%s, injectLimit=%d, strip=%s, llmMode=%s, review=%s@%d:00）',
    dataDir,
    dataDirResolution.source,
    config.injectLimit,
    config.stripDirectives,
    config.llmMode,
    config.reviewEnabled,
    config.reviewHour,
  );
}
