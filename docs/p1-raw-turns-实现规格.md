# P1 raw_turns 原始层 · 实现规格

> 依据《记忆架构最终设计 v1.0》§10 迁移计划 P1 行 + §4.1 数据模型。
> 状态：待用户确认后实施。本规格只描述 P1，不越界做 P2 闸门 / P3 schema。

---

## 0. 目标与边界

**目标**：新增 append-only 的 `raw_turns` 原始层，每轮对话**最先**落库，作为"谁在何时说过什么"的唯一原始事实源，修复 P0-1「原始证据缺口」（用户话语大量不落库）。

**边界（P1 红线）**：
1. **只写不读**——P1 阶段 raw_turns 不接入任何注入/检索路径（切读留到 P4 装配器）。
2. **events 双写保留**——现有 `handleUserMessage` / `handleAssistantMessage` 行为一字不动。
3. **最小改动**——不重构现有 EventLog / 注入 / 复盘代码；新增独立模块，停写即回滚。

**验收（§10 P1 行）**：
- 新轮次 user + assistant 消息 **100%** 落 raw_turns；
- 旧路径行为不变（events 提取、注入、复盘照旧）；
- 回滚 = 移除捕获调用一行（或 feature flag 关停），天然安全。

---

## 1. 数据模型（`src/types.ts` 新增）

对齐设计 §4.1。新增 `RawTurn` 接口与 `RawSpeaker` 枚举：

```ts
export type RawSpeaker = 'user' | 'assistant' | 'system' | 'tool';

export interface RawTurn {
  /** 全局稳定 ID，'rt-' 前缀 */
  event_id: string;
  /** 会话定位：DSH session id */
  session_id: string;
  /** 轮次定位：turn 号（不可得时为 ''，未知显式空串而非伪造） */
  turn_id: string;
  /** 谁在说 */
  speaker: RawSpeaker;
  /** 原话全文（不用摘要替代）；附件/工具载荷另列于 payload */
  raw_text: string;
  /** 话语实际发出时间（含时区，ISO） */
  asserted_at: string;
  /** 系统获知并写入时间（ISO） */
  ingested_at: string;
  /** 内容哈希（sha256 raw_text），谱系定位用；非真实性证明 */
  content_hash: string;
}
```

**设计约束落地**：
- `event_id` 用 `data.id`（DSH 消息自带 id，跨重启可溯源）优先；无 id 时退化为 `rt-${store.makeId()}`。
- `turn_id` 不可得时**显式空串**，禁止伪造（§0.3 红线 3：未知字段显式 unknown）。
- 禁止修改与删除（除 ADR-4 授权删除，P1 不实现）。

---

## 2. 字段映射（session/event → RawTurn）

实时入口事件形状（已核实，见 index.ts:1060 与 extract.ts:267/535）：
`{ type: string, data: Record<string, unknown>, time?: number }`

| RawTurn 字段 | 来源 | 规则 |
|---|---|---|
| `speaker` | `type` | `user/message`→user；`assistant/message`→assistant；`system/message`→system；`tool/call`、`tool/result`→tool；其余（turn/step/request/session/title/agent-inbox 等）**跳过** |
| `raw_text` | 见下 | 四类各自的原文提取 |
| `asserted_at` | `time`（number 毫秒） | `new Date(time).toISOString()`；缺失用 `new Date().toISOString()` |
| `ingested_at` | 写入时刻 | `new Date().toISOString()` |
| `content_hash` | `raw_text` | `node:crypto` sha256，hex |
| `event_id` | `data.id` | user：`data.id`；assistant：`data.message.id`；无则 `rt-${makeId()}` |
| `session_id` | session 对象 | 见 §5 待确认点 |
| `turn_id` | turn 事件/计数器 | 见 §5 待确认点 |

**raw_text 提取（四类）**：
- **user/message**：仅 `data.source.kind === 'user'` 才捕获（`source.kind` 非 user 的是 DSH 运行时上下文注入，跳过）；取 `data.content[]` 中 `type==='text'` 块的 `text` join。
- **assistant/message**：复用 `assistantTextFromBlocks` 语义——从 `data.message.content[]` **从后往前**取第一条 `type==='text'` 块（跳过 reasoning/tool_call/thinking），得到 AI 的**表达**原文（不含思考过程）。
- **system/message**：`data.content[]` 的 text 块 join。
- **tool/call** / **tool/result**：`JSON.stringify(data)`（载荷原文，审计用）。

> 注：过滤「运行时上下文注入」的理由——raw_turns 回答"谁在何时说过什么"，机制注入（`current runtime context` 等）不是"谁说的"，与现有 `isExtractableUserMessage` 的过滤口径一致。

---

## 3. 存储（新建 `src/raw-turn-log.ts`）

复用 `EventLog`（`src/event-log.ts`）的按月分片 JSONL 追加模式，但**独立成类**（零改动现有 EventLog）：

- 分片目录：`raw-turns/`（store root 下），文件名 `YYYY-MM.jsonl`，`manifest.json` 记录月份。
- 写路径：`store.appendText()` 追加（O_APPEND 语义，与 EventLog 一致）。
- `RawTurnLog` 方法：
  - `append(turn: RawTurn): Promise<void>` —— 按月分片追加 + 更新 manifest + 维护内存 cache；
  - `list(): Promise<RawTurn[]>` —— 供测试/审计读（P1 生产热路径**不调用**）。

**为什么独立类而不是参数化 EventLog**：P1 原则是"最小改动、旧路径不变"。EventLog 承载 events 的生产读写，参数化重构会引入回归风险；raw_turns 未来可能需要不同字段与谱系删除逻辑，独立类便于演进。

---

## 4. 捕获入口（`src/index.ts`）

**唯一改动点**：`ctx.on('session/event', ...)`（index.ts:1060），在三个现有 handler **之前**插入捕获：

```ts
ctx.on('session/event', (session, event) => {
  void captureRawTurn(session, event);   // ← 新增，最优先
  void handleUserMessage(event);
  void handleAssistantMessage(event);
  void observeToolEvent(event);
});
```

`captureRawTurn` 实现要点：
- 整个函数体 try/catch 吞异常（旁路捕获，任何失败不得让主链路崩——与 handleUserMessage 同风格）。
- 按 §2 映射构造 RawTurn，仅对四类 speaker 落库，其余静默返回。
- 写入失败仅 `ctx.logger.warn`，不重试不抛出。

---

## 5. 待确认点（P1-0 预检结论 · 已确认）

以下两点已从 DSH 源码查证（非打印猜测），来源见每条括号内文件路径。

### 5.1 `session_id` —— 已确认：`session.id`（string）

`ctx.on('session/event', (session, event))` 的第一个参数是 `dsh-session` 的 `Session` 实例
（`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:1324`）。

- `session.id` 是 getter：`get id() { return this.header.id; }`（同文件 :1344），返回**字符串**（durable header 的单一份身份）。
- 广播时 `callbackArgs = [this, event]`（:1584），即回调第一参就是 Session 实例本身。
- 结论：`session_id` 直接取 `session.id`（string），**无降级**。若运行环境中该字段缺失（理论上的防御分支），降级为 `''` 并 warn，禁止编造。

### 5.2 event 顶层字段 —— 已确认：含 `time`（number 毫秒）与 `seq`（number），**无 `turn`**

`dsh-session` 在 `append()` 里构造并 `deepFreeze` 事件信封（同文件 :1528-1534）：

```js
const event = deepFreeze({
  type,                       // string
  seq: SessionSeq(this.log.length), // number（会话内单调递增序号）
  time: Date.now(),           // number，毫秒时间戳
  data: dataSnapshot,         // Record<string, unknown>
  ...surfaceMetadataSnapshot  // 可选：sourceEventSeqs / surfaceOp
});
```

- **`asserted_at` 来源已确认**：`event.time`（number 毫秒）→ `new Date(time).toISOString()`。**无需降级**。
- **`turn_id` 不可得**：事件信封顶层**没有 `turn` 字段**，只有 `seq`。`turn` 只出现在部分事件的 `data` 内：
  - `assistant/message`、`system/message` 的 `data.turn` 是 number（`dsh-agent-loop/lib/index.js:1061/1157`）；
  - `user/message` 的 `data` 直接是 message 对象（`{role, content, source, id}`），**没有 `turn`**（同文件 :1072）。
  - 因为 user 侧拿不到统一的轮次号，`data.turn` 无法作为一致的"轮次定位"字段。
- 结论：`turn_id` 在 P1 **显式降级为 `''`**（未知显式空串，禁止伪造，§0.3 红线 3）。后续若要补真实轮次定位，需从 `seq` 或引入轮次计数器，P1 不做。

### 5.3 `event_id` 来源 —— 已确认：`data.id` / `data.message.id`

消息由 `dsh-llm` 的 `createMessage` 统一构造（`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js:37-41`），**每条消息自带 `id`**（`brandString(randomUUID())`）：

- `user/message`：`data` 即 message 对象 → `data.id`（string）。
- `assistant/message`：`data = { turn, step, message, ... }` → `data.message.id`（string）。
- `system/message`：`data = { turn, step, message }`（message 也有 id，但按 §2 表格 system 不映射 id，退化为 `rt-${makeId()}`）。
- `tool/call`、`tool/result`：无映射 id 来源 → `rt-${makeId()}`。

> 红线提醒：turn_id 的"降级为空串"已显式记录；session_id / asserted_at 均已从源码确证真实来源，禁止编造（§0.3 红线 3）。

---

## 6. 测试计划（`tests/`）

1. **映射单测**（纯函数）：`speakerOf(type)`、`rawTextOf(event)` 四类映射正确；运行时上下文注入（source.kind≠user）被跳过；assistant reasoning 块被跳过。
2. **RawTurnLog 追加单测**：`append` 后 `list()` 能读回；跨月分片正确；`event_id`/`content_hash` 稳定。
3. **集成断言**（可 mock session/event 序列）：一段 user→assistant→tool 序列，raw_turns 捕获 user+assistant+tool 三类，events 提取路径仍产出既有事件。
4. **回归**：现有 events / 注入 / 复盘测试全部保持绿（旧路径不变）。

---

## 7. 回滚

- 停写 = 删除 `void captureRawTurn(session, event)` 一行（或关 feature flag），raw_turns 目录停止增长，其余零影响。
- raw_turns 数据是纯新增文件，删除目录即物理回滚（P1 阶段不涉及读，无依赖）。

---

## 8. 分步实施清单

| 步 | 内容 | 产出 |
|---|---|---|
| P1-0 | §5 两个预检（打印 session 结构与 event 顶层字段） | 字段映射定稿 |
| P1-1 | `types.ts` 新增 RawTurn / RawSpeaker | 类型 |
| P1-2 | 新建 `src/raw-turn-log.ts` | 存储 |
| P1-3 | `index.ts` 新增 `captureRawTurn` + 挂到 session/event 首位 | 捕获入口 |
| P1-4 | `tests/` 补映射/存储/集成/回归测试 | 测试 |
| P1-5 | `npm test` + `npm run build` 全绿；在真实 QQ 会话实测一轮，确认 raw-turns/ 落库 | 验收 |

---

## 9. 与后续阶段的衔接（本规格不做，仅记）

- **P2**：复盘 G1 取材从 raw_turns 取原始证据（复用 import-chat 解压/解析）；G2/G3 闸门。
- **P3**：events 的 `sourceEventIds` 指向 raw_turns `event_id`；facts/self_model 补齐 speaker/subject/时间五元组。
- **P4**：装配器 shadow，按意图读 raw_turns→events→facts。
