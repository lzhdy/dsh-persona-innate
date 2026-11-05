# dsh-persona-innate 记忆架构最终设计

**版本**：v1.1（含第二轮评审增量）
**日期**：2026-11-05
**状态**：v1.0 已于 2026-11-05 获用户批准（"按最推荐方案执行"）；v1.1 于同日并入第二轮评审（`dsh-memory-architecture-review-round2.md`）的五项增量与实施现状修正。Phase 0 V1-V8 已完成、P1/P2 已实施，P3-P6 及五项增量施工中。
**配套文档**：
- 《记忆架构重设计评审报告》（`dsh-memory-architecture-review.md`）：第一轮评审，16 项健康度评分与研究核验。
- 《记忆架构第二轮评审》（`dsh-memory-architecture-review-round2.md`）：本轮评审，对标世界代表系统 + 五项增量（本文件 §16）。
- 实测报告：`docs/phase0-现状核实报告.md`、`docs/p1-raw-turns-实现规格.md`、`docs/p2-巩固闸门-实现规格.md`。
- 原始输入：《dsh-persona-innate 记忆架构 · 重设计讨论要点》（`memory-redesign-notes.md`）。
- 本文件 §2 的 ADR 记录取代评审报告 §10 的"待决策"清单。

**v1.0 → v1.1 变更记录**：
1. §0.1 修正"仓库不存在"的事实错误（仓库一直存在，HEAD `f64924c`）。
2. 新增 §16「第二轮评审增量」（五项增量 + 落地性确认 + 施工顺序）。
3. §10 迁移计划补充实施现状标注。

---

## 0. 使用说明（执行会话必读）

本文件是唯一实施依据。执行总原则：**先核实、后实施；只增不删；每阶段可回滚。**

### 0.1 环境核查结论（2026-11-05 12:00 本机实测，14:40 修订）

- **修订**：源仓库 `C:\Users\lizhenhui\WorkBuddy\2026-11-03-23-43-19\dsh-persona-innate` **一直存在**（HEAD `f64924c`，main 单分支），并非 v1.0 原文所述"已不存在"。该误判源于 v1.0 起草时的环境访问限制，Phase 0（V1）已实测纠正。
- 运行时数据目录 `C:\Users\lizhenhui\.dsh\`（含 sessions / storages / logs / profiles / attachments）。
- `.dsh\sessions\` 下有 8 个会话目录，含两侧对称的原始对话原文——已确认为 raw_turns 回填来源（V8 抽查通过，标准 zstd 格式）。

**结论**：代码与数据实际位置已确认，无需再向用户核实路径；Phase 0 V1-V8 已完成（见 `docs/phase0-现状核实报告.md`）。

### 0.2 执行前强制核实清单（Phase 0，只读不改动）

| # | 核实项 | 方法 | 产出 |
|---|---|---|---|
| V1 | 代码与数据实际位置 | 询问用户并实地确认 | 路径记录 |
| V2 | 完整备份 | 数据目录整体复制（带时间戳），验证可恢复 | 备份路径与校验结果 |
| V3 | `buildInjection` 实际读源 | 读代码确认：events+openThreads（附件 L39）还是 events+self_model 摘要（L67） | 唯一现状描述 |
| V4 | 三条自述（"我记忆好乱"等）现状 | 查 self_model 与待复盘数据；确认下次 02:00 复盘时间 | 即时风险清单 |
| V5 | 平台猜测 attribute（confidence 0.95）现状 | 查 facts / attribute 存储 | 隔离对象清单 |
| V6 | events / facts / self_model / state 四文件真实 schema 与规模 | 逐文件盘点 | 与 §4 的字段差异表 |
| V7 | 复盘调度（02:00）与启动补跑实际行为 | 读代码与日志 | 调度行为描述 |
| V8 | `.dsh\sessions` 是否含可回填对话原文 | 经用户批准后抽查会话文件格式 | 回填可行性结论 |

核实结果与本文档不符时：**以实测为准，先更新本文档对应章节并经用户确认，再继续。**

### 0.3 三条红线

1. 任何不可逆操作（删原文/旧版本、清备份、批量抹除人格历史、授权删除级联）须用户显式批准（§10.2）。
2. V3（读路径核实）未完成前，不改任何注入与复盘代码。
3. 未知字段一律显式 `unknown`，禁止批量猜测回填。

---

## 1. 背景与问题定义

### 1.1 系统现状（据附件，行号为附件行号）

- 四层记忆：events（情景，追加）/ facts（稳定事实与未结事，可修订）/ self_model（自我叙事，版本化追加）/ state（当前状态，覆盖）（L20—29）。
- 两条写入路径：实时路径规则化、零 LLM 写入（L31—36）；每日 02:00 复盘派生 facts / self_model，启动补跑（L35—36）。
- 每轮注入 `buildInjection`，附件对其读源有两种不一致描述（L39 vs L67），待 V3 核实。

### 1.2 五个契约缺口（P0；完整证据见评审报告 §4）

1. **原始证据缺口**：events 是筛选摘要，用户大量话语不落库；"有些信息只存在于摘要里，找不到原始对话"（L48）。
2. **来源与主体混淆**：无独立 speaker / subject / epistemic_type；AI 疑问句可被当成用户事实（L49、L72—76）。
3. **时间语义不足**：summary 内"昨天"未归一化形成二次偏移；复盘时刻被写入 `lastMentionedAt` 伪造提及（L47、L99—100）。
4. **读契约断裂**：facts（attribute）无注入消费者，superseded 不在读取端生效（L64—70、L102—106）。
5. **巩固污染闸门缺失**：AI 猜测成为 confidence 0.95 的事实；"我记忆好乱"可能经复盘固化为稳定特质（L78—82、L98—100、L150）。

设计文档健康度基线：**完全通过 2/16（12.5%）**。本设计目标：16 项全部具备明确契约、迁移路径与可验证证据（设计目标健康度 16/16；实现后须重新审计确认，此为设计目标值，非实测分）。

---

## 2. 已批准决策记录（ADR）

用户于 2026-11-05 批准按最推荐方案执行，以下决策全部生效：

**ADR-1 架构主线**：全量原始事件溯源 + 分域单一权威派生存储 + 本地混合索引。暂不引入图数据库，不启用 A-MEM 式自动改写旧笔记；图仅在四臂对照 D 臂达门槛后评估（§11.3）。

**ADR-2 self_model 晋升冻结与闸门**：实施后立即暂停"复盘自动晋升稳定特质"；晋升必须满足 §4.4 门槛（≥3 独立证据组、≥2 会话/日期、≥1 非 AI 独白来源、无未解反证）；"我记忆好乱"等既有候选先隔离为 candidate，不删除。

**ADR-3 污染事实处置**：已知错误事实（如平台猜测 0.95 attribute）标 `quarantined` / `disputed` 并附原因与证据链接，**不删除**；隔离后不再进入注入，历史保留可审计。

**ADR-4 raw_turns 保留与删除策略（默认值，用户可调）**：
- 默认无限期保留、仅本地存储、不云同步；访问仅限证据展开与审计回放。
- 用户授权删除：按 `source_event_ids` 谱系级联（删原文载荷 → 依赖该证据的派生项 status=retracted、reason=source_deleted → 重建索引），不留"幽灵摘要"。
- 备份：每次改动前快照，默认保留最近 5 份；备份受同一删除请求约束。

**ADR-5 读路径先行核实**：Phase 0 完成 V3（L39/L67 歧义）之前，不改任何注入代码。

**ADR-6 人脑机制边界**：只借功能分工（快写慢整、情景/语义分工、多痕迹保留、情境线索、可逆排序衰减）；不做生物仿真、不按遗忘曲线删事实、不让召回增强可信度（§9）。

---

## 3. 目标架构总览

```
对话轮次（user / assistant / system / tool）
      │ ①全量捕获（append-only，每轮最先执行）
      ▼
┌────────────── raw_turns（原始事实源）──────────────┐
│ 证明"谁在何时说过什么"；不证明话语内容为真          │
└────┬──────────────┬──────────────────┬───────────┘
     │②显著事件筛选   │③复盘巩固（三道闸门）│④当前状态更新
     ▼              ▼                  ▼
   events      facts + self_model      state
 （显著情景投影）（权威派生：主张版本/人格版本）（短寿命权威）
     └──────────────┴──────────────────┘
                    │ ⑤按意图装配（契约三）
                    ▼
              工作记忆（带标签注入）
                    ▲
  索引层（精确词/实体/speaker/时间过滤 ＋ 可选向量）＝全部可重建、不承载真值
```

### 3.1 单一事实源关系

| 层 | 角色 | 权威性 |
|---|---|---|
| raw_turns | 原始证据：谁在何时说过什么 | 唯一原始事实源 |
| facts | 当前有效主张及其版本史 | 当前稳定事实的唯一权威 |
| self_model | 当前稳定人格叙事 | 当前人格的唯一权威 |
| state | 当前任务/线程/约束 | 短寿命状态的唯一权威 |
| events | 显著性视图 | 不决定事实是否当前有效 |
| 索引（词/实体/向量/未来图） | 检索加速 | 可整体删除重建，不承载真值 |

### 3.2 核心原则

**数据库选型 ≠ 记忆协议。** 协议先规定证据、来源、双时态、版本、污染闸门与按意图读取；存储只负责持久化与索引。错误的 speaker 或 valid time 放进任何数据库，得到的都只是更快的错误检索。

---

## 4. 数据模型

### 4.1 raw_turns（append-only JSONL）

| 字段 | 类型 | 语义 |
|---|---|---|
| `event_id` | string | 全局稳定 ID（如 `rt-000123`） |
| `session_id` / `turn_id` | string | 会话与轮次定位 |
| `speaker` | enum | `user` / `assistant` / `system` / `tool` |
| `raw_text` | string | 原话全文，不用摘要替代；附件引用另列 |
| `asserted_at` | ISO8601 | 该话语实际发出时间，含时区 |
| `ingested_at` | ISO8601 | 系统获知并写入的时间 |
| `content_hash` | string | 完整性与谱系定位；哈希不是内容真实性证明 |

写入规则：**每轮先落 raw_turns，再做其他一切**（筛选、提炼、注入）。全量捕获 ≠ 全量注入：原文仅在证据核验、精确回放、需要展开时进入上下文。禁止修改与删除（除 ADR-4 授权删除）。捕获范围包括用户询问、元对话、状态确认，以及 AI 的立场、认错、承诺、边界——两侧对称。

### 4.2 events（显著情景投影）

| 字段 | 语义 |
|---|---|
| `event_id` | 稳定 ID |
| `source_event_ids[]` | 指向 raw_turns；为空且带 legacy 标记 = 未经原文验证 |
| `summary` | 摘要，必须可展开回原句 |
| `salience` | 显著性评分；仅影响默认展示排序，不影响真值 |
| `speakers[]` | 参与说话人 |
| `topics[]` / `entities[]` | 主题与实体标签 |
| `content_time_range` | 内容所指时间（继承源消息解析结果，不重解析） |
| `creation` / `version` | 创建方式（规则/复盘）与版本 |

旧数据迁移：找不到原文的旧摘要标 `unverified_legacy`——仍可被召回，但必带"未经原文验证"标签，且不得作为新 facts 的唯一证据源；只回填仍存在的原文，**绝不补造**。

### 4.3 facts（可修订主张及版本）

| 字段 | 语义 |
|---|---|
| `fact_id` / `version_id` | 主张 ID 与版本 ID |
| `speaker` | 谁提出该主张 |
| `subject` | 说谁/说什么（用户、AI、第三方、对象）；**禁止由 speaker 推断 subject** |
| `predicate` / `value` | 最小结构化主张 |
| `source_event_ids[]` | 必须可解析回 raw_turns；多来源逐一列出 |
| `asserted_at` | 何时说的 |
| `ingested_at` | 系统何时知道 |
| `valid_from` / `valid_to` | 内容所指有效区间；未知 → `null`＋unknown 标记，不得默认"永久"或"今天" |
| `status` | `candidate / active / quarantined / disputed / superseded / retracted / expired` |
| `status_changed_at` | 系统改变该版本状态的时间（区别于 valid_to） |
| `confidence` | 当前证据支持程度的校准值（语义见 §4.9） |
| `epistemic_type` | `direct_observation / user_statement / ai_inference` |
| `superseded_by` | 指向替代版本 |
| `evidence_group_id` | 同一原始根源标识（防同源复读算多份证据） |
| `time_parse{}` | 原始相对表达、基准时间、时区、精度、不确定性 |

硬约束：**疑问句、猜测、假设不进入 facts**（保留在 raw_turns）；`ai_inference` 默认 `candidate`；用户修正仍是 `user_statement`，通过取代关系生效。

### 4.4 self_model（版本化人格候选与稳定叙事）

复用 facts 全部字段，另加：`trait_id`、`evidence_fact_ids[]`、`contrary_evidence_ids[]`、`promotion_reason`、`revocation_reason`。人格结论通常 `epistemic_type=ai_inference`，不得伪装成直接观察。

**晋升门槛（ADR-2 已批准；初始治理参数，可调）**——同时满足才可晋升 stable：
1. ≥3 个独立 evidence groups（同源复读归并为一组）；
2. 跨 ≥2 个会话或日期；
3. ≥1 个非 AI 独白来源（用户明确反馈或人工标注行为）；
4. 无未解决反证（`contrary_evidence_ids` 为空或全部已解决）。

不足 → 只保留 candidate，不进人格注入槽。**对称规则**：负面自述（"我记忆好乱"）与正面全局自述（"我记性很好""我总是理解你"）同等受限——都是 AI 自述，过同一门槛。
撤销：出现独立反证 → 降级 disputed/candidate 或以新版本撤销；历史保留、不再注入。

### 4.5 state（短寿命当前状态）

当前任务、open thread、临时约束、到期时间、指向 facts/events 的 ID 引用。不复制稳定事实正文；不因"最近出现"晋升人格或长期事实。thread 的 `last_mentioned_at` **只能**由 raw_turns 中真实提及的 `asserted_at` 计算（§4.8 规则 6）。

### 4.6 associations（可选，默认关闭）

`from_id` / `to_id` / `edge_type` / `source_event_ids[]` / `created_by` / `created_at` / `status`。只用于召回扩展候选；不得自动修改事实状态、置信度、有效期或任何笔记正文。

### 4.7 status 状态机

| 从 | 到 | 触发者 | 触发条件 |
|---|---|---|---|
| — | candidate | 写入闸门 G2 | 新主张通过最小校验（字段齐全、证据可解析） |
| candidate | active | 写入闸门 G2 | epistemic_type ∈ {direct_observation, user_statement} 且无冲突 active 版本 |
| candidate | quarantined | 人工/维护任务 | 来源可疑、同源复读、污染嫌疑 |
| active | superseded | 写入闸门 G2 | 新版本通过闸门并明确取代（写 superseded_by ＋ status_changed_at） |
| active | disputed | 写入闸门/人工 | 出现未解决独立矛盾 |
| active | retracted | 用户陈述/人工 | 原说话人撤回（"之前说错了"） |
| active | expired | 读取时惰性/维护任务 | valid_to 已过 |
| quarantined | candidate / active | 人工 | 复核通过 |
| disputed | active / superseded | 人工/新证据 | 矛盾裁决 |
| superseded | active | 人工 | 取代它的版本自身被撤销且无其他有效版本 |

规则：每次迁移追加 status_change 记录（时间、原因、操作者）；**历史永不删除**；superseded/expired/retracted 版本仅在历史查询中可见且必带标签。

### 4.8 时间语义（五种时间戳＋相对时间解析）

| 字段 | 回答的问题 |
|---|---|
| `asserted_at` | 何时说的 |
| `ingested_at` | 系统何时知道 |
| `valid_from` / `valid_to` | 内容指何时、哪段区间有效 |
| `status_changed_at` | 系统何时失效/改变该版本 |

相对时间解析六规则：
1. 基准 = **承载该表达的原始消息的 asserted_at**；绝不用复盘时刻、注入时刻。
2. **写入时一次性解析**，读取时不再重解析——杜绝"昨天"随读取时间漂移。
3. 同时保存：原始表达、解析区间、精度（默认 day 级）、不确定性。
4. 派生物（摘要/facts）中的相对表达**继承**源消息解析结果，禁止重新解析。
5. 无法解析 → 显式 unknown；禁止默认为"今天"。
6. `last_mentioned_at` 只由真实提及（raw_turns 的 asserted_at）计算；复盘复述、索引重建、注入命中均不得刷新。

### 4.9 confidence 与 evidence_group 语义

- confidence 是"当前证据支持程度"的校准值。**唯一可升高途径**：新增独立证据、直接性提升（ai_inference → user_statement）、经校准的人工确认。
- **禁止升高**：召回次数、复读次数、复盘次数、多版本同文——任何组合都不行。
- `evidence_group_id` 标识同一原始根源（原文→摘要→复盘→注入整条链）；同组内任意数量的复述 = 1 份证据。
- 展示 salience（排序优先级）可与召回频率相关，但 **salience 与 truthiness 严格分离**。

---

## 5. 三条读写契约

### 契约一：全量原始捕获，选择性提炼

1. 每轮先写 raw_turns，再做显著事件筛选与异步提炼。
2. 原文只在证据核验、精确回放、需要展开时进入上下文；常规回答只取精简结果，控 token。
3. 摘要永远带 source_event_ids；提炼失败不反向修改原文。
4. 原文保留与删除按 ADR-4 谱系策略执行；不以"保留证据"为由拒绝合法删除请求。

### 契约二：复盘巩固必须过三道闸门

**G1 复盘前（选材）**
- 候选只取自 raw_turns / events 的明确原始证据。
- AI 文本（含复盘自身的历史输出）不得作为用户证据。
- 同源链条先按 evidence_group 去重；复述同一来源不算新证据。
- 复盘文本不产生新 `last_mentioned_at`。

**G2 写入前（校验）**
- speaker / subject / epistemic_type / 时间五元组 / status 逐项校验；缺项 → 显式 unknown 或拒绝写入。
- ai_inference → 默认 candidate。
- 疑问句、猜测、假设 → 不入 facts。
- 冲突 → 新版本＋superseded，或 disputed；不覆盖、不静默改写。
- self_model 晋升 → 过 §4.4 门槛；正负自述同等受限。

**G3 注入前（过滤）**
- 强制排除：quarantined / superseded / expired / retracted，及 valid 区间不含当前的历史值。
- disputed 仅在确有必要时带争议标签出现。
- self_model 只注入当前 stable 版本。
- 所有片段带机器可读标签（附录 A）。

**越权禁止**：关联传播、图中心性、向量相似、复读频率——任何组合都不得越过 G1—G3 改变事实状态或置信度。

### 契约三：按意图构造工作记忆（不让任何一层永久当主干）

意图判定：规则优先（时间词/历史词→历史回放；人格词→人格；任务续接→当前任务；偏好/属性词→当前事实；语义模糊→混合召回）；歧义回退"当前任务"；每轮最多叠加 2 个主意图按预算分配。

| 意图 | 主读层 | 读取规则 | 默认预算 |
|---|---|---|---|
| 继续当前任务/未结事项 | state → 必要时展开 events/facts | 只看当前线程与未过期状态；无关人格与旧事实不入 | state 60% / 展开 30% / self 0—10% |
| 当前偏好/属性/承诺/知识更新 | facts | active＋当前有效＋排除 superseded；带来源与说话人 | facts 70% / events 证据 20% / state 10% |
| 历史回放（当时发生什么/谁说过什么/原话） | events → 必要时展开 raw_turns | 保持时序与说话人；**不得用当前 facts 改写历史**；失效值带"历史值＋失效区间"标签 | events 70% / 原文 30% |
| 人格/风格/自我叙事 | self_model ＋ 少量证据事件 | 仅 stable 未撤销版本；candidate 不冒充稳定自我 | self 70% / 证据 30% |
| 模糊回忆/跨事件发现 | 混合召回 → 回源展开 | 向量只找候选；最终受来源/时间/状态/证据约束 | 候选 60% / 展开 40% |

**配额原则（替代机械 50%）**：
- 同一 evidence_group ≤40% 注入预算或 ≤2 槽。
- epistemic_type=ai_inference ≤30%（人格意图除外——该意图本就只取 stable）。
- 工作记忆注入预算默认 ≤1200 tokens（p95 口径），按模型可调。
- 不设 user/AI 机械对半配额；目标是主体清晰与口径合理，**不是抹掉 AI 自我表达**。

---

## 6. 混合检索设计

默认流水线：
1. **意图解析**：意图、实体、speaker、时间范围、是否历史查询。
2. **结构化过滤**：先排除状态、有效期、来源不适用项（G3 的检索侧前置）。
3. **并行召回**：精确词/BM25 ＋ 实体 ID 连接；（可选）向量通道。
4. **去重**：按 evidence_group_id 与原始事件归并，防同源复读挤占预算。
5. **重排＋证据展开** → 生成带标签工作记忆。

- **向量索引**：默认关闭；当精确词＋结构化召回的缺口实测存在（gold set 模糊切片不达标）再启用；只作候选生成，不做有效性判断。
- **图投影（若未来启用）**：只投影带类型边（subject—predicate—object、speaker、事件、有效时间）；遍历/PPR 只扩候选、不改 status/confidence；可整体删除重建；不把高中心性解释为高可信。

---

## 7. 写入路径与复盘流程

### 7.1 实时路径（零 LLM，每轮）

1. 写 raw_turns（全量，两侧对称）。
2. 筛选生成/更新 events（显著情景投影，带 source_event_ids）。
3. 更新 state（当前任务、thread、临时约束）。
4. **实时路径不写 facts / self_model**——留给复盘，防一次对话即改写稳定认知。

### 7.2 复盘路径（每日 02:00 ＋ 启动补跑，调度不变）

1. **取材（G1）**：从 raw_turns 取窗口内原始证据；同源去重；不采信复盘自身历史输出为用户证据。
2. **抽取候选**：规则/LLM 抽取候选主张，逐条带 speaker/subject/epistemic_type/时间五元组。
3. **闸门校验（G2）**：逐条过校验；ai_inference → candidate；疑问不入；冲突建版本。
4. **写入**：facts / self_model candidate 落库；过 §4.4 门槛才晋升 stable。
5. **状态维护**：处理 superseded/expired 转移，记录 status_change。
6. **产出审计报告**：本次新增 candidate 数、晋升数、隔离数、冲突数。

复盘**不得**：直接晋升未达门槛的特质；刷新 last_mentioned_at；把 AI 独白算作用户提及；修改 raw_turns。

---

## 8. 存储方案决策依据（摘要；完整对比见评审报告 §6）

| 方案 | 一句话定位 |
|---|---|
| 星型实体中心/时态知识图谱 | 关系与多跳强；抽边不自动正确、放大污染、成本最高 → 只作可选投影 |
| A-MEM/仿突触动态关联 | 候选关联发现强；边权不可兼任真值、自动改旧笔记损审计 → 不启用自动改写 |
| 纯向量库 | 模糊召回强；superseded/有效期/否定语义弱 → 只作二级召回通道 |
| **事件溯源＋分域存储＋混合索引** | 七维综合最优，最贴合现有本地 JSONL/JSON 与约 30 条事件/月规模 → **主推荐（ADR-1）** |

研究反证（防"图一定更好"的过度推断）：
- HippoRAG 多跳 QA 最高 +20%，但非个人对话时态/说话人污染的直接证据。
- Zep 的 single-session-assistant 在两种模型上分别下降 9.06% / 17.7%。
- Mem0g 图增强总体约 +2%，single-hop/multi-hop 不优于基座。
- Mem0 full-context 质量更高（Overall J 72.90 vs 66.88/68.44）但 p95 17.117s vs 1.440s/2.590s——质量、延迟、成本必须联合评估。
- 以上数字均来自各自论文的实验设置，**不构成本项目收益承诺**；本案选型以本地四臂对照为准（§11.3）。

---

## 9. 人脑机制借鉴边界（ADR-6）

**借功能分工（功能类比，非生物仿真）**：
1. **互补学习系统** → 快写（raw_turns/events）＋慢整（闸门巩固），避免一次反思改写稳定自我。
2. **情景/语义分工** → "发生过什么"与"现在是什么"分路读取。
3. **多痕迹保留** → 语义化后原文仍可回放，巩固 ≠ 原文可丢。
4. **情境线索** → speaker/subject/会话/时间/实体/意图作检索线索。
5. **遗忘/强化** → 仅用于可逆的展示排序与索引权重。

**不借**：
1. 按艾宾浩斯曲线删除事实或降低真值（Murre & Dros 2015 复现的是人类遗忘现象，不是 AI 删除策略的依据）。
2. 召回即增强可信度（正反馈放大污染，与本案症状直接冲突）。
3. 生成模型自由重构原话（当前症状恰是摘要失源）。
4. "海马=图数据库、皮层=向量数据库"式隐喻当架构定律。

---

## 10. 分阶段迁移计划

| 阶段 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **P0 核实** | §0.2 清单 V1—V8 | 《现状核实报告》经用户确认 | 无改动，天然安全 |
| **P1 原始层** | 新增 raw_turns 追加写入；events 双写保留，不切读 | 新轮次 100% 落 raw_turns；旧路径行为不变 | 停写即回滚 |
| **P2 闸门** | 复盘接入 G1—G3；既有污染项按 ADR-2/3 隔离标注 | candidate 不晋升；quarantined 不注入；污染项带原因可审计 | 摘除标注即回滚 |
| **P3 schema** | facts/self_model 补齐 §4.3/4.4 字段；unknown 显式；legacy 标注 | 字段齐全率 100%（unknown 计为齐全）；证据链接可解析（legacy 除外） | 字段为 additive，天然可回滚 |
| **P4 装配器** | 按意图装配器 shadow 运行，对比旧 buildInjection 差异 | shadow ≥14 天或 ≥30 轮；关键指标达 §11.2 | feature flag 一键切回旧路径 |
| **P5 索引** | 结构化＋精确词索引重建；向量按实测缺口启用 | 检索延迟/磁盘量在预算内；召回达 gold set 标准 | 索引可删可重建 |
| **P6 图实验** | 四臂对照（可选，仅在用户要求或 C 臂多跳缺口明确时） | D 臂达 §11.3 门槛才进入图数据库成本评估 | 图投影可整体删除 |

**实施现状（2026-11-05 更新）**：

- ✅ **P0 核实**：V1-V8 已完成（`docs/phase0-现状核实报告.md`）。
- ✅ **P1 原始层**：已实施 `62732ec`（feat）+ `571cc51`（test 修时间炸弹）+ `ffc566a`（chore 清瑕疵）。
- ✅ **P2 闸门**：已实施 `697806d`（feat）+ `f64924c`（fix 防御）。
- ⬜ **P3 schema**：待施工（施工单元 2，见 §16.6）。
- ⬜ **P4 装配器**：待施工。
- ⬜ **P5 索引**：待施工。
- ⬜ **P6 图实验**：待施工（按 §11.3 门槛 + §16.3 增量3）。

> 五项增量（§16）与本迁移计划的映射：增量5 骨架先行（度量器）→ P3 → 增量1/2 → P4+增量4 → P5/P6+增量3。

### 10.2 可逆 / 不可逆分栏

**可逆（默认采用）**：新增文件与字段、unknown 标记、candidate 隔离、状态迁移（status_change 记录）、shadow/feature flag、索引重建/删除、图投影增删、salience 调整。

**不可逆（须用户显式批准＋备份＋谱系清单，初始迁移一律不执行）**：删除原文或旧版本、把摘要改写成"原话"、物理替换并废弃旧存储、清除备份、批量抹除人格历史、授权删除及其派生级联。

---

## 11. 验收标准与四臂对照

### 11.1 Gold set（140 项，脱敏/合成，另留隐藏集防过拟合）

speaker 归属 20 / 相对时间 20 / 知识更新 20 / 错误与污染事实 20 / 不可回答与弃权 20 / 人格稳定 20 / 关联查询 20（10 单跳＋10 多跳）。每题含 gold 答案、允许弃权标记、证据 event IDs、speaker、时间与有效期标注；附件五类症状转为可重复最小案例。

### 11.2 核心指标（设计验收阈值，非现有系统成绩）

| 指标 | 阈值 |
|---|---|
| speaker 归属准确率 | ≥95% |
| 相对时间归一化/区间正确率（含跨复盘"昨天"不二次偏移） | ≥95% |
| 知识更新正确率 | ≥95% |
| superseded 旧值被当作当前事实次数 | =0 |
| quarantined/已知错误事实进入注入上下文比例 | =0 |
| AI 疑问冒充用户事实 | =0 |
| 不可回答项正确弃权率 | ≥90% |
| 可回答项错误弃权率 | ≤10% |
| 被污染候选特质注入次数（正/负自述） | =0 |
| 稳定特质一致率（每次可回溯独立证据） | ≥90% |
| 派生事实证据链接可解析率（legacy 除外） | =100% |
| p95 输入 token 相对 events-only 基线增幅 | ≤15% |
| p95 端到端延迟增幅 | ≤20% |

准确性关键门槛未达时，速度优势无效。同时报告 p50/p95 token、端到端延迟、检索延迟、索引构建时间、磁盘量。

### 11.3 四臂对照与 D 臂（上图）门槛

同一 raw_turns、同一派生数据快照、同一模型/解码参数、同一提示模板、相同输入 token 预算，仅变检索策略：
- **A events-only**：只走显著事件及必要原文展开。
- **B facts-first**：当前任务优先 facts，事件仅作证据展开。
- **C 混合无图**：按意图装配＋结构过滤＋精确词/向量召回＋同源去重＋证据展开。
- **D 混合＋图投影**：C 上仅增加带类型图候选扩展。

四臂使用相同写入与污染防护（避免把写契约改善误记为图的收益）；报告分项任务分解，不只报总体均分。**默认采用 C。** D 进入图数据库成本评估须同时满足：多跳/关联切片较 C 提升 ≥15 个百分点、核心指标回退 ≤2 个百分点、关键错误仍为 0、p95 token 增幅 ≤10%、p95 延迟增幅 ≤20%，且在新增隐藏集复现通过。

---

## 12. 症状 → 修复机制映射

| 附件症状（行号） | 根因 | 修复机制（本文件章节） |
|---|---|---|
| "昨天"二次偏移（L47、72—76） | 相对时间以读取/复盘时刻为基准 | 写入时一次性解析，基准=源消息 asserted_at；派生继承不重解析（§4.8） |
| AI 疑问句被当用户事实（L49、72—76） | 无 speaker/epistemic_type | 强制字段＋G2：疑问与 ai_inference 不入 active（§4.3、§5 契约二） |
| 平台猜测成 0.95 attribute（L78—82） | confidence 脱离来源、无闸门 | ai_inference 默认 candidate；confidence 不随复读上升（§4.9）；既有项标 quarantined（ADR-3） |
| "我记忆好乱"恐固化为人格（L98—100、150） | 无晋升闸门 | §4.4 门槛（3/2/1）＋正负自述对称受限（ADR-2） |
| facts 纠偏读不到、旧值仍注入（L64—70、102—106） | 读契约断裂 | 按意图装配＋G3 强制过滤 superseded/quarantined/expired（§5 契约三） |
| 找不到原始对话（L48） | events 摘要兼任证据 | raw_turns 全量捕获＋source_event_ids 谱系（§4.1、§4.2） |
| 复盘复述伪造 lastMentionedAt（L99—100） | 提及时间=复盘时刻 | last_mentioned_at 只由真实提及计算（§4.8 规则 6） |
| user:self≈1:3、用户近期事件缺失（L55—62、114—115） | 写入口径不对称 | 全量捕获消除源头缺口；装配按意图＋同源去重，不靠机械配额（§4.1、§5 契约三） |

---

## 13. 默认参数表（初始治理参数，均可经用户调整）

| 参数 | 默认值 | 依据 |
|---|---|---|
| self_model 晋升门槛 | ≥3 独立证据组 / ≥2 会话或日期 / ≥1 非 AI 独白来源 / 无未解反证 | ADR-2 |
| 同一 evidence_group 注入占比 | ≤40% 或 ≤2 槽 | 防同源复读挤占 |
| ai_inference 注入占比（非人格意图） | ≤30% | 防推断冒充事实 |
| 工作记忆注入预算 | ≤1200 tokens（p95） | 可按模型调整 |
| shadow 观察期 | ≥14 天或 ≥30 轮 | P4 切换前置条件 |
| raw_turns 保留 | 无限期、仅本地 | ADR-4 |
| 备份保留 | 最近 5 份快照 | ADR-4 |
| 相对时间精度 | day 级；更粗 → unknown | §4.8 |
| 向量索引 | 默认关闭 | §6 |
| 图数据库 | 不引入 | ADR-1，除非 D 臂达门槛（§11.3） |
| 复盘时间 | 02:00＋启动补跑（维持现状） | §7.2 |

---

## 14. 执行会话操作清单

1. 读本文件＋评审报告＋附件原文（三份材料齐备再动手）。
2. 完成 §0.2 V1—V8，产出《现状核实报告》，请用户确认后再继续。
3. 与用户确认备份位置，完成 V2 备份并验证。
4. 按 §10 顺序实施 P1→P5，**每阶段验收通过后再进下一阶段**；每阶段结束向用户报告改动、验收结果、回滚点。
5. P6 仅在用户要求或 C 臂多跳缺口明确时启动。
6. 全程遵守 §0.3 三条红线与 §15 禁止事项。
7. 全部完成后：重新按 16 项检查做一次设计健康度复审＋运行测试，出实测报告（未测项保持"未验证"，不得填写预估值）。

---

## 15. 禁止事项（反结论清单）

1. 不按遗忘曲线删除事实或降低真值。
2. 不因召回/复读/复盘次数提高 confidence。
3. 不把摘要改写成"原话"。
4. 不让边权、图中心性、向量相似度决定事实有效性。
5. 不自动改写旧笔记（A-MEM 式演化不启用）。
6. 不设机械 user/AI 50% 写入或注入配额。
7. 不把"失效"当"删除"——历史仍可查、可审计。
8. 不在 V3 核实前改任何注入代码。
9. 不批量猜测未知字段——显式 unknown。
10. 不把任何论文数字当本项目收益承诺；选型只认本地四臂对照。

---

## 16. 第二轮评审增量（v1.1 新增）

> 来源：《dsh-memory-architecture-review-round2.md》（第二轮评审，2026-11-05）。
> 结论：v1.0 骨架正确（五缺口识别准确、三契约闭合、认识论卫生领先业界），问题不在脑仿生或存储选型。本轮补三块肉——程序性记忆、综合泛化、评测资产化，另加检索与 salience 两项强化。五项增量**均已确认可落地**（工程落点见各条"落点"行），施工顺序见 §16.6。

### 16.1 增量1：procedures 层（程序性记忆）

- **动机**：CoALA 四类记忆（情景/语义/程序/工作）缺"程序"一类——六层里没有一层回答"遇到这类情况该怎么做"。
- **设计要点**：新增 `procedures` 层，**复用 facts 的全部字段与机制**（版本化、七态状态机、五时间戳、`evidence_group_id`、G2 闸门、§4.4 晋升门槛）。一条 procedure = 在〔情境〕采取〔做法〕，因为〔来源证据〕。
- **哲学红线（不可违反）**：procedures **只能长出来、不能写进去**。必须是 AI 从自身经历归纳的做法（`epistemic_type=ai_inference`、默认 `candidate`、过 G2、达晋升门槛才 `stable`）；绝不预设行为规则/角色卡/话术。检验一条 procedure：作者写进去教她怎么说话 → 禁止；她从 N 次经历自己归纳 → 允许。与理念 1"人格长出来，不写进去"同一条红线。
- **落点**：`src/types.ts` 加 `PersonaProcedure`/`ProceduresFile`；新建 `src/procedures.ts`（存储+服务，复用 self-model.ts 模式）；`src/review.ts` run() 加 procedures 提炼步骤；`src/promotion.ts` 的晋升闸门对 procedures 同生效。
- **依赖**：P3 schema（`evidence_group_id`）。
- **标注**：层概念=业界已有（CoALA）；"只能长出来不写进去"红线=组合创新/待验证。

### 16.2 增量2：综合泛化（CLS 归纳泛化职责）

- **动机**：§9 借了 CLS"快写慢整"，但只实现"抽取"，未实现"归纳泛化"（从多条经历综合出更高层结构知识）。
- **设计要点**：复盘 §7.2 在"抽取候选"后、G2 前加"综合泛化"步骤，产出泛化候选（同过 G2、默认 `candidate`、达晋升门槛才 `stable`）。
- **过度归纳风险（进闸门）**：泛化候选须挂 ≥2 个不同 `evidence_group_id` 的反例检查（有未解决反例不晋升）；confidence 有上限、不因"被归纳一次"高于来源证据最高值。
- **落点**：`src/review.ts` 加 generalize 步骤（新 LLM prompt）+ 泛化候选闸门。
- **依赖**：P3 schema（`evidence_group_id` 反例检查）。
- **标注**：职责=CLS 已有；闸门化=组合创新/待验证。

### 16.3 增量3：检索升级（typed-edge 图投影 + 向量启用判据）

- **设计要点**：①typed-edge 图投影 schema 具体化（仅 `subject—predicate—object`/`speaker`/`event`/`valid time` 四类边，PPR 仅作候选扩展、最终回 facts/raw_turns 验证）；②向量启用判据量化（gold set 增补"改写问法切片"，精确词+结构化召回缺口 ≥10% 才启用向量）。
- **与 ADR-1 顺序厘清**：**不是提前上图**。ADR-1"暂不上图、D 臂达门槛才评估"不变；增量3 只是把 D 臂门槛提前定义好，避免 P6 启动时从零设计。
- **落点**：判据部分 → 增量5 的 gold set 加"改写问法切片"；图投影部分 → P6。
- **标注**：typed-edge 投影=业界已有；判据量化=组合创新/待验证。

### 16.4 增量4：salience 第二职责

- **设计要点**：salience 在"展示排序"外承担三职责——①巩固优先级（复盘窗口长尾事件按 salience 降采样）；②冷热分层（热数据内存/热索引、冷数据落盘/冷索引分代，缓解黄6 超长 footprint 与本地单点）；③检索预算分配。**红线**：salience 永不触碰 status/confidence/有效期（只影响"先看谁"，不影响"谁是真的"）。
- **落点**：`src/review.ts`（巩固优先级降采样）、`src/recall.ts`（检索预算）、`src/raw-turn-log.ts`/`event-log.ts`（冷热分层）。
- **标注**：冷热分层=业界已有；边界=组合创新/待验证。

### 16.5 增量5：评测资产化（gold set 转回归资产）

- **设计要点**：§11.1 的 140 项 gold set 落成可运行回归套件（标注文件 + 跑分脚本 + **隐藏集分离**）；P3-P6 每步迁移前后全量跑 + 13 项指标 diff 留痕；gold set 版本化（随迁移新增改写问法切片、症状最小案例）。
- **落点**：新建 `goldset/` 数据目录 + `scripts/eval-goldset.mjs`；`package.json` 加 `eval:goldset` 脚本。
- **标注**：gold set 概念=业界已有；"转回归资产 + 每步留痕 + 隐藏集防过拟合"=组合创新/待验证。

### 16.6 施工顺序与实施现状

| 顺序 | 施工单元 | 内容 | 依赖 | 状态 |
|---|---|---|---|---|
| 1 | 增量5 骨架 | gold set 结构 + 13 指标定义 + 跑分脚本框架 + 首批 speaker/相对时间切片 | 无 | 施工中 |
| 2 | P3 schema | facts 七态 + speaker/subject/epistemic_type + 五时间戳 + evidence_group_id + lastMentionedAt 只由真实提及计算 | 增量5 骨架 | 待施工 |
| 3 | 增量1 procedures | procedures 层 | P3 | 待施工 |
| 4 | 增量2 综合泛化 | 复盘泛化步骤 | P3 | 待施工 |
| 5 | P4 装配 + 增量4 | 按意图装配器 shadow + salience 第二职责 | P3 | 待施工 |
| 6 | P5/P6 | 索引 + 图实验（增量3 判据在此验收） | 评测证据 | 待施工 |

> 施工顺序原则：**评测资产化（增量5 骨架）先行**，因为它是所有后续增量的"度量器"——没有它，"是否有效"无从判断；其次 P3 schema，因为它解锁增量1/2 的 `evidence_group_id` 前置。增量3 的"判据"随增量5 落地，"图投影"押后到 P6。

---

## 附录 A：注入片段标签 schema（示例）

```json
{
  "type": "fact",
  "fact_id": "f-0231",
  "version_id": "f-0231.v2",
  "text": "用户偏好简洁回复",
  "speaker": "user",
  "subject": "user",
  "epistemic_type": "user_statement",
  "asserted_at": "2026-11-03T21:14:00+08:00",
  "ingested_at": "2026-11-04T02:00:12+08:00",
  "valid_from": "2026-11-03",
  "valid_to": null,
  "status": "active",
  "status_changed_at": "2026-11-04T02:00:12+08:00",
  "confidence": 0.8,
  "evidence_group_id": "eg-0117",
  "source_event_ids": ["rt-08812"]
}
```

标签必须机器可读且可展示；AI 推断项显著标"推断"；历史值带"历史＋失效区间"。

## 附录 B：研究参考文献

1. McClelland, McNaughton & O'Reilly (1995). *Why there are complementary learning systems in the hippocampus and neocortex*. Psychological Review. https://doi.org/10.1037/0033-295X.102.3.419
2. Nadel & Moscovitch (1997). *Memory consolidation, retrograde amnesia and the hippocampal complex*. Current Opinion in Neurobiology. https://doi.org/10.1016/S0959-4388(97)80010-4
3. Murre & Dros (2015). *Replication and Analysis of Ebbinghaus' Forgetting Curve*. PLOS ONE. https://doi.org/10.1371/journal.pone.0120644
4. Sumers et al. *Cognitive Architectures for Language Agents (CoALA)*. https://arxiv.org/abs/2309.02427
5. Park et al. *Generative Agents*. https://arxiv.org/abs/2304.03442
6. Zhong et al. *MemoryBank*. https://arxiv.org/abs/2305.10250
7. Wu et al. *LongMemEval*. ICLR 2025. https://arxiv.org/abs/2410.10813
8. Gutiérrez et al. *HippoRAG*. NeurIPS 2024. https://arxiv.org/abs/2405.14831
9. Rasmussen et al. *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*. https://arxiv.org/abs/2501.13956
10. Xu et al. *A-MEM: Agentic Memory for LLM Agents*. NeurIPS 2025. https://arxiv.org/abs/2502.12110
11. Chhikara et al. *Mem0*. https://arxiv.org/abs/2504.19413
12. Wu et al. *From Human Memory to AI Memory: A Survey*. https://arxiv.org/abs/2504.15965
13. Logan (2026). *Continuum Memory Architectures for Long-Horizon LLM Agents*. https://arxiv.org/abs/2601.09913

---

**最终判断（v1.1）**：问题不是"四层不够脑仿生"，而是原始证据、来源主体、双时态、有效事实读取与巩固治理五个契约未闭环。本设计以最小改动补齐这五个契约：保留四层认知分工与本地存储，新增 raw_turns 原始层与三道闸门，重写读写契约，暂不上图。第二轮评审在此基础上补三块肉：程序性记忆（增量1，守住"只能长出来"红线）、综合泛化（增量2，补 CLS 漏借的那一半）、评测资产化（增量5，让"正确"可被证明），另加检索升级（增量3）与 salience 第二职责（增量4）两项强化。存储选型服务于契约，由本地四臂对照决定图与动态关联是否值得，而非以技术隐喻定义记忆。
