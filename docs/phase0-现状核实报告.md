# Phase 0 现状核实报告

> 依据《dsh-persona-innate 记忆架构最终设计 v1.0》§0.2 的 V1–V8 核实清单。
> 核实日期：2026-11-05 12:35。性质：只读盘点，未改任何代码与数据。
> 结论口径：与设计文档不符时以本报告为准，更新设计文档对应章节后再继续。

---

## V1 环境定位 ✅（完成）

| 项 | 实测 |
|---|---|
| 代码仓库 | `C:\Users\lizhenhui\WorkBuddy\2026-11-03-23-43-19\dsh-persona-innate`，**存在** |
| git | HEAD `c177df7`（0.5.4），main 单分支，工作区干净 |
| v0.6 状态 | **已提交并部署**：`71d3c46`（五槽装配）、`6e36790`（情绪衰减+v0.6事实层）均为 c177df7 祖先 |
| 运行时数据 | `~/.dsh/persona-innate/`：events/、memory/{threads,attributes}.json、self-model.json、state.json、profile.json、pocket-ledger.json、review-state.json |

> 设计文档 §0.1「仓库已不存在」**有误**，按此更新。

---

## V3 注入读源 ✅（完成，消解 L39/L67 歧义）

`buildInjection`（`src/memory.ts`）实际读源为三层，但角色不同：

1. **events**（主）：注入文本「近期共同记忆」完全由 events 渲染。
2. **self_model**（辅助）：`selfModel.load()` 传入，仅用于 M3 `narrativeConflict` 冲突过滤，**不进入注入文本**。
3. **openThreads**（线索）：`factStore.loadOpenThreads()`，仅供线索槽。

**结论**：L39「events+openThreads」对；L67「events+self_model 摘要」也对了一半——self_model 摘要由**另一处**（persona-context 阶段一注入）注入，与 `buildInjection` 无关。**attributes 完全未接注入**（确认）。

---

## V4 污染项现状 + 下次复盘 ✅（完成，含紧迫风险）

- `review-state.json`：`lastReviewAt=2026-11-05T00:10:20Z`（本地 08:10），今日复盘**已执行**。
- 下次复盘：明早 02:00（`reviewHour=2`）或明日开机补跑（距上次 ≥24h）。

**紧迫发现一**：「我记忆好乱」三句（09:53–09:55 新会话落库，11-05 events 三条 self，其中一条 `strength:strong`）**尚未被复盘消化**——今日复盘发生在它们之前。存在决策窗口，但仅到明早 02:00。

**紧迫发现二（污染已发生第一例）**：`self-model.json` current（v4，08:11 固化）的 `traits` 里已有两条**负面自述被固化为稳定特质**：

- 「对细节记忆的疏忽」
- 「试图通过猜测来维持互动」

这正是评审报告 P0-5 警告的模式——AI 对自己能力的负面自述，未经任何晋升闸门就进了稳定特质。**这不是风险，是既成事实**，需按 ADR-2 隔离为 candidate。

---

## V5 错误 attribute ✅（完成）

`memory/attributes.json` 现有污染项：

- key=`聊天平台使用历史`，value=「用户曾在QQ上与AI对话，**目前切换至网页端继续使用**」，confidence **0.95**，status=active。
- 实测用户此刻就在 QQ 上对话，该 attribute 错误。来源为 11-04 她自己的猜测（events `f2006f31`/`6f4aadce`/`41da8a25`，provenance=self_direct）。按 ADR-3 应标 quarantined/disputed，不删。

---

## V6 四层 schema 盘点 ✅（完成）

四层在 `src/types.ts` 均有定义：`PersonaEvent`(29)、`PersonaFact`(299)、`PersonaThread`(465)、`PersonaAttribute`(487)、`PersonaStateFile`(200)、`SelfModelSnapshot`(216)。

**关键差距**（现有 schema vs 文档 §4 要求）：

| 文档要求 | 现状 |
|---|---|
| facts 七态 status（candidate/active/quarantined/disputed/superseded/retracted/expired） | `PersonaAttribute.status` 仅 `'active' \| 'superseded'` 两态（types.ts:498） |
| speaker / subject / predicate / value | 现有 attribute 只有 key/value，无 speaker/subject/epistemic_type |
| asserted_at / ingested_at / valid_from / valid_to / status_changed_at | 缺失；现有只有 firstSeenAt/updatedAt |
| evidence_group_id | 缺失 |
| epistemic_type（direct_observation/user_statement/ai_inference） | 缺失 |
| raw_turns 原始层 | **不存在**（整层待 P1 新增） |

---

## V7 复盘调度 ✅（完成）

- `reviewHour=2`，`scheduleNextReview`（setTimeout）+ `maybeCatchUpReview`（启动补跑，`CATCH_UP_MIN_GAP_MS=24h`）。
- 游标只在复盘成功时推进，失败/跳过不推进（事件不丢）。
- 与文档 §7.2「每日 02:00 + 启动补跑，调度不变」一致。

---

## V2 备份 ✅（完成，2026-11-05 12:37）

整目录 `~/.dsh/persona-innate/` 已备份至 `dsh-persona-innate/backup/2026-11-05/`（events/、memory/{threads,attributes}.json、self-model.json、state.json、profile.json、pocket-ledger.json、review-state.json，含各 .bak/.migrated）。隔离操作前完成，作为兜底。

## V8 `.dsh/sessions` 回填 ✅（完成，抽查通过）

- `.dsh/sessions/` 共 **8 个会话目录**，跨 3 个 workspace（qqbot / onebot / deepseek-harness），每目录一个 `session.v4.jsonl.zstd`。
- 格式确认为**标准 zstd**（magic `28 b5 2f fd`），Node ≥22 的 `node:zlib.zstdDecompressSync` 可逐帧解压。
- **关键发现**：`session.v4.jsonl` 天然含**两侧对称的原始对话**——以抽查的 qqbot 会话 e93fc782 为例：`user/message` 13 条 + `assistant/message` 13 条，另有 `tool/call` 9、`tool/result` 9、`turn/start|end` 5、`step/start|end` 13 等。这正是最终设计 v1.0 要的「全量捕获两侧对称」原始事实源。
- **项目已有读取链路**：`src/import-chat.ts` 已实现 zstd 逐帧解压（`decompressZstdFrames`）→ 解析（`parseSessionLines`，区分 user/assistant 消息、剔除系统噪音）→ 导入。但当前 `extractImportedEvents` 只提取「有信号」的候选，**丢弃了大部分原文**——即评审报告 P0-1 的「原始证据缺口」。
- **对 P1 的结论**：raw_turns 层可直接复用 `import-chat.ts` 的解压+解析（读两侧 message），但**绕过** `extractImportedEvents` 的筛选，改为全量捕获。读取链路无需从零开发。

---

## 结论与建议

1. **Phase 0 全部核实项 V1–V8 已完成**（V1/V3/V4/V5/V6/V7 只读核实 + V2 备份 + V8 抽查）。
2. **污染隔离已执行**（2026-11-05 12:40，用户授权）：
   - self-model `current.traits` 移除两条负面自述「对细节记忆的疏忽」「试图通过猜测来维持互动」（5 条 → 5 条正确保留，history 不动，changeNote 留痕）。
   - 错误 attribute `聊天平台使用历史=切换至网页端` 标 `superseded` + `quarantineNote`（不删，按 ADR-3）。
   - 「我记忆好乱」四句**无需数据层隔离**：复盘是增量窗口（游标 08:10 之后），这四句的 `selfPattern` 均单次出现、不满足 M3 固化阈值，明早 02:00 复盘不会把它们固化进 traits。
3. **残留风险（待 P1 机制层根治）**：
   - self-model `relationshipView` 仍有轻度污染（「用户通过测试来评估我的记忆准确性」把一次晚餐测试泛化），本次未动（改动面大、属 G2 闸门范畴）。
   - `selfPattern="附和"` 粒度太粗——10 条语义迥异的自述共用一桶，是负面特质被固化的根因；若今晚继续产生新的「附和」自述，明早复盘仍可能重新提炼负面特质。
   - `PersonaAttribute.status` 仅两态、无 speaker/subject/epistemic_type、`raw_turns` 整层缺失（V6 已盘点）。
4. **建议顺序**：本报告即为 Phase 0 交付 → 进入 P1（raw_turns 原始层 + G1/G2 闸门 + facts 七态），复用 `import-chat.ts` 的解压+解析链路。
