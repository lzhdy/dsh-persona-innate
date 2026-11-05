# dsh-web-search-account

> **2026-11-05 现状：这个插件的搜索通道已不是主路由。**
> 线上 `web.searchProvider` 现在指向第三方包 `@fffangchenghao/dsh-web-search` 的 `bing`
> （八引擎直抓 + RRF 融合，免 key、零 token）。本插件保留作**回滚路径**与**账号鉴权修复**：
>
> - 切回它：`cordis.patch.yml` 里 `searchProvider: deepseek-search-account`（一行）
> - 切回官方：`searchProvider: deepseek-official`（会重新要求 `DEEPSEEK_API_KEY`）
>
> 切换理由与审计结论见 `docs/issue-register.md` 的 ISS-043。下面保留本插件自身的完整说明。

让 DSH 的 `web_search` **默认不花额度**，同时修掉官方包的账号鉴权门禁。

两件事，一件讲成本，一件讲鉴权。

## 一、成本：官方 `web_search` 必然调模型

用户的直觉是「上网又不是调大模型，凭什么扣余额」。实测结论是：**`web_search` 确实是一次模型调用**。

```
POST https://api.deepseek.com/anthropic/v1/messages
{
  "model": "deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "<query>" }],
  "tools": [{ "type": "web_search_20250305" }]
}
→ usage: { "input_tokens": 9804, "output_tokens": 867,
           "server_tool_use": { "web_search_requests": 1 } }
```

它的形态不是「下载搜索结果页」，而是「把 query 交给模型、由模型决定搜什么、读回正文、再总结」——
那 9804 个输入 token 里绝大部分是搜回来的网页正文。所以按 token 计费是形态决定的，不是插件加的。

| 通道 | 调模型 | 扣额度 | 实测 |
|---|---|---|---|
| 官方 `web_search`（`mode: account`） | 是 | 扣（按 token） | `input 9804 / output 867`，10 条结果，约 4.7s |
| `web_fetch`（官方，独立通道） | 否 | 不扣 | 代码里 `llm` / `messages` / `anthropic` 零命中 |
| **本插件免模型搜索**（默认） | **否** | **不扣** | 抓 `cn.bing.com/search`，约 105KB，解析出 5–10 条，**150–330ms** |

免模型通道的做法见 `free-search.js`：一次 HTTP GET 拿 Bing 结果页，解析 `li.b_algo` 块，
取标题 / 真实 URL / 摘要。它快、免费，代价是**只有标题和一两句摘要，没有正文总结**——
需要正文时再由她 `web_fetch` 那一条 URL（同样不花钱）。

## 二、鉴权：官方包的账号门禁

官方 `@deepseek-ai/dsh-web-search-deepseek` 里有一段门禁：

```js
resolveAccountToken: async (endpoint) => {
  if (ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider !== "deepseek-account") return void 0;
  return await ctx.get("deepseekAccount")?.resolveToken(endpoint);
}
```

只有「当前会话的模型 provider 就是 `deepseek-account`」时才使用账号令牌，否则一律回退去找
`DEEPSEEK_API_KEY`。本机默认模型是 LM Studio 的本地模型（provider = `llama-local`），于是：
账号明明处于登录态，搜索却报 `WebError: WEB_PROVIDER_CREDENTIAL_MISSING`，而 `DEEPSEEK_API_KEY` 从未配置过。

更糟的是这个 provider 的 `available()` 返回 **true**（因为 `resolveAccountToken` 这个函数本身存在），
所以缝合层不会报「不可用」，而是直接选中它、到搜索时才炸——她只能在对话里现场发现搜索坏了。

本插件复用官方 `DeepSeekSearchProvider`，只把「取令牌」换成直接向 `deepseekAccount` 服务要，
注册成独立 provider id（`deepseek-search-account`）。**不修改任何官方文件**，官方插件升级不会覆盖。

## 三种模式

`mode` 在 `cordis.patch.yml` 的插件 config 里改，默认 `free-first`：

| mode | 行为 | 什么时候用 |
|---|---|---|
| `free-first`（默认） | 先免费通道；解析出 0 条或抛错时才回退账号通道 | 日常。省钱，坏日子有兜底 |
| `account` | 只走账号通道（官方行为，一次搜索一次模型调用） | 需要模型总结正文、或免费通道被墙时 |
| `free-only` | 只走免费通道，不回退，失败就报错 | 明确不想花任何额度时 |

其他可调项：`freeEndpoint`（默认 `https://cn.bing.com/search`）、`freeTimeoutMs`（默认 12000）、
`freeUserAgent`、`maxUses`、`maxTokens`、`bootSelfTest`。

恢复官方行为的**一行改动**：

```yaml
- id: web-search-account
  name: 'dsh-web-search-account'
  config:
    mode: account
```

## 部署（一条命令）

```bash
node runtime/dsh-web-search-account/deploy.mjs            # 部署 + 自动补齐 patch 条目
node runtime/dsh-web-search-account/deploy.mjs --check    # 只检查，不写盘（升级后先跑这个）
```

脚本做三件事：把 `package.json` 与插件自身的 `.js`（`index.js`、`free-search.js`）拷进
`<dshHome>/profiles/web/node_modules/dsh-web-search-account/`；检查 `cordis.patch.yml` 有没有
insert 条目与 `web.searchProvider` 覆盖，缺则补上并先备份原文件；打印重启与验证命令。幂等。

手动部署的等价内容（供核对）：

```yaml
# 追加到 ~/.dsh/profiles/web/cordis.patch.yml
# ⚠ 新增插件必须用 insert: 形式；直接写 - id:/name: 会被当成「覆盖已有条目」并报 entry not found
- insert:
    - id: web-search-account
      name: 'dsh-web-search-account'
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search-account
    fetchProvider: http
```

重启后生效。验证：`dsh --profile web --dump-config | grep -A3 web-search-account` 应看到该条目。

## DSH 升级会不会让它失效

| 失效方式 | 触发条件 | 怎么发现 | 怎么恢复 |
|---|---|---|---|
| 包被清掉 | 任何转发 pnpm 的操作（`dsh plugin add/remove` 等）把它当多余包裹清理；它不在 profile `package.json` 的 dependencies 里 | `deploy.mjs --check` 报「未就位」；搜索退回 `WEB_PROVIDER_CREDENTIAL_MISSING` | 重跑 `deploy.mjs` |
| 只丢了 `free-search.js` | 之前用旧版 deploy 只拷了 `index.js` | 启动即报模块找不到（`ERR_MODULE_NOT_FOUND`） | 重跑 `deploy.mjs`（现在会拷全部 `.js`） |
| patch 条目失效 | dsh 改 patch 语法，或 `web` 的 id/name 变了 | `--dump-config` 头部出现 `patch: entry ... not found` | 按新语法改 `cordis.patch.yml` 两段 |
| 内部契约变化 | 官方 `DeepSeekSearchProvider` 改构造签名或 options 字段名（本插件直接 import 该类） | 启动无 `registered` 日志；插件 apply 抛错 | 对照新版源码改 `resolveOptions` 那段；或改用「内联请求实现」摆脱对该类的依赖 |
| Bing 改版 | 结果页不再用 `li.b_algo`，解析出 0 条 | 日志出现 `search-free-empty` 后紧跟 `search`（走了付费兜底），或 `free-only` 下直接报错 | 改 `free-search.js` 的 `parseBing`；或临时 `mode: account` |

**关键事实**：上游 **0.2.2-rc.1 仍然保留**那段账号门禁（逐行核对过），所以升级 dsh **不会**让鉴权问题自动消失，插件仍需保留。
上游哪天改成「只要有账号令牌就用」，鉴权部分即可删除；成本部分（免模型通道）仍然有价值。

## 运行观测

插件把元信息追加到 `~/.dsh/logs/web-search-account.log`（dsh 的 `ctx.logger` 不落文件，
所以另开一个可外部核对的出口）：

| event | 含义 |
|---|---|
| `registered` | 注册成功，记录 `mode`、`freeEndpoint`、账号令牌是否可用 |
| `boot-free-search` | 启动用**免费**通道自检的结果（零 token，每次启动都做） |
| `boot-free-search-failed` | 免费通道自检失败（此时 free-first 会回退，free-only 会报错） |
| `boot-search` / `boot-search-failed` | 纯 `account` 模式下用账号通道自检（**每天至多一次**，重启不叠加消耗） |
| `boot-search-skipped` | 当天已跑过账号自检，本次跳过（不花额度） |
| `search-free` | 一次真实搜索走了免费通道（`sources` / `bytes` / `ms`，**无 token 消耗**） |
| `search-free-empty` | 免费通道抓到页面但解析出 0 条（引擎结构变了的信号） |
| `search-free-failed` | 免费通道请求失败（网络 / 超时 / 非 2xx） |
| `search` / `search-failed` | 走了账号通道（**这次花了额度**）及其失败码 |

`registered` 这行**存在本身**就是证据：注册失败会抛 `WEB_DUPLICATE_PROVIDER` 并中止 apply，那行就不会出现。

自检不许偷偷花钱：免模型模式下自检走免费通道；只有 `mode: account` 才用账号通道自检，且每天至多一次。

## 回滚

删 `cordis.patch.yml` 里上面两段 → 删 `node_modules/dsh-web-search-account/` → 重启。
回滚后搜索恢复为「报 `WEB_PROVIDER_CREDENTIAL_MISSING`」的原状。

## 已知边界

- **免模型通道只拿得到结果页的摘要**，不是正文。跨多源综合、需要长文推理的问题，`mode: account` 质量更好。
- 解析依赖 Bing 的结果页结构（`li.b_algo`），属外部契约，Bing 改版会失效——不会静默给出错答案，
  而是 `search-free-empty` + 回退。
- Bing 结果页里有 `/ck/a?...&u=a1<base64>` 中间跳转，已还原成真实 URL；否则模型拿到的是跳转器地址，打不开。
- 账号额度只能在平台看：`https://platform.deepseek.com/usage`（官方 `getState()` 的 `usageUrl` 指向 `/usage`）。
  dsh 代码里没有「剩余搜索次数」这个概念。
- 账号令牌失效时回退 `DEEPSEEK_API_KEY`，两条都无才报凭据缺失——不静默失败。
- 依赖官方类的构造签名 `new DeepSeekSearchProvider(() => options)`。官方若改签名，这里要跟。
- `web_fetch` 用的是匿名抓取（`web-fetch-http`），对 Google / 百度百科 / 维基等站点的失败属
  **网络与反爬层面**（实测换成 Chrome UA 仍 403），不是配置问题。所以「查资料」应当用 `web_search`。
- 它只是**工具**，不是**身体**：搜到的内容目前不写记忆（`tool_output` 零写入方，见项目问题清单 ISS-042）。
  身体（M4）要补的是能力注册 + 事件上报 + 权限开关，检索逻辑可直接复用这里。
