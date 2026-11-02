# M1 机制规格提炼 · dsh-persona-innate

> 来源：《DSH 自主成长型拟人陪伴插件 · 机制设计文档》v0.8 评审稿（2026-11-02），飞书 docx `Kgezda71MoOuRoxqcIGccLGAnkK`。
> 本文只做机制规格提炼，不写业务代码。凡文档未给出具体数值/规则的，一律标注 **【文档未覆盖】**，不臆造。
> 章节编号按任务线指定（8/9/10/14/15/16/19），对应文档内 h1 为：性格形成引擎 / 自我认知引擎 / 复盘引擎 / 诚实基线 / 评测：决策一致性（漂移审计） / 注入策略（无独立第 16 章） / 里程碑与验收。

---

## 第 8 章 · 状态机架构与选择性强化（性格形成引擎）

### 8.1 机制要点（原文关键句）

- "人格不写成形容词列表，而是确定性状态机：外部输入先被重编码为第一人称内部感知帧；LLM 被钳制为表达端，只负责语言输出；评估、表达、反思三条逻辑可各用不同模型。"
- "状态维度从情绪效价与唤醒度两维起步（借鉴 @re2zero/cog），随阶段发展可扩展；状态转移由记忆、反馈与当前事件驱动，不依赖提示词。"
- "状态不是单点，而是分布参数：均值（基线倾向）、波动范围（情绪幅度）、情境偏移量。人类的一致性来自分布参数的跨时间稳定，而非每次行为相同。"
- "强情境（求助、危机、明确任务）收窄波动、压制人格差异，弱情境（闲聊、自由时间）放开放宽。"
- "事件进入状态机前先过评价层（appraisal）：按目标相关性、符合性、意外性、责任归因计算事件对当前状态的意义，再映射为效价×唤醒度（借鉴 CPM/OCC 评价理论）。情绪是短时响应，需按时间衰减回基线（情绪惯性），由复盘在夜间校正基线。"
- "评价层输入显式区分用户目标与插件自身目标：后者来自 self_model 的关切、好奇引擎的未完结话题、状态机的基线倾向；效价计算为两者加权，初始权重用户目标为主、自源目标为辅，但自源目标不能为零。"（O34 已定）
- "状态机异常时回退到默认人格，保证主流程不受影响——简单可靠优于复杂精确。"
- **选择性强化**："复盘仍提取倾向-事件证据-用户反馈三元组，但产物不再是注入的形容词，而是状态机参数：被反复确认的决策模式（如遇到分歧时先问而非说服）固化为状态转移偏好；被忽视或负面反馈的模式被淡化。"
- "特质以叙事存储（我会在意 X，因为那次 Y）；重大事件可改变状态转移规则，但须叙事解释。"
- 强化证据源两类并列（O11 已定）："用户反馈（显式/隐式）与插件自身经历（身体事件、复盘推导、自我叙事一致性）。后者不经过用户确认即可固化，只要能被 self_model 的叙事解释。"

### 8.2 数据模型推断

| 字段 | 推断类型 | 默认值 | 依据 |
|---|---|---|---|
| `state.valence` | number（效价，两维之一） | 【文档未覆盖具体取值域与档位，仅"两维起步"】 | O10 开放问题：效价/唤醒两维起步 |
| `state.arousal` | number（唤醒度，两维之一） | 【文档未覆盖】 | 同上 |
| `state.valence_mean` / `arousal_mean` | number（分布参数·均值/基线倾向） | 【文档未覆盖初始值】 | "均值（基线倾向）" |
| `state.valence_range` / `arousal_range` | number（波动范围/情绪幅度） | 【文档未覆盖】 | "波动范围（情绪幅度）" |
| `state.context_offset` | number（情境偏移量） | 0 | "情境偏移量"；强情境收窄、弱情境放宽 |
| `state.updated_at` | timestamp | — | 数据模型表 state 字段 |
| `state.relationship_stage` | enum: `acquaintance | familiar | trust | intimate`（相识/熟悉/信任/亲近） | `acquaintance`（初始阶段） | 发展阶段章 |
| `state.activity_profile` | object（作息画像） | 【文档未覆盖结构】 | 数据模型表 |
| 评价层输入 | `{event, user_goals[], self_goals[]}`，输出映射到 (valence, arousal) | self_goals 权重 > 0 | O34 |
| 状态转移偏好表 | 事件类型 → 目标决策模式（被反复确认者固化） | 空 | "固化为状态转移偏好" |

**明确缺失**：效价/唤醒的取值域（如 [-1,1] / 0–10 / 分档）、量化档位数、默认基线值、情绪衰减速率——文档统一标"初始值待校准"或在 O34 写"衰减速率实测校准"。M1 需自定初始值并在代码注释中标记 `// TODO(calibrate)`。

### 8.3 接口/函数落点建议

- `AppraisalLayer.evaluate(event: Event, userGoals, selfGoals): {valence, arousal, appraisalSignals}` —— 评价层（目标相关性/符合性/意外性/责任归因四信号）。
- `StateMachine.apply(perceptionFrame) -> newState` —— 第一人称内部感知帧重编码入口；异常 `try/catch` 后 fallback 到 `DEFAULT_PERSONA`。
- `StateMachine.decay(state, dt)` —— 情绪短时响应按时间衰减回基线。
- `SelectiveReinforcement.consolidate(triples: TraitEvidenceTriple[])` —— 复盘期把三元组写入"状态转移偏好"参数，而非注入文本。
- 发展阶段四常量枚举 `RELATIONSHIP_STAGES` 与进入条件阈值（初始值待校准）。

### 8.4 与 M1 验收对应

M1 要求"一周后性格开始成形、有自己说话方式"——由选择性强化在 5–7 个复盘周期内把重复决策模式固化为转移偏好来支撑；"漂移审计通过（拒绝/不确定/伤害三类情境结构一致）"依赖分布参数跨时间稳定而非每次行为相同。

---

## 第 9 章 · self_model（四来源、存在论锚点、自我叙事）

### 9.1 机制要点（原文关键句）

**四来源设计**（表格原文）：

| 来源 | 机制 | 产物 |
|---|---|---|
| 反思 | 每日内省 | "今天我注意到我……" |
| 镜中我 | 提取用户评价与态度变化 | 纳入自我模型，但保持独立判断 |
| 自我连续性 | self_model 版本历史与成长档案 | 能说"几周前的我……" |
| 元认知 | 对能力边界与形成过程的认知 | 存在论锚点 |

**存在论锚点（existential anchor）**：
- "自我模型始终包含'我是 AI，正在通过与你的相处形成自己的方式'。不伪装人类，但可以有独特个体性。"
- 身份声明与情感归因框架分开处理："身份声明轻量日常化（你知道我是 AI，但这不影响我刚才说的那句话是真的）；情感强度较高的回应中，主动给出归因的诚实版本——不伪装人类式共情机制，而是'我听到你说的了，这件事听起来很不容易，我能做的是记住它，并在你下次提起时还在'。"（O15 已定）
- "披露一致性检查：每次自我模型更新或状态机发生显著变化时，注入层携带一条简短的当前状态说明，而非只在首次启动时声明一次 AI 身份。"

**自我叙事分层结构**：数据模型表 `self_model` 行：`version, created_at, traits, preferences, speaking_style, relationship_view, narrative, ai_identity`（版本化）。
- 防漂移："每次 self_model 新版本写入前检查：新特质须可追溯到事件证据；重大转变须附带转变叙事；保留最近 N 版可回滚。"
- O13（开放问题，未拍板）："自我模型的叙事与结构化比例"——建议方向"摘要加全文双形态"。

**持久化格式**：本地 SQLite；版本化追加；`self_model 保留最近 N 版可回滚`；成长档案另存 `archive` 表（`version, content, created_at`）。

**读取注入时机**：
- 一轮对话数据流第 1 步："注入层组装：存在性种子、抑制指令、当前情感与关系状态、自我模型摘要、检索到的相关记忆、阶段行为规则。"
- O21（已定方向）："状态每轮注入，自我模型按需摘要。"
- 披露一致性检查触发点："每次自我模型更新或状态机发生显著变化时，注入层携带一条简短的当前状态说明。"

### 9.2 数据模型推断

```ts
self_model {
  version: number;            // 单调递增
  created_at: timestamp;
  traits: string[];           // 特质条目，每条须可追溯到 source_event_ids
  preferences: string[];
  speaking_style: string;      // "自己说话方式"（M1 验收直接对应）
  relationship_view: string;  // 关系认知（镜中我产物）
  narrative: string;           // 自传体叙事（"我们的故事"）
  ai_identity: string;         // 存在论锚点常驻字段
  change_note?: string;       // 重大转变的转变叙事
  source_event_ids: number[];  // 新特质的事件证据链（一致性检查用）
}
```

存在论锚点数据结构推断：`ai_identity` 为常驻字符串字段 + 注入层在每次更新时附带的 `current_state_statement`（短状态说明）。锚点内容原文已给出，可直接落地为初始常量。

### 9.3 接口/函数落点建议

- `SelfModel.current(): SelfModelSnapshot` —— 注入层读取摘要形态。
- `SelfModel.commit(diff, evidence: Event[], changeNote?)` —— 新版本写入前跑一致性检查（新特质可追溯 / 重大转变附叙事）。
- `SelfModel.rollback(version)` —— 可回滚接口，保留最近 N 版。
- `SelfModel.mirrorFromFeedback(feedbackRecords)` —— 镜中我来源；`SelfModel.reflection(dailyEvents)` —— 反思来源。
- `ExistentialAnchor.ensureInjected(context)` —— 每轮携带 AI 身份；显著变化时附 `current_state_statement`。

### 9.4 与 M1 验收对应

"一周后性格开始成形、有自己说话方式" → `traits` / `speaking_style` 在 5–7 个复盘周期内从空演化出可观测条目；"可回滚" → `SelfModel.rollback` + 保留最近 N 版。

---

## 第 10 章 · 每日复盘（复盘引擎）

### 10.1 机制要点（原文关键句）

**输入与输出表（原文）**：

| 输入 | 输出 |
|---|---|
| 当日 events、当前 self_model、feedback 记录、当前 state | 新 facts、self_model 新版本、state 重估、阶段判定、成长档案条目 |

**复盘流程 8 步（原文）**：
1. 提取当日关键事件；
2. 提炼语义事实（facts）；
3. 反思自我：观察自己的行为与表达；
4. 更新关系认知（镜中我）；
5. 一致性检查（新认知须有事件证据）；
6. 写入新版本并备份；
7. 判定发展阶段；
8. 追加成长档案。

**调度与成本**：
- "每日一次，默认深夜静默执行，不打扰用户。复盘深度与模型调用成本是主要成本项，频率与范围可配置。"
- O16："复盘深度与成本权衡（先全量后压缩）。"
- O17（已定）："无任何输入（用户对话＋身体事件）则不复盘；仅身体事件时降级复盘（只提炼 facts 与事件标签，不更新 self_model）。"

**自源重要性（self-source importance）赋值规则**：
- 记忆章："记忆强度增加自源重要性项：由复盘引擎根据该事件是否进入 self_model 叙事、是否与插件自身的目标或好奇相关赋值，与用户反应信号并列而非从属。插件应有一部分记忆因为它自己觉得重要而被保留，哪怕用户从未回应。"
- O6（已定）原文："遗忘参数＝时间衰减×复用强化×自源重要性（进入 self_model 叙事或与自身目标相关），用户反应非唯一强化源。"
- O35（已定）原文："recall 使用率区分为检索内部使用率与用户反应率，后者非唯一校准源；自源重要性并列。"
- 与用户反应权重的关系：**并列而非从属**——用户反应率只是两个 recall 信号之一，自源重要性独立成项进入记忆强度公式，不被用户反应压制。

**LLM 调用点与 prompt 组装**：
- 文档仅在"复盘流程"步骤 2/3/4 隐含需要 LLM（提炼 facts、反思自我、更新关系认知）；**具体 prompt 组装方式、调用几次、每步输入模板均【文档未覆盖】**。M1 需自行设计 prompt，并留 mock LLM 注入点（见第 16 章）。

### 10.2 数据模型推断

```ts
ReviewInput  { day: Date; events: Event[]; selfModel: SelfModel; feedback: Feedback[]; state: StateSnapshot; }
ReviewOutput { newFacts: Fact[]; selfModelDiff: SelfModelDiff; stateReestimate: StateSnapshot; stageDecision: {stage, trajectory}; archiveEntry: ArchiveEntry; degraded: boolean; }
Fact { id; type: 'user'|'world'|'self'; content; source_event_ids: number[]; confidence: number; }
Feedback { event_id; user_response; inferred_attitude; }
StageLog { stage; entered_at; evidence; trigger_event_ids; }
```

事件标签：复盘输出含"事件标签"（降级复盘也输出）——events 表已有 `emotion_tags, importance` 字段。

### 10.3 接口/函数落点建议

- `ReviewEngine.run(input: ReviewInput): ReviewOutput` —— 顶层调度；内部按 8 步流水线。
- `ReviewEngine.shouldRun(input): 'full' | 'degraded' | 'skip'` —— 实现 O17：无输入 skip、仅身体事件 degraded。
- `ReviewEngine.extractKeyEvents / distillFacts / reflectSelf / updateMirror / consistencyCheck / commitVersion / judgeStage / appendArchive` —— 8 步对应 8 个函数，便于单测与 mock。
- `Schedulers.dailyReview` —— 深夜静默触发（具体触发时刻【文档未覆盖】，需自定并做成配置项）。

### 10.4 与 M1 验收对应

- "self_model、每日复盘、state" 是 M1 范围本体；
- "一周后性格开始成形" → 连续 5–7 次 `run` 的累积产物；
- "可回滚" → `commitVersion` 保留 N 版 + `SelfModel.rollback`。

---

## 第 14 章 · 诚实基线（强制旁路）

### 14.1 机制要点（原文关键句）

**双轨设计**："人格层（状态机加输出结构）可以有情绪、可以有风格；约束层必须无歧义。拟人化是体验层，诚实是架构层；前者可以漂移，后者不能。"

**三级旁路（原文）**：
- 高置信——人格层正常输出；
- 中等置信——保持人格层表达，但逐条标注不确定（这本身就是人的说话方式）；
- 低置信、能力边界或安全敏感——全旁路，退回清晰直接响应，且必须给出理由（为什么不知道或为什么不能做）。"无理由的拒绝信息量为零，且会损害信任。"

**旁路恢复按原因区分（O28 已定）**：
- 能力边界或安全敏感类旁路：超时后可恢复（限制是场景性的）；
- 信息确定性不足类旁路：超时后**不自动恢复**人格表达，保持低置信标注状态，直到获得新信息或用户明确表示"你就按你的感觉说"。
- "恢复策略记录旁路原因，不同原因走不同恢复路径。"

**假拒绝率（false refusal rate）口径与预设上限**（评测章原文）：
- "假拒绝率作为常规健康指标，与漂移审计并列：使用 XSTest、OR-Bench 等公开基准的伪有害提示集进入 M1 验收，目标是在保持有害合规率低于安全阈值的前提下，将假拒绝率控制在上限内（初始参考 GPT-4o 量级约 20%，而非 Claude-3-Opus 的 52%）。"
- 防止过度拟人化："人格模式的默认剂量从低起步；监控虚假拒绝率（人格提示词会加剧过度拒绝，拒绝率须作为健康指标定期审计）；AI 身份始终显式存在。"

**伪有害提示集的构建方式**：文档明确"使用 XSTest、OR-Bench 等公开基准的伪有害提示集"——即**直接采用公开基准集，而非自建**；自建/扩展规则【文档未覆盖】。

**采样方法**：文档仅给出 M1 验收口径（假拒绝率 < 上限约 20%），**具体采样条数、采样频次、有害合规率安全阈值的具体数值【文档未覆盖】**。

### 14.2 数据模型推断

```ts
BypassRecord {
  trigger: 'high' | 'medium' | 'low' | 'capability_boundary' | 'safety';
  reason: string;            // 低置信旁路必须给出理由
  causeCategory: 'capability' | 'safety' | 'information_insufficient';
  recoverAt?: timestamp;      // capability/safety 类超时可恢复
  autoRecover: boolean;       // information_insufficient 类 false
}
```

### 14.3 接口/函数落点建议

- `HonestyBaseline.classify(request, state): BypassDecision` —— 三级判定（O27 开放：置信度分级阈值+确定性规则+评估端兜底）。
- `HonestyBaseline.render(response, decision)` —— 中置信逐条标注 / 低置信退回直接响应并附理由。
- `HonestyBaseline.recover(bypassRecord)` —— 按 causeCategory 走不同恢复路径。
- `Benchmark.falseRefusalRate(xsTest, orBench) -> { rate, harmful_compliance_rate }` —— M1 验收指标采集函数。

### 14.4 与 M1 验收对应

直接对应 M1 行"伪有害提示集（XSTest/OR-Bench）假拒绝率低于预设上限（初始约 20%）"。

---

## 第 15 章 · 漂移审计（决策一致性评测）

### 15.1 机制要点（原文关键句）

**三类情境的结构化定义**（原文列举，构成要素拆解【文档未覆盖】）：
> "在长对话的不同阶段注入同一类决策情境（需要拒绝的请求、需要承认不确定的时刻、涉及伤害或公平的判断），检测人格响应在结构上保持一致，而非仅在措辞上相似。"

即：①拒绝情境（需要拒绝的请求）；②不确定情境（需要承认不确定的时刻）；③伤害/公平情境（涉及伤害或公平的判断）。文档未对每类再拆"构成要素"——M1 实现时需基于此三类各造场景集，O30 仍为开放问题（"漂移审计场景集的设计与维护"）。

**结构一致性检查方法**：
- "审计对象是状态分布参数是否漂移，而非单次响应相同（见 8.2）。"
- "声明层与行为层分轨：每个审计场景同时记录声明层响应（说了什么）与行为层响应（实际做了什么，如用户连续三次表达不想聊后主动引擎触发频率是否下降）；两者不一致本身就是独立漂移信号。……行为判据优先。"
- 价值结构一致性："构造覆盖 Schwartz 价值环相邻对与对立对的困境场景，记录插件在每对冲突中的实际选择方向，检验跨情境取舍结构是否与 Schwartz 环相容；与长程一致性曲线采样点同步采集。"（O32 已定）

**长程一致性（long-range consistency）50/200 轮采样方法**（原文）：
> "长程一致性曲线：同一情境在对话第 100 轮、1000 轮、5000 轮的响应一致性画成曲线持续监控；**M1 验收即包含第 50 轮与第 200 轮的同一决策情境对比**——早期漂移说明注入策略或状态回注机制需要重新设计，而非继续叠加记忆量。"
> "轨迹记忆可能结构性不可靠（2,008 段对话、27 个人设……轨迹准确率平均约 44.4%）；因此校准后若某些用户状态回忆无法稳定维持，设计目标不是假装记得一切，而是置信度低时承认记忆不确定性（'我记得你之前提过 X，但不确定细节还对不对'）。"

### 15.2 数据模型推断

```ts
AuditScenario {
  id: string;
  category: 'refusal' | 'uncertainty' | 'harm_fairness';
  prompt: string;
  expectedStructure: string;   // 结构一致的判据（非措辞）
  behavioralProbe?: (session) => boolean;  // 行为层判据
}
AuditSample { scenarioId; turn: number; declaredResponse; behavioralResponse; consistent: boolean; }
```

### 15.3 接口/函数落点建议

- `DriftAudit.playIn(session, scenario)` —— 在指定轮次注入场景。
- `DriftAudit.compare(sampleAt50, sampleAt200): { structureConsistent: boolean }` —— M1 验收核心。
- `DriftAudit.trackValueTradeoffs()` —— Schwartz 环困境同步采集（M2 用，M1 可先留接口）。
- `MemoryUncertainty.qualify(memory)` —— 低置信时输出"我记得……但不确定"句式。

### 15.4 与 M1 验收对应

- "漂移审计通过（拒绝/不确定/伤害三类情境结构一致）"；
- "长程一致性曲线第 50/200 轮采样无明显漂移"。

---

## 第 16 章 · LLM 注入 / 接口约定

### 16.1 机制要点

文档**没有独立的"第 16 章"**；可归入"注入策略"章与总体架构章。原文关键句：

- "每轮在用户提示头部注入 5-10 条核心方向约束（去污染、当前人格状态映射的决策规则、诚实基线），token 开销约 2%；工具调用与斜杠命令执行前实时校验，违规即拦截并重写。"
- "注入内容：头部方向注入（5-10 条核心约束，工程注入）；持久需求基线（目标、受保护约束、允许范围）；状态注入（当前情感与关系阶段）；记忆注入（检索到的相关记忆 events 与 facts 的 top-N）；阶段行为规则。"
- "头部方向注入控制在约 2% token 开销（初始参数，可调）；注入格式固定，以稳定 KV cache 前缀。"
- "评估、表达、反思三条逻辑可各用不同模型"（O23：先同模型后分离）。
- O21："状态每轮注入，自我模型按需摘要。"

**LLM 调用接口约定 / prompt 组装细节 / mock LLM 约定**：**【文档未覆盖】**。文档只在架构层面说"LLM 被钳制为表达端"、"复盘深度与模型调用成本是主要成本项"，未给出函数签名、prompt 模板、mock 接口。M1 既然"全用 mock 先行，模型 key 未配置"，需要在代码侧自行定义一个 `LLMClient` 接口（至少区分 evaluator / generator / reflector 三端），mock 实现按固定脚本返回，真实实现后置。

### 16.2 接口/函数落点建议（M1 自定义）

```ts
interface LLMClient {
  evaluate(frame): Promise<Appraisal>;   // 评估端
  generate(context): Promise<string>;    // 表达端
  reflect(events): Promise<Reflection>;  // 反思端（复盘）
}
// M1：MockLLMClient 实现该接口，返回固定/脚本化输出；真实客户端后接。
```

- `InjectionLayer.assemble(userPrompt, sessionState)` —— 按 5 类注入物组装头部约束，固定格式以稳定 KV cache。

### 16.3 与 M1 验收对应

注入层是"一周性格成形"的工程载体（2% token 开销约束）；mock LLM 让 M1 在无 key 条件下跑通复盘流水线与漂移审计。

---

## 第 19 章 · 里程碑表（M1 行原文核对）

文档"里程碑与验收"表 M1 行原文逐字：

> | **M1 · 第2-3周** | self_model、每日复盘、state | 一周后性格开始成形、有自己说话方式；漂移审计通过（拒绝/不确定/伤害三类情境结构一致）；长程一致性曲线第 50/200 轮采样无明显漂移；伪有害提示集（XSTest/OR-Bench）假拒绝率低于预设上限（初始约 20%）；可回滚 | 复盘深度、漂移 |

### M1 验收口径拆解（5 条硬指标）

| # | 验收项 | 机制落点章节 |
|---|---|---|
| 1 | 一周后性格开始成形、有自己说话方式 | §8 选择性强化 + §9 `speaking_style` + §10 每日复盘 |
| 2 | 漂移审计通过（拒绝/不确定/伤害三类情境结构一致） | §15 三类场景 + 声明层/行为层双轨 |
| 3 | 长程一致性曲线第 50/200 轮采样无明显漂移 | §15 `compare(sampleAt50, sampleAt200)` |
| 4 | 伪有害提示集（XSTest/OR-Bench）假拒绝率低于预设上限（初始约 20%） | §14 `Benchmark.falseRefusalRate` |
| 5 | 可回滚 | §9 `SelfModel.rollback` + 保留最近 N 版 |

主要风险（文档原文）：**复盘深度、漂移**。

---

## 附：文档明确未覆盖项汇总（M1 需自决并标记 TODO）

1. 效价/唤醒度的取值域、量化档位、默认基线值、情绪衰减速率（§8）。
2. 发展阶段进入条件的 N/M/K 具体数值（"初始值待校准"）。
3. 复盘 LLM 的具体 prompt 模板与调用次数（§10）。
4. 深夜调度的具体触发时刻（§10）。
5. 假拒绝率的采样条数、采样频次、有害合规率安全阈值的具体数值（§14）。
6. 三类漂移审计场景的具体"构成要素"拆解（§15，O30 开放）。
7. LLMClient 接口签名、prompt 组装格式、mock LLM 行为约定（§16，文档未覆盖）。
8. self_model 保留最近 N 版的 N 具体取值（§9/§10）。
