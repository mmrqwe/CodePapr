# ADR-007: Checkpoint payload v3 迁移与渲染器绑定

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-001, ADR-006

## 背景

现有 `CONTEXT_COMPACTION_VERSION = 2`，sections 为
`userGoal / constraints / completedWork / importantContext / assumptions /
validationNotes / pendingWork / openQuestions / todoList`
（contextCompaction.ts:24-50）。PR3 将引入结构化
`ContextCheckpointState`（confirmedFacts / decisions / verification /
failuresAndRisks / references 等），需要版本升级与转换。

## 决策

### v2 → v3 映射（确定性，纯函数，PR0 实现 migrator）

| v2 字段 | v3 字段 | 规则 |
|---|---|---|
| userGoal | goal | 直通 |
| constraints | constraints | 直通 |
| completedWork | completedWork | 直通 |
| assumptions | assumptions | 直通 |
| validationNotes | verification / failuresAndRisks | 命中失败/风险模式 → failuresAndRisks，其余 → verification |
| pendingWork | activeWork | 直通 |
| openQuestions | openQuestions | 直通 |
| todoList | todos | 直通 |
| importantContext | confirmedFacts / references | 含验证关键词（通过/失败/成功/verified/passed/failed/test/构建/修复…）或文件路径 → confirmedFacts；其余 → references |
| （无） | decisions | 空数组 |
| （无） | provenance | 空数组 |
| modelTier: 'local' | summaryInfo.kind = 'local-fallback' | 其余 → 'llm'，model = modelName |

### 渲染器绑定

- 已归档的 v2 payload **保持 v2 渲染器渲染**（`renderedContent` 不动），
  升级 v3 后存量会话重启字节不漂移；
- migrator 只生成「用于合并输入 / 生成新 checkpoint」的 v3 state，
  **不重写已持久化的 v2 payload**；
- v3 渲染器以现有 `buildLocalContextCheckpointSections` 为基础演进，不重写；
- `todoDigest` 冻结语义保留。

## 后果

- PR3 的 LLM merge 输出与本地 fallback 都必须产出 v3 state；
- 渲染层需要按 payload.version 分派 renderer。
