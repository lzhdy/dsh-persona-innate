# 隐藏集（Hidden Set）

## 规则

1. **物理隔离**：本目录与 `goldset/public/` 分开存放，绝不合并。
2. **默认不跑**：`scripts/eval-goldset.mjs` 默认只读 `public/`，仅在 `--hidden 1` 时读取本目录下的 `*.json`。
3. **防过拟合**：隐藏集用于验证系统没有「背下公开集答案」，样例同样脱敏/合成，与公开集不重叠、不共享 evidence id。
4. **当前占位**：`hidden.json` 为空数组，待后续施工单元（P3-P6、增量 1/2/3/4）按类别填充对应切片。
5. **禁止交叉引用**：隐藏集条目不得通过 evidence id 或问法向公开集泄露答案。

## 填充约定

- 每条 entry 与公开集同一 schema（`id`/`category`/`question`/`goldAnswer`/`allowAbstain`/`evidenceEventIds`/`speaker`/`timeRange`/`validity`）。
- `id` 前缀与公开集一致（`spk`/`rel`/`upd`/`ctm`/`abs`/`per`/`asc`），但序号段独立（例如 `spk-901` 起），避免与公开集混淆。
