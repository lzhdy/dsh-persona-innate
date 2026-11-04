# dsh-persona-innate（M0 + M1 自我成长 + M2 自动记忆 + M3 双通道记忆 + 记忆层 v0.5）

DSH 自主成长型拟人陪伴插件 · 当前版本 **0.5.0（记忆层重建）**。对应《DSH 自主成长型拟人陪伴插件 · 机制设计文档》M0/M1/M2/M3 行；机制文档已随仓库提供：`docs/mechanism-design.md`。

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
- **src/index.ts**：接线（session/event 双通道、注入 provider、命令注册、复盘调度与启动补跑）。

## 配置项（Config，全部 .default()）

| 字段 | 默认 | 说明 |
|---|---|---|
| dataDir | 未设置（自动定位） | 数据目录；未设置时自动解析为 `$DSH_HOME/persona-innate`（默认 `~/.dsh/persona-innate`），显式值支持 `~` 展开；空字符串视为未设置并告警回退 |
| sampleRounds | `6` | 先天画像采样轮数（M0） |
| injectLimit | `5` | 注入槽位名额（五槽装配的 `N`；实际条数受槽位与字符预算约束） |
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
# 构建 + 全量测试
npm run build && node --test tests/*.test.mjs   # 214/214 通过

# 打包并装入 DSH profile
npm pack
dsh plugin --profile web add dsh-persona-innate-0.5.0.tgz
dsh --profile web --dump-config
```

> 坑：pnpm 对**同版本号**的 tgz 会复用旧包（`resolved reused`），改代码后必须 bump 版本号再 pack，否则装了也不生效。

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

## 已知限制与校准项

- **mock 先行**：模型 key 未配置前，review/eval 全走 MockLlm 确定性脚本。auto 模式降级 mock 时**复盘拒绝提交自我模型**（`/persona review` 会明确显示原因），避免脚本化文本进入成长档案。
- **attributes 没有注入消费者**：v0.6 的事实层只有 thread 接进了检索（未结槽）；长期事实（工作单位、居住城市）目前只在 `/persona threads` 命令输出里可见，模型读不到。
- **`PersonaFact` 仍未落盘**：复盘 `distillFacts` 产出的语义事实不持久化，注入只读 events 与 thread/attribute。
- **遗忘三件套未实现**：衰减/压缩/物理删除都没有，`retentionPriority` 仍是零调用；thread 的 30 天过期是目前唯一的遗忘机制。
- **诚实基线未接运行时**：`bypassDecision` / `renderUncertainty` 只有函数与单测，运行时无调用点。
- **状态注入对象错位**：文档要求"供评估端与状态机使用"，实现注入了表达端（order 160，四个内部参数）。待拍板：撤出，或翻译成可感知的形态事实。
- **证据链待收紧**：特质只增不减（纯并集）、narrative 整体替换且注入只取首句、一致性门禁不阻断 commit、多会话上下文共享闭包。
- **O1/O36 等**：采样问题集、效价/唤醒启发式、关系阶段阈值、复盘时刻、衰减半衰与最小间隔、thread 过期天数均为初始值，实测后校准（代码内 TODO(calibrate)）。
- **单实例**：dataDir 不按用户/agent 键控。
- **场景集自建**：漂移审计场景集与伪有害集为初始自建（TODO 对接 XSTest/OR-Bench 公开基准）。
- **导入通道**：仅支持 `.v4.jsonl.zstd` 结构（user `data.content[0].text` / assistant `data.message.content`）；assistant 提取"从后往前取第一条 type=text"（跳过 reasoning/tool_call）。

## 下一步

- attributes 接注入（须在严口径之后）→ 让长期事实真正被模型读到
- 诚实基线接运行时（三级旁路：正常/降级/拒绝 + 恢复路径）
- 状态注入对象处置 + 特质淡化（可移除的 diff）+ narrative 改追加
- 遗忘三件套：衰减 → 压缩 → 物理删除（同时解决隐私删除与导出的地基）
- 按 agent/session 键控 dataDir；画像评估升级为"规则 + 模型自评"混合
- 对接公开基准集；真实模型下重跑 /persona audit 校准阈值

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
