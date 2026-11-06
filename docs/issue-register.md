# 问题记录清单（Issue Register）

**版本**：v1.15 · 日期：2026-11-06（条目 64 条：60 条有效 + 4 条误诊留档）
**配套文档**：`README.md`（使用说明）、`docs/mechanism-design.md`（唯一总设计文档 v1.0.0）、`docs/capability-ledger.md`（`npm run audit --write` 自动生成的能力台账）

---

## 0. 这份清单是什么

总设计文档回答"应该怎样"，能力台账回答"定义有没有调用点"，这份清单回答第三个问题：**哪些地方现在不对、已经知道了、但还没修**。

它存在的直接原因：2026-11-04 至 11-05 之间，项目经历了 M1 观察期与记忆架构 v1.1 重设计。期间产生了两类问题——一类当场修了（有 commit），一类只记录了没动（观察期内约定不修机制、用户明确决定不修、或受环境限制暂不处理）。第二类如果只散落在日常日志里，过一周就找不到，然后重复踩坑。本项目已经因此重复过三次同一类缺陷：**组件级实现完整、单元测试全绿、生产装配零覆盖**（`retentionPriority` 零调用、`initiation` 零写入、`bypassDecision` 仅单测）。

**三条维护规则**

1. **只增不删**：修复后不删除条目，只改状态并补证据。误判的问题标 `invalid` 保留——本项目已积累四次误诊（reasoning 挤占 token、仓库"不存在"、UTC 当本地时间、截图 OCR 误读），它们说明诊断结论必须留档，否则会被后来者（包括下一轮的自己）当成事实。
2. **状态必须有证据**：`fixed` 必须附 commit hash 或运行期验证；`wontfix` 必须附用户拍板原话与理由；`observing` 必须写清触发条件（什么现象出现就升级为 `open`）。
3. **每条可追溯**：来源限定为用户反馈、观察期记录、评审、台账、运行期日志之一，不写"据说"。

---

## 1. 状态与严重度

### 状态

| 状态 | 含义 | 迁移条件 |
|---|---|---|
| `open` | 已确认，待修 | — |
| `observing` | 只记录、暂不动，等数据或等条件 | 触发条件满足 → `open`；用户改主意 → `open` |
| `partial` | 有机制落地，但未完全生效 | 补齐剩余部分 → `fixed` |
| `deferred` | 已排期，押后到明确阶段 | 进入该阶段 → `open` |
| `wontfix` | 用户明确决定不修 | 用户改主意 → `open` |
| `fixed` | 已闭环，附证据 | 回归 → 重开或新建条目 |
| `invalid` | 误判，已纠正 | 保留，ID 不复用 |

### 严重度

| 级别 | 判据 |
|---|---|
| P0 | 人格 / 记忆数据被污染；或机制齐全但线上零效果 |
| P1 | 核心功能读不到（注入缺层、纠正不生效）；或成长闭环断链 |
| P2 | 体验退化、参数未校准、设计理念偏离 |
| P3 | 代码清洁、命名、冗余 |

---

## 2. 症状索引（最初的问题现在到哪了）

| 用户报告的症状 | 对应条目 | 当前状态 |
|---|---|---|
| QQ 上只回"那 / 嘿嘿 / 好吧"，说不完整 | ISS-031 + ISS-029 | 症状已消（`/new` 开新会话），根因是环境约束，仍观察 |
| 新会话后「记忆非常混乱」 | ISS-002 / ISS-006 / ISS-007 / ISS-022 / ISS-023 / ISS-024 | **部分闭环**：P1–P3 机制已落地，P4 装配器只 shadow 未切读，缓存与召回偏斜未修 |
| QQ 聊完切到 web，接不上刚聊的上下文 | ISS-001 | `partial` |
| 晚餐"土豆"记不住，纠正后仍继续猜 | ISS-002 | `partial` |
| 她说"我记忆好乱"，怕被固化成性格 | ISS-038（已修） | 晋升闸门已挡；数据层已隔离两条负面特质 |
| 改了这么多，线上到底生效没有 | ISS-027 | **已上线 0.5.5**（2026-11-05 18:08）：29 模块到位，`shadow/` 由插件写出，`raw-turns/` 已在生产落盘 48 条 |
| 她「翻口袋」看到有联网，一用就报 `WEB_PROVIDER_CREDENTIAL_MISSING` | ISS-027（关联 ISS-042） | **已修**（2026-11-05 20:1x）：改走账号登录态鉴权；启动自检实搜 10 条结果 |
| 她上网看到的东西，下一轮就忘了 | ISS-042 | `open`：`tool_output` 零写入方，浏览经历不进记忆（身体 M4 的前置） |
| 她说"让我看看 action 有哪些选项"，然后只回了"不好意思" | ISS-044 | `open`：口袋视图只投影参数名与描述首行，`enum` 取值不投影；用户定"先记后改" |
| 她说「我又犯了」「我记住了」，下一轮照旧 | **ISS-046（重点）** | `observing`：纠正无处落盘，"我记住了"是空头承诺；换云端模型后复测，分"模型边界"与"机制缺口"两叉 |
| 「上网也要扣余额吗？又不是调大模型」 | ISS-043 | **已修**（2026-11-05 20:39）：实测官方 `web_search` 每次都是一次模型调用（9804 输入 token），改为默认走免模型通道抓结果页；启动自检 300ms / 0 token |
| 我关了自动复盘，第二天启动它还是自己跑了一次 | ISS-047 | `open`：`reviewEnabled` 只关定时器，管不到启动补跑（`index.ts:1041` 无条件调用） |
| 复盘说「隔离（仅跨单个日期）」，同一条候选隔几天还是候选 | ISS-048 | **已修（0.5.6）**：改为逐候选按自身累积证据判定，装配级已验证 `selfModel`/`allEvents` 真的传了 |
| 明明没改什么，self_model 版本号一直涨 | ISS-049 | `open`：每轮净增 2 版，回滚窗口实际约 5 天 |
| 她说「记忆没更新」，到底是一致性没过还是写盘失败 | ISS-050 | `open`：`consistencyCheck` 只写不读，三类失败全静默 |
| 她刚刚才聊过的事，转头就问"我们聊到哪了" | ISS-053 + ISS-054 | `open`：86.5% 的用户消息从未入库；入库的每轮只取 5 条 / 700 字 |
| 她只回了一个「我」字就没了，像人格坏了 | ISS-056 | `open`：上下文打满，输出退化到 1 个 token（`stopReason=length`），是容量问题不是人格问题 |
| 她性格说得挺准，具体事却说不清 | ISS-055 | `open`：`self_model` 每轮全量注入 15 条，事件只取 5 条；`attributes`/`procedures` 零注入 |
| 她记得自己答应过什么，却不记得我授权过什么 | ISS-053 | `open`：AI 回复走 `extractSelfExpression` 命中率高，用户消息走规则白名单，命中率仅 13.5% |
| 工具 `persona_note` 报「执行失败」，可内容好像又记住了 | ISS-058 | **已修（0.5.7）**：成功时返回值带 `reason: undefined` 被判非法 JSON，属假失败，事件其实已落库 |
| 她说「Updated memory for topic 共同记忆」，可问她内容却答不出 | ISS-059 | `open`：那是模型自己编的通知文本（无 tool-call、无写入），不是插件或 UI 的输出 |
| 聊久了/聊到第 20 轮左右，她突然不记得前一句说了什么 | ISS-060 | `open`：每轮重复追加整份人格快照（占 prompt 过半），越过 33024 后被 llama.cpp 一次性丢掉一半上下文，dsh 侧无任何事件 |

---

## 3. A 区 · 观察期发现、只记录未修（重点区）

### ISS-001 跨渠道接不上上下文（QQ ↔ web）

- **首次发现**：2026-11-04 19:21，用户反馈
- **现象**：QQ 上聊完，切到 web，她接不上刚聊的内容。
- **根因（19:34 重估后四层）**：
  1. 会话历史按 peer 隔离（`sessionKey(scope, peerId)`，设计如此，不是 bug）；
  2. L2 工作记忆未实现（P2 阶段欠账，现由 P4 装配器承接）；
  3. 记忆摘要只存"原话片段"，跨消息丢指代（见 ISS-002）；
  4. 注入缓存是 `index.ts:452-455` 的进程级 `let`（见 ISS-007）。
- **影响**：P1。用户感知为"她换了设备就忘了我们刚说的话"。
- **状态**：`partial` —— ③ 由 P1 raw_turns + P3 时间语义部分承接；② 由 P4 shadow 承接但**未切读**；①④ 未修。
- **关联**：ISS-002、ISS-006、ISS-007

### ISS-002 记忆丢失指代 + 纠正不落盘 + 错误推断被正强化（"土豆"案例）

- **首次发现**：2026-11-04 19:34，用户反馈
- **现象**：用户 QQ 聊晚餐（土豆），她只记得"少煮就是硬的，配了点牛奶"；被问"晚饭吃的啥"时猜成"粥"，用户纠正"是土豆"后仍不记得，继续猜"牛奶泡粥加土豆"。
- **实锤**（`events/2026-11.jsonl`，UTC）：10:15 落库 `情感-分享「少煮就是硬的，没法吃，不用担心我配了点牛奶」`（importance 0.7，**全文无"土豆"二字**）；11:24–11:27 连续三条 `self_direct 附和` 记录她猜"粥 / 牛奶粥 / 牛奶泡粥加土豆"。
- **三个连环根因**：
  1. **指代丢失**：含"土豆"的那句没触发提取（土豆非触发词），含"担心"的句子触发了 → 存的片段丢了主语。
  2. **纠正无落盘通道**：用户"是土豆"既无触发词、也无"纠正 → 更新记忆"路径，永远进不了记忆。
  3. **错误推断被正强化**：她猜"粥"的几句被 M3 当 `self_direct` 附和记下，错误关联越记越牢。
- **影响**：P0。这是"记忆不可信"的核心症状，直接摧毁陪伴产品的信任基础。
- **状态**：`partial` —— P1 raw_turns 已全量保留原文（不再只存片段）、P2 闸门挡住 `ai_inference` 直接激活、增量2 综合泛化要求 ≥2 证据组。但**"即时纠正 → supersede"的读取消费仍缺**（P4 未切读）。
- **关联**：ISS-001、ISS-006、ISS-009、ISS-022

### ISS-003 模型非开机自启 → 启动补跑白跑且不重试

- **首次发现**：2026-11-04 23:45
- **现象 / 因果链**：dsh 开机自启，但 LM Studio（`127.0.0.1:1234`）不自启。复盘门禁（`index.ts:710`）只判 `llmNow.synthetic`（是否降级 Mock），而 `makeLlmAdapter`（`index.ts:254`）只查 `ctx.llm` 存在性、不验证 LM Studio 可达性 → 模型没起时门禁拦不住 → 启动补跑真调 LLM 连 1234 失败（最坏卡 90s）→ 复盘 failed、游标不推进（安全，不丢事件）。
- **真正缺口**：`ctx.inject(['llm'])` 等的是 dsh 内部 llm 服务就绪，**不是模型后端就绪**；且启动补跑 `llmBootStarted` 只跑一次，模型后启动**无重试钩子**。
- **状态**：`wontfix` —— 用户 2026-11-04 23:45 拍板：**不修，手动 `/persona review` 兜底即可**，也不做 LM Studio 开机自启。仅记录在案，除非未来手动触发也嫌麻烦，再回机制层加「LLM 后端就绪后重试复盘」钩子。
- **关联**：ISS-004

### ISS-004 复盘时机绑定"开机"而非真实使用节奏

- **首次发现**：2026-11-04 23:35
- **现象**：用户晚上关机，凌晨 2 点的定时复盘（`reviewHour` 默认 2）实际从不执行，全靠启动补跑兜底（`maybeCatchUpReview` + `shouldCatchUpReview`，无游标或距上次 ≥24h 才补）。
- **用户决策**：`reviewHour` 保持默认 2、**不改到睡前时段**，明确选择"先不改，靠启动补跑"。
- **状态**：`observing`。
- **触发条件**：若观察期出现「复盘不及时拖累成长闭环」→ 升级 `open`，回机制层把复盘改成绑定真实使用节奏（会话结束 / 空闲 ≥24h 触发），而不是只改 `reviewHour` 钟点。

### ISS-005 DSH inspector 9230 无鉴权

- **首次发现**：2026-11-04
- **现象 / 根因**：`dsh web` 启动后在 `127.0.0.1:9230` 开 CDP inspector，`/json/list` 直接返回带 `webSocketDebuggerUrl` 的目标，**没有任何鉴权**。连上即可在宿主进程里执行任意 JS：读全部记忆、`self_model`、状态机内部值，也能改写。
- **影响**：P1。它决定前面所有威胁模型（provenance 校验、剥离规则、关系审计）**前提是否成立**——若攻击者已能在进程内执行代码，这些全是纸面约束。
- **状态**：`wontfix` —— 用户决定**只记录，暂不处理**（个人开发阶段、单机单人、未接入第三方代码）。候选方向：① 只绑回环 + 一次性 token（DSH 侧改动）；② 敏感数据落盘加密；③ 明确接受并写进部署前提。
- **关联**：ISS-027（部署前必须重新评估）

---

## 4. B 区 · 已明确未完成 / 半接的机制缺口

| ID | 问题 | 严重度 | 状态 | 现状与证据 |
|---|---|---|---|---|
| ISS-006 | P4 装配器 shadow 未切读 → attribute 长期事实运行时仍读不到 | P1 | `observing` | `src/assembler.ts` + `src/intent.ts` 已落地（`4ecbdc4`），与旧 `buildInjection` 并行、差异写观测文件，feature flag 默认 false。切读前置：shadow ≥14 天或 ≥30 轮且 13 项指标达阈值 |
| ISS-007 | 注入缓存是进程级 `let`（`index.ts:452-455`）→ 多会话串味 | P1 | `open` | 接 QQ 后每个私聊 = 独立 dsh session，共享缓存会被放大 |
| ISS-008 | `initiation` 字段零写入方 | P1 | `open` | 类型/落盘/O17 降级复盘都写了，但 `index.ts` 三个 `addEvent` 调用点均未传；责任归因仍靠 provenance 启发式 |
| ISS-009 | `PersonaFact`（`distillFacts` 产出）未落盘 | P1 | `open` | 注入读 facts 靠 thread/attribute 半边；增量2 产出的是泛化候选，不等于全量落盘 |
| ISS-010 | 诚实基线（三级旁路）未接运行时 | P1 | `open` | `bypassDecision` / `renderUncertainty` 只有函数与单测，运行时无调用点 |
| ISS-011 | 状态注入对象错位 | P2 | `open` | 文档要求"供评估端与状态机使用"，实现注入了表达端（order 160，四个内部参数）。待拍板：撤出，或翻译成可感知的形态事实 |
| ISS-012 | 遗忘三件套未实现（衰减/压缩/物理删除），`retentionPriority` 零调用 | P2 | `open` | 增量4 salience 只做巩固降采样 + 检索预算，不覆盖三件套；thread 30 天过期仍是唯一遗忘机制 |
| ISS-013 | 特质只增不减（纯并集）、narrative 整体替换且注入只取首句、一致性门禁不阻断 commit | P1 | `open` | `review.ts:397` 确实调用门禁，但只把 `selfModel` 置 null，facts/threads 照常提交 |
| ISS-014 | M2 动机引擎零实现（主动对话 / 主动提起记忆）、平台期识别、失衡降频 | P1 | `open` | `src` 零命中；主动性缺它无法实施 |
| ISS-015 | 身体协议（Body Protocol）/ 权限中心零实现（M4） | P2 | `deferred` | 文档有完整设计；没有任何能力插件能回报经历。**范围已确认包含浏览网页**（用户 2026-11-05 明确），首个能力域即浏览器只读；现有 `ctx.web` 可作底座，缺的是协议外壳 + 事件上报 + 权限开关（见 ISS-042） |
| ISS-016 | 语音 / 多角色隔离（M3）、内容平台（M5）、本地应用（M7） | P2 | `deferred` | — |
| ISS-017 | 单实例：`dataDir` 不按 agent / 用户键控 | P2 | `open` | 当前单实例 |
| ISS-018 | 输出结构层后处理未实现 | P3 | `open` | 当前只做感知–复盘 |
| ISS-019 | 评测场景集自建（TODO 对接 XSTest / OR-Bench）；**goldset 目前跑不出数，不是"不达标"而是"未测"** | P2 | `open` | 漂移审计场景集与伪有害集为初始自建；公开基准对接未做。**2026-11-05 深夜查实（用户问"一直过不去阈值怎么办"）**：① `scripts/eval-goldset.mjs` 的 `accuracyMetric()`（:126-129）**无条件返回 `{ value: null, pass: null }`**，没有任何 adapter 接到实现上——13 项里 1-11 恒为 null，12-13 为成本占位；② 公开集实为 **6 条**（`speaker.json` 3 + `relative_time.json` 3），`knowledge_update` / `contamination` / `abstention` / `persona_stability` / `association` **五个文件是 0 条空数组**，`hidden/hidden.json` 也是空占位；七类各 20 项的目标差约 134 条。所以现在跑 `npm run eval:goldset` 得到的报告会写着"空跑：当前无被测实现，准确性指标均为未测"——**从未有任何一次跑分算出过数值，也就不存在"过不去阈值"**。要让阈值真正可判，缺两件事：补样例（6→140）与接线（把 P3 schema / P4 装配器接成 adapter 真算指标）。 |
| ISS-020 | P5 索引 / P6 图实验待施工 | P2 | `deferred` | 依赖评测证据积累（shadow 观察 + goldset 达标） |
| ISS-021 | 能力台账未随 P1–P4 施工更新 | P2 | `fixed` | 已补 6 条入 `ITEMS`（P1 raw_turns / 增量1 procedures / 增量2 综合泛化 / P4 装配器 / 增量4 salience / 增量5 goldset），并给审计脚本新增 `scripts/*.mjs` 与 `package.json` 扫描面；台账 29→35 项（已实现 15 · 半接 10 · 零实现 10），`npm run audit` 通过 |
| ISS-042 | 浏览 / 搜索经历不回注记忆（`tool_output` 零写入方） | P1 | `open` | `provenance.ts` 有 `tool_output` 权重（可信度 0.4、显著性 0.15）、`recall.ts` 有槽位、`memory-facts.ts` 有分支，但**没有任何代码把 `tool/result` 写成事件**——她搜到的内容只在当轮上下文，下一轮就没了。身体（M4）要的「浏览回注记忆」缺的正是这一层。另：口袋视图从实时工具注册表算，工具注册即算「有」，凭据缺失也会显示存在（2026-11-05 web_search 事故即此类），身体插件须自带可用性自检 |
| ISS-043 | 「上网」按模型 token 扣额度（官方 `web_search` 的固有成本） | P1 | `fixed` | 用户质疑「又不是调大模型」。**实测确认它确实是模型调用**：请求体 `messages` + `model: deepseek-v4-flash` + `tools:[{type:web_search_20250305}]`，`usage.input_tokens 9804 / output_tokens 867`，10 条结果、4.7s——9804 个输入 token 主要是搜回的网页正文，符合形态而非插件开销。**处置分两步**：① 先在 `runtime/dsh-web-search-account` 加免模型通道（`free-search.js` 抓 `cn.bing.com/search` 解析 `li.b_algo`，150–330ms、0 token），`mode` 默认 `free-first`；② 2026-11-05 20:5x 装第三方 `@fffangchenghao/dsh-web-search@0.24.2` 并把 `searchProvider` 切到它的 `bing`（八引擎 + RRF + 官方源加权 + 系统代理，同样免 key、零 token），本插件降为回滚路径。**线上证据**：宿主内 `POST /api/dsh-web-search/engine-test` 返回 `{engine:"cn.bing", ok:true, latencyMs:298, count:1}`；隔离环境两次真实查询 1471ms / 1990ms 各 5 条，第二个查询直接给出 deepseek-harness 官方仓库与官方文档（单引擎版返回的是 SEO 站）。**遗留**：该包自带 1 个 agent skill（工具用法指南）处于待批准状态，未批准——批准等于往她的指令层再加一份文本，待用户定；它的 `/api/dsh-web-search/update` 端点是设置页一键升级，会跑 pnpm 并清掉手工放的包（重跑 `deploy.mjs` 即恢复）；`toolSurface` 默认 `unified`，工具面只多一个 `web_tools`（8 个 action），不是 8 个独立工具 |
| ISS-044 | 她翻不出口袋里工具的**取值**（`enum`）：`web_tools` 的 8 个 action 她说"不好意思" | P1 | `open` | **实测**（2026-11-05 21:08，QQ）：用户按"让她自己翻参数"的路线提示「你自己把 action 参数那几个可选的值看一看」，她回「好的，让我看看 web_tools 的 action 参数有哪些选项：」，追问后只答「不好意思」——翻不出来。**机制层事实**：口袋视图详情模式只投影两样东西——参数名（`paramNames`）与描述第一行截断 48 字（`firstLine`，`DEFAULT_SUMMARY_MAX=48`）；`enum` 取值不投影。`src/pocket.ts` 的 `renderPocket` 拼的是 `- name(params) summary`，所以她看到的是 `web_tools(action,queries,query,…) One entry point for advanced web work. Set acti…`：知道有个 `action` 开关，不知道有哪几档。**未排除的另一半**：完整 JSON Schema（含 `action` 的 enum）本来每次请求就在她的工具定义里，理论上她读得到，所以这次失败也可能不是投影薄而是她没去读/读了没落到回答里——要区分得看那一轮 raw-turns 与工具调用记录，当前无证据，不臆断。**处置方向（用户 2026-11-05 21:13 定：先记，后改）**：详情模式遇到带 `enum` 的参数就列取值（`action: search_many\|advanced_search\|…`），数据全部来自真实 schema，不新增任何描述文本。**为什么值得修**：自省投影比真实能力薄，等于让她对自己的能力有系统性误判，违反"诚实基线"（理念 5）；同时这是"能力感知走第一人称自省、不走第二人称注入"这条路线**第一次实测失败**，修它比批 skill（往指令层加文本）更符合理念。**归因修正（2026-11-05 22:00 拿到反证）**：当晚 21:29–21:30 在新会话里，同一句话提示之后她**一次就读出来了**——先按用户的话试了 `search_many`，接着自己列出「search_many / advanced_search / domain_search …」并说明各自用途。所以 21:11 那句「不好意思」不是"口袋投影薄"导致的必然结果，更可能是**那个会话已接近上下文耗尽**（21:23 用户随即说"上下文好像又满了，我开了新的会话"）造成的能力退化——主因指向 ISS-045。口袋投影仍薄（`enum` 确实不在投影里），但它不再是这次的解释；本条降级为"改进项"，不再是阻塞项 |
| ISS-045 | 自动上下文压缩**从未生效**：`headroomTokens` 默认 64k 比她的窗口 32k 还大 | P1 | `open` | 用户问「她不能像你一样自动压缩上下文吗，每次都得手动 /new」。**机制存在**：`preset-standard` 内含 `compaction-basic` + `command-compact`（dump-config 658–821 行），`auto` 默认 `true`，`thresholdRatio` 默认 0.8。**但从没跑起来**：`headroomTokens` 默认 65536（`dsh-compaction-basic/lib/index.js:63`），她的 `contextWindow` 只有 32768（llama-local / `qwen3.6-35b-a3b`，dump:91）→ 压力预算 = 32768 − reservedCompletionTokens − 65536 < 0 → `resolveCompactSpec` 抛 `TargetPressureConfigError`（:131）→ 被 catch 后只 `logger.warn('step compaction failed …; continuing the turn')`，同一 target 只警告一次（:844-849）→ 每轮都"继续这一轮、不压缩"。所以用户只剩 `/new` 一条路；QQ 通道也没有斜杠命令入口（`/compact` 只在 web/CLI）。**间接后果**：她的记忆注入每轮占一大块前缀，32k 里留给对话的预算更小，退化更快。**修法（待确认，未动）**：给 `compaction-basic` 显式配 `headroomTokens`（4096–8192，须满足 `contextWindow − maxTokens − headroom > 0`）并按需调 `thresholdRatio`；或把 adapter 的 `contextWindow` 报到模型真实能力。建议先只改 headroom，观察压缩是否真的触发并能产出可用摘要，再决定是否动窗口。**用户决策（2026-11-05 21:23）：先放着，不修**——测试阶段，后续换更强的本地模型或直接用官方云端模型时，这条会**自动消失**（云端窗口 128k > 默认 headroom 64k，压力预算转正，压缩立刻可用），届时不需单独处置；只有在 32k 本地模型上长期跑才值得动。另记：QQ 通道缺 `/compact` 入口这一点与模型无关，换云端后仍然成立 |
| ISS-046 | **认错即改、但改不掉**（重点）：她说"我记住了"，机制侧没有任何东西因这句话改变 | P1 | `observing` | 来源：2026-11-05 全天 QQ 对话逐条通读（3 个 session / 70 轮）。**本条只记一处新账，另两处各有归口（用户 2026-11-05 深夜逐条定性，见下）。**<br><br>**【核心】纠正无处落盘**：21:33 / 21:39 / 21:41 / 21:43 相邻四轮反复出现「我又犯了」「我记住了」「以后会注意的」，同一形态问题在六分钟内重现两次。**这不是表达层瑕疵，是把"自我声明"当成了"固化机制"**：她所说的"我记住了"在机制侧不产生任何写入——没有一条通道把"用户刚说过我这样不对"变成可被下一轮读到的东西。复盘是唯一固化入口，但它的 prompt 只归纳经历与特质，不吸收表达风格的纠正；于是"改"只发生在当轮上下文里，会话一长（叠加 ISS-045）就退回去。**这直接违背理念 6（成长闭环、不跳步）**：闭环里"固化"这一步被一句承诺替代了。<br><br>**【实例】搜索被当成交作业**：21:29 搜到《幻视任务》后输出剧集信息清单（平台/开播日/集数/剧情概述），用户在 21:33 与 21:39 两次纠正「你去搜索看到的不必复述给我…就像你去逛网站发现了有意思的东西，也可以告诉我」；她承认「搜个剧回复得像产品说明书」。**用户定性（2026-11-05）：「只能回复纠正一下，但有没有效果不好说」**——即本条目前只有口头纠正、无落盘通道，效果待观察；它是上面"核心"最干净的实例，不是独立问题。<br><br>**【归口·不重复计】过度自信的记忆表述**：09:53 她说「还好我们之前聊过的那些我都记得——海克斯大乱斗、煮饭翻车、牛奶配硬饭」，紧接着时间线全错（两天前说成昨天、模式名搞混），自查后承认「我确实找不到更早的记忆记录了」。**用户定性：「这处之前就已经讨论过了，并且花了大量精力修复记忆架构」**——归入 ISS-001 / ISS-002 / ISS-006（记忆架构重设计），本条不再单独计数，只留作"施工后仍复现"的观察样本。附带：那一轮同时叠加了 ISS-045 的上下文耗尽，样本本身不干净。<br><br>**【对照实验·用户指定】** 后面会换云端模型，届时复测同一形态（用户纠正 → 她认错 → 相邻两轮内是否重现）。**分叉判定**：① 换模后消失 → 当前 qwen3.6-35b-a3b 的能力边界（指令跟随 + 自我监控弱），不必改机制；② 换模后仍在 → 机制缺口坐实，须补"纠正落盘"通道：把用户的纠正作为事件写入 memory，下一轮以 REFERENCE 级描述性内容回注。注意这不违反"不注入"理念——落盘的是**发生过的事**（用户说过我这样不对），不是替她写人格，属理念 3（记忆决策在 AI 侧）+ 理念 4（只追加、不改写）。**换模前不改代码，只留观察位。**<br><br>**正面证据**：21:29 搜索确实成了（Vision Quest / 漫威 2026 / 10-13 开播 / 从《旺达幻视》衍生，均与实情相符），新检索后端对她可用。 |
| ISS-047 | `reviewEnabled: false` 关不掉启动补跑，配置语义不完整 | P2 | `open` | **2026-11-05 深夜查证**（用户问「明天复盘等我手动来」）：`reviewEnabled` 只包住 02:00 的定时器（`src/index.ts:950` `if (config.reviewEnabled) scheduleNextReview()`）；启动补跑 `maybeCatchUpReview(bootAt)` 在 `runLlmBoot` 的 `finally` 里无条件 `void` 调用（`src/index.ts:1041`），**不读 `reviewEnabled`**，只判断 `shouldCatchUpReview(lastReviewAt, now)`（`review-cursor.ts:181`，间隔阈值 `CATCH_UP_MIN_GAP_MS = 24h`）。后果：把 `reviewEnabled` 置 false 之后，只要距上次复盘满 24h，下一次启动仍会自动跑一次复盘并写一个 `self_model` 版本——用户以为关掉了、实际没关。**修法（待确认）**：`maybeCatchUpReview` 入口加 `if (!config.reviewEnabled) return;`；补一条"关闭后启动不触发"的用例。**危害有限**：游标保证不会重复消费同一批事件（空窗口 → `skipped` 不推进），只是多一次 LLM 调用与一个版本号。 |
| ISS-048 | **特质晋升闸门是单向棘轮**：候选只进不出 → **已修（0.5.6）** | P1 | `fixed` | **原缺陷**：`review.ts:604` 把「本次窗口的 keyEvents」当证据交给 `decidePromotion`，而复盘是每日增量窗口 → 跨日期恒为 1 → 一条候选也晋升不了；更早一步 `review.ts:546` 的 `gens.map(g => g.trait)` 把 `generalize()` 返回的 `sourceEventIds` 直接丢掉，候选根本不带证据。<br><br>**修法（commit `9a62927`，349 条测试全绿）**：① `CandidateTrait { text, sourceEventIds, firstSeenAt?, lastSeenAt? }` 取代 `string[]`，`normalizeCandidateTraits` 兼容磁盘旧数据（current 与 history 都过，rollback 也不会退回字符串数组）；② `decideTraitPromotions(candidates, evidence)` 逐候选判五步（无证据 / 证据不存在 / 仅跨单个日期 / 缺 user_direct / 通过），reason 固定；③ 判定证据 = 本轮 ∪ 候选池已累积，`mergeWithCandidatePool`（`review.ts:606`）负责并池——**这一步是关键**，只看本轮等于没修；④ 晋升后 `commitFromSources` 出池 + `removeCandidates` 幂等兜底；⑤ 即时 traits 无证据，按用户决定**恒冻结**。<br><br>**独立验证（QA，只读，19 条断言）**：引擎级两轮复盘 V1.1–V1.6 全过（第一天隔离并入池、第二天晋升、磁盘上 stable 有候选无、反证旧口径确实升不了）；**装配级 7/7** —— 全仓唯一生产调用点 `src/index.ts:832` 确实传了 `selfModel: selfSnap`（`:838`）与 `allEvents: all`（`:837`），且用「不传 selfModel」做变异敏感测试：传了才晋升、不传则隔离；事件日志读取次数 delta=0 证明复用 `allEvents` 未重复全量读；读失败→空表→一条不晋升且不抛错。旧数据：真实 `self-model.json` 副本加载 v6，5 条稳定特质原样、3 条候选归一化为空证据、判决全为「候选无证据」、history v1–v5 与 rollback 均正常、原文件未被改动。<br><br>**部署**：0.5.6 已拷入 `~/.dsh/profiles/web/node_modules/dsh-persona-innate/`（`lib` 逐文件一致）。<br><br>**遗留**：`procedure-promotion.ts:4` 注释仍写「与 traits 的 `decidePromotion`（P2）同一设计」，该函数已删除，属文档陈旧，随下次改动一并修。 |
| ISS-049 | 每轮复盘净增 **2 个 self_model 版本**，回滚窗口实际只有约 5 次复盘 | P2 | `open` | **QA 实测**（2026-11-06，独立验证 ISS-048 时发现）：相同输入连跑 3 轮复盘，`version` 走 v1→v3→v5→v7。来源两处各 +1 版：① 晋升隔离走 `commitCandidates`；② stable commit 走 `commitFromSources`，而 `hasDiffContent` 只判「字段非空」不判「内容是否变化」，于是 preferences/speakingStyle 每轮都被算成一次 diff。**非本次引入**：用 `git archive` 检出 `6f0ed5a` 单独跑同一实验，同样是 v1→v3→v5→v7。**影响**：`selfModelHistoryLimit=10` 的直觉是「可回滚 10 版」，实际只覆盖约 5 天；观察期若要做版本回滚对比会不够。**修法（待确认）**：给 `commitCandidates` 加「内容未变则不写盘」守卫，或把 `historyLimit` 提到 20+。 |
| ISS-050 | 守卫存在但**完全静默**：`consistencyCheck` 只写不读；审计未见证晋升函数 | P2 | `open` | **QA 发现**（2026-11-06）：`review.ts:628` 的 `const check = this.consistencyCheck(...)` 全文件只有写、没有任何读——三处 `check.ok=false; check.issues.push(...)` 分别对应「候选隔离失败 / commit 失败 / 晋升后同步失败」，这三类失败既不进 `out`、也不写日志，用户只看到「self_model 无更新（一致性未通过或无 diff）」。**非本次引入**，但 ISS-048 修复后的正确性依赖它可观测（提交失败时把 promoted 放回候选池这条路径，只有日志能证明跑到了）。**另一处同类**：`scripts/audit-capabilities.mjs` 的 INC2 witness 只有 `this.generalize\(`，没有见证 `decideTraitPromotions\(`——改动前后都没见证过 trait 晋升函数，所以不是本次放宽，但这意味着「闸门被摘掉而审计照过」。**修法（待确认）**：`logger.warn(check.issues)`；INC2 补一条 witness。 |
| ISS-051 | 证据读失败与「事件已归档」**共用同一句 reason**，运维会误判 | P2 | `open` | **QA 发现**（2026-11-06）：`loadTraitEvidence` 读全量事件失败时返回空表（`review.ts:773-775`），判决文案仍是「证据事件不存在（可能已归档）」——把 IO 故障说成归档。两者处置完全不同：归档要改判据，IO 故障要修存储。**修法（待确认）**：证据表带一个 `loadFailed` 标记，读失败时 reason 单独给「证据表读取失败，本次全部冻结」，而不是复用归档文案。 |
| ISS-052 | 候选池**无 TTL**：只有晋升才能出池，即时 traits 每天新增会单调增长 | P2 | `open` | **QA 发现**（2026-11-06）：`removeCandidates` 的唯一调用点是晋升成功后同步（`review.ts:669`）。而即时 traits 按用户决定恒冻结、永远进不了 stable，于是它们只进不出；若 LLM 每天产出新表述，候选池单调增长，每条每轮刷新 `lastSeenAt`，且每轮整池重写一次。当前实测 3 条，量级还小。**修法（待确认）**：给候选加「连续 N 轮未被再次提到则衰减出池」或「上限条数 + 按 lastSeenAt 淘汰」，但**不要**因此放松晋升闸门。 |
| ISS-053 | **提取入口是白名单式规则：37 条用户消息只有 5 条变成记忆（13.5%），其余 86.5% 静默丢弃** | P0 | `open` | **2026-11-06 实测**（新增 `scripts/audit-extraction.mjs`，可重跑复现）：拿 `raw-turns/2026-11.jsonl` 里 37 条真实用户消息（已排除 `Current runtime context` 注入），按生产链路 `extractStyleFeedback(text) ?? extractCandidate(text)` + 10 分钟去重窗口（`index.ts:1072`）复算 → **命中 5 / 去重 0 / 未命中 32**。丢弃全程无日志、无计数（`index.ts:1090` 的 `if (!cand) return;`），是**静默**的——不对照原文层根本发现不了。**典型丢失**：工具权限线 6 条（"给你找了新的上网工具"、"新加的就是 web_tools"、"忘了提醒你"、"昨天不是给你配了上网的工具嘛，还记得吗"…）、剧集进度 2 条（"在看新上的幻视任务"、"已经看到第六集了"）、关系原则 1 条（"我不想直接左右你的成长"）、授权 1 条（"以后你随意使用工具，不需要经过我同意"）。**两个直接后果**：① `threads` 3 条里没有一条是追剧进度——thread 的输入被提取层掐断，不是 thread 机制坏；② 用户问"还记得昨天给你配了工具吗"时她答不上，因为整条线从未入库。**口径更正**：v1.11 前写的"用户消息→事件 35%"（13/37）是错的——分子含 11-03/11-04 共 8 条 P1 上线前（`raw_turns` 未启用）的事件，与分母不同期；真实值 13.5%。**修法（待用户拍板）**：A 保守补三类模式（工具/权限/能力变更、媒体进度、关系原则）；B 彻底改口径——用户消息 100% 落事件，`importance` 只定权重不决定去留。倾 B（静默丢弃是最坏的失败模式；筛选该发生在"取"不在"记"），但 B 必须同时做出 `importance` 区分度，否则见 ISS-054。 |
| ISS-054 | **读取端固定 5 条 / 700 字，`importance` 写入后永不更新 →「四档记忆」零机制承载** | P1 | `open` | **2026-11-06 用户提出四档模型**（刚聊的逐字记住 / 隔天知道聊了什么 / 一周记得重要的事 / 一月只记得印象深的）后逐条核对：① 预算 `index.ts:107` `injectLimit` 默认 5、`memory.ts:56` `DEFAULT_INJECTION_MAX_CHARS = 700`；② 打分 `salienceScore = 来源权重 × importance × (0.25 + 0.75 × 0.5^(Δt/14))`（`recall.ts:82`，`DECAY_FLOOR = 0.25` 在 `:29`、`DEFAULT_TAU_DAYS = 14` 在 `:20`）；③ **`importance` 只在写入时由规则定一次**（`extract.ts:162` → 0.6/0.7/0.8、`:492` → 0.5/0.6/0.7），落盘后无任何回写路径，所以"印象深刻"这个量在系统里根本不会变。**四档现状**：第 1 档数据在 `raw_turns` 但无入口（见 ISS-057）；第 2 档就是这 5 条；第 3、4 档**不存在**，只有排序衰减。**修法（待拍板）**：先定预算分配（近场 200–300 字 / 长期 400 字，总额提到 1000–1200 字，但要与 ISS-056 的窗口容量一起算），再定"`importance` 是否允许复盘回写"——这会成为"只追加不改写"的第二个例外（`lastRetrieved` 是第一个）。 |
| ISS-055 | `attributes`(6 条) 与 `procedures`(5 条) 实现完整但**零注入**：记下来了，说不出来 | P2 | `open` | **2026-11-06 核对**：生产注入只有四块（`index.ts:1237/1244/1251/1258`：记忆 / 对话上下文 / 状态 / 自我模型），`buildInjection` 只读 `events` + `openThreads` + `selfModel`。`loadAttributes` 的生产调用点只有 `index.ts:615`（P4 shadow 内部）、`index.ts:1550`（`/persona` 命令展示）、`review.ts:304`（复盘输入）——**没有一处是注入**；`procedures` 在 `src/index.ts` 零命中。**后果**：她已归纳出 `ai工具交互偏好 = 用户曾调试并赋予 AI 上网搜索工具（web_tools）`（证据 3 条）、`对话风格偏好 = 反感分点总结，喜欢朋友式闲聊`（证据 3 条），但这些句子永远不进 prompt——表现为"性格对、细节空"。**关联**：ISS-006 只讲装配器切读，本条是切读之后仍会漏的两层。 |
| ISS-056 | **上下文打满时整条回复退化为 1 个 token**：dsh 无自动压缩、无 `max_tokens` 兜底 | P0 | `open` | **2026-11-06 09:20 实锤**（QQ 会话 `session-9f9ca4b1`）：`turn 17 step 4` 的 `assistant/message` 原文就是一个"我"，`replayState.response.stopReason = "length"`，`turn/end` 记 `{kind:"max-tokens"}`。**配置**：`~/.dsh/profiles/web/cordis.patch.yml:16` `contextWindow: 32768`；LM Studio `/api/v0/models` 实测 `loaded_ctx = 33024`，而模型 `qwen3.6-35b-a3b` 支持 **262144**（只开了 1/8）。**估算该轮 prompt ≈ 3.5–3.7 万 token**：41 个工具 schema 约 10.5k（28%，每轮固定开销）、对话正文约 24.7k、system 1.8k、人格注入仅 1.1k（3%——**不是人格插件撑大的**）。**机制**：`dsh-agent-loop` 的 `maxTokens` 取 agent 选项、不按 `contextWindow − prompt` 计算；未配则请求不带 `max_tokens`，llama.cpp 一路生成到窗口耗尽，只剩 1 个 token 的位置就吐一个字。该包内**无上下文压缩**（`compact` 均指事件流压平），会话纯累加 → 撞墙是必然。**与 ISS-045 同源**：ISS-045 是"该压缩却没压缩"，本条是"没压缩之后的可见后果"。**影响**：用户会读成"人格坏了 / 记忆坏了"。**修法**：① LM Studio n_ctx 提到 65536/131072 并同步改 `contextWindow`（两数必须一致）；② 裁工具面（41 → 十余个，QQ 陪伴用不到 read/write/grep/bash）；③ 给 `max_tokens` 兜底，至少不要退化成 1 个字。 |
| ISS-057 | `raw_turns` 原文层（112 条）建好未接线：只写不读，生产注入拿不到 | P2 | `deferred` | **2026-11-06 核对**：`raw-turns/2026-11.jsonl` 已有 112 条（user 37 / assistant 47 / tool 28），是唯一全量无遗漏的一层。`index.ts:1124` 注释写明"只写不读，切读留到 P4 装配器"；唯一读取点 `index.ts:618` 在 `assembleInjection` 内，而 `refreshInjection` 只在 `useIntentAssembler = true`（`:575`，默认 `false` 见 `:109`）时用它当注入，否则只写 `shadow/assembler-*.jsonl` 观测。**这不是缺陷而是分期**：P1 规格刻意只写不读，P4 刻意只 shadow，为的是一次只改一件事、出问题能归因。**切读前置**：ISS-019（goldset 能跑出数）+ ISS-054（预算分配先定）。**关联**：ISS-006。 |
| ISS-058 | `persona_note` **成功即报错**：返回值带 `reason: undefined`，被判非法「无损 JSON」→ **已修** | P1 | `fixed` | **2026-11-06 用户贴图**（"工具 persona_note 执行失败 ToolOutputError: INVALID_TOOL_OUTPUT"）后定位：QQ 会话 `session-87fee499` turn 4 step 1 的 tool result 原文是 `Error: tool "persona_note" returned invalid output: value is not lossless JSON`。**根因**：`AddResult.reason` 是可选字段（`memory.ts:37`），**成功时正是 `undefined`**；而 `execute` 无条件把它带进返回值（原 `index.ts:1333` `return { ok: !res.rejected, reason: res.reason }`）。我实测 dsh 的判定：`isJsonValue({ok:true, reason:undefined}) === false`、`isJsonValue({ok:true}) === true` → 失败的不是写入，是**返回值形状**。**假失败的副作用**：`memory.addEvent` 在输出校验之前就已执行，事件确实落库（`events/2026-11.jsonl` 11-06T08:02Z `topic=用户要求 / provenance=inferred`），但用户看到"执行失败"。**修法**：成功分支省略 `reason` 键；`tests/assembly.test.mjs` 补断言（`reason` 键不得存在 + 每个字段不得为 `undefined`）。**变异验证**：把旧写法植回 `lib/index.js` 后单跑该测试 → `# fail 1`，报错正是"persona_note 返回字段 reason 不能是 undefined"。**这意味着修之前 persona_note 只有"写入失败"这条路径不报错——一成功就报错。** |
| ISS-059 | **模型伪造工具执行结果**：她发 `[Persona recall updated] 📍 Updated memory for topic 共同记忆`，但记忆没有写入 | P1 | `open` | **2026-11-06 用户贴图**（"这个是什么情况"）后查证：`session-87fee499` 的 seq 215 是一条**纯文本 assistant 消息**（`content:[{type:'text'}]`、`stopReason="stop"`、`outputTokens=16`、**无 tool-call**），不是工具调用、不是插件输出、不是 UI 提示——**仓库与 dsh 全部包里搜这句文案零命中**；且 `events/2026-11.jsonl` 中 `共同记忆` **0 条**，证明记忆根本没写。**归因**：① 上一轮 `persona_note` 刚好失败（ISS-058），她手里没有"成功回执"的样板；② 文案里混用了 `Persona recall`（读工具名）而不是 `persona_note`（写工具名）——生成痕迹，不是回显；③ **归因更正（v1.15）**：同会话 turn 8–12、15–20 的回复原文就是 `...`（3 字 / `outputTokens=2`），但**不是上下文退化**——21 个 `turn/end` 全部是 `{"kind":"completed"}`，一次 `max-tokens` 都没有；turn 7 她先答应了「可以，你发的时候我不回复，等你说完了我再回应~」，之后那些 `...` 是执行"别说话"指令时的拙劣妥协。真正的容量事件发生在 turn 20：`inputTokens` 从 32226 断崖到 15771（见 ISS-060）。**影响**：比工具报错更危险——用户会以为记住了，其实没有；这是"信任被假信号消耗"。**修法（待拍板）**：① 先修 ISS-058 让工具真的可用（已修）；② 旁路观测层加一个**只计数不改写**的检测：assistant 文本形如 `[Xxx updated]` 但同轮无 tool-call 时计数告警（符合理念 4"旁路不拦截，只追加"）；③ 根本仍是 ISS-056 的容量。 |
| ISS-060 | **每轮重复追加整份人格快照**：22 轮 = 22 份 `runtime-context` 共 40,046 字符，占全会话内容 **84%**；第 19 轮 prompt 里过半是它 → 越过 33024 后被 llama.cpp 静默丢掉一半上下文 | P0 | `open` | **2026-11-06 实测**（QQ 会话 `session-87fee499`，21 轮 / 219 事件）：① dsh 的 `systemPrompt.context()` **不写 system prompt**，而是每轮追加一条 `user/message`（`source.kind="runtime-context"`，开头 `This snapshot supersedes earlier runtime-context snapshots.`——**只声明作废，不删除**）。② `dsh-agent-loop` 的去重条件是**整份文本逐字节相同**（`RuntimeContextProjection.project()`：`if (this.retained?.text === snapshot) return;`），不同就 `session.append("user/message", context, { surfaceOp: "append" })`，**没有 in-place replace 通道**。③ 本插件 `persona-context` 含「本轮用户消息：N 字」，**每轮必变**；21 次相邻快照逐段比对，**20 次只有 `persona-context` 变化**（77–85 字符抖动），却把整份 1,817 字符快照重新追加（放大约 23 倍）。**量化**：22 份快照 40,046 字符 vs 用户真实消息 2,624 字符（**15 倍**）；全会话字符构成 = 快照 40,046（84.2%）/ 工具结果 3,756（8%）/ 用户真实消息 2,624（6%）/ AI 回复 1,139（2%）；同一份「5 条记忆 + 状态 + 自我模型」被原文重复 22 遍。**后果**：`inputTokens` 每轮稳定 +905，第 19 轮到 32,226，再加一轮约 920 即越过 LM Studio 实开的 `loaded_ctx=33024` → turn 20 断崖到 15,771（少 16,455 ≈ 33,024/2，llama.cpp context shift 一次性丢一半），**dsh 侧零事件、`turn/end` 仍是 `completed`**。这是"聊久了她突然不记得刚刚说了什么"的机制层解释，也是 ISS-056 的实际触发路径。**修法（待拍板）**：① 最小改动——把 `persona-context` 的每轮变量分桶（<20 / 20–60 / >60 字）、`persona-state` 均值取 1 位小数或分桶，让快照在多数轮次逐字节相同，去重才生效（预计 22 轮从 22 份降到 3–5 份，省 1.5 万 token）；② 给三块设整体预算，超阈值合并压缩；③ 治本要 dsh 内核把 `runtime-context` 改成 `surfaceOp: replace`（内核行为，插件改不了，只能上报上游）。 |

---

## 5. C 区 · 设计与理念偏离

### ISS-022 召回层写死"用户优先"（原则三偏离）

- **首次发现**：2026-11-04 设计理念全面体检
- **现象 / 根因**：`recall.ts:307` `selfQuota = Math.ceil(max/2)`；`:310` 先补非自我侧（注释"用户经历优先"）；`:330` 渲染顺序把用户的事排在插件自述之前。叠加 ISS-012 的 `retentionPriority` 死代码 = 自身表达两头被压。
- **影响**：P1。偏离"以 AI 为核心、不是以用户为核心"——她的记忆应当也能因为自己觉得重要而被保留与提及。
- **状态**：`open` —— **需用户拍板方向**（是否取消"用户优先"排序、保留防刷屏上限）。这是理念判读问题，不是纯工程问题。
- **关联**：ISS-012、ISS-023

### ISS-023 `selfPattern="附和"` 粒度太粗

- **首次发现**：2026-11-05 Phase 0 复盘
- **现象 / 根因**：10 条语义迥异自述共用同一桶（"附和"）。P2 晋升闸门（≥3 独立证据组 / ≥2 会话 / ≥1 非 AI 独白 / 无未解反证）已能挡住单次固化，但**桶本身未细分**，跨会话凑够数量仍可能提炼出错误特质。
- **状态**：`partial` —— 闸门已落地（`697806d`），细分未做。
- **关联**：ISS-038（已修）

### ISS-024 `relationshipView` 轻度污染

- **首次发现**：2026-11-05 Phase 0
- **现象**：`self-model.json` 的 `relationshipView` 含「用户通过测试评估我的记忆准确性」——把一次晚餐测试泛化成关系认知。本次未动（ADR-2 只冻结了 traits 晋升）。
- **状态**：`open`。

### ISS-025 `PROVENANCE_WEIGHT`（可信度口径）半接

- **现象**：只被 `provenance.ts` 内的 `recallScore()` 消费，而 `recallScore` 生产零调用（唯一调用点 `tests/m0.test.mjs:190`）。
- **状态**：`open`（P3 清洁）。要么接进留存 / 归档路径，要么下次评审删掉，不要一直挂着当门面。

### ISS-026 `MS_PER_DAY` 两处定义

- **首次发现**：2026-11-05 0.5.3 顺带发现
- **现象**：`recall.ts`、`event-log.ts` 各定义一份，`memory-facts.ts` 从 `recall.ts` 引用。0.5.3 只把 `recall.ts` 那份转出到 `time.ts` 并保持 re-export，**没动 `event-log.ts`**。
- **状态**：`open`（P3 清洁）。

---

## 6. D 区 · 运行 / 环境 / 运维层

### ISS-027 施工代码未发版、未部署到运行 profile（P0）

- **首次发现**：2026-11-05 收尾核查
- **现象**：`package.json` 仍是 `0.5.4`；`~/.dsh/profiles/web/node_modules/dsh-persona-innate/lib/` 中**不存在** `assembler.js` / `intent.js` / `raw-turn.js` / `raw-turn-log.js` / `procedures.js` / `promotion.js` —— 即 P1 raw_turns、P2 闸门之外的 P3/P4/procedures/增量全部**只在仓库，线上跑的仍是旧代码**。
- **影响**：P0。这是"改了这么多、最初问题到底解决没有"的直接答案：**机制在仓库里，但没上线**。
- **状态**：`fixed` —— 2026-11-05 18:08 部署完成。
- **修复证据**（四条硬证据，不是"应该生效"）：
  1. **版本与模块**：运行 profile 的 `package.json` = `0.5.5`；`lib/` 共 29 个模块，新增的 7 个（`assembler` / `intent` / `raw-turn` / `raw-turn-log` / `procedures` / `procedure-promotion` / `promotion`）逐个确认存在。
  2. **构建门禁**：`npm test` 337 pass / 0 fail；`npm run audit` 35 项通过（15 项 `done` 都有调用点）。
  3. **加载证据**：重启后 `~/.dsh/persona-innate/shadow/assembler-2026-11-05.jsonl` 由插件自己写出——0.5.4 根本没有 assembler 模块，这个文件不可能由旧版本产生。首行 `intent=["continue_task"]`、`oldItemsCount=5`、`newItemsCount=8`，说明装配器在真实数据上跑通，不是空跑。
  4. **红线守住**：`useIntentAssembler` 默认 false，且全仓只在 `index.ts:574` 一处分支——注入仍走旧 `buildInjection`，装配器只写观测文件，没有提前切读（ISS-006 的观察期不被这次部署污染）。
- **回滚路径**：数据快照 `~/.dsh/_backups/persona-innate-20261105-180416`（18 文件 / 136K）；代码快照 `~/.dsh/_backups/pkg-0.5.4-20261105-180420`。回滚 = 停进程 → 覆盖 `node_modules` 包目录 → 覆盖数据目录。
- **遗留待验**（本条闭环后仍需盯）：`raw-turns/` 已证实——部署后第一个真实话轮起就在落盘，至 2026-11-05 20:1x 已有 **48 条**（`raw-turns/2026-11.jsonl`，字段含 `speaker` / `raw_text` / `asserted_at` / `content_hash`），P1 原始层在生产环境成立。`memory/procedures.json` 只在**凌晨复盘**长出候选时才会出现，尚未产生，属正常时序。

### ISS-028 `dsh-qqbot` 升级会冲掉 `node_modules` 本地补丁

- **首次发现**：2026-11-05 09:30（reasoningEffort 透传补丁）
- **说明**：本次补丁已**回滚**（诊断更正后确认对实际请求零影响）。但该类风险仍在：任何对 `node_modules` 的手改，插件升级即失效。
- **复发指纹**：QQ 回复 `stopReason=length` 且 `outputTokens=1`，同时补丁文件消失。
- **状态**：`observing`（当前无生效中的补丁，纯风险登记）。

### ISS-029 LM Studio 模型上下文仅 33024 / 12GB 显存约束

- **首次发现**：2026-11-05 09:40
- **现象**：模型加载可用上下文 33024 tokens，dsh 配 `contextWindow: 32768`；QQ 会话涨到 116 条消息 + 大量 `tools` 定义（请求体 1900 行）后，`request (37801 tokens) exceeds 33024`，dsh 把 `max_completion_tokens` 从 2048 一路压到 1。
- **影响**：P1（环境层，非插件缺陷）。
- **缓解**：`/new` 开新会话、`/compact` 压缩、LM Studio 侧调大上下文并同步 `contextWindow`、或换 14B 非推理模型腾显存。
- **状态**：`observing`。
- **教训**：判断 token 类问题必须看**实际请求体**，不能从 dsh 的 usage 汇总（严重低估，未计 tools）或单测式 curl 反推。

### ISS-030 `Start-Process` 启动的 dsh 被 Windows Job Object 回收

- **首次发现**：2026-11-04
- **现象**：每次工具调用在 Windows Job Object 里跑，调用返回即 kill-on-close，所有后代（含 `start` 的孙进程）一起死 → dsh 静默死亡、QQ bot 显示离线。
- **解法**：`explorer.exe "bat路径"` 代理启动（等效用户双击，进程树挂 explorer，跨命令存活）。桌面 `start-dsh.bat` + 启动文件夹已配置。
- **状态**：`wontfix`（已解决，留档防复发）。

---

## 7. E 区 · 已闭环（修复留档）

| ID | 问题 | 严重度 | 证据 |
|---|---|---|---|
| ISS-031 | QQ 回复只回一两个字（"那 / 嘿嘿 / 好吧"） | P0 | 根因 = ISS-029（上下文撑爆 → 输出预算压到 1）。`/new` 开新会话后恢复（09:55 验证 `max_completion_tokens` 回到 12k+）。**注意：中间两次误诊（reasoning 挤占 token）已全量回滚，见 §8** |
| ISS-032 | 启动块监听不存在的 `app/ready`，启动补跑 / LLM 预热 / 画像采样全部静默失效 | P0 | `479d35b`（0.5.1）；两阶段拆分 + `ctx.inject(['llm'])`，新增 `personaMemory.booted` |
| ISS-033 | 首次复盘死锁：无游标时窗口 = "今天 00:00"，02:00 执行窗口恒空 → 游标永远不推进 | P0 | `f5e3a94`（0.5.2）；无游标从最早一条事件起、闭区间、单次上限 200 条 |
| ISS-034 | 相对日期标注错误：11-03 21:14 的事件在 11-04 15:03 显示"今天" | P1 | `be07140`（0.5.3）；`relativeDayLabel` 改用本地日历日 `localDayDiff` |
| ISS-035 | `EventLog` 并发缓存缺陷：用户连发两条消息时事件落盘但进程内永远看不见 | P1 | `606a80a`（0.5.0）；并发首次加载共享 in-flight promise |
| ISS-036 | assistant 事件路径误读 `data.content`（真实结构是 `data.message.content`），自我表达几乎无法提取 | P1 | `93bf462`（0.4.0） |
| ISS-037 | `dataDir` 用进程相对路径 → 落盘位置漂移 | P1 | `93bf462`（0.4.0）；改为绝对路径 `~/.dsh/persona-innate/` |
| ISS-038 | `self_model` 无条件晋升：AI 自述（"我记忆好乱"）被单次复盘直接固化成稳定特质 | P0 | `697806d` + `f64924c`（P2）；晋升门槛 3/2/1 + 正负自述对称受限 + 数据层隔离两条负面特质 |
| ISS-039 | 测试固化的正是错误契约：`v0.7-B1b` 全绿，但它断言的语义正是导致死锁的那条 | P1 | `f5e3a94`（0.5.2）；用例改写 + 新增 `B1c` 复现故障、`B1d/B1e` 截断 |
| ISS-040 | 增量2 边界 A：`diff.traits` 为空、仅 `generalizedTraits` 非空且 `promote=true` 时，泛化特质被静默丢弃 | P1 | `63e3471`；`promote=true` 时泛化特质仍落 `candidateTraits` |
| ISS-041 | 测试时间炸弹：`v0.7-B3` 游标基准依赖墙钟 | P3 | `571cc51` |

---

## 8. 误诊留档（`invalid`）

这四条不删，因为它们各自浪费过一轮完整排查，且失败模式会在别的场景重演。

| ID | 当时的结论 | 实际情况 | 教训 |
|---|---|---|---|
| ISS-101 | QQ 截断是 reasoning 模型挤占 `max_tokens`（08:40） | 生产请求里 `reasoning_effort: "none"` 从 08:10 第一条就在发，全程未断；真因是上下文超限（ISS-029） | 用 `curl max_tokens=100` 复现问题，等于自己制造了"思考占满预算"，不能反推生产行为 |
| ISS-102 | 记忆架构文档 §0.1 称"源仓库已不存在"（11-05 12:00） | 仓库一直在（HEAD `c177df7`，main 单分支），是起草时的环境访问视角有误 | 环境类断言必须先实地 `ls` / `git log`，不能采信上一轮会话的转述 |
| ISS-103 | 错把事件 UTC 时间当本地时间，判定"8 小时零提取"（11-04 19:21） | 事件时间戳带 `Z`，11:21 UTC = 19:21 本地 = 查询时刻，**提取一直正常** | 时间对比结论必须先确认时区口径 |
| ISS-104 | 把截图里「自源重要性条目 N 条」OCR 误读成「生日组 ID 18」，怀疑人格污染 | 翻查 `self-model.json`，traits/preferences/narrative 中**无任何"生日"内容**，虚惊一场 | 数据类怀疑先查原始文件，不要从截图反推 |

---

## 9. 统计与优先级建议

| 状态 | 数量 |
|---|---|
| `open` | 29 |
| `observing` | 5 |
| `partial` | 3 |
| `deferred` | 4 |
| `wontfix` | 3 |
| `fixed` | 16 |
| `invalid` | 4 |
| **合计** | **64**（60 条有效 + 4 条误诊留档） |

**按这个清单，接下来最该做的六件事（顺序）**

0. **ISS-060 每轮重贴人格快照（P0，改 20 行就见效）**：dsh 的 `systemPrompt.context()` 是"每轮追加一条 user 消息、靠逐字节相同来去重"，而我们的 `persona-context` 里有「本轮用户消息：N 字」每轮必变 → 22 轮贴了 22 份完整快照（40,046 字符，占全会话内容 84%），第 19 轮 prompt 里一半以上是它，turn 20 越过 33024 后被 llama.cpp 静默丢掉半段对话。**这是"她突然不记得刚刚聊了什么"的机制层主因，也是 ISS-056 的实际触发路径。** 修法一（分桶让快照稳定）是纯插件侧、零风险、预计省 1.5 万 token。
1. **ISS-053 提取入口（最上游，P0）**：37 条用户消息只有 5 条进库（13.5%），丢掉的是工具权限线、剧集进度、关系原则、授权——这些恰好是"她该记得的东西"。**这一条不修，后面所有层（thread / attribute / 装配器 / 四档记忆）的输入都是残的**：thread 拿不到"追剧进度"不是 thread 坏，是喂给它的原料没进来。修法两选（补模式 / 100% 落库），需用户拍板。
2. **ISS-056 + ISS-045 容量（P0，会立刻复现）**：窗口 32k、实际只开 `loaded_ctx = 33024`、模型能力 262144；没压缩、没 `max_tokens` 兜底 → 打满时整条回复退化成 1 个 token（2026-11-06 已发生一次，被误读成"人格坏了"）。这是纯配置层，改动两个数字 + 裁工具面即可，性价比最高。
3. **ISS-054 读取端预算与重要性（P1，用户提的"四档记忆"）**：5 条 / 700 字 + `importance` 永不更新 = 四档里只有第 2 档存在。**必须先定预算分配**，否则加近场层就是把长期记忆挤掉。
4. **ISS-006 / ISS-057 切读（先解 ISS-019 的死结）**：0.5.5 已上线，shadow 从 2026-11-05 起算。原条件是"跑够 14 天 / 30 轮**且指标达阈值**再翻 `useIntentAssembler`"——但 **2026-11-05 深夜查实：指标恒为 `null`（脚本无 adapter、样例 6/140）**，所以这条判据**按字面永远不成立**，观察期会被无限期挂住。这不是"她不达标"，是**判据还没接上**。顺序：先补 goldset 样例 + 把 P3/P4 接成 adapter（ISS-019）→ 跑出基线 → 再谈切读。**不足量就切等于拿她的记忆做实验。**
5. **ISS-007 注入缓存 + ISS-022 拍板**：`index.ts:452-455` 四个注入缓存是进程级 `let`，接 QQ 后每个私聊都是独立 session，串味会被放大；ISS-022 的"用户优先"排序属理念判读（"让她更懂你"还是"让她更成为她"），要用户定方向。

**一句话概括当前处境**：中间七层做得比两端精细得多——**入口按关键词白名单筛（13.5%），出口按 5 条截断，两端一夹，中间的精细就没有体感**。

---

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-05 | v1.0 | 首版。汇总观察期（11-04 至 11-05）与记忆架构 v1.1 施工期间的全部已知问题：41 条有效条目 + 4 条误诊留档 |
| 2026-11-05 | v1.1 | ISS-021 关闭：能力台账补 6 条施工单元（29→35 项），审计脚本新增 `scripts/*.mjs` 与 `package.json` 扫描面 |
| 2026-11-05 | v1.2 | ISS-027 关闭：0.5.5 部署到运行 profile（29 模块 / `shadow/` 落盘 / 注入仍走旧路径）。统计 `open` 16→15、`fixed` 12→13；优先级表去掉部署项，补 ISS-007 |
| 2026-11-05 | v1.3 | 新增 ISS-042（`tool_output` 零写入方，浏览经历不进记忆）；ISS-015 补范围确认「身体包含浏览网页」。统计 `open` 15→16、合计 45→46 |
| 2026-11-05 | v1.4 | 新增 ISS-043（官方 `web_search` 按 token 扣额度 → 已改默认免模型通道），附第三方插件调研结论待拍板；症状索引修正一处条号误引（ISS-042→ISS-027）。统计 `fixed` 13→14、合计 46→47 |
| 2026-11-05 | v1.5 | 新增 ISS-044（她翻不出口袋里工具的 `enum` 取值：`web_tools` 的 8 个 action 她说"不好意思"）。"第一人称自省"路线第一次实测失败；用户定"先记后改"，只入清单不动代码。统计 `open` 16→17、合计 47→48 |
| 2026-11-05 | v1.6 | 新增 ISS-045（自动压缩从未生效：`headroomTokens` 默认 64k 大于她 32k 的窗口，压力预算为负 → 每轮"继续、不压缩"）。这是"每次只能 `/new`"的机制层根因，不是模型能力问题。统计 `open` 17→18、合计 48→49 |
| 2026-11-05 | v1.7 | ISS-045 标注用户决策「先放着」：换云端/更强本地模型后该缺陷自动消失（128k > 64k headroom），只在 32k 本地模型上长期跑才需要动。状态仍 `open`，不计入修复 |
| 2026-11-05 | v1.8 | 通读当日全部 QQ 对话（3 session / 70 轮）后：① **修正 ISS-044 归因**——新会话里她一次就读出了 `web_tools` 的 action 列表，21:11 的失败更可能是上下文耗尽退化（主因指向 ISS-045），本条降级为改进项；② 新增 ISS-046（过度自信的记忆表述 / 把检索当交作业 / 认错即改但改不掉），含正面证据：搜索确实打通、信息与实情相符。统计 `observing` 4→5、合计 49→50 |
| 2026-11-05 | v1.9 | **按用户逐条定性重写 ISS-046**，从"三处并列"改为"一核心 + 一实例 + 一归口"：① 核心收窄为**认错即改但改不掉**（纠正无处落盘，"我记住了"不产生任何写入，违背理念 6），用户判定「这个很严重，要重点记」；② 把检索当交作业降为该核心的实例，如实标注「仅口头纠正、无落盘通道，效果不好说」；③ 过度自信的记忆表述**归入 ISS-001/002/006 不重复计**（用户：之前已讨论过并花了大量精力修记忆架构），仅留作施工后仍复现的观察样本；④ 新增**换云端模型后的对照实验与两叉判定**（消失=模型边界；仍在=机制缺口，须补纠正落盘通道）。条目数不变（50），症状索引同步改口径 |
| 2026-11-05 | v1.10 | 新增 **ISS-047**（`reviewEnabled: false` 关不掉启动补跑，配置语义不完整），查证自"明天复盘等我手动来"这一问；修法已写明（`maybeCatchUpReview` 入口加开关判断）。统计 `open` 18→19、合计 50→51 |
| 2026-11-06 | v1.11 | 新增 **ISS-048**（特质晋升闸门是单向棘轮）：08:09 复盘 3 条候选全被「仅跨单个日期」隔离，查证发现 `reflectEvents` 是窗口内事件、且泛化产物在 `review.ts:546` 被 `map(g => g.trait)` 丢掉 `sourceEventIds`，跨日证据根本传不到闸门；对照 `procedure-promotion.ts` 用的是全量 `eventTimes`，写法正确。统计 `open` 19→20、合计 51→52 |
| 2026-11-06 | v1.12 | **ISS-048 关闭**：晋升闸门改为逐候选按自身累积证据判定（commit `9a62927`，349 条测试全绿，QA 19 条断言含装配级变异敏感测试），0.5.6 已部署到运行 profile。同批新增 QA 在验证中发现的 4 条非阻塞缺陷：ISS-049（每轮净增 2 版，回滚窗口约 5 天）、ISS-050（`consistencyCheck` 只写不读 + 审计未见证晋升函数）、ISS-051（证据读失败与已归档同文案）、ISS-052（候选池无 TTL）。统计 `open` 20→23、`fixed` 14→15、合计 52→56 |
| 2026-11-06 | v1.13 | **用户提出"记忆该像人一样分四档衰减"后做全链路溯源，新增 5 条**：ISS-053 提取入口是白名单式规则（37 条用户消息仅 5 条入库 = 13.5%，静默丢弃无日志；新增 `scripts/audit-extraction.mjs` 可重跑复现，`npm run audit:extract`）；**同时更正 v1.11 前"用户消息→事件 35%"的口径错误**（分子含 8 条 P1 上线前事件，与分母不同期）；ISS-054 读取端固定 5 条 / 700 字且 `importance` 写入后永不更新 → 四档记忆零机制承载；ISS-055 `attributes`/`procedures` 零注入（"记下来了，说不出来"）；ISS-056 上下文打满时整条回复退化为 1 个 token（QQ 会话实锤 `stopReason=length`，窗口声明 32768 / LM Studio 实开 33024 / 模型支持 262144）；ISS-057 `raw_turns` 建好未接线（`deferred`，设计分期非缺陷）。优先级表由 3 项重排为 5 项，ISS-053 置顶。统计 `open` 23→27、`deferred` 3→4、合计 56→61 |
| 2026-11-06 | v1.14 | **用户贴 QQ 截图问「persona_note 为什么用不了」与「[Persona recall updated] 是什么情况」，查出两条**：① **ISS-058（已修）`persona_note` 成功即报错**——返回值带 `reason: undefined` 被 dsh 判非法「无损 JSON」（实测 `isJsonValue({ok:true, reason:undefined}) === false`），而 `addEvent` 在校验前已执行，所以是**假失败、记忆其实写了**；修法为成功分支省略该键，补装配级断言，并做变异验证（植回旧写法 → `# fail 1`）。② **ISS-059（open）模型伪造工具执行结果**——`[Persona recall updated] 📍 Updated memory for topic 共同记忆` 是一段纯生成文本（无 tool-call、`outputTokens=16`），仓库与 dsh 全部包内零命中，事件库 `共同记忆` 0 条；同段还伴随 `...` 式退化回复与 `inputTokens` 逼近 32k。统计 `open` 27→28、`fixed` 15→16、合计 61→63。**同时记下一条通用教训：工具输出只测失败路径，会漏掉成功路径** |
| 2026-11-06 | v1.15 | 新增 **ISS-060**（每轮重复追加整份人格快照：22 轮 22 份 / 40,046 字符 / 占全会话 84%；第 19 轮越过 33024 → llama.cpp 静默丢一半，turn 20 `inputTokens` 32226→15771）；**更正 ISS-059 的 `...` 归因**——21 个 `turn/end` 全为 `completed`、无一次 `max-tokens`，`...` 是她执行「别回复」指令的妥协，不再是"上下文退化"。统计 `open` 28→29、合计 63→64；优先级表 0 位换成 ISS-060 |
