/**
 * dsh-web-search-account —— 让 `web_search` 可用，并且默认**不花额度**。
 *
 * 它解决两个独立的问题：
 *
 * 一、鉴权（官方包的账号门禁）
 *   官方 `@deepseek-ai/dsh-web-search-deepseek` 的 `resolveAccountToken` 有一条门禁——
 *   只有「当前会话 provider === 'deepseek-account'」时才使用账号令牌，否则一律要求
 *   `DEEPSEEK_API_KEY`。本机默认模型是 LM Studio 本地模型（provider = llama-local），
 *   于是账号明明处于登录态、搜索却报 `WEB_PROVIDER_CREDENTIAL_MISSING`。
 *
 * 二、成本（官方通道必然调模型）
 *   官方 `web_search` 的形态是「query 交给模型 + 服务端搜索工具」，实测一次搜索
 *   input 9804 / output 867 token——**它本来就是一次模型调用**，按 token 扣额度。
 *   所以真正的「免费上网」只有两条路：抓已知 URL（`web_fetch`，本来就不调模型），
 *   或者抓搜索结果页自己解析（见 free-search.js）。
 *
 * 本插件因此提供两种通道，由 `mode` 决定路由：
 *
 *   free-first（默认）  先走免模型通道（HTTP 抓 Bing 结果页 + 解析），零 token；
 *                       解析不出结果时才回退到账号通道。日常不花钱，坏日子有兜底。
 *   account            只走账号通道（官方行为，一次搜索一次模型调用）。
 *   free-only          只走免模型通道，不回退——出问题就报错，绝不偷偷花钱。
 *
 * 实现上复用官方 `DeepSeekSearchProvider`（请求体构造、错误映射、去重与片段拼接全部沿用
 * 官方实现，不复制），只把「取令牌」换成直接向 `deepseekAccount` 服务要，注册成独立
 * provider id。**不修改任何官方文件**，插件升级不会失效。
 */

import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { searchFree, DEFAULT_ENDPOINT, DEFAULT_USER_AGENT } from './free-search.js';

export const name = 'dsh-web-search-account';

/** 依赖 web 能力缝合层（`ctx.web`）。 */
export const inject = ['web'];

/** 独立 provider id：不能与官方的 `deepseek-official` / `deepseek-search-api` 重名。 */
const PROVIDER_ID = 'deepseek-search-account';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_USES = 5;
const API_KEY_ENV = 'DEEPSEEK_API_KEY';

const MODES = new Set(['free-first', 'account', 'free-only']);

/** 构造带 `code` 的错误，让缝合层与工具层能把它当 provider 错误渲染。 */
const webError = (message, code = 'WEB_PROVIDER_ERROR') => {
  const error = new Error(message);
  error.code = code;
  return error;
};

/**
 * 运行期观测：dsh 的 `ctx.logger` 不落文件，插件日志在文件里看不到。
 * 这里直接追加一行 JSONL，让「注册成功 / 令牌是否可用 / 每次搜索走了哪条通道、花了多少」可被外部核对。
 * 只记元信息，不记令牌。
 */
const LOG_DIR = join(homedir(), '.dsh', 'logs');
const LOG_FILE = join(LOG_DIR, 'web-search-account.log');
const note = async (record) => {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8');
  } catch {
    /* 观测失败不影响搜索本身 */
  }
};

/** 本地日期（YYYY-MM-DD），用于「启动自检每天最多一次」的判定。 */
const localDate = (at = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

/**
 * 读观测日志，取最后一次**真正发起过**账号通道启动自检的本地日期（`boot-search` / `boot-search-failed`）。
 * 跳过 `boot-search-skipped`，否则跳过记录会把「今天已跑过」永久续期。无日志返回 null。
 */
const lastBootSearchDate = async () => {
  try {
    const text = await readFile(LOG_FILE, 'utf8');
    const lines = text.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"boot-search')) continue;
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.event !== 'boot-search' && parsed.event !== 'boot-search-failed') continue;
        if (typeof parsed.ts === 'string') return localDate(new Date(parsed.ts));
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 无日志等同没跑过 */
  }
  return null;
};

export function apply(ctx, config = {}) {
  const baseURL = typeof config.baseURL === 'string' && config.baseURL.length > 0
    ? config.baseURL
    : DEFAULT_BASE_URL;
  const model = typeof config.model === 'string' && config.model.length > 0 ? config.model : DEFAULT_MODEL;
  const apiVersion = typeof config.apiVersion === 'string' && config.apiVersion.length > 0
    ? config.apiVersion
    : DEFAULT_API_VERSION;
  const maxTokens = Number.isInteger(config.maxTokens) && config.maxTokens > 0 ? config.maxTokens : DEFAULT_MAX_TOKENS;
  const maxUses = Number.isInteger(config.maxUses) && config.maxUses > 0 ? config.maxUses : DEFAULT_MAX_USES;

  const mode = MODES.has(config.mode) ? config.mode : 'free-first';
  const freeEndpoint = typeof config.freeEndpoint === 'string' && config.freeEndpoint.length > 0
    ? config.freeEndpoint
    : DEFAULT_ENDPOINT;
  const freeTimeoutMs = Number.isInteger(config.freeTimeoutMs) && config.freeTimeoutMs > 0
    ? config.freeTimeoutMs
    : 12000;
  const freeUserAgent = typeof config.freeUserAgent === 'string' && config.freeUserAgent.length > 0
    ? config.freeUserAgent
    : DEFAULT_USER_AGENT;

  /** 免模型通道是否参与路由。 */
  const usesFree = mode === 'free-first' || mode === 'free-only';
  /** 免模型通道解析不出结果时，是否允许回退到账号通道（只有 free-first 允许）。 */
  const allowsFallback = mode === 'free-first';

  /** 问账号服务要令牌；未登录 / 令牌不适用于该 endpoint 时返回 undefined。 */
  const accountToken = async (endpoint) => {
    const account = ctx.get('deepseekAccount');
    if (account === undefined || typeof account.resolveToken !== 'function') return undefined;
    const token = await account.resolveToken(endpoint);
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  };

  /** 账号态不可用时的回退：凭据服务里显式配置的 API key。 */
  const configuredApiKey = async () => {
    const credentials = ctx.get('credentials');
    if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined;
    const resolved = await credentials.resolve(API_KEY_ENV);
    const value = resolved?.value;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const provider = new DeepSeekSearchProvider(() => ({
    resolveAccountToken: accountToken,
    resolveApiKey: configuredApiKey,
    apiKeyEnv: API_KEY_ENV,
    baseURL,
    model,
    apiVersion,
    maxTokens,
    maxUses,
  }));

  // 官方类的 id 是固定字段（'deepseek-official'），注册前改成自己的 id，
  // 否则缝合层会以 WEB_DUPLICATE_PROVIDER 拒绝。
  provider.id = PROVIDER_ID;

  /** 官方搜索实现（一次模型调用）。先抓住原始引用，后面路由要直接用它。 */
  const paidSearch = provider.search.bind(provider);
  const paidAvailable = provider.available.bind(provider);

  /**
   * 可用性检查（缝合层要求：**不许发网络请求**）。
   * 免模型通道的选择是配置层面的确定事实，直接返回 true 不算撒谎；
   * 它的真实健康度由 `boot-free-search` 与每次 `search-free-*` 日志给出。
   */
  provider.available = () => (usesFree ? true : paidAvailable());

  /**
   * 兼容 seam 的接口演进：上游 0.2.2 起把「这条路由上的搜索有没有可发的凭据」抽成
   * provider 的 `ready()`，没有凭据时干脆不把工具暴露给模型，而不是让它现场报错。
   *
   *   - 免模型通道不需要任何凭据 → true。
   *   - 只走账号通道时对齐官方 `searchConfigured()` 语义；账号服务尚未注册时返回 true（乐观），
   *     启动早期误判为 false 会让工具整个会话都不可用，代价比「调用时才发现没凭据」更大。
   */
  provider.ready = async () => {
    if (usesFree) return true;
    try {
      const account = ctx.get('deepseekAccount');
      if (account === undefined) return true;
      const token = await accountToken(`${baseURL}/messages`);
      if (token !== undefined) return true;
      return (await configuredApiKey()) !== undefined;
    } catch {
      return false;
    }
  };

  /**
   * 搜索路由。这是本插件的核心：同一个 `web_search` 工具，按 mode 决定走哪条通道。
   *
   *   free-first：先免费后付费。免费通道抛错或解析出 0 条 → 回退账号通道。
   *   free-only ：只免费。免费通道失败就原样报错，绝不静默花钱。
   *   account   ：只付费。官方行为。
   */
  provider.search = async (request, signal) => {
    const startedAt = Date.now();

    if (usesFree) {
      try {
        const free = await searchFree(request.query, {
          maxResults: request.maxResults,
          endpoint: freeEndpoint,
          timeoutMs: freeTimeoutMs,
          userAgent: freeUserAgent,
          signal,
        });
        if (free.sources.length > 0) {
          await note({
            event: 'search-free',
            provider: PROVIDER_ID,
            engine: free.engine,
            sources: free.sources.length,
            bytes: free.bytes,
            ms: Date.now() - startedAt,
          });
          return { sources: free.sources, truncated: free.truncated };
        }
        // 解析出 0 条 = 引擎结果页结构变了或该词无结果。不是崩溃，但要留证据。
        await note({
          event: 'search-free-empty',
          provider: PROVIDER_ID,
          engine: free.engine,
          bytes: free.bytes,
          ms: Date.now() - startedAt,
        });
      } catch (error) {
        // 调用方主动取消：不吞、不回退，直接抛。
        if (error?.name === 'AbortError' || signal?.aborted === true) throw error;
        await note({
          event: 'search-free-failed',
          provider: PROVIDER_ID,
          code: error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 200),
          ms: Date.now() - startedAt,
        });
        if (!allowsFallback) throw webError(`免模型搜索失败：${String(error?.message ?? error)}`);
      }
      if (!allowsFallback) {
        throw webError(`免模型搜索没有返回结果（${freeEndpoint}），free-only 模式不回退账号通道`);
      }
    }

    try {
      const result = await paidSearch(request, signal);
      await note({ event: 'search', provider: PROVIDER_ID, sources: result.sources.length, ms: Date.now() - startedAt });
      return result;
    } catch (error) {
      await note({
        event: 'search-failed',
        provider: PROVIDER_ID,
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 200),
        ms: Date.now() - startedAt,
      });
      throw error;
    }
  };

  // 注册失败（例如 id 冲突）会抛 WEB_DUPLICATE_PROVIDER，整段 apply 中止——
  // 因此下面那行 registered 日志的「存在」本身就证明注册成功。
  ctx.web.registerSearchProvider(provider);

  // 启动自检：报「走的是哪条通道」+「真搜一次能不能出结果」，不打印令牌。
  // 必须等 deepseekAccount 服务就绪再查——apply 阶段账号平台可能还没起来，
  // 此时 ctx.get('deepseekAccount') 是 undefined，会误报 missing。
  // 注意：搜索路径本身是「调用时取令牌」，不受这个时序影响。
  ctx.inject(['deepseekAccount'], (readyCtx) => {
    void (async () => {
      try {
        const account = readyCtx.get('deepseekAccount');
        const token = typeof account?.resolveToken === 'function'
          ? await account.resolveToken(`${baseURL}/messages`)
          : undefined;
        const ok = typeof token === 'string' && token.length > 0;
        await note({
          event: 'registered',
          provider: PROVIDER_ID,
          mode,
          baseURL,
          model,
          freeEndpoint: usesFree ? freeEndpoint : null,
          accountToken: ok ? 'ok' : 'missing',
        });
        ctx.logger?.info?.(
          '[web-search-account] 已注册 %s（mode=%s，免费通道=%s），账号令牌：%s',
          PROVIDER_ID,
          mode,
          usesFree ? freeEndpoint : '未启用',
          ok ? 'ok' : '不可用',
        );

        if (config.bootSelfTest === false) return;

        // 自检策略随 mode 走，核心原则：**自检不许偷偷花钱**。
        //   免模型模式 → 用免费通道自检（零 token），每次启动都做，因为不花钱。
        //   纯账号模式 → 用账号通道自检，但每天最多一次（重启不叠加消耗）。
        if (usesFree) {
          const startedAt = Date.now();
          try {
            const free = await searchFree('deepseek harness', {
              maxResults: 3,
              endpoint: freeEndpoint,
              timeoutMs: freeTimeoutMs,
              userAgent: freeUserAgent,
            });
            await note({
              event: 'boot-free-search',
              provider: PROVIDER_ID,
              engine: free.engine,
              sources: free.sources.length,
              bytes: free.bytes,
              ms: Date.now() - startedAt,
            });
          } catch (error) {
            await note({
              event: 'boot-free-search-failed',
              provider: PROVIDER_ID,
              code: error?.code ?? null,
              message: String(error?.message ?? error).slice(0, 200),
              ms: Date.now() - startedAt,
            });
          }
          return;
        }

        if (!ok) return;
        const today = localDate();
        const lastDay = await lastBootSearchDate();
        if (lastDay === today) {
          await note({ event: 'boot-search-skipped', reason: 'already-ran-today', date: today });
          return;
        }
        const startedAt = Date.now();
        try {
          const result = await paidSearch({ query: 'deepseek harness', maxResults: 3 });
          await note({ event: 'boot-search', provider: PROVIDER_ID, sources: result.sources.length, ms: Date.now() - startedAt });
        } catch (error) {
          await note({
            event: 'boot-search-failed',
            provider: PROVIDER_ID,
            code: error?.code ?? null,
            message: String(error?.message ?? error).slice(0, 200),
            ms: Date.now() - startedAt,
          });
        }
      } catch (error) {
        await note({ event: 'self-check-failed', provider: PROVIDER_ID, message: String(error?.message ?? error).slice(0, 200) });
        ctx.logger?.warn?.('[web-search-account] 账号令牌自检失败：%s', String(error));
      }
    })();
  });
}
