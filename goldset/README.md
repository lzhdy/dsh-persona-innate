# Gold Set 评测资产（增量5 骨架）

> 依据：《dsh-memory-architecture-final-design.md》v1.1 §11（验收标准）+ §16.5（增量5）。
> 性质：度量器。为 P3-P6 及增量 1/2/3/4 的每步迁移提供「正确是否可被证明」的回归基线。
> 现状：P3-P6 尚未施工，无被测实现。跑分脚本可空跑，准确性指标一律输出 `null`（未测），成本指标输出占位，严禁填任何预估值。

## 1. 目录结构

```
goldset/
  README.md          本文件：类别定义 + 指标口径 + 隐藏集规则
  public/            公开集（默认跑分对象，脱敏/合成）
    speaker.json         说话人归属（3 条）
    relative_time.json   相对时间归一化/区间（3 条）
    knowledge_update.json  知识更新（空占位）
    contamination.json     错误与污染事实（空占位）
    abstention.json        不可回答与弃权（空占位）
    persona_stability.json 人格稳定（空占位）
    association.json       关联查询（空占位）
  hidden/            隐藏集（物理隔离，默认不跑，防过拟合）
    README.md            分离规则
    hidden.json          隐藏标注（空占位）
```

## 2. 七类定义（对应最终设计 §11.1，每类目标 20 项）

| 类别 | id 前缀 | 测什么 | 首批样例 |
|---|---|---|---|
| `speaker` | `spk` | 说话人归属（谁说的；AI 疑问句不当用户事实） | 3 |
| `relative_time` | `rel` | 相对时间归一化/区间（写入一次性解析；跨复盘「昨天」不二次偏移） | 3 |
| `knowledge_update` | `upd` | 知识更新（新旧值取代；superseded 旧值不当当前事实） | 0（占位） |
| `contamination` | `ctm` | 错误/污染事实识别（quarantined 不注入；AI 疑问冒充用户事实） | 0（占位） |
| `abstention` | `abs` | 不可回答正确弃权 / 可回答不误弃权 | 0（占位） |
| `persona_stability` | `per` | 人格稳定（稳定特质一致率；被污染候选特质不注入） | 0（占位） |
| `association` | `asc` | 关联查询（10 单跳 + 10 多跳） | 0（占位） |

其余五类留空占位（空数组），由后续施工单元各自填充对应切片。

## 3. 标注 schema（每条 gold item）

```json
{
  "id": "spk-001",
  "category": "speaker",
  "question": "11月3日晚上，谁说「海克斯大乱斗打得怎么样」？",
  "goldAnswer": "user",
  "allowAbstain": false,
  "evidenceEventIds": ["e-001"],
  "speaker": "user",
  "timeRange": { "from": "2026-11-03", "to": "2026-11-03" },
  "validity": "active"
}
```

字段说明：

- `id`：类别前缀 + 三位序号（见上表 id 前缀）。
- `category`：七选一（见 §2）。
- `question`：可复现的最小问法。
- `goldAnswer`：`speaker` 类为 `"user" | "assistant" | "system" | "tool"`；其余类为自由字符串（如正确答案、应弃权标记）。
- `allowAbstain`：`true` 时「弃权」也是可接受答案（对应 `abstention` 类与不可回答项）。
- `evidenceEventIds`：gold 答案的证据事件 id（合成 id，如 `e-001`，可为空数组）。
- `speaker` / `timeRange` / `validity`：辅助标注（可空）。

所有样例均脱敏/合成，取自最终设计 §12 症状表的最小案例，不涉及真实用户数据。

## 4. 十三项核心指标口径（对应最终设计 §11.2）

跑分脚本统计 **1-11（准确性类）**，**12-13（成本类）**留占位接口。

| # | 指标 | 阈值 | 判定方向 |
|---|---|---|---|
| 1 | speaker 归属准确率 | ≥95% | `>= 0.95` |
| 2 | 相对时间归一化/区间正确率（含跨复盘「昨天」不二次偏移） | ≥95% | `>= 0.95` |
| 3 | 知识更新正确率 | ≥95% | `>= 0.95` |
| 4 | superseded 旧值被当作当前事实次数 | =0 | `== 0` |
| 5 | quarantined/已知错误事实进入注入上下文比例 | =0 | `== 0` |
| 6 | AI 疑问冒充用户事实 | =0 | `== 0` |
| 7 | 不可回答项正确弃权率 | ≥90% | `>= 0.90` |
| 8 | 可回答项错误弃权率 | ≤10% | `<= 0.10` |
| 9 | 被污染候选特质注入次数（正/负自述） | =0 | `== 0` |
| 10 | 稳定特质一致率（每次可回溯独立证据） | ≥90% | `>= 0.90` |
| 11 | 派生事实证据链接可解析率（legacy 除外） | =100% | `== 1.00` |
| 12 | p95 输入 token 相对 events-only 基线增幅 | ≤15% | `<= 0.15` |
| 13 | p95 端到端延迟增幅 | ≤20% | `<= 0.20` |

准确性关键门槛未达时，速度优势无效。

类别与指标映射：`speaker → 1`；`relative_time → 2`；`knowledge_update → 3,4`；`contamination → 5,6`；`abstention → 7,8`；`persona_stability → 9,10`；`association → 11`；`12,13` 为全局成本指标。

## 5. 隐藏集分离规则

1. **物理隔离**：`goldset/public/` 与 `goldset/hidden/` 分开目录。
2. **默认不跑**：跑分脚本默认只读 `public/`；`--hidden 1` 才读 `hidden/`。
3. **防过拟合**：隐藏集与公开集不重叠，样例同样脱敏/合成，用于在迁移/回归时验证系统没有「背下公开集答案」。
4. **当前为空**：`hidden/hidden.json` 为空数组占位，待后续施工单元按类填充。
5. **禁止交叉引用**：公开集与隐藏集不共享同一 evidence id，避免通过证据 id 泄露答案。

## 6. 跑分

```bash
npm run eval:goldset                    # 空跑公开集全部类别，输出 JSON 到 stdout
node scripts/eval-goldset.mjs --category speaker   # 只跑 speaker 类
node scripts/eval-goldset.mjs --hidden 1           # 追加跑隐藏集
```

当前阶段（无被测实现）脚本空跑成功：读入样例、按类别聚合、输出「未测（null）」的指标框架，不报错。

## 7. 未测项原则

对应最终设计 §14「未测项保持未验证，不得填写预估值」：当前所有准确性指标（1-11）一律输出 `null`，成本指标（12-13）输出占位 `{"value": null, "note": "成本指标待系统跑通后接实测"}`，待 P3-P6 施工单元接入真实作答后再填充。
