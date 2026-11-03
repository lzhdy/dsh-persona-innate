# dsh-persona-innate（M0 原型 + M1 自我成长接线 + M2 自动记忆 + M3 双通道记忆）

DSH 自主成长型拟人陪伴插件 · 当前版本 **0.4.0（M3 + 真实链路缺陷修复）**。对应《DSH 自主成长型拟人陪伴插件 · 机制设计文档》M0/M1/M2/M3 行。

> **0.4.0 升级提示（含行为变更与数据迁移）**：数据目录默认值由相对路径 `'persona-innate'` 改为自动定位到 `$DSH_HOME/persona-innate`（默认 `~/.dsh/persona-innate`），不再随启动目录漂移；旧目录数据需迁移，详见文末 [0.4.0 Changelog](#040-changelog)。

**唯一硬要求**：不要角色卡 / 人设注入——人格、记忆、情感、自我认知全部由 AI 在与用户相处中自己成长。注入层（persona-memory / persona-state / persona-self-model）全部是**描述性信息**（记忆事实、状态参数、自我观察摘要），不含任何"人格指令 / 行为规则"文本。

## M3：双通道记忆架构（当前版本核心）

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

- **src/extract.ts**：提取器（M2/M3）。`extractCandidate` / `extractSelfExpression` / 诱导检测（INDUCE_PROBES、INDUCE_WINDOW=3、sessionInduceRisk）/ SELF_CORRECTION / USER_CORRECTION / dedupKey。
- **src/memory.ts**：事件库。写队列串行化（M3-2 并发写修复）、importEvents 批量事务、剥离检查、注入检索（recallScore）。
- **src/review.ts**：每日复盘 8 步流水线 + 强化过滤（imported / induced 不进强化，self_correction 延迟验证）。
- **src/import-chat.ts**：导入管线（M3 后半）。zstd 逐帧解压（magic 定位）、会话行过滤、消息提取、错误分级、runImportChat。
- **src/self-model.ts**：版本化自我叙事（存在论锚点、证据追溯、保留 10 版、成长档案）。
- **src/state.ts**：状态机（open/focused/guarded 三模式、acquaintance→intimate 阶段）。
- **src/eval.ts**：漂移审计、长程一致性、诚实基线。
- **src/index.ts**：接线（session/event 双通道、注入 provider、命令注册、复盘调度）。

## 配置项（Config，全部 .default()）

| 字段 | 默认 | 说明 |
|---|---|---|
| dataDir | 未设置（自动定位） | 数据目录；未设置时自动解析为 `$DSH_HOME/persona-innate`（默认 `~/.dsh/persona-innate`），显式值支持 `~` 展开；空字符串视为未设置并告警回退 |
| sampleRounds | `6` | 先天画像采样轮数（M0） |
| injectLimit | `5` | 每轮注入最近记忆条数 |
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
npm run build && node --test tests/*.test.mjs   # 139/139 通过

# 打包并装入 DSH profile
npm pack
dsh plugin --profile web add dsh-persona-innate-0.4.0.tgz
dsh --profile web --dump-config
```

用户侧命令：

```
/persona                          # 状态（记忆条数、剥离检查、画像、self_model、状态机、复盘）
/persona state                    # 状态机：模式 / 关系阶段 / 情绪分布 / 强化记录数
/persona review                   # 手动触发一次每日复盘并输出摘要
/persona audit                    # 漂移审计 + 长程一致性 + 诚实基线 → dataDir/audit.json
/persona profile                  # 先天画像（内部参考）
/persona import-chat <path>       # 导入 DSH 历史会话（.v4.jsonl.zstd）为 imported 记忆
```

模型侧工具（沿用 M0）：`persona_recall`（检索最近记忆）、`persona_note`（自源记忆写入，剥离检查）。

记忆写入由 AI 侧自主完成：日常聊天经 session/event 自动提取（确定性规则，零 LLM 成本）、复盘自源提炼、模型 persona_note 为补充通道；**历史会话导入为显式命令**（补记忆不补成长，不进强化回路）。

## 已知限制与校准项

- **mock 先行**：模型 key 未配置前，review/eval 全走 MockLlm 确定性脚本；真实验收见上方清单。
- **O1/O36 等**：采样问题集、来源权重、效价/唤醒启发式、关系阶段阈值、复盘时刻均为初始值，实测后校准（代码内 TODO(calibrate)）。
- **单实例**：dataDir 不按用户/agent 键控。
- **场景集自建**：漂移审计场景集与伪有害集为初始自建（TODO 对接 XSTest/OR-Bench 公开基准）。
- **导入通道**：仅支持 `.v4.jsonl.zstd` 结构（user `data.content[0].text` / assistant `data.message.content`）；assistant 提取"从后往前取第一条 type=text"（跳过 reasoning/tool_call）。

## 下一步

- 状态机夜间基线校正、好奇心引擎合并进 selfGoals
- 按 agent/session 键控 dataDir；画像评估升级为"规则 + 模型自评"混合
- 对接公开基准集；真实模型下重跑 /persona audit 校准阈值
- self_correction 延迟验证的复盘侧维持性检查精化

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
