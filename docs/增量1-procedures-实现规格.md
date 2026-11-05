# 增量1 procedures 层 实现规格

> 依据：《dsh-memory-architecture-final-design.md》v1.1 §16.1（增量1）+ §4.4（晋升门槛）+ §4.7（七态状态机）。
> 红线（最高优先级）：procedures **只能长出来、不能写进去**——必须是 AI 从自身经历归纳的做法，绝不预设行为规则/角色卡/话术。

## 0. 目标与范围

新增 `procedures` 程序性记忆层（六层之外补上 CoALA 的"程序"一类），复用 facts 的字段/七态/evidence_group 机制。**只写不读**：procedures 落库，但不接入注入/检索（注入留 P4 装配器）。

**本轮做**：① types 加 `PersonaProcedure`/`ProceduresFile`；② 新建 `src/procedures.ts`（存储 + 提炼候选校验）；③ `review.ts` 加 procedures 提炼步骤（新 LLM prompt）+ 落库（默认 `candidate`）；④ 晋升闸门 `decideProcedurePromotion`（保守近似，默认冻结）。

**明确不做**：不接注入（P4）；不预设任何 procedure 种子；不改 facts/self_model 现有逻辑。

## 1. 红线如何落地（可执行的约束）

1. **强制证据**：每条 procedure 的 `sourceEventIds` 必须非空且全部真实存在于 events（复用 `memory-facts.ts` 的 `checkIds`）。无证据 = 预设脚本 → 整条丢弃。
2. **认识论强制**：`epistemicType` 固定 `'ai_inference'`（她归纳的），不可由 LLM 指定为别的值。
3. **默认 candidate**：新 procedure 一律 `candidate`，不直接 `active`。
4. **晋升门槛**：`candidate → active` 须过 `decideProcedurePromotion`（§4.4 的保守近似，见 §4）；单日窗口下恒 false，等于默认冻结（与 P2 traits 一致，ADR-2 刻意设计）。
5. **禁止祈使句**：trigger/action/rationale 过 `stripMemoryFact` 严口径门禁；prompt 约束用描述性陈述（"我会先澄清再展开"），不用祈使句（"你应该先澄清"）。

## 2. 改动点 1：`src/types.ts`

新增类型：

```ts
/** 程序性记忆（procedure）：她从经历归纳的"遇到什么情况、怎么做"（§16.1 增量1） */
export interface PersonaProcedure {
  /** 'pr_' + 稳定哈希（由 trigger 推导，同 trigger 跨天合并） */
  id: string;
  /** 情境：遇到什么情况（描述性，非祈使句） */
  trigger: string;
  /** 做法：她怎么做（描述性，非祈使句） */
  action: string;
  /** 依据：为什么这样做（指向具体经历） */
  rationale: string;
  /** 谁提出（固定 'assistant'，她自己的做法） */
  speaker: string;
  /** 认识论类型（固定 'ai_inference'，红线） */
  epistemicType: EpistemicType;
  /** 七态（默认 candidate，红线） */
  status: FactStatus;
  confidence: number;
  /** 证据链：她经历的事件 id，非空且真实（红线） */
  sourceEventIds: string[];
  evidenceGroupId?: string;
  assertedAt?: string;
  ingestedAt?: string;
  validFrom?: string | null;
  validTo?: string | null;
  statusChangedAt?: string;
  firstSeenAt: string;
  updatedAt: string;
  /** 取代它的新 procedure id（做法演化时） */
  supersededBy?: string;
  supersededAt?: string;
}

/** procedures 存储文件 */
export interface ProceduresFile {
  version: 1;
  procedures: PersonaProcedure[];
}
```

## 3. 改动点 2：新建 `src/procedures.ts`

复用 `memory-facts.ts` 的存储与校验模式（不 import 具体实现以避免耦合，按需 import 纯函数）：

- `procedureId(trigger: string): string` —— `stableId('pr_', normalizeFactKey(trigger))`（同 trigger 跨天合并；`stableId`/`normalizeFactKey` 从 `memory-facts.js` import）。
- `ProcedureStore` 类：
  - 构造 `(store: KVStore)`，路径 `memory/procedures.json`。
  - `loadProcedures(): Promise<FactLoad<PersonaProcedure>>`（复用 `readList` 三态语义 + `isProcedureShaped` 结构校验）。
  - `saveProcedures(procedures): Promise<void>`（`writeTextAtomic`）。
- `isProcedureShaped(v): v is PersonaProcedure`：id/trigger/action/rationale/speaker 为 string、status 七态合法、epistemicType 三态合法、sourceEventIds 为数组。
- `RawProcedureCandidate`：LLM 输出的不可信候选（trigger/action/rationale/sourceEventIds 全 unknown）。
- `deriveProcedures(input)` 纯函数（无 I/O，可单测）：
  - `input = { raw, knownEventIds, existingProcedures, eventTimes?, now }`。
  - 逐候选：trigger/action/rationale 非空 + 过 `stripMemoryFact` 门禁（含祈使句丢弃）→ sourceEventIds `normalizeIds` + `checkIds`（非空 + 真实）→ 合并（同 id 更新，否则新建 candidate）。
  - 新建：`status: 'candidate'`、`speaker: 'assistant'`、`epistemicType: 'ai_inference'`、`confidence: 0.5`、`ingestedAt/statusChangedAt: now`、`assertedAt: latestEventTime(ids, eventTimes)`、`evidenceGroupId: evidenceGroupId(ids)`、`firstSeenAt/updatedAt: now`。
  - 更新：同 id 时，若 trigger 相同则更新 action/rationale（允许做法细化）、合并 sourceEventIds、`updatedAt: now`；**status 不变**（candidate 仍是 candidate，晋升走闸门）。
- `emptyProcedureStats` / drop 计数（复用 FactDropReason 口径，或简化）。

## 4. 改动点 3：晋升闸门

新建 `src/procedure-promotion.ts`（或并入 `src/promotion.ts`）：

```ts
/** procedure 晋升判定（§4.4 保守近似）：candidate → active 须跨 ≥2 个日期 */
export function decideProcedurePromotion(
  candidate: PersonaProcedure,
  eventTimes?: ReadonlyMap<string, string>,
): PromotionDecision {
  const days = new Set<string>();
  for (const id of candidate.sourceEventIds) {
    const t = eventTimes?.get(id);
    if (t) days.add(t.slice(0, 10));
  }
  if (days.size >= 2) return { promote: true, reason: `跨 ${days.size} 个日期，做法稳定` };
  return { promote: false, reason: `证据仅 ${days.size} 个日期，不足 2，保持 candidate` };
}
```

> 与 traits 的 `decidePromotion` 一致：单日复盘窗口下恒 false → procedures 默认冻结在 candidate，等跨日期累积后自动晋升。这是 ADR-2「默认冻结」的刻意设计，不追求即时晋升。

## 5. 改动点 4：`src/review.ts`

1. 新增 `PROCEDURE_PROMPT`（中文模板，固定 JSON 输出）：
   ```
   你是反思端模型。从当日事件里，归纳"你自己遇到什么情况、是怎么做的"，只输出 JSON。
   格式：{"procedures":[{"trigger":"遇到什么情况（描述性）","action":"你怎么做（描述性）","rationale":"为什么这样做","sourceEventIds":["事件id"]}]}
   trigger/action/rationale 必须用描述性陈述（如"当用户问开放问题时，我会先澄清再展开"），禁止祈使句（"你应该…"、"提醒用户…"）。
   只能归纳你自己（assistant）的做法，不能把用户的要求写成你的做法，不能预设任何行为规则。
   sourceEventIds 必须逐字取自下面列出的事件 id，不要编造；没有可归纳的就输出 {"procedures":[]}。
   ```
2. 在 `run()` 里、`extractThreadsAndAttributes`（step4.5）之后、P2 晋升闸门之前，加 procedures 提炼（LLM #5，单独计 `cost.procedureCalls`）：
   ```ts
   out.procedures = await this.extractProcedures(input.events, { allEvents: input.allEvents });
   ```
3. `extractProcedures` 方法（仿 `extractThreadsAndAttributes` 的失败姿态）：
   - `imported` 事件不参与（补记忆不补成长）。
   - 读不到既有 procedures → 不写盘。
   - LLM 非 JSON → 不写盘。
   - `deriveProcedures` 产出后，对每条 candidate 跑 `decideProcedurePromotion`（eventTimes 映射从 allEvents 构造），达标者 `status='active'` + `statusChangedAt=now`，否则保持 candidate。
   - 落盘 + 返回 stats（proceduresCreated/proceduresUpdated/proceduresPromoted/dropped）。
4. `ReviewOutput` 加 `procedures?: ProcedureStats`、`cost` 加 `procedureCalls: number`（`types.ts`）。

## 6. 测试（新增 `tests/procedures.test.mjs`）

1. procedureId 同 trigger 稳定、异 trigger 区分。
2. isProcedureShaped：合法通过、非法 status/epistemicType 拒绝。
3. deriveProcedures：新建 candidate（epistemicType=ai_inference、speaker=assistant、status=candidate）；sourceEventIds 为空/未知 → 丢弃；含祈使句 → strip 丢弃。
4. decideProcedurePromotion：单日 → false、跨 2 日期 → true、eventTimes 缺失 → false。
5. 同 trigger 跨天合并（更新 action/rationale 不新建第二条）。
6. `npm test` 全绿（现有 295 + 新增）。

## 7. 验收

- `npm run build` exit 0；`npm test` 全绿。
- procedures 落库为 candidate（非 active），epistemicType=ai_inference、speaker=assistant、evidenceGroupId/assertedAt 已填。
- 无证据/含祈使句的 procedure 被丢弃（红线可证）。
- 不接注入（grep 确认 `procedures` 未出现在 recall.ts/index.ts 注入路径）。
- git 提交，报告 commit hash 与用例数。
