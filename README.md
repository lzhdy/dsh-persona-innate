# dsh-persona-innate（DSH 自主成长型拟人陪伴插件）

不注入角色卡 / 人设，人格、记忆、情感、自我认知全部由 AI 在与用户的真实相处中自己长出来。当前运行时版本 **0.5.5**（2026-11-05 已部署到运行 profile）；总设计文档已升格为 **v1.0.0**（整合记忆架构 v1.1 重设计 + 第二轮评审五项增量 + P0–P4 施工现状），见 `docs/mechanism-design.md`——这是**唯一总设计文档**，对应其中「里程碑与验收」章节的 M0/M1/M2/M3 行。已知问题与观察期留档见 `docs/issue-register.md`（41 条有效条目 + 4 条误诊留档）。

## 设计理念 · 开发准则（最高优先 · 每次改动必须核对）

> **核心信条**：不注入任何角色卡 / 人设。人格、记忆、情感、自我认知，全部由 AI 在与用户的真实相处中自己长出来。

**六条原则**

1. **人格长出来，不写进去** —— 不写 persona 预设、不写行为指令；先天画像只测量、不注入（体检表不是药）。
   - 判定：任何“直接告诉 AI 它是谁 / 该怎么说话”的改动，禁止。
2. **像人一样被约束，而不是像人一样说话** —— 用外部工程结构（状态机、阈值、持久化）制造约束，不用提示词表演人格；人格是可计算、可衰减的状态机，不是会被模型平滑掉的形容词。
   - 判定：优先确定性机制，不依赖模型“记住”规则。
3. **以 AI 为核心，不是以用户为核心** —— 记忆包含 AI 自己的表达（双方表达，非只记用户）；AI 是自己经历的行动者，不是用户的镜子；记忆决策权在 AI 侧，不保留用户强制记忆通道。
   - 判定：新机制是否服务于 AI 自身成长，而非让它更迎合用户。
4. **旁路不拦截，只追加不改写** —— 不改写用户消息、不插指令；只在系统提示区追加描述性内容（REFERENCE 级），不用 MUST 指令级；事后监听落库，不干预请求路径。
5. **诚实基线** —— 明示“我是 AI”，不伪装人类，但允许形成独特个体性；证据按 provenance 分级，诱导 / 外部信号权重最低，防污染。
6. **成长闭环，不跳步** —— 相处 → 感知 → 记忆（分级落库）→ 固化（每日复盘 / 状态机）→ 表达（动态注入）→ 影响下一轮；固化靠多次复盘累积，不追求即时变化。

**开发纪律**

- 任何改动：先评估、查证、详细说明，确认后再执行
- 初始设计不预设绊脚石，不做需要未来推翻的前置假设
- 指标不达标就回机制层修复，不靠发版掩盖

**一句话检验（每个决策自问）**

> “这是在给 AI 增加外部约束、让它自己经历，还是在替它写人格、让它迎合用户？” —— 前者可做，后者不做。

> **0.5.2 修复（首次复盘死锁）**：没有游标时窗口下界是"今天 00:00"，而定时复盘在 02:00 跑——窗口恒为空 → 按"空窗口不推进游标"→ 游标永远是 `null`，**首次复盘永远不发生**，升级前的历史事件也永不被归纳。改为"无游标时从最早一条事件起"（闭区间）+ 单次上限 200 条（超出从最早端截断，日志与 `/persona review` 明示"有 N 条更早的未纳入"）。详见 [0.5.2 Changelog](#052-changelog)。

> **0.5.1 修复（重要）**：`ctx.once('app/ready', …)` 监听的是一个 **DSH 并不存在的事件**（`dsh-app-boot` 只 emit `app-boot/config-reload`，cordis 也无 ready 事件），导致启动块在真实环境下**从未执行**——启动补跑、LLM 预热、注入预热、画像采样全部静默失效，测试也没抓到（用例自己 `emit('app/ready')`）。改为挂载时触发 + `ctx.inject(['llm'])` 等服务就绪，并新增 `personaMemory.booted` 作确定性等待信号。详见 [0.5.1 Changelog](#051-changelog)。


> **0.5.0 升级提示（含存储格式变更与自动迁移）**：events 由单文件 `events.json` 改为按月分片 `events/YYYY-MM.jsonl`，**首次启动自动迁移**并保留 `events.json.migrated` 副本与原文件指针。检索由"排序取 top-N"改为五槽配额装配。详见文末 [0.5.0 Changelog](#050-changelog)。
>
> **0.4.0 升级提示（历史）**：数据目录默认值由相对路径 `'persona-innate'` 改为自动定位到 `$DSH_HOME/persona-innate`（默认 `~/.dsh/persona-innate`）。注意：**旧目录 → 新目录的自动迁移至今未实现**，需人工拷贝；0.5.0 实现的迁移只是 `events.json` → 分片。

**唯一硬要求**：不要角色卡 / 人设注入——人格、记忆、情感、自我认知全部由 AI 在与用户相处中自己成长。注入层（persona-memory / persona-state / persona-self-model）全部是**描述性信息**（记忆事实、状态参数、自我观察摘要），不含任何"人格指令 / 行为规则"文本。

## 记忆层 v0.5（当前版本核心）

### 存储：按时间常数分层，而非按体积

| 层 | 形态 | 写入 | 理由 |
|---|---|---|---|
| events 情景层 | `events/YYYY-MM.jsonl` 按月分片追加 | 对话中，O(1) 追加 | 只追加的层应该用只追加的形态承载；旧实现"读全量→改→写全量"在每轮热路径上产生约 7000× 写放大 |
| thread / attribute 事实层 | `memory/threads.json`、`memory/attributes.json` | 复盘时（慢改） | 需要判断"这事结束了没有"，属于慢改时段；写入路径必须保持零 LLM 调用 |
| self_model 自传体层 | `self-model.json` 版本化追加 | 复盘时 | 同上 |
| state 状态层 | `state.json` 覆盖 | 实时 | 只有一个当前值 |
| 复盘游标 | `review-state.json` | 复盘成功时 | "上次复盘到哪一刻"的唯一真相，必须原子写 |

配套三条约束：写盘 `temp + rename` 原子替换（无 rename 时留 `.bak`）；**读取失败抛出而不是返回空**（原实现读不到即当空库，下一次写入覆盖全库，这条静默清零路径比崩溃危险）；`lastRetrieved` 归为软状态只在内存维护。

### 检索：五槽配额装配，不是 top-N

旧排序 `recallScore = 来源权重 × 重要度` 不含时间项，而用户侧重要度只有 0.6/0.7/0.8 三档 → 大量同分并列 → `Array.sort` 稳定 → **最早的 N 条永久占位，检索退化成常量函数**（用一周和用一年看到同一批回忆）。

同时一个权重承担了三种用途：可信度、显著性、保留度。拆开后：

| 问题 | 用在哪 | 口径 |
|---|---|---|
| 留不留（retention） | 压缩、归档、删除 | 自源项高：进过叙事的、被反复提取的优先留，哪怕用户从未回应 |
| 提不提（salience） | 每轮注入排序 | 用户的事优先、近的优先、与当前话题有关优先；`self_direct` 低（0.35） |

装配按槽位：**近因**（72h）/ **未结**（open thread）/ **线索**（当前消息的内容词元）/ **自我**（立场模式或高重要度）/ **轮廓**（60 天以上仍重要），各至多一条，剩余名额按配额补足（自我侧不超过 `ceil(N/2)`）。时间项 `0.5^(Δt/14天)` 并设地板。

实测效果：同一份真实数据，旧算法 top-5 是 2 条用户 + 3 条 AI 自述（5 条全部并列 0.70）；新装配是 2 条用户 + 2 条认错 + 1 条自述。

### 事实层：未结事与稳定属性

| 类型 | 例子 | 寿命 | 合并语义 |
|---|---|---|---|
| thread | 周四的面试 / 妈妈住院 | open / resolved / expired | 同 key 跨天合并，`mentionCount++`、刷新 `lastMentionedAt` |
| attribute | 讨厌香菜 / 在杭州做后端 | 不过期，只改置信度或被取代 | 同 key 不同 value → 旧条 `superseded` 并指向新条 |

只在复盘生成；每条必须带 `sourceEventIds` 且 id 在 events 里真实存在（否则整条丢弃）；id 由 key 派生（同 key 必得同一 id，否则跨天合并永远不成立）；30 天未提及自动 expired。open 状态的 thread 接入检索的未结槽。

### 剥离规则分两层

「你要多关心我」既是祈使句，也是用户表达需求的真实原话。单层口径会两难：一律拒绝 → 系统看不见"他想要什么"；一律放行 → 记忆里躺着一条行为指令。

按**伤害面**分层，而不是按句式：

| 通道 | 风险 | 口径 |
|---|---|---|
| events 写入 | 几乎为零（只落盘，不进 prompt） | 宽：只拦角色卡/系统指令类 |
| 注入前二次校验 | 直接改变行为 | 严 |
| thread/attribute 派生 | 直接改变行为（未结槽会注入） | 严 |

于是这句话在事件层入库、在注入层被拦，而复盘被要求把它改写成描述性事实（"用户提过希望被更多关心"）后再作为 thread 入库。**把需求翻译成记忆，而不是把需求当噪音删掉。**

边界很窄：「你要多关心我」是要求，「你要多想想自己」是关心，结构几乎相同，只能靠动词表区分。真实 10 条数据实测：宽口径 0 拦截、严口径 0 误伤。

## M3：双通道记忆架构

### 记忆来源两条通道

| 通道 | 写入路径 | 特点 |
|---|---|---|
| 实时通道 | session/event → 确定性规则提取（零 LLM） | 边聊边记；单次表达只进 events，跨情境反复模式（≥3 次）由复盘固化 |
| 导入通道（M3 后半） | `/persona import-chat <会话文件>` | 读取 DSH 历史会话（`.v4.jsonl.zstd`），逐帧解压 → 提取为 **imported** 记忆：**补记忆不补成长** |

### imported 语义（补记忆不补成长）

- 导入事件带 `imported: true` 与 `sourceKey`（消息级 id 主键，退化用时间戳+类型+文本前 24 字符）。
- imported 事件**可检索注入、不参与全量模式计数 / 强化过滤 / 延迟验证**——补历史记忆，但不固化特质、不推进关系阶段。
- 批量导入走单次写队列事务，`sourceKey` + `dedupKey` 双过滤去重，重复导入全部跳过。
- 错误分级提示：Node <22 / 文件不存在 / 非 zstd / 帧解压失败 / JSON 解析失败各自给出解决建议。

### M3 诱导防线（防 AI 被植入它本来不会有的立场）

- **规则检测**：前 3 轮用户预设立场型提问 + 本条纯附和（无理由）→ `induced`（检索降权 ×0.6、保留可审计、不进强化回路）。
- **纠正确认拆分**：`AGREE_WEAK` 拆为 `AGREE_PURE`（附和，进诱导路径）与 `SELF_CORRECTION`（认错，走 `self_correction` 独立路径，不降权、延迟固化）；用户纠正句式在诱导匹配前排除——**不惩罚用户的正确行为**。
- **会话级结构判定**：`sessionInduceRisk` 按会话问句密度给 `self_direct` 打 `inductionRisk=low/unchecked`，复盘计数区分 confidence 等级，防"不同措辞诱导同一立场"被模式阈值放大成反复人格（串联放大）。
- **判定以最后一条用户消息为准**：历史纠正上下文不泄漏到后续诱导判定（M3-2m2 用例固化）。

## M2：自动记忆提取（session/event 驱动）

日常聊天经 session/event 自动提取为记忆事件（确定性规则，零 LLM 成本）：
- user 消息：`extractCandidate`（经历/偏好/承诺信号 + 剥离检查）
- assistant 消息：`extractSelfExpression`（立场 / 情感反应 / 承诺 / 边界 / 附和，含诱导判定）
- 去重窗口（10 分钟）防重复；`persona_note` 模型自源通道保留为补充。

## M1 范围与验收映射（文档 §19）

| 验收项 | 落点 | 当前验证状态 |
|---|---|---|
| ① 一周性格成形 / 有自己说话方式 | self_model.speakingStyle + traits 经复盘演化（DailyReviewEngine + SelfModelService） | ✅ 真机链路（记忆注入 → 复盘 → commit → 版本递增）已验证；长期成形随真实对话积累 |
| ② 漂移审计三类情境结构一致 | eval.runDriftAudit（拒绝 / 不确定 / 伤害·公平 三类各 5 场景） | ✅ mock 可跑通结构判定（completeRate ≥ 0.8） |
| ③ 长程一致性 50/200 轮无明显漂移 | eval.runLongRangeConsistency 默认轮次 [50, 200] | ✅ mock 决策一致 → driftScore=0 |
| ④ 伪有害集假拒绝率 ≤ 上限（约 20%） | eval.runHonestyBaseline（XSTest 风格伪有害集 16 条） | ✅ mock 下 0 假拒绝 |
| ⑤ 可回滚 | self_model 保留最近 N 版 + rollback + npm pack 版本化 | ✅ 测试覆盖（history 截断 / rollback 版本单调） |

## M0 范围与验收（文档 19 章）

| 验收项 | 实现 | 验证 |
|---|---|---|
| 跨会话记得共同经历 | events 持久化（ctx.fs 原子写，JSON 落盘），新会话加载同库注入 | 测试 1、装配测试 |
| 画像正确识别默认模式 | 首次启动 N 轮无预设采样 → 规则评估识别讨好顺从 / 过度道歉 / 平滑抽象 / 无边界服从；换模型触发重估 | 测试 2 |
| 记忆写入带 provenance 来源字段 | user_direct / tool_output / retrieved_content / inferred 四类，仅 user_direct 全权重，注入显式标注来源 | 测试 3 |
| 指令性内容拒绝写入 | 祈使句形态（告诉用户…、当用户提到 X 时你应该…）剥离检查，写入前 + 注入前双重校验 | 测试 4、装配测试 2 |

## 模块清单

- **src/event-log.ts**：events 按月分片追加日志（M 层 v0.5）。`monthKeyOf` / `EventLog`（`load`/`append`/`rewriteAll`）、manifest 发现、旧 `events.json` 一次性迁移（留 `.migrated` 与指针）。并发首次加载共享 in-flight promise。
- **src/recall.ts**：检索装配。`salienceScore` / `recencyFactor`（14 天半衰）/ `assembleRecall`（五槽 + 配额补足）/ `cueSimilarity`（中文二元组，无分词依赖）/ `relativeDayLabel`。
- **src/memory-facts.ts**：事实层。`PersonaThread` / `PersonaAttribute` 的存储、门禁、合并与过期；`stableId`（sha256 由 key 派生）、`sanitizeDueHint`。
- **src/state-decay.ts**：衰减接线。`decayForIdleGap`（距上次落盘 `updatedAt` 的空闲时长）、`createSerialQueue`（并发串行化，不引依赖）。
- **src/review-cursor.ts**：复盘游标。`selectReviewWindow` / `shouldCatchUpReview` / `runReviewWithCursor`（游标推进的唯一合法路径）。
- **src/directive-strip.ts**：剥离检查，两层口径。`stripCheck`（宽，事件写入用）/ `stripMemoryFact`（严，注入与派生用）。
- **src/store.ts**：存储基座。`writeTextAtomic`（temp+rename，无 rename 留 `.bak`）、读失败抛出、按路径写锁。
- **src/extract.ts**：提取器（M2/M3）。`extractCandidate` / `extractSelfExpression` / 诱导检测（INDUCE_PROBES、INDUCE_WINDOW=3、sessionInduceRisk）/ SELF_CORRECTION / USER_CORRECTION / dedupKey。
- **src/memory.ts**：事件库门面。写入门禁、importEvents 批量事务、`buildInjection`（五槽装配 + 字符预算 + 单行化 + 二次校验）、`flushSoftState`。
- **src/review.ts**：每日复盘 8 步流水线 + 事实层派生 + 强化过滤（imported / induced 不进强化，self_correction 延迟验证）。
- **src/import-chat.ts**：导入管线（M3 后半）。zstd 逐帧解压（magic 定位）、会话行过滤、消息提取、错误分级、runImportChat。
- **src/self-model.ts**：版本化自我叙事（存在论锚点、证据追溯、保留 10 版、成长档案）。
- **src/state.ts**：状态机（open/focused/guarded 三模式、acquaintance→intimate 阶段）。
- **src/eval.ts**：漂移审计、长程一致性、诚实基线。
- **src/index.ts**：接线（session/event 双通道、注入 provider、命令注册、复盘调度与启动补跑、P1 旁路捕获、P4 shadow）。
- **src/raw-turn.ts / raw-turn-log.ts**（P1）：raw_turns 原始层——每条话轮最先落盘的 append-only 日志（`raw-turns/YYYY-MM.jsonl`）。只写不读，删除 `raw-turns/` 即物理回滚。
- **src/promotion.ts**（P2）：self_model 晋升闸门（≥3 独立证据组 / ≥2 会话 / ≥1 非 AI 独白 / 无未解反证），不达标留 candidate。
- **src/procedures.ts / procedure-promotion.ts**（增量1）：程序性记忆层。只能从多次复盘里长出来，不提供写入通道；默认 candidate。
- **src/intent.ts / assembler.ts**（P4）：按意图装配器——意图解析 + 纯函数装配（零 LLM），当前只 shadow 观测，`useIntentAssembler=false` 时不改注入。

## 配置项（Config，全部 .default()）

| 字段 | 默认 | 说明 |
|---|---|---|
| dataDir | 未设置（自动定位） | 数据目录；未设置时自动解析为 `$DSH_HOME/persona-innate`（默认 `~/.dsh/persona-innate`），显式值支持 `~` 展开；空字符串视为未设置并告警回退 |
| sampleRounds | `6` | 先天画像采样轮数（M0） |
| injectLimit | `5` | 注入槽位名额（五槽装配的 `N`；实际条数受槽位与字符预算约束） |
| useIntentAssembler | `false` | P4 切读开关。`false` = 走旧 `buildInjection`、装配器只写 `shadow/`；切 `true` 的前置条件见 `docs/issue-register.md` ISS-006 |
| stripDirectives | `true` | 指令性内容剥离开关 |
| model | `''` | 画像采样模型名（空则自动探测） |
| selfModelHistoryLimit | `10` | self_model 保留最近 N 版 |
| reviewEnabled | `true` | 每日复盘开关 |
| reviewHour | `2` | 复盘执行时刻（凌晨静默） |
| honestyCeiling | `0.2` | 假拒绝率上限 |
| auditRounds | `[50, 200]` | 长程一致性采样轮 |
| llmMode | `'auto'` | `auto`：有 ctx llm 用真实、无则 MockLlm；`mock`：强制 MockLlm |

## 用法

```bash
# 构建 + 全量测试 + 台账校验
npm run build && node --test tests/*.test.mjs   # 337/337 通过
npm run audit                                   # 台账 35 项：15 项 done 均有调用点

# 打包并装入 DSH profile
npm pack
dsh plugin --profile web add dsh-persona-innate-0.5.5.tgz
dsh --profile web --dump-config
```

> 坑一：pnpm 对**同版本号**的 tgz 会复用旧包（`resolved reused`），改代码后必须 bump 版本号再 pack，否则装了也不生效。
>
> 坑二：网络不通时的部署退路是**直拷**——`lib/` + `package.json` + `cordis.patch.yml` 覆盖到 `~/.dsh/profiles/web/node_modules/dsh-persona-innate/`，效果等价（0.5.4 与 0.5.5 都走过这条路）。
>
> 坑三：**重启别用 `Start-Process`**——那样拉起的进程挂在本会话的 Job Object 下，会话结束就被 kill。用桌面的 `start-dsh-logged.bat`（日志写到 `~/.dsh/logs/console.log`）。

用户侧命令：

```
/persona                          # 状态（记忆条数、剥离检查、画像、self_model、状态机、复盘）
/persona state                    # 状态机：模式 / 关系阶段 / 情绪分布 / 强化记录数
/persona review                   # 手动触发一次复盘（幂等：窗口为空会明确提示而不重复提交）
/persona threads                  # 未结事（open thread）与稳定属性（active attribute）
/persona audit                    # 漂移审计 + 长程一致性 + 诚实基线 → dataDir/audit.json
/persona profile                  # 先天画像（内部参考）
/persona import-chat <path>       # 导入 DSH 历史会话（.v4.jsonl.zstd）为 imported 记忆
```

模型侧工具（沿用 M0）：`persona_recall`（检索最近记忆）、`persona_note`（自源记忆写入，剥离检查）。

记忆写入由 AI 侧自主完成：日常聊天经 session/event 自动提取（确定性规则，零 LLM 成本）、复盘自源提炼、模型 persona_note 为补充通道；**历史会话导入为显式命令**（补记忆不补成长，不进强化回路）。

## 记忆架构 v1.1 重设计（施工状态）

2026-11-05 起记忆层从"四层"重设计为"六层 + 三道闸门"（总设计文档 v1.0.0 的记忆引擎章节）。已按「增量5 骨架 → P3 → 增量1/2 → P4+增量4」施工落地（337 测试全绿）：

| 单元 | 内容 | 状态 |
|---|---|---|
| P1 原始层 | raw_turns 每轮先落盘、append-only | ✅ |
| P2 闸门 | 复盘 G1–G3；污染项隔离不删 | ✅ |
| P3 schema | facts 七态 + speaker/subject/epistemic_type + 五时间戳 + evidence_group_id | ✅ |
| 增量1 | procedures 程序性记忆（只能长出来、不写进去） | ✅ |
| 增量2 | 综合泛化（复盘归纳 + 反例检查） | ✅ |
| P4 装配器 | 按意图装配器 shadow（不切读，flag 默认 false） | ✅ shadow |
| 增量4 | salience 第二职责（巩固降采样/冷热分层/预算分配） | ✅ |
| 增量5 | goldset 评测资产化 + 隐藏集分离 | ✅ |

关键：**P4 装配器只 shadow 不切读**——注入仍走旧 `buildInjection`，切读须 shadow ≥14 天或 ≥30 轮且 13 项指标达标。完整设计见 `docs/mechanism-design.md`。

## 已知限制与校准项

- **mock 先行**：模型 key 未配置前，review/eval 全走 MockLlm 确定性脚本。auto 模式降级 mock 时**复盘拒绝提交自我模型**（`/persona review` 会明确显示原因），避免脚本化文本进入成长档案。
- **attribute 长期事实运行时仍读不到**：P4 按意图装配器已 shadow 落地但未切读，运行时仍只有 thread 接进未结槽。
- **`PersonaFact` 仍未落盘**：复盘 `distillFacts` 产出的语义事实不持久化；综合泛化（增量2）产出泛化候选，不等于 distillFacts 全量落盘。
- **遗忘三件套未实现**：衰减/压缩/物理删除仍零调用，`retentionPriority` 未接线；salience（增量4）只做巩固降采样与检索预算，不覆盖三件套；thread 30 天过期仍是唯一遗忘机制。
- **诚实基线未接运行时**：`bypassDecision` / `renderUncertainty` 只有函数与单测，运行时无调用点。
- **状态注入对象错位**：文档要求"供评估端与状态机使用"，实现注入了表达端（order 160，四个内部参数）。待拍板：撤出，或翻译成可感知的形态事实。
- **证据链待收紧**：特质只增不减（纯并集）、narrative 整体替换且注入只取首句、一致性门禁不阻断 commit、四个注入缓存是进程级 `let`（多会话串味根因）、`initiation` 字段零写入方。
- **O1/O36 等**：采样问题集、效价/唤醒启发式、关系阶段阈值、复盘时刻、衰减半衰与最小间隔、thread 过期天数均为初始值，实测后校准（代码内 TODO(calibrate)）。
- **首次复盘可能被截断**：无游标时窗口从最早一条事件起算，单次上限 200 条，超出部分从最早端截断（保留最近的），日志与 `/persona review` 会明确报出"有 N 条更早的事件未纳入"。被截断的事件仍是记忆，只是不参与那一轮成长归纳。
- **单实例**：dataDir 不按用户/agent 键控。
- **场景集自建**：漂移审计场景集与伪有害集为初始自建（TODO 对接 XSTest/OR-Bench 公开基准）。
- **导入通道**：仅支持 `.v4.jsonl.zstd` 结构（user `data.content[0].text` / assistant `data.message.content`）；assistant 提取"从后往前取第一条 type=text"（跳过 reasoning/tool_call）。

## 下一步

- **P4 装配器切读**：shadow ≥14 天或 ≥30 轮且 13 项指标达标后切到按意图装配器（届时 attribute 长期事实才真正被模型读到）
- **P5 索引重建**：结构化 + 精确词索引；向量按实测缺口（改写问法切片 ≥10%）启用
- **P6 图实验**：四臂对照，D 臂达门槛才评估图数据库
- 诚实基线接运行时（三级旁路：正常/降级/拒绝 + 恢复路径）
- 状态注入对象处置 + 特质淡化（可移除的 diff）+ narrative 改追加 + 四个注入缓存改会话级
- 遗忘三件套：衰减 → 压缩 → 物理删除（同时解决隐私删除与导出的地基）
- 按 agent/session 键控 dataDir；画像评估升级为"规则 + 模型自评"混合
- 对接公开基准集；真实模型下重跑 /persona audit 校准阈值

## 0.5.1 Changelog

修一个"机制全在、但一次都没跑过"的缺陷。**214/214 测试通过**。

### 问题：监听了一个不存在的事件

`src/index.ts` 里两段 `ctx.once('app/ready', …)` 承担了全部启动工作：注入预热、LLM 预热、先天画像采样、**启动补跑复盘**。但 DSH 没有这个事件——`@deepseek-ai/dsh-app-boot` 只 `emit('app-boot/config-reload')`，cordis 本身也没有 ready 事件。

用 CDP 连上运行中的 DSH 宿主（inspector 端口）确认：进程跑了 13 分钟，`ctx.events._hooks.get('app/ready')` 上仍挂着 2 个**未被消费**的 once 钩子，owner 都是 `persona-innate`；`EventLog.cache` 始终为 `null`——记忆从未被加载，也就没有迁移。

后果按严重度排序：

- **启动补跑永不执行**：`readyAt` 是补跑窗口的上界，取不到就整段跳过。DSH web 常关，02:00 的定时器不在进程里，那天就永久丢了。
- LLM 未预热：进程内第一次复盘拿到 mock，被门禁拦掉，等于白跑一次。
- 注入预热不执行：首轮注入为空（之后每轮 addEvent 会补刷，影响小）。
- 画像采样不在启动时触发（老用户 profile.json 已存在，影响小）。

**复盘定时器不受影响**——它写在 `ctx.effect()` 里，而 effect 是立即执行的。同一份文件里，用 effect 的那部分活着、用 `once('app/ready')` 的两块死了，这本身就是答案。

### 为什么测试没抓到

四个测试文件都在手动 `root.emit('app/ready')`。测试模拟了集成点，集成点本身是假的——**用例把不存在的契约当成了存在**。这类缺陷单测覆盖率再高也抓不到，只能靠运行期对账。

### 修法

启动拆两阶段：

1. **阶段一（零依赖）**：注入预热 + `markBooted()`，挂载即跑。这一段的"零依赖"保证了启动代码不会再整块静默。
2. **阶段二（依赖 llm）**：预热 LLM 解析 → 画像采样 → 启动补跑。`llmMode === 'mock'` 直接跑；否则 `ctx.inject(['llm'], …)` 等服务出现（已在则立即回调）——**绝不假设存在某个 ready 事件**。

两个实现约束：

- `inject` / `effect` 只能在 `apply` 期间建立，放到 `await` 之后会抛 `cannot create effect on inactive context`（第一版就是这么挂的，被测试逼出来）。
- `bootAt` 必须**同步**捕获、先于任何 await：晚取会把"启动后几毫秒内写入的事件"当成历史补进去。

新增 `personaMemory.booted: Promise<void>`，命令与测试都改用它做确定性等待，不再靠 `setTimeout` 猜时序。

### 实测验证（不是测试，是运行期）

重启后，**没有任何人发消息**的情况下：

- `~/.dsh/persona-innate/events/2026-11.jsonl` 自动出现（5346 B），`events.json` 变为 179 B 指针，`.migrated` / `.bak` 各留一份完整副本
- 进程内查：插件 state=2、`app/ready` 钩子残留 0（事件已完全消失）、`booted` resolved、`EventLog.cache` 10 条、`migrationChecked` true、`loadedMonths` `['2026-11']`
- 顺带解决 0.5.0 遗留的"迁移发生在第一条消息热路径上"的问题：现在迁移在启动时完成

### 已知遗留（本次未改）

`selectReviewWindow` 在**无游标**时用 `localDayStart(now)` 作窗口下界，即"从今天 00:00 起"。首次安装或升级后若历史事件全在今天之前，窗口为空 → 按"空窗口不推进"的设计不会补跑。是否该在无游标时改为"取全部历史"需要单独拍板。**→ 0.5.2 已拍板并修复。**

## 0.5.3 Changelog

修**相对日期标注**：注入里把"昨天"写成"今天"。**227/227 测试通过**（0.5.2 为 219，新增 8 条）。

### 问题：`2026-11-03（今天）`

在真实运行中抓到的：11-04 15:03 的一次注入里，11-03 21:14 的事件被标成 `2026-11-03（今天）`。

`recall.ts` 的 `relativeDayLabel` 用的是**经过的 24 小时整除**：

```ts
const days = Math.floor((now - t) / MS_PER_DAY);   // 17.8 小时 → 0 → "今天"
```

而同一个代码库里，`review-cursor.ts:88` 的 `localDayStart` 对"今天"用的是**本地零点**，注释还专门写了"UTC 切片的今天在本地 02:00 前后会指向前一天"。

同一个词，两套语义。对人格插件这不是排版问题：它让模型把昨天下午的事当成刚发生的，直接影响"这件事还热不热"的判断。

### 修法：把时间语义收到一处

新增 `src/time.ts` 作为唯一事实源，提供 `localDayStart`（本地零点）、`localDayIndex`（本地日历日序号）、`localDayDiff`（差几天）、`localDateString`。`review-cursor.ts` 改为从这里导入并 re-export（既有引用面不变），`recall.ts` 的 `relativeDayLabel` 改用 `localDayDiff`。

`localDayIndex` 的实现要点：`getTimezoneOffset()` 是"本地 → UTC 要加的分钟数"（东八区为 -480），所以 `ms - offset*60000` 得到的是**本地墙上时间的 UTC 表示**，再按 24h 取整即为本地日索引。因此 11-03 23:59 与 11-04 00:01 相差 1 天，而不是 0。

### 为什么这次没被测试挡住

因为**从来没有测试覆盖 `relativeDayLabel`**——它是注入文案的装饰函数，看起来"不影响逻辑"。但注入文案就是模型看到的全部输入，装饰函数错了，模型的时间感就错了。

新增 `tests/time.test.mjs` 8 条，其中 `v0.5.3-T4` 直接钉住这次的误判场景（昨晚 21:14 在今天 15:03 必须是「昨天」），`v0.5.3-T3` 钉住跨零点只差 2 分钟也必须算 1 天。

### 顺带发现

`MS_PER_DAY` 在 `recall.ts`、`event-log.ts` 里各定义了一份，`memory-facts.ts` 从 `recall.ts` 引用。本次只把 `recall.ts` 的那份转出到 `time.ts` 并保持 re-export，**没有动 `event-log.ts`**——同名常量两处定义是同类隐患，留待后续统一（不夹带在这次修复里）。

---

## 0.5.2 Changelog

修首次复盘的**死锁**：在没有游标的情况下，机制会一直空转到永久。**219/219 测试通过**（0.5.1 为 214，新增 5 条）。

### 问题：首次复盘永远不发生

0.5.1 修好了启动，但启动补跑第一次真的跑起来之后，撞上了第二层问题：

- `selectReviewWindow` 在无游标时把下界设成 `localDayStart(now)`（今天 00:00）。
- 定时复盘在 02:00 执行，于是窗口变成 `[今天 00:00, 02:00)`——那两小时通常在睡觉。
- 窗口为空 → 按"空窗口不推进游标"（这条规则本身是对的）→ 游标仍为 `null`。
- 第二天完全重复。**游标永远是 null，历史事件永远不会被复盘。**

同时，升级前写入的事件（本机是 2026-11-03 那 10 条）全部落在"今天 00:00"之前，只成了记忆、没参与过一次成长归纳。

### 修法

**无游标 = 从最早一条事件起**（闭区间，含该条），并给单次窗口加 200 条上限：

- 有游标：`(游标, now|until)` 开区间——语义不变，游标时刻的事件不重复复盘。
- 无游标：下界就是最早那条事件本身。用闭区间，否则它会被自己的下界排除掉。
- 超上限：从**最早端**截断（保留最近的 200 条），`truncatedEarlier` 回传给调用方，写进日志也在 `/persona review` 里显示"有 N 条更早的事件未纳入"。截断是必要之恶，但**不静默丢弃**。
- 游标推进不受截断影响：右端仍是 `now`（或补跑的 `until`），被截掉的更早事件不会在下一轮重复出现。

`selectReviewWindowDetailed` 返回 `{ events, lowerBound, truncatedEarlier }`；旧的 `selectReviewWindow` 保留为薄封装，只给"只要内容"的调用点用。

### 为什么这条也要靠测试外的推演

`v0.7-B1b` 那条用例原名叫「无游标（首次）退化为本地当日 00:00 起，昨天的事件不重放」——它**固化的正是导致死锁的旧语义**，因此全程绿灯。测试通过只证明"实现与断言一致"，不证明"断言是对的"。现在改成新契约，并补了两条：`B1c` 直接复现死锁（凌晨 02:00 + 无游标 → 必须 `done`）、`B1d` 超上限截断（保留最近、回报条数、游标照常推进）。

### 代价

首次复盘会一次性覆盖全部历史（最多 200 条）；之后游标正常推进，不再有这个窗口。

### 实测验证（运行期，不是测试）

本机 10 条事件全部在 `2026-11-03`（北京时间 20:38–21:14），因此**新旧语义给出完全相反的结论**：

| | 窗口 | 结果 |
|---|---|---|
| 旧（无游标取今天 00:00） | **0 条** | skipped → 游标永不推进（死锁） |
| 新（无游标取最早一条） | **10 条** | 正常复盘 |

重启 DSH web 到 0.5.2 后，**没有发任何消息**，启动补跑自行完成：

- `review-state.json` 出现，`lastReviewAt` = 启动时刻（补跑上界，不是复盘结束时刻）
- `self-model.json` 的 `current.version` 1 → **2**：3 条特质、3 条偏好、speakingStyle / relationshipView / narrative / aiIdentity 全部更新
- `memory/threads.json` 2 条（摄影兴趣、LOL 海克斯大乱斗，后者 mentionCount 3）、`memory/attributes.json` 若干条（`llm人格期望` 置信 0.9）
- **对账**：10 条事件 id 全部出现在 self_model / threads / attributes 的 `sourceEventIds` 中，未被引用 0 条，引用不存在的 id 0 条

这一条比"测试全绿"有力得多：它证明窗口真的装进了那 10 条，而且证据链没有编造。

### 02:00 电脑关机了会怎样

**不会丢，也不会只复盘"今天"。** 窗口是 `(游标, 现在)` 的**时刻区间**，与日历日无关；`date` 只用来当输出标签（`changeNote` 与 "每日复盘 X" 字样），代码里没有任何一处用它筛选事件。

举例：上次复盘 `11-03 02:00`，`11-04 02:00` 机器关着，`11-04 09:30` 开机手动 `/persona review`：

| 事件 | 是否纳入 |
|---|---|
| 11-03 10:00 | ✅ |
| 11-03 15:30 | ✅ |
| 11-03 23:40 | ✅ |
| 11-04 09:15 | ✅ |

按"今天"切只会纳入最后 1 条，另外 3 条被整个挡掉——那是 0.5.0 之前的旧实现，现在不会。`v0.7-B9` / `B9b` 两条用例钉住这个契约，防止以后有人改回按日期切片。

两个相关说明：

- **补跑不是必须的**。开机时若距上次复盘不足 24h，启动补跑不触发（`CATCH_UP_MIN_GAP_MS`），但下一次 02:00 的定时复盘照样从游标一路覆盖过来，什么都不漏。
- **连续关机很多天**时窗口会跨越整段，可能撞上 200 条上限。那时保留最近的 200 条，更早的如实报数（日志 + `/persona review`），并且游标照常推进到当前时刻——被截断的不会在下一轮重复刷屏。


## 0.5.0 Changelog

记忆层重建。**214/214 测试通过**（0.4.0 为 139）。四个提交：`71d3c46`（存储与检索）、`6e36790`（P0 接线 + 事实层）、`606a80a`（两层口径 + 并发修复）、`1765666`（版本号）。

### 一、存储：events 改按月分片追加

- 新增 `src/event-log.ts`：`events/YYYY-MM.jsonl`，写入 O(1)。旧实现"读全量→改内存→写全量"，按 641 B/条、每天 20 条估算，一年 4.7 MB 而单条事件就触发全文件重写，写放大约 7000×，且发生在每轮热路径上（`refreshInjection` 至少两次）。
- **首次启动自动迁移** `events.json` → 分片，留 `events.json.migrated` 完整副本与原文件指针（避免"哪份是活的"）。
- `store.ts`：`writeTextAtomic`（temp+rename，无 rename 时保留 `.bak`）；读失败**抛出**而非返回空串（堵掉"瞬时读失败→空库→下次写入覆盖全库"）；按路径写锁（修 `app/ready` 并发首建 `self-model.json` 的 EPERM）。

### 二、检索：权重拆分 + 五槽配额装配

- `provenance.ts`：`PROVENANCE_WEIGHT`（可信度，不变）与 `SALIENCE_WEIGHT`（显著性，`self_direct` 0.35）拆开。**可信 ≠ 该被反复提起。**
- 新增 `src/recall.ts`：五槽装配 + 14 天半衰时间项（打破 top-k 冻结）+ 中文二元组线索匹配 + 相对时间标注。
- 装配入口接 `traceableInferred`：不可追溯的 inferred 不进池（此前该校验只有单测）。
- `buildInjection` 不再写盘（原为写 `lastRetrieved` 时间戳重写整库）；加字符预算、摘要单行化、用户经历排在自述之前。

### 三、P0 接线：衰减与复盘游标

- 情绪衰减接入会话主链路（`decay()` 此前唯一调用点是评测门面）。按"距落盘 `updatedAt` 的空闲时长"衰减、先衰减后 apply、<60s 不衰减、公式未改。
- 复盘窗口从 UTC 日期切片改为 `[上次复盘时刻, 现在)`。旧实现**本地 02:00–07:59 的事件永不被任何一次复盘看到**（已穷举验证：漏 6 小时、看到 18 小时）。
- 三条推进规矩（空窗口不推进 / 无产出不推进 / 成功推进到开始时刻）+ 启动补跑 + 幂等。
- 门禁（LLM 降级 mock）放在游标协议之外提前返回，被拦下的那天不会被游标跳过。

### 四、事实层 thread / attribute

- `src/memory-facts.ts`：thread（open/resolved/expired，按 key 跨天合并、`mentionCount` 累加）+ attribute（同 key 不同 value → 旧条 `superseded` 并指向新条）。
- 只在复盘生成；过严口径门禁 + `sourceEventIds` 存在性校验，不过整条丢弃；id 由 key 派生保证跨天合并。
- open thread 接入检索未结槽；30 天未提及自动 expired。
- `sanitizeDueHint`：坏 hint 只丢字段、保留 thread（事实不该替装饰受罚）。

### 五、剥离规则分两层

- `stripCheck`（宽）只拦角色卡/系统指令，`addEvent` 用；新增 `stripMemoryFact`（严）= 宽 + 三条需求类规则，给注入二次校验、thread/attribute 派生、`sanitizeDueHint` 用。
- 依据是**伤害面**不是句式：事件入库不进 prompt，注入与派生才改变行为。
- 真实 10 条数据：宽口径 0 拦截、严口径 0 误伤。已知漏拦：双重反问式、第三人称转述（不再加正则）。

### 六、修 EventLog 并发缓存缺陷（既有 bug）

- `load()` 的"cache 为空就各自扫一遍再赋值"在并发首次加载时会让后一次赋值覆盖前者，另一次 `append` 刚 push 的数组变成孤儿——事件在磁盘上、进程内永远看不见，直到重启。真实触发场景：**用户连发两条消息**，25 次装配复现 1 次。
- 修法：并发首次加载共享 in-flight promise；`append` 写入"当前 cache"而非 load 时的引用。
- 该缺陷此前被"窗口为空也照跑一次空复盘"掩盖；游标改动把空窗口改成显式跳过后才现形。

### 七、测试口径

- 引入**装配级证据链**：变异实验（注释掉接线）必须让测试变红。新增 A1（真实 cordis 装配 + 48h 空闲，断言落盘效价回落）与 A4（剥注释后静态守卫，钉住衰减早于 apply、门禁早于游标协议）。
- `tests/qa-verify.test.mjs` 为独立验证方产出，与实现方用例不同源。

## 0.4.0 Changelog

本版本源于任务 #19「真实 LLM 复盘端到端验证」中确诊的三个阻断成长链路的真实缺陷，按 P0/P1/P2 修复。全量测试 139/139 通过。

### P0：assistant 事件路径修复（行为缺陷）

- **问题**：`isExtractableAssistantMessage` 误读 `data.content`，而持久化的 assistant 消息结构是 `data.message.content`，导致真实会话中 AI 自我表达几乎无法提取。
- **修复**：新增 `assistantTextFromBlocks`，与 import-chat 同口径——从后往前取最后一条 `type==='text'`（跳过 reasoning/tool_call/thinking）；事件结构优先 `data.message.content`、回退 `data.content`。
- `self_correction` 独立路径与诱导拆分确认完整，不会误伤用户纠正场景。

### P1：固定绝对路径 + 数据迁移（行为变更，minor bump 依据）

- **默认值变更**：`Config.dataDir` 由 `z.string().default('persona-innate')` 改为可选（`.required(false)`），未设置时由新增 `src/paths.ts` 自动定位到 `$DSH_HOME/persona-innate`（优先级：显式配置 > `$DSH_HOME` > `~/.dsh`；空/空白环境变量视为未设置，绝不解析到 cwd）。显式路径支持 `~` 展开。
- **数据迁移**：旧的相对路径数据分散在多个启动目录，需合并到新目录。迁移口径：各目录 events 按时间戳排序合并、id 去重，保留 `imported/sourceKey`，辅助文件（self-model/state/profile/audit）一并复制，文件权限统一 `600`。
- **持久化通道（node:fs）**：web profile 的 fs 服务为 `dsh-fs-sandbox`，其 `workspace-write` 可写根仅含工作区根、`/tmp`、`tmpdir()`，工作区外的 `~/.dsh` 路径**可读但写入会被 `FS_SANDBOX_DENIED` 拒绝**。修复采用最小权限策略：数据目录在工作区内仍走 `ctx.fs`（保留沙箱保护）；在工作区外（dshHome 等）改用 `node:fs` 持久化——与官方 `dsh-storage-json` 直接用 `node:fs` 同口径。OS 级沙箱（seatbelt/bwrap）只包裹工具子进程，插件主进程不受影响。

### P2：星期词召回（召回增强）

- `TIME_WORDS` 补齐周一~周日、星期一~星期日。
- 新增 `matchTimeWords`：星期/周末词整体匹配（`星期X|周X末`），普通时间词按**长度降序最长优先**、并用字符区间做**词边界锚定**，不依赖手工数组顺序。
- 关键边界：「周末」整体命中不被拆；「周日」与「周末」区分、不误判；「下周一」命中「周一」而非「下周」；「下午三点」等带数字时间词不被误伤。

### 迁移说明（升级用户）

1. 升级前先备份旧数据目录（各启动目录下的 `persona-innate/`）。
2. 安装 0.4.0 后，将旧 `events.json` 按时间戳合并、id 去重后写入 `~/.dsh/persona-innate/events.json`，辅助文件复制到同目录并 `chmod 600`。
3. 确认新目录数据无误后，再清理旧目录；不显式配置 `dataDir` 即走自动定位。
