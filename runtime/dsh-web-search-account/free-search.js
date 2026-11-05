/**
 * 免模型的搜索通道：直接抓搜索引擎结果页，解析成 `ctx.web` 的 sources 结构。
 *
 * 为什么需要它：
 *   官方 `web_search` 的实现是「把 query 交给模型 + 服务端搜索工具」，一次搜索就是
 *   一次 Messages 调用（实测 input 9804 / output 867 token）。用户要的是「上网不额外花钱」，
 *   而这个诉求只有两条路能满足：抓已知 URL（web_fetch），或者抓搜索结果页自己解析。
 *
 * 本模块做的是后者：
 *   GET https://cn.bing.com/search?q=...  →  取 HTML  →  解析 `li.b_algo` 块
 *   →  [{ url, title, snippet }]
 *   全程只有一次 HTTP 请求，不经过任何模型，不产生 token 账单。
 *
 * 边界（必须知道）：
 *   - 解析依赖 Bing 的 `li.b_algo` 结构，属**外部契约**。Bing 改版会解析出 0 条——
 *     不会静默返回错误答案，调用方据此回退到账号搜索（见 index.js 的 mode 路由）。
 *   - 摘要来自搜索结果页本身（截断到一两句），不是正文。要正文再 `web_fetch` 那个 URL。
 *   - Bing 在结果页里会用 `/ck/a?...&u=a1<base64>` 中间跳转，这里会还原成真实 URL，
 *     否则模型拿到的链接打不开（那是 Bing 的跳转器，不是目标页）。
 */

/** 默认引擎：国内可直连，实测 HTTP 200 / 约 100KB / `b_algo` 结构稳定。 */
export const DEFAULT_ENDPOINT = 'https://cn.bing.com/search';

/** 默认 UA。带浏览器 UA 与不带 UA 拿到的 HTML 不同，必须显式给。 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_BYTES = 3_000_000;

/** 常见命名实体。数字实体单独处理，不在这里列。 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
};

/** 解 HTML 实体：`&amp;` `&#39;` `&#x4e2d;` 都还原。认不出的原样保留（不猜）。 */
export const decodeEntities = (text) =>
  text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? match : hit;
  });

/** 去标签 + 解实体 + 压空白。Bing 的标题里有 `<strong>` 高亮，摘要里有 `<b>`。 */
export const stripTags = (html) =>
  decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * 还原 Bing 的跳转链接：`https://www.bing.com/ck/a?!&&p=...&u=a1<base64url>&ntb=1`
 * 里的 `u=a1...` 才是目标地址（base64url，前缀 `a1` 表示「URL」）。
 */
export const unwrapBingUrl = (href) => {
  if (!href.includes('/ck/a')) return href;
  const matched = /[?&]u=a1([^&]+)/.exec(href);
  if (matched === null) return href;
  try {
    const base64 = decodeURIComponent(matched[1]).replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    return /^https?:\/\//.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
};

/** 搜索结果里不该出现的东西：Bing 自家页面、广告跳转壳。 */
const isUsableUrl = (url) => {
  if (!/^https?:\/\//.test(url)) return false;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === 'www.bing.com' || host === 'cn.bing.com' || host === 'go.microsoft.com') return false;
  return true;
};

/**
 * 解析 Bing 结果页。按 `li.b_algo` 切块，每块取 `<h2><a href>` 作标题链接，
 * 再按三级候选取摘要（`b_lineclamp` → `b_caption` 内的 `<p>` → 任意首个 `<p>`）。
 *
 * @param {string} html 结果页 HTML
 * @returns {Array<{url: string, title?: string, snippet?: string}>} 去重后的结果，可能为空
 */
export const parseBing = (html) => {
  const chunks = html.split(/<li class="b_algo/i);
  chunks.shift(); // 第一个分片是首个结果块之前的内容
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const anchor = /<h2[^>]*>\s*<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (anchor === null) continue;
    const url = unwrapBingUrl(decodeEntities(anchor[1]));
    if (!isUsableUrl(url) || seen.has(url)) continue;
    const title = stripTags(anchor[2]);
    const snippetMatch =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(chunk) ??
      /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk) ??
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    const snippet = snippetMatch === null ? '' : stripTags(snippetMatch[1]);
    seen.add(url);
    sources.push({
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet.length > 0 ? { snippet } : {}),
    });
  }
  return sources;
};

/** 从 `content-type` 里读字符集，缺省 utf-8。Bing 是 utf-8，留个 gbk 兜底不吃亏。 */
const charsetOf = (contentType) => {
  const matched = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? '');
  if (matched === null) return 'utf-8';
  const label = matched[1].toLowerCase();
  if (label === 'gb2312' || label === 'gbk' || label === 'gb18030') return 'gbk';
  return label;
};

/**
 * 抓一页 HTML。自己开 fetch 而不走 `ctx.web.fetch`，因为那层会把 HTML 转成纯文本，
 * `b_algo` 结构就没了——这里的解析依赖原始标签。
 */
const fetchHtml = async (url, { timeoutMs, userAgent, acceptLanguage, signal }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': acceptLanguage,
      },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const sliced = buffer.byteLength > MAX_BYTES ? buffer.subarray(0, MAX_BYTES) : buffer;
    const charset = charsetOf(response.headers.get('content-type'));
    let html;
    try {
      html = new TextDecoder(charset).decode(sliced);
    } catch {
      html = new TextDecoder('utf-8').decode(sliced);
    }
    return { status: response.status, url: response.url, html, bytes: buffer.byteLength };
  } catch (error) {
    // 取消原样抛出（调用方要能分辨「主动取消」而不是「搜索坏了」）。
    if (error?.name === 'AbortError') throw error;
    // undici 的失败信息只有 "fetch failed"，真正的原因在 cause 里（ECONNREFUSED / ENOTFOUND / 证书…）。
    // 不把 cause 带出来，日志里就只剩一句没用的话。
    const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
    const wrapped = new Error(`搜索页请求失败（${url}）：${reason}`);
    wrapped.code = 'WEB_PROVIDER_ERROR';
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', forwardAbort);
  }
};

/**
 * 免模型搜索：抓结果页 → 解析 → 截断到 `maxResults`。
 *
 * 返回 `sources` 为空**不是异常**，是「这个引擎这次没给出结果」——调用方据此决定
 * 回退到账号搜索还是直接报错。真正的基础设施错误（网络、超时、非 2xx）才抛。
 *
 * @param {string} query 查询词（原样进 `q` 参数，不做改写）
 * @param {object} [options]
 * @returns {Promise<{sources: Array<object>, truncated: boolean, engine: string, bytes: number, status: number}>}
 */
export async function searchFree(query, options = {}) {
  const endpoint = typeof options.endpoint === 'string' && options.endpoint.length > 0 ? options.endpoint : DEFAULT_ENDPOINT;
  const maxResults = Number.isInteger(options.maxResults) && options.maxResults > 0 ? options.maxResults : 10;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const userAgent =
    typeof options.userAgent === 'string' && options.userAgent.length > 0 ? options.userAgent : DEFAULT_USER_AGENT;
  const acceptLanguage = typeof options.acceptLanguage === 'string' && options.acceptLanguage.length > 0
    ? options.acceptLanguage
    : 'zh-CN,zh;q=0.9,en;q=0.8';

  // 多要几条：解析会丢（Bing 的结果块里有广告位、视频位），留余量再截断。
  const wanted = Math.min(Math.max(maxResults * 2, 10), 30);
  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${new URLSearchParams({
    q: query,
    count: String(wanted),
  })}`;

  const page = await fetchHtml(url, { timeoutMs, userAgent, acceptLanguage, signal: options.signal });
  if (page.status < 200 || page.status >= 300) {
    const error = new Error(`搜索页返回 HTTP ${page.status}（${endpoint}）`);
    error.code = 'WEB_PROVIDER_ERROR';
    throw error;
  }
  const parsed = parseBing(page.html);
  const sources = parsed.slice(0, maxResults);
  return {
    sources,
    truncated: parsed.length > sources.length,
    engine: new URL(endpoint).hostname,
    bytes: page.bytes,
    status: page.status,
  };
}
