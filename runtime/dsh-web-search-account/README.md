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

## 部署（一条命令）

```bash
node runtime/dsh-web-search-account/deploy.mjs            # 部署 + 自动补齐 patch 条目
node runtime/dsh-web-search-account/deploy.mjs --check    # 只检查，不写盘（升级后先跑这个）
```

脚本做三件事：把 `package.json` / `index.js` 拷进 `<dshHome>/profiles/web/node_modules/dsh-web-search-account/`；
检查 `cordis.patch.yml` 有没有 insert 条目与 `web.searchProvider` 覆盖，缺则补上并先备份原文件；打印重启与验证命令。
幂等，重复跑不会重复插 YAML。

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

分三种情况，风险从高到低：

| 失效方式 | 触发条件 | 怎么发现 | 怎么恢复 |
|---|---|---|---|
| 包被清掉 | 任何转发 pnpm 的操作（`dsh plugin add/remove` 等）把它当多余包裹清理；它不在 profile `package.json` 的 dependencies 里 | `deploy.mjs --check` 报「未就位」；搜索退回 `WEB_PROVIDER_CREDENTIAL_MISSING` | 重跑 `deploy.mjs` |
| patch 条目失效 | dsh 改 patch 语法，或 `web` 的 id/name 变了 | `--dump-config` 头部出现 `patch: entry ... not found` | 按新语法改 `cordis.patch.yml` 两段 |
| 内部契约变化 | 官方 `DeepSeekSearchProvider` 改构造签名或 options 字段名（本插件直接 import 该类） | 启动无 `registered` 日志；插件 apply 抛错 | 对照新版源码改 `resolveOptions` 那段；或改用「内联请求实现」摆脱对该类的依赖 |

**关键事实**：上游 **0.2.2-rc.1 仍然保留**那段账号门禁（`if (provider !== 'deepseek-account') return undefined`，逐行核对过），
所以升级 dsh **不会**让这个问题自动消失，插件仍需保留。上游哪天改成「只要有账号令牌就用」，本插件即可删除。

已做的加固：给 provider 补了 `ready()`（对齐 0.2.2 新增的 seam 约定，无凭据时不把工具暴露给模型，
而不是让它现场报错）；启动自检每天最多一次（重启不叠加消耗）；`deploy.mjs` 一条命令恢复。

## 运行观测

插件把元信息追加到 `~/.dsh/logs/web-search-account.log`（dsh 的 `ctx.logger` 不落文件，
所以另开一个可外部核对的出口）。三类事件：

| event | 含义 |
|---|---|
| `registered` | 模块导入 + provider 注册成功，且账号令牌当时可用（`accountToken: "ok"`） |
| `boot-search` | 当天首次启动真搜一次的结果条数（**每个自然日至多一次**，重启不重复消耗） |
| `boot-search-skipped` | 当天已经跑过自检，本次重启跳过（不花额度） |
| `search` / `search-failed` | 每次真实搜索的结果条数 / 失败码 |

`registered` 这行**存在本身**就是证据：注册失败会抛 `WEB_DUPLICATE_PROVIDER` 并中止 apply，
那行就不会出现。

## 回滚

删 `cordis.patch.yml` 里上面两段 → 删 `node_modules/dsh-web-search-account/` → 重启。
回滚后搜索恢复为「报 `WEB_PROVIDER_CREDENTIAL_MISSING`」的原状。

## 已知边界

- 搜索消耗该 DeepSeek 账号自身额度，与「用 DeepSeek Account 模型时」同源。
- 限额分两层：**单次请求**内搜索次数上限 `max_uses`（默认 5，本插件沿用）、`max_tokens` 4096；
  **账号级**额度由平台控制，dsh 代码里只有余额接口，不暴露「剩余搜索次数」——
  查额度看 `https://platform.deepseek.com/usage`（官方 `getState()` 里的 `usageUrl` 就指向 `/usage`）。
- 启动自检每天最多一次真搜（约 4–5 秒、10 条结果），重启不叠加。
- 账号令牌失效（未登录 / 过期）时回退 `DEEPSEEK_API_KEY`，两条都无才报凭据缺失——不静默失败。
- 依赖官方类的构造签名 `new DeepSeekSearchProvider(() => options)`。官方若改签名，这里要跟。
- 本插件解决的是**搜索**；`web_fetch` 用的是匿名抓取（`web-fetch-http`），对 Google / 百度百科 /
  维基等站点的失败属**网络与反爬层面**（实测：换成 Chrome UA 仍 403），不是配置问题。
  这正是「应该用 web_search 而不是抓搜索结果页」的原因。
- 它只是**工具**，不是**身体**：搜到的内容目前不写记忆（`tool_output` 零写入方，见项目问题清单 ISS-042）。
  身体（M4）要补的是能力注册 + 事件上报 + 权限开关，抓取与检索逻辑可直接复用本插件所挂的 `ctx.web`。
