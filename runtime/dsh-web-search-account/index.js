/**
 * dsh-web-search-account —— 让 `web_search` 用账号登录态鉴权，而不是要求 DEEPSEEK_API_KEY。
 *
 * 为什么需要它：
 *   官方 `@deepseek-ai/dsh-web-search-deepseek` 的 `resolveAccountToken` 有一条门禁——
 *   只有「当前会话 provider === 'deepseek-account'」时才使用账号令牌，否则一律要求
 *   `DEEPSEEK_API_KEY`。本机默认模型是 LM Studio 本地模型（provider = llama-local），
 *   于是账号明明处于登录态、搜索却报 `WEB_PROVIDER_CREDENTIAL_MISSING`。
 *
 * 本插件做了什么：
 *   复用官方 `DeepSeekSearchProvider`（请求体构造、错误映射、结果去重与片段拼接全部沿用官方实现，
 *   不复制），只把「取令牌」这一步换成直接向 `deepseekAccount` 服务要。注册成独立 provider id，
 *   由 profile 的 cordis.patch.yml 选中。**不修改任何官方文件**，插件升级不会失效。
 *
 * 代价与边界：
 *   - 搜索消耗的是该账号自己的额度（与「用 DeepSeek Account 模型时」同源），不存在额外计费口径。
 *   - 若账号未登录 / 令牌过期，`resolveToken` 返回 undefined，此时回退到 `DEEPSEEK_API_KEY`
 *     （凭据服务或启动环境变量），两条路都没有才报凭据缺失——不会静默失败。
 */

import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/**
 * 运行期观测：dsh 的 `ctx.logger` 不落文件，插件日志在文件里看不到。
 * 这里直接追加一行 JSONL，让「注册成功 / 令牌是否可用 / 每次搜索的结果数」可被外部核对。
 * 只记元信息，不记查询正文之外的内容，也不记令牌。
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
 * 读观测日志，取最后一次**真正发起过**启动自检的本地日期（`boot-search` / `boot-search-failed`）。
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

  /**
   * 兼容 seam 的接口演进：上游 0.2.2 起把「这条路由上的搜索有没有可发的凭据」抽成
   * provider 的 `ready()`，没有凭据时干脆不把工具暴露给模型，而不是让它现场报错。
   * 这里对齐官方 `searchConfigured()` 的语义，但账号服务尚未注册时返回 true（乐观）——
   * 启动早期误判为 false 会让工具整个会话都不可用，代价比"调用时才发现没凭据"更大。
   */
  provider.ready = async () => {
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

  // 注册失败（例如 id 冲突）会抛 WEB_DUPLICATE_PROVIDER，整段 apply 中止——
  // 因此下面那行 registered 日志的「存在」本身就证明注册成功。
  ctx.web.registerSearchProvider(provider);

  /** 包一层 search：记录结果条数，让「搜索到底有没有走这条路」可被外部核对。 */
  const search = provider.search.bind(provider);
  provider.search = async (request, signal) => {
    const startedAt = Date.now();
    try {
      const result = await search(request, signal);
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

  // 启动自检：只报「有没有拿到令牌」和「真搜一次能不能出结果」，不打印令牌。
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
          baseURL,
          model,
          accountToken: ok ? 'ok' : 'missing',
        });
        ctx.logger?.info?.(
          '[web-search-account] 已注册 %s（baseURL=%s），账号令牌：%s',
          PROVIDER_ID,
          baseURL,
          ok ? 'ok' : '不可用，将回退 DEEPSEEK_API_KEY',
        );

        // 启动真搜一次：这是「搜索能力当前是否可用」的唯一硬证据。
        // 但**每天最多一次**——搜索走账号额度，重启不应反复消耗。
        // 关闭方式：config.bootSelfTest = false。
        if (ok && config.bootSelfTest !== false) {
          const today = localDate();
          const lastDay = await lastBootSearchDate();
          if (lastDay === today) {
            await note({ event: 'boot-search-skipped', reason: 'already-ran-today', date: today });
          } else {
            const startedAt = Date.now();
            try {
              const result = await provider.search({ query: 'deepseek harness', maxResults: 3 });
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
          }
        }
      } catch (error) {
        await note({ event: 'self-check-failed', provider: PROVIDER_ID, message: String(error?.message ?? error).slice(0, 200) });
        ctx.logger?.warn?.('[web-search-account] 账号令牌自检失败：%s', String(error));
      }
    })();
  });
}
