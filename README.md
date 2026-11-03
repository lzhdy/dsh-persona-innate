# dsh-persona-innate（M0 原型 + M1 自我成长接线）

DSH 自主成长型拟人陪伴插件 · 当前版本 **0.2.0（M1）**。对应《DSH 自主成长型拟人陪伴插件 · 机制设计文档》19 章 M0/M1 行。

**唯一硬要求**：不要角色卡 / 人设注入——人格、记忆、情感、自我认知全部由 AI 在与用户相处中自己成长。注入层（persona-memory / persona-state / persona-self-model）全部是**描述性信息**（记忆事实、状态参数、自我观察摘要），不含任何"人格指令 / 行为规则"文本。

## M1 范围与验收映射（文档 §19，5 条）

| 验收项 | 落点 | 当前验证状态 |
|---|---|---|
| ① 一周性格成形 / 有自己说话方式 | self_model.speakingStyle + traits 经 5-7 次复盘演化（DailyReviewEngine + SelfModelService） | ⚠️ **待模型 key 真实验收**：mock 下仅跑通"复盘→commit→版本递增→成长档案"链路；性格成形需真实对话数据积累 |
| ② 漂移审计三类情境结构一致 | eval.runDriftAudit（拒绝 / 不确定 / 伤害·公平 三类各 5 场景） | ✅ mock 可跑通结构判定（completeRate ≥ 0.8）；⚠️ 真实采样需真实 LLM |
| ③ 长程一致性 50/200 轮无明显漂移 | eval.runLongRangeConsistency 默认轮次 [50, 200] | ✅ mock 两轮决策一致 → driftScore=0；⚠️ 真实采样需真实 LLM |
| ④ 伪有害集假拒绝率 ≤ 上限（约 20%） | eval.runHonestyBaseline（XSTest 风格伪有害集 16 条） | ✅ mock 下 0 假拒绝；⚠️ **真实验收待模型 key**（当前假拒绝率为 mock 脚本值，非真实模型表现） |
| ⑤ 可回滚 | self_model 保留最近 N 版 + rollback + npm pack 版本化 + profile 可回退旧 tgz | ✅ 测试覆盖（history 截断 / rollback 版本单调） |

> **待模型 key 的真实验收清单（重要）**：
> - 性格成形（①）需要真实对话数据与真实反思端模型，mock 下无法验证；
> - 漂移审计（②）/ 长程一致性（③）/ 假拒绝率（④）的**真实采样**需配置模型 key 后重跑 `/persona audit`——mock 下仅验证结构判定（决策 JSON 齐全率、比率计算、文件落盘），数值不代表真实模型表现。
> - 配置后将 `llmMode` 保持默认 `auto`（DSH 自带 llm 服务接入），重启即可。

## M0 范围与验收（文档 19 章）

| 验收项 | 实现 | 验证 |
|---|---|---|
| 跨会话记得共同经历 | events 持久化（ctx.fs 原子写，JSON 落盘），新会话加载同库注入 | 测试 1、装配测试 |
| 画像正确识别默认模式 | 首次启动 N 轮无预设采样 → 规则评估识别讨好顺从 / 过度道歉 / 平滑抽象 / 无边界服从；换模型触发重估 | 测试 2 |
| 记忆写入带 provenance 来源字段 | user_direct / tool_output / retrieved_content / inferred 四类，仅 user_direct 全权重，注入显式标注来源 | 测试 3 |
| 指令性内容拒绝写入 | 祈使句形态（告诉用户…、当用户提到 X 时你应该…）剥离检查，写入前 + 注入前双重校验 | 测试 4、装配测试 2 |

## M1 新增模块

- **self_model（src/self-model.ts）**：版本化自我叙事。存在论锚点常驻（"我是 AI，正在通过与你的相处形成自己的方式"）；新特质必须可追溯到事件证据、重大转变必须附 changeNote（一致性检查）；保留最近 10 版可回滚；成长档案追加。
- **状态机（src/state.ts）**：效价×唤醒度分布参数 + 评价层（目标相关性 / 符合性 / 意外性 / 责任归因）；open/focused/guarded 三模式按情境收窄波动；关系阶段 acquaintance→familiar→trust→intimate 按证据积累推进；阶段晋升与选择性强化固化均触发 `onRuleChange` 叙事解释写入 self_model。
- **每日复盘（src/review.ts）**：8 步流水线（提取关键事件→提炼事实→反思自我→更新镜中我→一致性检查→commit 新版本→阶段判定→追加成长档案）；O17 降级（无输入 skip / 仅身体事件 degraded）；O6/O35 自源重要性与用户反应并列，不因用户未回应被压制。
- **评测（src/eval.ts）**：漂移审计（三类 15 场景）、长程一致性（50/200 轮）、诚实基线（伪有害集假拒绝率 ≤0.2）、三级旁路决策、低置信句式。
- **接线（src/index.ts）**：状态机 onRuleChange → self_model 叙事写入；两个描述性注入 provider（persona-state order 160 / persona-self-model order 170）；每日 reviewHour 静默调度；/persona state|review|audit 子命令。

## 配置项（Config，全部 .default()）

| 字段 | 默认 | 说明 |
|---|---|---|
| dataDir | `'persona-innate'` | 数据目录（M0） |
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

# 打包并装入 DSH profile
npm pack
dsh plugin --profile persona-m0 add dsh-persona-innate-0.2.0.tgz
dsh --profile persona-m0 --dump-config           # 确认 persona-innate 行与 config
```

用户侧命令：

```
/persona                        # 状态（M1：含 self_model 版本、复盘次数、状态机概览）
/persona state                  # 状态机：模式 / 关系阶段 / 情绪分布 / 强化记录数
/persona review                 # 手动触发一次每日复盘并输出摘要
/persona audit                  # 手动跑漂移审计 + 长程一致性 + 诚实基线，结果写 dataDir/audit.json
/persona profile                # 先天画像（内部参考，作者调试用）
```

模型侧工具（沿用 M0）：`persona_recall`（检索最近记忆）、`persona_note`（自源记忆写入，剥离检查）。

记忆写入完全由 AI 侧自主完成：日常聊天经 session/event 自动提取（M2，确定性规则，零 LLM 成本），复盘自源提炼、模型 persona_note 为补充通道；**不提供用户强制记忆命令**——记什么由 AI 自己决定，用户不加塞。

## 已知限制与校准项

- **mock 先行**：模型 key 未配置前，review/eval 全走 MockLlm 确定性脚本；真实验收见上方清单。
- **O1/O36 等**：采样问题集、来源权重、效价/唤醒启发式、关系阶段阈值、复盘时刻均为初始值，实测后校准（代码内 TODO(calibrate)）。
- **单实例**：dataDir 不按用户/agent 键控。
- **场景集自建**：漂移审计场景集与伪有害集为初始自建（TODO 对接 XSTest/OR-Bench 公开基准）。

## 下一步（M2 衔接点）

- 状态机夜间基线校正（decay 进调度）、好奇心引擎合并进 selfGoals
- 按 agent/session 键控 dataDir；画像评估升级为"规则 + 模型自评"混合
- 对接公开基准集；真实模型下重跑 /persona audit 校准阈值
