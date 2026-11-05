# 增量4 salience 第二职责 实现规格

> 依据：《dsh-memory-architecture-final-design.md》v1.1 §16.4（增量4）。
> 红线：salience 永不触碰 status/confidence/有效期（只影响"先看谁"，不影响"谁是真的"）。

## 0. 目标与范围

salience 在"展示排序"（recall.ts `salienceScore` 已有）之外承担第二职责。三职责中，本轮**只做①巩固优先级降采样**；③检索预算、②冷热分层本轮不做（理由见 §0.1）。

### 0.1 本轮做 / 不做

**本轮做**：①巩固优先级降采样——复盘派生（threads/attributes/procedures）喂给 LLM 的事件窗口，从"时间序取最近 N 条"改为"按 salience 降序取 top-N"，防止停机多日后窗口超限时，简单 `slice(-N)` 把高 salience 长尾事件挤出。

**本轮不做**（延后，理由）：
- ③检索预算分配：与 P4 装配器（assembler.ts 按意图预算分配）边界重叠，需厘清"salience 驱动预算"与"意图驱动预算"的分工，留待 P4 切读后的检索增强阶段（与 P5 索引一起）。
- ②冷热分层：event-log/raw-turn-log 存储分代改造，风险最高、无硬性验收阈值（§11.2 只要求"报告磁盘量"），当前数据规模 footprint 未成瓶颈，留作独立存储优化单元单独评估可逆性。

## 1. 改动点：`src/review.ts`

### 1.1 现状（两处相同写法）

```ts
// extractThreadsAndAttributes（约 285 行）与 extractProcedures（约 371 行）：
const listing = source
  .slice(-MAX_FACT_EVENTS)   // 时间序取最近 60 条
  .map((e) => `- [${e.id}] (${e.topic}) ${e.summary}`)
  .join('\n');
```

`slice(-MAX_FACT_EVENTS)` 的问题：`source` 已是按时间升序（`events.sort` 时间升序），取末尾 60 条 = 最近 60 条。停机多天后窗口内事件远超 60 条时，更早但 salience 高的事件（重要、高重要性、来源可信）被最近 60 条低 salience 杂事挤掉。

### 1.2 改为 salience 降采样

```ts
// 复用 recall.ts 已导出的 salienceScore（来源权重 × 重要性 × 时间衰减）。
// salienceScore 本身已含 recencyFactor 时间衰减，故按 salience 降序天然平衡"近因"与"重要"：
// 近期事件 recency 高、salience 高；重要事件 importance 高、salience 高。
const sampled = sampleBySalience(source, MAX_FACT_EVENTS, nowMs);
const listing = sampled
  .map((e) => `- [${e.id}] (${e.topic}) ${e.summary}`)
  .join('\n');
```

### 1.3 新增辅助函数（放 `src/review.ts` 私有，或 `src/recall.ts` 导出）

```ts
/** salience 降采样：按 salience 降序取 top-limit，再按时间升序恢复时序（LLM 看到的时间序不变）。 */
export function sampleBySalience(
  events: readonly PersonaEvent[],
  limit: number,
  nowMs: number,
): PersonaEvent[] {
  return events
    .slice()
    .sort((a, b) => salienceScore(b, nowMs) - salienceScore(a, nowMs))
    .slice(0, limit)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
```

放在 `src/recall.ts`（与 salienceScore 同源，便于单测与复用），`review.ts` import。确认无环：recall.ts 只 import types/provenance/time，不 import review.ts。

### 1.4 `nowMs` 来源

`extractThreadsAndAttributes` / `extractProcedures` 里已有 `now`（ISO 字符串）。降采样需要毫秒，用 `Date.parse(now)`（now 由调用方注入或 `new Date().toISOString()`，可解析）；解析失败回退 `Date.now()`。

## 2. 测试（`tests/salience-sample.test.mjs` 或并入 recall 测试）

用 mock 事件测 `sampleBySalience` 纯函数：
1. 事件数 ≤limit → 全保留，且时间升序不变。
2. 事件数 >limit，存在"较早但 importance 高"的事件 → 该高 salience 事件被保留、最近的某条低 salience 事件被挤出。
3. 降采样结果时间升序（时序不变）。
4. limit=0 → 空数组不抛错。
5. `salienceScore` 时间衰减起作用：两条同 importance 事件，更近的排更前。

## 3. 验收

- `npm run build` exit 0；`npm test` 全绿（331 既有 + 新增 salience 用例）。
- `extractThreadsAndAttributes` / `extractProcedures` 两处 `slice(-MAX_FACT_EVENTS)` 都改为 `sampleBySalience`。
- `sampleBySalience` 纯函数、可单测，降采样后时间序不变。
- 红线不破：只改"喂给 LLM 的窗口选择"，不触碰任何 status/confidence/有效期，不改变写入逻辑。
- git 提交，报告 commit hash 与用例数。
