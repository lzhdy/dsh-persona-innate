# dsh-web-search-account

让 DSH 的 `web_search` 用 **DeepSeek 账号登录态**鉴权，而不是要求 `DEEPSEEK_API_KEY`。

## 为什么需要它

官方 `@deepseek-ai/dsh-web-search-deepseek` 里有一段门禁（`resolveOptions`）：

```js
resolveAccountToken: async (endpoint) => {
  if (ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider !== "deepseek-account") return void 0;
  return await ctx.get("deepseekAccount")?.resolveToken(endpoint);
}
```

只有「当前会话的模型 provider 就是 `deepseek-account`」时才使用账号令牌，否则一律回退去找
`DEEPSEEK_API_KEY`。本机默认模型是 LM Studio 的本地模型（provider = `llama-local`），于是：

- 账号明明处于登录态（`~/.dsh/.credentials.yaml` 里有 `deepseek-account-platform/default` 的 grant）；
- 搜索却报 `WebError: WEB_PROVIDER_CREDENTIAL_MISSING`；
- 而 `DEEPSEEK_API_KEY` 从来没配置过。

更糟的是这个 provider 的 `available()` 返回 **true**（因为 `resolveAccountToken` 这个函数本身存在），
所以缝合层不会报「不可用」，而是直接选中它、到搜索时才炸——模型只能在对话里现场发现搜索坏了。

## 做了什么

复用官方 `DeepSeekSearchProvider`（请求体构造、错误映射、结果去重与片段拼接全部沿用官方实现，
不复制代码），只把「取令牌」换成直接向 `deepseekAccount` 服务要，注册成**独立 provider id**
（`deepseek-search-account`），由 profile 的 `cordis.patch.yml` 选中。

**不修改任何官方文件**，官方插件升级不会覆盖这里。

## 部署（两步）

```bash
# 1. 放包（不做 pnpm add：那会触发整库重装，可能把 persona 插件重下来）
cp -r ./ /c/Users/<你>/.dsh/profiles/web/node_modules/dsh-web-search-account/
```

```yaml
# 2. 追加到 ~/.dsh/profiles/web/cordis.patch.yml（注意：新增插件必须用 insert: 形式，
#    直接写 - id: / name: 会被当成「覆盖已有条目」并报 entry not found）
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

## 运行观测

插件把元信息追加到 `~/.dsh/logs/web-search-account.log`（dsh 的 `ctx.logger` 不落文件，
所以另开一个可外部核对的出口）。三类事件：

| event | 含义 |
|---|---|
| `registered` | 模块导入 + provider 注册成功，且账号令牌当时可用（`accountToken: "ok"`） |
| `boot-search` | 启动自检真搜一次的结果条数（默认开启，`config.bootSelfTest: false` 可关） |
| `search` / `search-failed` | 每次真实搜索的结果条数 / 失败码 |

`registered` 这行**存在本身**就是证据：注册失败会抛 `WEB_DUPLICATE_PROVIDER` 并中止 apply，
那行就不会出现。

## 回滚

删 `cordis.patch.yml` 里上面两段 → 删 `node_modules/dsh-web-search-account/` → 重启。
回滚后搜索恢复为「报 `WEB_PROVIDER_CREDENTIAL_MISSING`」的原状。

## 已知边界

- 搜索消耗该 DeepSeek 账号自身额度，与「用 DeepSeek Account 模型时」同源。
- 账号令牌失效（未登录 / 过期）时回退 `DEEPSEEK_API_KEY`，两条都无才报凭据缺失——不静默失败。
- 依赖官方类的构造签名 `new DeepSeekSearchProvider(() => options)`。官方若改签名，这里要跟。
- 本插件解决的是**搜索**；`web_fetch` 用的是匿名抓取（`web-fetch-http`），对 Google / 百度百科 /
  维基等站点的失败属**网络与反爬层面**（实测：换成 Chrome UA 仍 403），不是配置问题。
  这正是「应该用 web_search 而不是抓搜索结果页」的原因。
