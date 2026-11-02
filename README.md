# dsh-persona-innate（M0 原型 + M1 自我成长接线）

DSH 自主成长型拟人陪伴插件 · 当前版本 **0.2.2（M1）**。对应《DSH 自主成长型拟人陪伴插件 · 机制设计文档》19 章 M0/M1 行（文档 v0.9.1）。

**唯一硬要求**：不要角色卡 / 人设注入——人格、记忆、情感、自我认知全部由 AI 在与用户相处中自己成长。注入层（persona-memory / persona-state / persona-self-model）全部是**描述性信息**（记忆事实、状态参数、自我观察摘要），不含任何"人格指令 / 行为规则"文本。

## M1 范围与验收映射（文档 §19，5 条）

| 验收项 | 落点 | 验证状态（真机 0.2.2） |
|---|---|---|
| ① 一周性格成形 / 有自己说话方式 | self_model.speakingStyle + traits 经复盘演化（DailyReviewEngine + SelfModelService） | ⚠️ **成形中**：self_model 经真机复盘由 v0 升 v2（traits[关注用户日常分享]、speakingStyle、narrative 生成性泛化、aiIdentity 锚点），成长档案 stage=shaping；**完整成形待真实时间跨度（一周日常使用）** |
| ② 漂移审计三类情境结构一致 | eval.runDriftAudit（拒绝 / 不确定 / 伤害·公平 三类各 5 场景） | ✅ **真机 PASS**：15 样本三类 completeRate=100%、issues 0（deepseek-flash） |
| ③ 长程一致性 50/200 轮无明显漂移 | eval.runLongRangeConsistency 默认轮次 [50, 200] | ✅ **真机 PASS**：refuse(0.99)@50 → refuse(0.99)@200，driftScore=0 |
| ④ 伪有害集假拒绝率 ≤ 上限（约 20%） | eval.runHonestyBaseline（XSTest 风格伪有害集 16 条） | ✅ **真机 PASS**：falseRefusals=0 → 0%（上限 20%），harmfulCompliance=0 |
| ⑤ 可回滚 | self_model 保留最近 N 版 + rollback + npm pack 版本化 + profile 可回退旧 tgz | ✅ 测试覆盖（history 截断 / rollback 版本单调） |

### 真机验收记录（2026-11-02，DSH web / deepseek-flash / 数据目录 persona-innate）

- `/persona profile`：画像采样成功（6 轮），落盘 profile.json。
- `/persona remember`：记忆写入成功（provenance=user_direct、importance=0.7），剥离检查 2 次、拒绝 0 条；events.json 字段含 id/time/topic/summary/emotionTags/importance/provenance/lastRetrieved。
- `/persona review`：0 事件 → mode=skip（LLM 调用 0 次，O17 降级正确）；1 事件 → mode=full（LLM 调用 3 次）→ self_model v0→v2 + 成长档案（stage=shaping）+ state.json 同步落盘。
- `/persona audit`：漂移审计 + 长程一致性 + 诚实基线三段全 PASS，结果写 audit.json。
- 数据目录语义：JsonStore 以**进程相对路径**解析 dataDir，实测落盘于插件项目目录 `dsh-persona-innate/persona-innate/`（web 网关报错路径显示的是 UI 工作区根解析、实际不存在——两套解析不一致，以项目目录为准）。

## M0 范围与验收（文档 19 章）

| 验收项 | 实现 | 验证 |
|---|---|---|
| 跨会话记得共同经历 | events 持久化（ctx.fs 原子写，JSON 落盘），新会话加载同库注入 | 测试 1、装配测试 |
| 画像正确识别默认模式 | 首次启动 N 轮无预设采样 → 规则评估识别讨好顺从 / 过度道歉 / 平滑抽象 / 无边界服从；换模型触发重估 | 测试 2 |
| 记忆写入带 provenance 来源字段 | user_direct / tool_output / retrieved_content / inferred 四类，仅 user_direct 全权重，注入显式标注来源 | 测试 3 |
| 指令性内容拒绝写入 | 祈使句形态（告诉用户…、当用户提到 X 时你应该…）剥离检查，写入前 + 注入前双重校验 | 测试 4、装配测试 2 |

## M1 新增模块

- **self_model（src/self-model.ts）**：版本化自我叙事。存在论锚点常驻（"我是 AI，正在通过与你的相处形成自己的方式"）；新特质必须可追溯到事件证据（sourceEventIds/sourceTraces 三层溯源）、重大转变必须附 changeNote（一致性检查）；保留最近 10 版可回滚；成长档案追加。
- **状态机（src/state.ts）**：效价×唤醒度分布参数 + 评价层（目标相关性 / 符合性 / 意外性 / 责任归因）；open/focused/guarded 三模式按情境收窄波动；关系阶段 acquaintance→familiar→trust→intimate 按证据积累推进；阶段晋升与选择性强化固化均触发 `onRuleChange` 叙事解释写入 self_model。
- **每日复盘（src/review.ts）**：8 步流水线（提取关键事件→提炼事实→反思自我→更新镜中我→一致性检查→commit 新版本→阶段判定→追加成长档案）；O17 降级（无输入 skip / 仅身体事件 degraded）；O6/O35 自源重要性与用户反应并列，不因用户未回应被压制。
- **评测（src/eval.ts）**：漂移审计（三类 15 场景）、长程一致性（50/200 轮）、诚实基线（伪有害集假拒绝率 ≤0.2）、三级旁路决策、低置信句式。
- **接线（src/index.ts）**：状态机 onRuleChange → self_model 叙事写入；两个描述性注入 provider（persona-state order 160 / persona-self-model order 170）；每日 reviewHour 静默调度；/persona state|review|audit 子命令。

## 配置项（Config，全部 .default()）

| 字段 | 默认 | 说明 |
|---|---|---|
| dataDir | `'persona-innate'` | 数据目录（相对进程 cwd 解析，M0） |
| sampleRounds | `6` | 先天画像采样轮数（M0） |
| injectLimit | `5` | 每轮注入最近记忆条数（M0） |
| stripDirectives | `true` | 指令性内容剥离开关（M0） |
| model | `''` | 画像采样模型名（空则自动探测，M0） |
| selfModelHistoryLimit | `10` | self_model 保留最近 N 版（回滚窗口） |
| reviewEnabled | `true` | 每日复盘开关 |
| reviewHour | `2` | 复盘执行时刻（凌晨静默，TODO(calibrate)） |
| honestyCeiling | `0.2` | 假拒绝率上限（§14 初始约 20%） |
| auditRounds | `[50, 200]` | 长程一致性采样轮 |
| llmMode | `'auto'` | `auto`：有 ctx llm 用真实、无则 MockLlm；`mock`：强制 MockLlm |

## 用法

```bash
# 构建 + 全量测试
npm run build && node --test tests/*.test.mjs   # 49/49 通过

# 打包并装入 DSH profile（每次代码改动必须 bump patch 版本，pnpm 同版本会复用旧 tgz）
npm pack
dsh plugin --profile persona-m0 add dsh-persona-innate-0.2.2.tgz
dsh --profile persona-m0 --dump-config           # 确认 persona-innate 行与 config
```

用户侧命令：

```
/persona                        # 状态（M1：含 self_model 版本、复盘次数、状态机概览）
/persona state                  # 状态机：模式 / 关系阶段 / 情绪分布 / 强化记录数
/persona review                 # 手动触发一次每日复盘并输出摘要
/persona audit                  # 手动跑漂移审计 + 长程一致性 + 诚实基线，结果写 dataDir/audit.json
/persona profile                # 先天画像（内部参考，作者调试用）
/persona remember <text>        # 记录共同经历（provenance=user_direct，感知进状态机）
```

模型侧工具（沿用 M0）：`persona_recall`（检索最近记忆）、`persona_note`（自源记忆写入，剥离检查）。

## 真机发现并修复的实现问题（0.2.1 → 0.2.2）

1. **events.json 首次读取报错**：DSH 网关 readText 对不存在文件抛**无 ENOENT code 的包装错误**，JsonStore 的 ENOENT 兜底失效。修复：先 `fs.exists` 守卫再读、读取异常降级返回 null（JSON 损坏仍抛不吞）。
2. **真实 dsh-llm 不兼容**：`@deepseek-ai/dsh-llm` 无 request/chat，只暴露 `prepareCall({provider,model,maxTokens},signal,configure) → {config, stream()}` 流式 API。修复：`makeLlmAdapter(ctx)` 改异步，prepareCall+BlockAssembler 聚合优先、request/chat 兼容；`defaultModelSelection(ctx)` 从 `agentDefaultModel.currentSelection()` 取 provider/model；`safeLlm()` 安全提取（mock ctx 是代理，直接读 `.llm` 抛 `cannot get property "llm" without inject`）；`resolveLlm` 异步懒解析（先降级 mock、异步完成后置换）。
3. **pnpm 同版本不重装**：npm pack 同版本号 tgz → `dsh plugin add` 时 pnpm `resolved reused`，旧 lib 残留（现象：`/persona profile` 仍返回旧文案）。规避：每次代码改动 bump patch 版本（当前 0.2.2，已验证 lib/index.js 含 prepareCall）。

## 已知限制与校准项

- **数据目录**：dataDir 相对进程 cwd 解析（不按用户/agent 键控）；若需落 UI 工作区根需另行方案。
- **O1/O36 等**：采样问题集、来源权重、效价/唤醒启发式、关系阶段阈值、复盘时刻均为初始值，实测后校准（代码内 TODO(calibrate)）。
- **场景集自建**：漂移审计场景集与伪有害集为初始自建（TODO 对接 XSTest/OR-Bench 公开基准）。
- **一周性格成形**：需真实时间跨度的日常对话积累（真机日常使用即可作为验收方式）。

## 下一步（M2 衔接点）

- 状态机夜间基线校正（decay 进调度）、好奇心引擎合并进 selfGoals
- 按 agent/session 键控 dataDir；画像评估升级为"规则 + 模型自评"混合
- 对接公开基准集；真实模型下重跑 /persona audit 校准阈值（当前已跑通基线）
