# P3 schema 实现规格

> 依据：《dsh-memory-architecture-final-design.md》v1.1 §4.3（facts 七态 + 字段）、§4.8（五时间戳 + 规则 6）、§10 迁移计划 P3 行、Phase 0 报告 V6（字段差距盘点）。
> 性质：additive schema 补齐 + 两处语义修正。**不改动 status 的写入语义**（保持现有 active/superseded 逻辑），只扩类型、补字段、修 lastMentionedAt。

## 0. 目标与范围

P3 是最小可落地子集（P3a）：立 schema 骨架，为增量1/2 提供 `evidence_group_id` 前置。**明确不做**（防止过度扩大）：

- ❌ 不改 status 写入语义：本轮不引入 candidate/disputed/retracted/expired 的写入触发（留给增量1/2 + G2 完整化）。
- ❌ 不动 self_model 的 traits 结构化（那是 self_model 层的事，后续增量）。
- ❌ 不动 events 层的 speaker 字段（P3b，另列）。
- ❌ 不改注入/装配路径（P4）。

**本轮做**：① facts 七态类型 + 字段骨架；② evidence_group_id 稳定推导；③ assertedAt/ingestedAt/statusChangedAt 填充；④ speaker/epistemicType 从事件 provenance 推导；⑤ lastMentionedAt 只由真实提及计算（§4.8 规则 6）。

## 1. 改动点 1：`src/types.ts`

新增两个类型 + 扩展 PersonaAttribute：

```ts
/** facts 七态状态机（§4.7） */
export type FactStatus =
  | 'candidate' | 'active' | 'quarantined' | 'disputed'
  | 'superseded' | 'retracted' | 'expired';

/** 认识论类型（§4.3）：谁以何种方式提出该主张 */
export type EpistemicType = 'direct_observation' | 'user_statement' | 'ai_inference';
```

`PersonaAttribute` 改动：
- `status: 'active' | 'superseded'` → `status: FactStatus`。
- 新增（全 optional，缺省视为 unknown）：
  ```ts
  /** 谁提出该主张（§4.3 speaker；'user' | 'assistant' | 'system' | 'tool'，未知留空） */
  speaker?: string;
  /** 说谁/说什么（§4.3 subject；禁止由 speaker 推断，未知留空） */
  subject?: string;
  /** 最小结构化主张的谓词（§4.3 predicate；本轮不推导，留空） */
  predicate?: string;
  /** 认识论类型（§4.3；从事件 provenance 推导，见 §3） */
  epistemicType?: EpistemicType;
  /** 何时说的（§4.8；= 最新 sourceEvent 的 time，不可得留空） */
  assertedAt?: string;
  /** 系统何时写入（§4.8；= 派生时刻） */
  ingestedAt?: string;
  /** 内容所指有效区间（§4.8；本轮不推导，null=未知） */
  validFrom?: string | null;
  validTo?: string | null;
  /** 系统何时改变该版本状态（§4.8；写入时 = ingestedAt） */
  statusChangedAt?: string;
  /** 同源去重标识（§4.9；从 sourceEventIds 稳定推导，见 §3） */
  evidenceGroupId?: string;
  ```
- 保留现有字段：id/key/value/confidence/sourceEventIds/firstSeenAt/updatedAt/supersededBy/supersededAt。

`PersonaThread` 无字段改动（lastMentionedAt 语义修正只改计算方式，不改类型）。

## 2. 改动点 2：`src/memory-facts.ts`

### 2.1 `isAttributeShaped`（约 198 行）

status 校验从两态扩为七态：
```ts
const FACT_STATUSES: ReadonlySet<string> = new Set([
  'candidate', 'active', 'quarantined', 'disputed',
  'superseded', 'retracted', 'expired',
]);
// isAttributeShaped 里： FACT_STATUSES.has(a.status) 替代 (a.status === 'active' || a.status === 'superseded')
```
其余 shape 校验不变（旧两态数据天然通过七态校验，向后兼容）。

### 2.2 `DeriveInput` 扩展（约 280 行）

新增两个 optional 映射：
```ts
export interface DeriveInput {
  /* 现有字段不变 */
  /** eventId → 该事件 ISO time（lastMentionedAt/assertedAt 修正用；缺省回退 now） */
  eventTimes?: ReadonlyMap<string, string>;
  /** eventId → 该事件 provenance（speaker/epistemicType 推导用；缺省留空） */
  eventProvenances?: ReadonlyMap<string, Provenance>;
}
```
（需在文件顶部 import `Provenance` 类型。）

### 2.3 新增纯函数 `evidenceGroupId`

```ts
/**
 * 同源去重标识（§4.9）：同一组 sourceEventIds（忽略顺序）→ 同一 group。
 * 最小语义：完全相同的来源集合归为一组。部分重叠的"部分同源"留给后续。
 */
export function evidenceGroupId(sourceEventIds: readonly string[]): string {
  return stableId('eg_', [...sourceEventIds].sort().join('|'));
}
```

### 2.4 新增纯函数 `inferSpeakerEpistemic`

```ts
/** provenance → (speaker, epistemicType)。inferred 的 speaker 无法可靠归属，留空。 */
export function inferSpeakerEpistemic(p: Provenance): { speaker?: string; epistemicType?: EpistemicType } {
  switch (p) {
    case 'user_direct': return { speaker: 'user', epistemicType: 'user_statement' };
    case 'self_direct':
    case 'self_correction':
    case 'induced': return { speaker: 'assistant', epistemicType: 'ai_inference' };
    case 'tool_output':
    case 'retrieved_content': return { speaker: 'tool', epistemicType: 'direct_observation' };
    case 'inferred': return { speaker: undefined, epistemicType: 'ai_inference' };
  }
}
```

### 2.5 `deriveMemoryFacts` 改造

**threads 分支（约 440-481 行）**：lastMentionedAt 只由真实提及计算（§4.8 规则 6）。
- 新增辅助：`latestEventTime(ids, eventTimes): string | undefined`——取 ids 对应事件里 `Date.parse` 最大的 time；任一 id 不在映射或映射缺失 → 回退 `now`。
- 新建 thread：`lastMentionedAt: latestEventTime(ids, input.eventTimes) ?? now`（替换原 `now`）。
- 更新 thread：`existing.lastMentionedAt = latestEventTime(ids, input.eventTimes) ?? now`（替换原 `now`）。
- **注意**：`mentionCount`/`sourceEventIds` 合并逻辑不变；`expireStaleThreads` 用 lastMentionedAt 收敛，语义随之修正（30 天未真实提及才过期），无需改 expireStaleThreads。

**attributes 分支（约 487-558 行）**：
- 派生 `latest`（最新事件 id）与 `se`（speaker/epistemicType）：
  ```ts
  const latestId = latestEventId(ids, input.eventTimes);   // 最新事件 id，无映射 undefined
  const latestProv = latestId ? input.eventProvenances?.get(latestId) : undefined;
  const se = latestProv ? inferSpeakerEpistemic(latestProv) : {};
  ```
- 新建 attribute 时填充新字段：
  ```ts
  attributes.push({
    id, key, value, status: 'active', confidence, sourceEventIds: [...ids],
    firstSeenAt: now, updatedAt: now,
    speaker: se.speaker,
    epistemicType: se.epistemicType,
    assertedAt: latestEventTime(ids, input.eventTimes),   // 无映射 undefined
    ingestedAt: now,
    statusChangedAt: now,
    validFrom: null, validTo: null,
    evidenceGroupId: evidenceGroupId(ids),
  });
  ```
- 更新既有 attribute（same 分支）：同步刷新 `updatedAt`、`ingestedAt`、`assertedAt`（若有更新）、`evidenceGroupId`（若 sourceEventIds 变化）、`speaker/epistemicType`（若有更新）。**confidence 提值逻辑不变**。
- superseded 分支（同 key 旧条被取代）：旧条 `status='superseded'` 时同步 `statusChangedAt = now`；其余不变。
- **明确不做**：不改变"新写入 = active、同 key 取代 = superseded、同 value 复活 = active"这套现有语义。

### 2.6 新增辅助 `latestEventId`

```ts
function latestEventId(ids: readonly string[], eventTimes?: ReadonlyMap<string, string>): string | undefined {
  if (!eventTimes || ids.length === 0) return undefined;
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const t = eventTimes.get(id);
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = id; }
  }
  return best;
}
```
（`latestEventTime` 同法，返回 time 字符串。）

## 3. 改动点 3：`src/review.ts` `extractThreadsAndAttributes`（约 218-285 行）

在构造 `deriveMemoryFacts` 前，从 `allEvents` 构造两个映射并传入：
```ts
const all = opts.allEvents ?? (await new EventLog(this.deps.store).load());
knownEventIds = new Set(all.map((e) => e.id));
const eventTimes = new Map(all.map((e) => [e.id, e.time]));
const eventProvenances = new Map(all.map((e) => [e.id, e.provenance]));
// ...
const derived = deriveMemoryFacts({
  raw: parsed as RawMemoryFactOutput,
  knownEventIds,
  existingThreads: threadsLoaded.items,
  existingAttributes: attributesLoaded.items,
  now,
  eventTimes,
  eventProvenances,
});
```
（`all` 变量当前作用域覆盖到 deriveMemoryFacts 调用点，无需重读。）

## 4. 迁移兼容

- 现有 `memory/attributes.json` 两态 status（active/superseded）是七态子集，`isAttributeShaped` 七态校验直接通过，无需数据迁移。
- 旧数据无新字段 → 读取时字段为 undefined（unknown），符合"unknown 计为齐全"。
- 现有 `memory/threads.json` 的 lastMentionedAt 是派生时刻（旧语义），本轮不改存量数据，只在**新写入**时用真实提及时间。存量 thread 的 lastMentionedAt 会在下次被真实提及时刷新。

## 5. 测试（`tests/memory-v06.test.mjs` 或新增 `tests/p3-schema.test.mjs`）

1. 七态 status：`isAttributeShaped` 接受七个合法 status、拒绝非法 status。
2. evidenceGroupId：同 sourceEventIds 不同顺序 → 同 group；不同 sourceEventIds → 不同 group。
3. inferSpeakerEpistemic：user_direct→user/user_statement；self_direct→assistant/ai_inference；inferred→(无 speaker)/ai_inference。
4. lastMentionedAt 修正：thread 的 lastMentionedAt = 最新 sourceEvent 的 time（构造 eventTimes 注入，断言不再是 now）。
5. attribute 新字段：deriveMemoryFacts 产出含 assertedAt/ingestedAt/evidenceGroupId/epistemicType/speaker。
6. 迁移兼容：旧两态数据 load 通过；无 eventTimes/eventProvenances 时回退旧行为（lastMentionedAt=now、新字段 undefined）。
7. 既有测试不回归：`npm test` 全绿（现有 288 + 新增用例）。

## 6. 验收

- `npm run build` exit 0（类型全绿，含新增 FactStatus/EpistemicType/字段）。
- `npm test` 全绿。
- `deriveMemoryFacts` 产出的 attribute 含 evidenceGroupId/assertedAt/ingestedAt/statusChangedAt/speaker/epistemicType。
- thread 的 lastMentionedAt 由真实提及时间计算（注入 eventTimes 可证）。
- 现有 status 写入语义不变（新=active、取代=superseded、复活=active）。
- git 提交，报告 commit hash 与用例总数。
