#!/usr/bin/env node
/**
 * free-search.js 的自检（不需要 dsh 运行时，也不需要联网）。
 *
 * 为什么单独留一份：解析逻辑依赖 Bing 的结果页结构，属**外部契约**——它坏掉的时候
 * 不会抛错，只会静默返回 0 条。所以这里用一份固化的 HTML 夹具把「解析出几条、
 * 标题/摘要/URL 对不对、实体和跳转链接是否还原」钉住；Bing 改版时先跑这个，
 * 失败就说明是解析层，而不是网络层。
 *
 * 用法：node runtime/dsh-web-search-account/self-test.mjs
 */

import http from 'node:http';
import { decodeEntities, parseBing, searchFree, stripTags, unwrapBingUrl } from './free-search.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

// ── 纯函数 ────────────────────────────────────────────────────────────────
check('命名实体', decodeEntities('a &amp; b &nbsp;c') === 'a & b  c', decodeEntities('a &amp; b &nbsp;c'));
check('十进制实体', decodeEntities('&#39;q&#39;') === "'q'", decodeEntities('&#39;q&#39;'));
check('十六进制实体', decodeEntities('&#x4e2d;') === '中', decodeEntities('&#x4e2d;'));
check('未知实体原样保留', decodeEntities('&notareal;') === '&notareal;');
check('去标签 + 压空白', stripTags('<strong>标题</strong>\n  多余') === '标题 多余', stripTags('<strong>标题</strong>\n  多余'));
check('非跳转链接不动', unwrapBingUrl('https://example.com/x') === 'https://example.com/x');

const wrapped = 'https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9i&ntb=1';
check('Bing 跳转链接还原', unwrapBingUrl(wrapped) === 'https://example.com/b', unwrapBingUrl(wrapped));
check('坏 base64 原样返回', unwrapBingUrl('https://www.bing.com/ck/a?u=a1!!!') === 'https://www.bing.com/ck/a?u=a1!!!');

// ── 结果页解析 ────────────────────────────────────────────────────────────
const FIXTURE = `<!doctype html><html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/a">标题 A &amp; 实体</a></h2>
  <div class="b_caption"><p class="b_lineclamp2">摘要 A &lt;b&gt;内容&lt;/b&gt;</p></div></li>
<li class="b_algo b_algoBorder"><h2><a href="${wrapped}">标题 B</a></h2>
  <div class="b_caption"><p>摘要 B</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/a">重复 A</a></h2><p>dup</p></li>
<li class="b_algo"><h2><a href="https://www.bing.com/images">Bing 自家页面</a></h2><p>x</p></li>
<li class="b_algo"><h2>没有链接的块</h2><p>x</p></li>
</ol></body></html>`;

const parsed = parseBing(FIXTURE);
check('解析出 2 条（去重 + 剔除 Bing 自家页 + 剔除无链接块）', parsed.length === 2, `${parsed.length} 条`);
check('首条 URL', parsed[0]?.url === 'https://example.com/a', parsed[0]?.url);
check('首条标题解实体', parsed[0]?.title === '标题 A & 实体', parsed[0]?.title);
check('首条摘要取 b_lineclamp', parsed[0]?.snippet === '摘要 A <b>内容</b>', parsed[0]?.snippet);
check('次条跳转链接已还原', parsed[1]?.url === 'https://example.com/b', parsed[1]?.url);
check('空页面解析出 0 条（不是抛错）', parseBing('<html><body>无结果</body></html>').length === 0);

// ── searchFree 端到端（本地夹具服务器）─────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url?.includes('http500') === true) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end('boom');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/search`;

const ok = await searchFree('任意词', { endpoint, maxResults: 1 });
check('searchFree 请求带 q 参数', ok.status === 200);
check('maxResults 生效', ok.sources.length === 1, `${ok.sources.length} 条`);
check('truncated 标记', ok.truncated === true);
check('engine 记录主机名', ok.engine === '127.0.0.1', ok.engine);

let httpError;
try {
  await searchFree('任意词', { endpoint: `${endpoint}/http500` });
} catch (error) {
  httpError = error;
}
check('非 2xx 抛 WEB_PROVIDER_ERROR', httpError?.code === 'WEB_PROVIDER_ERROR', httpError?.message);

let netError;
try {
  await searchFree('任意词', { endpoint: 'http://127.0.0.1:1/search' });
} catch (error) {
  netError = error;
}
check('连不上时带出底层原因（不是光一句 fetch failed）', /ECONNREFUSED|请求失败/.test(netError?.message ?? ''), netError?.message);

server.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
