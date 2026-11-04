# IM 通道评估与决策（QQ）

> 版本 v1 · 2026-11-04 · 形状：决策记录（不是选型报告）
> 取证方式：`npm pack` 解包读发布产物，不采信插件目录站文案、不采信 CHANGELOG
> 本文的每条结论都带 `文件:行` 或可复现命令；无出处的一律不写

---

## 0. 结论

**观察期用官方 `@tencent-connect/dsh-qqbot@0.5.5`，只开私聊、群聊 `disabled`、硬改 `cordis.patch.yml` 绕过设置页 bug。**

三条并列判断，缺一条这个结论就不成立：

1. **官方是五个候选里唯一同时具备 fail-closed 机制、被动配额处理、活跃维护、供应链可追溯的**（§4）。
2. **它的默认值是开的**，所以不能"装上就用"——必须硬改配置（§5.1）。
3. **五个候选全都不能上报带 `initiation` 的结构化经历事件**（§4.5），所以选谁都不影响"身体"这件事。这一项在选型里应当**直接置零权重**，否则会干扰判断。

一句话区分两个层次：官方插件是一条**把 QQ 消息翻译成 dsh session 的管道**，不是身体。观察期只需要管道。

---

## 1. 为什么现在要接

观察期最大的摩擦不是功能缺失，是**只能在 dsh web 上聊**——离开电脑就断。这直接破坏观察期的方法论：观察需要一个自然的生活节奏，而"必须坐到电脑前"本身就在扭曲样本。

但要先把需求切开，否则会拿"通道"的标准去要求"身体"：

| | 需求 | 观察期要不要 |
|---|---|---|
| **L1 通道** | 消息能进出、会话能映射、记忆能合并 | **要**，这是本次目标 |
| **L2 身体** | 它能自己发起、能感知被谁触发、经历能回报成记忆 | **不要**，属 M4，须先补服务面 |

L2 不是"换个更好的插件"就能拿到的。`initiation` 字段在 `src/types.ts:48` 的注释写着"身体事件 M0 预留"，但 `src/index.ts` 三个 `addEvent` 调用点（938 / 1025 / 1133）**无一传入**——责任归因至今靠 `provenance` 启发式兜着。`PersonaMemoryService` 对外只有 `booted`、`status()`，**没有"身体事件上报"这个契约**：没有类型枚举、没有权限门、没有幂等键、没有能力降级约定。

所以就算明天写一个完美的 QQ 插件，它上报的经历也只能从 `memory.addEvent` 那个内部口挤进去。**自研 QQ 的第一步不是写 QQ，是先把 M4 的服务面补上**（§7）。

---

## 2. 评审口径

不看"好不好用"（无法量化、且容易受传闻影响），只看五条能落到代码或平台规则上的：

| # | 指标 | 为什么是硬指标 |
|---|---|---|
| A | **访问控制默认值** | 默认 `open` 意味着装上那一刻就有一个能读本机文件、能往群里回帖的入口。这不是配置问题，是默认信任边界 |
| B | **主动消息能力** | 决定"主动性"能不能实施。注意：平台配额是天花板，插件只能决定"能不能碰到天花板" |
| C | **经历回报（`initiation`）** | 决定这个通道能不能当身体。**五个全不满足 → 权重置零** |
| D | **形态与耦合** | 是不是 cordis 插件、要不要逆向宿主 API、会不会 `postinstall` 改别人的包 |
| E | **维护与供应链** | 停更/取消发布/无 repository/非商用许可证，任何一条都会在半年后变成迁移成本 |

---

## 3. 五候选对比

| 候选 | 私聊默认 | 群聊默认 | 形态 | 判断 |
|---|---|---|---|---|
| **官方 `@tencent-connect/dsh-qqbot` 0.5.5** | `open`（扫码绑定后转 `allowlist`） | `open` ⚠️ | cordis 插件，`inject = ['agents']` | **综合最优，必须硬改配置** |
| `dsh-im-qq` 0.1.1 | **`['*']` 全开** | `['*']` 全开 | cordis 插件，7 个声明式 `inject` | 架构最好，**停更 2.5 个月、无 `repository` 字段** |
| `qq-bridge` | 空白名单 = 全拒 ✅ | 全拒 ✅ | **不是插件**，逆向 DSH Web API | **PolyForm 非商用**、`postinstall` 改写 `@sockluma/sdk`、npm 上 10-27 取消发布 |
| `dsh-qq-onebot` | `allowlist` + 空 = 全拒 ✅ | `open` | cordis 插件，走 NapCat/OneBot | 私聊最安全、**主动能力最全**，但非官方通道有封号风险 |
| `dsh-qq-moony` | 空 = 谁发都回 ⚠️ | 空 = 关闭 ✅ | 单文件 | 0 star、建仓一天后停更 |

### 3.1 `dsh-im-qq`：设计对，出厂错

ACL 代码是五个里最讲究的——注释里明确写了 fail-closed 的理由，`core/` 与 `platform/` 分层也真实存在（换平台只换 `platform/` 目录，这正是 Body Protocol 想要的形状，§7.2 会回到这里）。

但**出厂默认 `['*']`**，等于把最好的设计配了最坏的默认。外加停更 2.5 个月、无 `repository` 字段。

> **自我更正（必须留在文档里）**：我最初说它"支持 ws/webhook 双模式"，那是**转述了插件目录站的宣传文案**。解包后实际情况：配置项注释写 `// websocket | webhook（P5 预留）`，`webhook` 与飞书适配**都没有实现**。分层是真的，双模式是假的。教训已记入工作区记忆：二手描述不能进结论。

### 3.2 `qq-bridge`：三条否决理由，任一条都够

不是 cordis 插件——它逆向 DSH Web API 来发消息，等于把"插件协议"这一层整个跳过。叠加 PolyForm 非商用许可证、`postinstall` 改写第三方包 `@sockluma/sdk`、npm 上已取消发布。**供应链上不可审计，直接出局。**

### 3.3 `dsh-qq-onebot`：留作后手，不是现在

私聊 `allowlist` + 空名单全拒，安全性是五个里最好的；主动说话、静默时段、外发审计都是现成的——**这恰好是动机引擎（M2）最缺的东西**。

代价是走 NapCat/OneBot 非官方通道，有封号风险。所以：**不作为观察期方案，作为动机引擎动工时的候选**。理由是它的"主动能力"在观察期用不上（观察期只需要被动通道），而封号风险在观察期是纯亏。

### 3.4 `dsh-qq-moony`：不评

0 star、建仓一天后停更。不需要更多理由。

### 3.5 决定性发现：五个候选全都没有 `initiation`

`grep` 五个包的发布产物，`initiation` / `self_initiated` / `user_initiated` / `external_triggered` **全部 0 命中**。

它们把 QQ 消息变成的，永远是一条普通的 `user_direct` 事件——**分不出"用户找我"和"我主动开口"**。而这两件事对人格成长的意义完全不同：前者是回应，后者是发起。

所以 C 项（经历回报）在本次选型里**应置零权重**：它是自研的活，不是选型的活。让它参与打分只会把决策引向"哪个插件看起来更像身体"这种无法验证的问题。

---

## 4. 官方 0.5.5 深挖

### 4.1 默认值是开的（本轮复核）

```
package/lib/config.js:7-10
  c2cMode:   Schema.union(['open','allowlist','disabled']).default('open')   ← 默认开放
  groupMode: Schema.union(['open','allowlist','disabled']).default('open')   ← 群聊默认开放
```

CHANGELOG 说"私聊默认白名单"，**描述的是扫码绑定之后的状态，不是 schema 默认值**。收紧只发生在绑定那一步：

```
package/lib/setup/persist.js:177,181
  config.set('access', { c2cMode: 'allowlist', c2cAllow: [openid] })
  accessMap.set('c2cMode', 'allowlist'); accessMap.set('c2cAllow', [openid])
```

注释写得很直白：`/** 用扫码者 openid 覆盖 c2cAllow 并切到白名单模式（重绑即换人）；群配置不动 */`

**所以：用扫码绑定的方式部署，私聊自动锁到你；群聊配置一行不动，保持 `open`。** 如果改用环境变量 `QQBOT_APPID` / `QQBOT_SECRET` 部署，根本不走绑定流程，私聊也保持全开。

两个相关 issue（截至 0.5.5 未修）：

- **#109（静默回归）**：在设置页"只是加一个白名单"，保存后 `c2cMode` 会从 `allowlist` 被打回 `open`，白名单实际失效。→ **动手改配置文件，不要用设置页。**
- **#111（权限边界错位）**：群聊消息即指令，access 白名单对这条链路没有约束力。白名单只控"谁能说话"，控不住"它能读什么"——群成员可以让它读本机文件并回帖到群里。→ **群聊直接 `disabled`。**

### 4.2 主动消息：只有降级路径，没有发起路径（本轮新增）

这是最重要的一条新增事实。`grep -rn "proactive|主动|sendActive"` 只在四处命中，全部在传输层：

```
package/lib/transport/reply-limiter.js:5
  当限额耗尽或消息过期时，应降级为主动消息（proactive，不传 msgId）。

package/lib/transport/reply-target.js:7
  3. 全部候选都超频/过期，才降级为主动推送（proactive）。
```

`reply-target.js` 的三级兜底逻辑是：

1. 优先显式 `target.msgId`（且须在 cache TTL 内，未超平台被动窗口）
2. 超频/过期后，用缓存里「最近一条未超频未过期」的 target
3. **全部候选都超频/过期，才降级为主动推送**（`msgId: undefined`）

也就是说：**"不带 `msgId` 发送"这个能力存在于代码里，但它只在被动回复配额耗尽时被触发，没有任何"我想说话"的入口。** 触发它的原因是"回不了了"，不是"想说话"。

结论：官方 0.5.5 **不能**用于主动性。这不是配置问题——没有这条代码路径。要实现主动性，要么走 `dsh-qq-onebot` 的现成能力，要么自研时把 `msgId: undefined` 这条路径提成正式 API 并接上配额管理。

### 4.3 主动消息零配额管理（本轮新增）

```
grep -rn "month|quota|配额|每月|perMonth" package/lib/ --include=*.js
  → 0 命中
```

插件对主动推送**不做任何平台配额控制**。QQ 开放平台的主动消息配额（约 4 条/月/人/群）由平台侧直接拒绝，插件不预判、不计数、不降级。

对观察期无影响（不主动发）。但这条是自研时的必做项：**没有本地配额账本，主动性会在配额耗尽后表现为"它突然不理我"**，而错误信息只会是一个平台错误码。

### 4.4 被动窗口：两个数字互相矛盾，需实测确认

| 来源 | 数字 |
|---|---|
| `reply-limiter.js` 构造默认 | `limit = 4`，`ttlMs = 3600_000`（1 小时） |
| `reply-target.js` 注释 | 「显式 msgId 须经 cache 确认未超平台被动窗口（**群 5min / 私聊 30min**）」 |

我此前说过"被动回复 60 分钟窗口"，与代码注释的 30 分钟不符。**这一条不采信任何二手说法，装完用实测确认**（验收第 6 条）。差别很实际：窗口 5 分钟意味着"隔十分钟再回上一条"会失败并降级成主动推送，从而消耗那 4 条/月的配额。

### 4.5 会话映射：一个 QQ 会话 = 一个独立 dsh session（本轮新增）

```
package/lib/session/session-id.js
  /** 铸造新会话 id（随机全局唯一…）*/
  export function mintSessionId() { return `session-${randomUUID()}`; }

package/lib/session/session-manager.js:139,171
  sessionKey(scope, peerId)  →  modelResolver / prefs 均按 key 取
```

`scope` 是 `'group' | 'c2c'`，`peerId` 是对方 openid。即 **每个私聊对象、每个群各对应一条独立的 dsh session**。

这条对 persona 插件是**放大器**，不是新问题：

> `src/index.ts:452-456` 的 `injectedText` / `injectedStateText` / `injectedSelfModelText` / `injectedContextText` 全是 `apply` 闭包里的 `let`，进程级单例；`recentRounds`（987 行）同理。provider 注册为 `text: () => injectedText`（1056 行），回调**不带任何 session 参数**。

所以当"web 会话"与"QQ 私聊会话"并发时，两边会互相覆盖注入内容——表现为注入里出现另一端的内容。观察期只有一个人用、只开私聊，影响是"偶尔串味"，不是数据损坏。

缓解与根治见 §6.2，台账项为 `X-session-isolation`（当前 `partial`）。

### 4.6 兼容性声明没覆盖我们的宿主版本

```json
"dsh": { "compatibility": { "dshReleases": { "0.1.0-rc.8": "compatible", "0.2.0-rc.2": "compatible" } } }
```

我们的宿主是 **`0.2.1-rc.5`**（`dsh --version`）。它验证过 `0.2.0-rc.2`，未验证 `0.2.1-rc.5`。同一 minor line，大概率兼容，但包自己的 note 明确写了：

> 「客户端依赖 `settings.section` / `sidebarRightTabs` / `sidebar.right.pane.tab` 席位契约与 `dsh.client` 模块系统，宿主大版本升级后请重新验收席位行为。」

→ **风险记为"客户端席位可能不显示"，缓解：绑定流程走终端二维码，不依赖端内绑定页**（§5.2）。

### 4.7 绑定流程是自动触发的

```
package/lib/index.js:13-20
  if (!appId || !appSecret) { logger.info('凭据未配置，启动扫码绑定...'); void ensureCredentials(...) }
```

且 `apply` **不 `await`** 扫码结果（注释解释了原因：无限期等待会阻塞 Host ready）。凭据就绪后 `persistCredentialsToProfile` 写入 `cordis.patch.yml`，触发 dsh 热更新重载。

对装配的含义：装完重启后，**日志里会直接出现二维码/绑定链接，不需要额外命令**。绑定成功后不需要再重启一次（HMR 会重载）。

---

## 5. 决策

### 5.1 配置（硬改 `cordis.patch.yml`，不用设置页）

| 项 | 值 | 依据 |
|---|---|---|
| profile | 现有 `web` | 单进程单写者。跨进程无文件锁，独立 profile 会抢写事件分片 + 双复盘定时器 |
| `access.c2cMode` | `allowlist` | 绑定会自动写成这样，但**显式写死**，防止 #109 把它打回 `open` |
| `access.c2cAllow` | `[你的 openid]` | 绑定后从 `cordis.patch.yml` 抄回来固定住 |
| `access.groupMode` | **`disabled`** | 群聊一关，#111 那条"群消息即指令读本机文件"的链路根本不存在 |
| `access.groupAllow` | `[]` | 与 `disabled` 同时存在，双保险 |
| `provider` / `model` | 显式 `deepseek-official` / `deepseek-chat` | 我们 profile 默认模型指向本地 LM Studio，不指定会落过去 |
| `debug` | 先 `true`，验收后关 | 有 `Access blocked: <reason>` 回调，排查白名单问题只能靠它 |

**观察期只开私聊一条**，一开一关，同时绕开 #109（设置页把模式打回 open）与 #111（群消息即指令读本机文件）。这是整个方案能成立的关键。

### 5.2 装配顺序

1. 备份 `~/.dsh/profiles/web`（含 `cordis.patch.yml`、`node_modules`）与已部署的 `lib`
2. `dsh plugin --profile web add @tencent-connect/dsh-qqbot@0.5.5`
3. `diff -r` 校验已部署的 `dsh-persona-innate` 未被触碰（依赖树变化不应影响它）
4. 硬改 `cordis.patch.yml` 写入 §5.1 的配置
5. 重启 dsh web → 日志出现二维码 → 手机 QQ 扫码
6. 绑定后回读 `cordis.patch.yml`，确认 `c2cMode=allowlist` 且 `c2cAllow` 恰为你的 openid（`persist.js` 的 `c2cAllowlistContains` 就是这个校验逻辑）
7. 跑 §5.3 验收

`dsh plugin` 的语义是把参数转发给 profile 目录里的 pnpm（`dsh plugin --help` 原文：*forwarding the remaining arguments to pnpm in the profile directory*），所以 `add` / `remove` / `why` 都能直接用。

### 5.3 验收（跑不通就回退）

| # | 验收 | 判定 |
|---|---|---|
| 1 | QQ 发一句 → `events/2026-11.jsonl` 多一条 | `provenance` 是 `user_direct` |
| 2 | 回复能带出既有记忆 | 摄影、LOL 那些未结事能被提起 |
| 3 | `/persona` 计数增长，来源分布不跑偏 | 不应出现 `self_direct` 暴涨 |
| 4 | web 端与 QQ 端先后说话，记忆**合并**不分裂 | 同一个 `events/` 分片，不出现两份 |
| 5 | 次日 02:00 复盘正常 | `self-model` 升到 v3 |
| 6 | 被动窗口实测 | 上一条消息隔 N 分钟后还能否被动回复，记录 N 的真实边界（§4.4 的 5min/30min/60min 三说并存） |
| 7 | 群聊确认关闭 | 把 bot 拉进任意群，发 @ 消息，应被 `Access blocked` 拒绝且 `debug` 日志有 reason |

### 5.4 观察期指标（3–5 天）

接 IM 的目的是让观察更自然，所以必须验证"更自然"这件事真的发生了，否则只是换了个入口：

1. **注入里 `user_direct` 占比**——如果 QQ 让对话变多，这个比例应上升；如果它只是变成"另一个我自言自语的地方"，`self_direct` 会涨。
2. **每次复盘窗口覆盖事件数**——0.5.2 引入的 `truncatedEarlier` 是否出现。出现说明一天的事件量撞到 200 条上限，观察期的节奏已经超出设计预期。

---

## 6. 已知风险与缓解

### 6.1 平台侧（换任何插件都一样）

AppID/AppSecret 申请、机器人上线审核、IP 白名单、被动窗口、主动配额——**这些是 QQ 开放平台给的，自研也去不掉**。如果期待是"自研之后可以随时主动发消息"，那不会发生；能改变的是"什么时候允许它碰那 4 条配额"、"碰之前记不记账"、"被拒之后怎么解释给自己听"。

### 6.2 会话串味

`X-session-isolation` 未修。观察期缓解：**尽量不在 web 与 QQ 同时长聊**。根治需要先回答一个 API 问题：`ctx.systemPrompt.context({ text })` 的回调是否运行在 session-scoped fiber 里、能否拿到 `sessionId`。如果拿不到，就得改成"注入时按 sessionId 从 store 现取"，那时 `text` 回调必须是 async——需要确认宿主是否支持。

**这一步在做动机引擎之前必须解决**，因为动机引擎一旦按会话判断"该不该说话"，串味的代价就从"内容错位"升级成"对错人说话"。

### 6.3 `#109` 的长期风险

只要有人动了设置页，`c2cMode` 就可能被打回 `open`。缓解：`c2cAllow` 显式写死，并且**在验收第 7 条里定期复查**——把"配置漂移"当成需要周期性确证的事实，而不是一次性配置。

---

## 7. 后续：自研身体的边界

这次调研的价值不只是选出通道，还给了自研的边界条件。

### 7.1 不重复造的部分

- WebSocket 心跳 / 重连 / 分片 / 富媒体下载 / 审批按钮渲染 —— 官方 `lib/transport/` 与 `lib/media/` 已经踩过坑，且是 MIT
- 会话映射 —— `sessionKey(scope, peerId)` 这套形状是对的

**做法：fork 连接层，只重写"上报"那一层**，而不是从零写。这比"完全自己写"省掉的是踩坑成本，不是架构主动权。

### 7.2 借鉴 `dsh-im-qq` 的分层

它的 `core/` 与 `platform/` 分离是五个候选里唯一接近 Body Protocol 形状的东西——换平台只换 `platform/` 目录。虽然它停更了，但**这个形状值得抄**：

```
core/       ← 与平台无关：经历是什么、什么时候算一次遭遇、怎么回报
platform/   ← 只做翻译：QQ 消息 ↔ core 的经历对象
```

### 7.3 Body Protocol 必须先回答的四个问题

自研 QQ 之前，M4 的服务面要先把这四个答案定下来（现在一个都没有）：

1. **经历的类型枚举**是什么？（不只是"收到消息"，还有"被拉进群"、"消息被撤回"、"对方三小时没回"这类没有请求方的事件）
2. **`initiation` 怎么填**？谁来判断 `self_initiated` / `user_initiated` / `external_triggered`——是插件报，还是大脑推断？
3. **幂等键**是什么？重连后重放的同一条消息不能变成两段记忆。
4. **能力降级约定**是什么？身体坏了（掉线、配额耗尽、被禁言），大脑怎么知道？——现在 `review.ts:120-123` 的 `onlyBodyEvents` 降级复盘分支**永远不触发**，因为没有任何身体事件来源。这条分支是等着被喂的。

### 7.4 明确不做的事

- **不用 `qq-bridge`**：非插件形态 + 非商用许可证 + `postinstall` 改写第三方包，供应链不可审计。
- **不为了"第三方更好"换掉官方**：网上对官方插件的负面反馈我无法验证，且决定性的指标（`initiation`）五个候选全为零。用无法验证的传闻替换可验证的事实，不划算。
- **不在观察期开群聊**：`#111` 那条链路的风险与观察期收益完全不成比例。

---

## 8. 附录：取证命令

复现本文任何一条结论：

```bash
# 取包（不安装）
npm pack @tencent-connect/dsh-qqbot@0.5.5
tar -xzf tencent-connect-dsh-qqbot-0.5.5.tgz

# 默认值（§4.1）
grep -n "default('open')\|c2cMode\|groupMode" package/lib/config.js

# 绑定只收紧私聊（§4.1）
grep -n -A3 "overwriteC2cAllowlist" package/lib/setup/persist.js

# 主动消息只有降级路径（§4.2）
grep -rn "proactive\|主动" package/lib/transport/

# 零配额管理（§4.3）
grep -rn "month\|quota\|配额" package/lib/ --include=*.js     # → 0 命中

# 被动窗口两个数字（§4.4）
grep -n "limit ?? 4\|ttlMs ?? \|群 5min" package/lib/transport/reply-limiter.js package/lib/transport/reply-target.js

# 会话映射（§4.5）
cat package/lib/session/session-id.js
grep -n "sessionKey" package/lib/session/session-manager.js

# 五个候选的 initiation 全员为零（§3.5）
grep -rn "initiation\|self_initiated\|user_initiated" <每个包>/lib/
```

---

## 9. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-04 | v1 | 初版。五候选源码取证、官方 0.5.5 深挖（含主动消息形态、零配额、会话映射、兼容性缺口）、观察期决策与验收 |
