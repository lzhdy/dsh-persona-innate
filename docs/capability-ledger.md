# 能力台账（capability ledger）

> **本文件由 `node scripts/audit-capabilities.mjs --write` 生成，不要手工编辑。**
> 唯一真相是脚本里的 `ITEMS` 数组：改功能就在同一个 commit 里改它。

## 为什么要有这个台账

这个项目三次栽在同一类缺陷上：机制写好了、测试全绿，但**没有任何调用点**。

- `retentionPriority()` 实现了，零调用 → 遗忘机制从未生效；
- `initiation` 字段、落盘、O17 降级复盘全都写了，三个 `addEvent` 调用点无一传入 → 责任归因永远靠启发式；
- `bypassDecision()` / `renderUncertainty()` 只有单测 → 诚实基线运行时不存在。

这类缺陷的共性是：**测试直接调函数，所以测试通过；真实链路绕开函数，所以线上为零。**
读代码也看不出——定义和调用长得一样。

因此台账不是文档，是可执行断言：`status=done` 的条目必须在定义文件之外找到调用点，
否则 `npm run audit` 直接失败。**把状态写成 done 本身就是一个要拿代码兑现的承诺。**

## 当前状态

| 里程碑 | 功能 | 状态 | 接线检查 | 备注 |
|---|---|---|---|---|
| M0 | events 记忆（按月分片追加） | ✅ 已实现 | ✅ 有调用点 | events/YYYY-MM.jsonl，写入 O(1) |
| M0 | provenance 显著性权重（提不提） | ✅ 已实现 | ✅ 有调用点 | 七类来源枚举 + 显著性权重已接线（v0.5 起 recall 用 SALIENCE_WEIGHT，不再用 PROVENANCE_WEIGHT） |
| M0 预留 | provenance 可信度权重（能不能当事实） | 🟡 半接 | — | PROVENANCE_WEIGHT 只被 provenance.ts 内的 recallScore() 消费，而 recallScore 生产零调用（唯一调用点 tests/m0.test.mjs:190）。保留原因：它仍是"可信度"口径的规范定义，且机制设计文档 v1.0.0 有 API 记录；要么接进留存/归档路径，要么在下次评审时删掉，不要一直挂着当门面 |
| M0 | 每轮记忆注入（五槽装配） | ✅ 已实现 | ✅ 有调用点 | order 150 |
| M0 | 先天画像采样 | ✅ 已实现 | ✅ 有调用点 |  |
| M1 | 每日复盘（游标协议） | ✅ 已实现 | ✅ 有调用点 | 0.5.2 修首次死锁；窗口 = 时刻区间 |
| M1 | self_model 版本化与历史 | ✅ 已实现 | ✅ 有调用点 |  |
| M1 | 自我模型注入 | ✅ 已实现 | ✅ 有调用点 | order 170 |
| M1 | 状态机（效价×唤醒 + 关系阶段） | ✅ 已实现 | ✅ 有调用点 | 0.5.0 把 decay 接进会话主链路 |
| M1 | 状态注入 | 🟡 半接 | 有命中（未声明完成） | 挂在 order 160（表达端），文档要求给评估端/状态机——对象错位未处置 |
| M1 | 成长档案 | ✅ 已实现 | ✅ 有调用点 | 真正落盘在 review.ts:432 的 appendGrowth；旧 witness 只匹配到 index.ts 里一句日志文案 |
| M1 | 漂移审计（/persona audit） | ✅ 已实现 | ✅ 有调用点 | 手动命令，非运行时门禁。旧 witness 匹配的是 /^audit$/i 这个无关字面量，改指向 eval.ts:308 定义、index.ts:1311 调用的真实符号 |
| M2 | 动机引擎（主动对话 / 主动提起记忆） | ❌ 零实现 | — | 文档 §275、里程碑 M2；src 零命中。主动性缺它就无法实施 |
| M2 | 平台期识别 | ❌ 零实现 | — | 验收要求：高频重复互动不误判为推进 |
| M2 | 失衡降频（人格自主性审计联动） | ❌ 零实现 | — |  |
| M0 预留 | initiation 责任归因（self/user/external） | 🟡 半接 | — | 类型/落盘/O17 降级复盘都写好了，但 index.ts 三个 addEvent 均未传；责任归因目前靠 provenance 启发式 |
| 未排期 | 遗忘三件套（衰减/压缩/物理删除） | 🟡 半接 | — | 函数已实现零调用；thread 30 天过期是目前唯一遗忘机制 |
| 未排期 | 诚实基线（三级旁路） | 🟡 半接 | — | 只有函数与单测，运行时无调用点 |
| 未排期 | PersonaFact 落盘 | ❌ 零实现 | — | 复盘 distillFacts 产出不持久化，注入只读 events 与 thread/attribute |
| 未排期 | attribute 注入消费者 | 🟡 半接 | — | loadAttributes 只用于复盘合并与 /persona threads，不进注入 |
| 未排期 | 一致性门禁阻断 commit | 🟡 半接 | 有命中（未声明完成） | review.ts:397 确实调用（旧版按整文件排除同文件调用，误报成零调用）。仍是 partial：只把 selfModel 置 null，facts/threads 照常提交 |
| 未排期 | 多会话上下文隔离 | 🟡 半接 | — | 三个注入缓存是 apply 闭包里的 let（进程级单例）；接 QQ 后会多一个 Agent，共享会被放大 |
| M3 | 语音 | ❌ 零实现 | — |  |
| M3 | 多角色隔离（dataDir 按 agent/用户键控） | ❌ 零实现 | — | 当前单实例 |
| M4 | 身体协议（Body Protocol） | ❌ 零实现 | — | 文档 §身体 有完整设计；没有任何能力插件能回报经历 |
| M4 | 权限中心 | ❌ 零实现 | — |  |
| M5 | 内容平台（视频/评论） | ❌ 零实现 | — |  |
| M6 | 社交 IM（QQ） | 🟡 半接 | — | 2026-11-04 运行期打通：官方 0.5.5 + 私聊 allowlist + 群聊 disabled，QQ 收发正常，persona 四个注入块确实到达 QQ 会话（用 session.v4.jsonl.zstd 逐帧解压验证）。仍是 partial：身体级实现（经历回报/initiation）需自研，见机制设计文档 v1.0.0 §身体 |
| M7 | 本地应用插件 | ❌ 零实现 | — |  |
| P1 | raw_turns 原始层（每轮先落盘，append-only） | ✅ 已实现 | ✅ 有调用点 | 唯一原始事实源；events 双写保留，读路径留给 P4 |
| 增量1 | procedures 程序性记忆层（只能长出来，不写进去） | ✅ 已实现 | ✅ 有调用点 | 复用 facts 机制；epistemicType=ai_inference、默认 candidate，晋升过闸门 |
| 增量2 | 综合泛化（复盘从 facts 归纳特质，≥2 证据） | ✅ 已实现 | ✅ 有调用点 | 泛化产物并入 candidateTraits，与即时特质同过晋升闸门；边界A已兜底 |
| P4 | 按意图装配器（intent + assembler） | 🟡 半接 | 有命中（未声明完成） | shadow 落地，注入仍走旧 buildInjection；flag 默认 false，切读须 shadow ≥14天/≥30轮且 13 项指标达标 |
| 增量4 | salience 第二职责（巩固降采样 + 检索预算） | ✅ 已实现 | ✅ 有调用点 | 红线：不触碰 status/confidence/有效期；冷热分层延后 |
| 增量5 | 评测资产化（goldset + 跑分脚本） | ✅ 已实现 | ✅ 有调用点 | goldset/public 七切片 + hidden 隐藏集；准确性指标空跑为 null，不填预估值 |

合计 35 项：已实现 15 · 半接 10 · 零实现 10。

## 纪律

1. **新增功能**：先在 `ITEMS` 里加一条（`status: missing`），实现并接上线后才改成 `done`。
2. **调整既有功能**：改了语义就更新同条目的 `note`；从"能用"变成"不能用"要立刻降级 status。
3. **评审基线**：任何"要不要做/怎么做"的讨论，先跑一次 `npm run audit`，对着台账说，不对着记忆说。
4. **不允许只加定义不加调用点**：如果暂时不接线，status 必须是 `partial`/`missing`，
   并且 note 里写清楚"为什么先不接"。
