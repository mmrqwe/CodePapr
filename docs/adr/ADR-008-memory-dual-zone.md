# ADR-008: .CodePapr/memory.md 双区模型与四个写者的迁移

- 状态: Superseded by [ADR-011](./ADR-011-retire-memory-md.md)（退役 memory.md；双区文件不再是产品面）。Amended by [ADR-010](./ADR-010-memory-zero-inbox.md)（废除用户审核队列）
- 日期: 2026-08-16
- 关联: ADR-001（L4 层）、ADR-010

## 背景

memory.md 目前有四个写路径：

| 写者 | 现状 |
|---|---|
| Agent `write` 工具 | 直接写（回合后 consolidation 依赖它） |
| 冷启动 bootstrap | `bootstrapMemoryContent` → `write_text_file` IPC（sendMessage.ts:843） |
| 回合后 consolidation | `consolidateMemoryContent` 读改写回（sendMessage.ts:2099-2110） |
| 用户手编 | 编辑器直接编辑 |

纯投影会覆盖用户手写；任意双写会让 ledger 被绕过、注入内容污染 memory。

## 决策

**双区模型：User Zone + Managed Zone。**

```markdown
# Project Memory

<!-- CodePapr:user-memory:start -->
（用户手编内容，投影器保留）
<!-- CodePapr:user-memory:end -->

<!-- CodePapr:managed-memory:start -->
（仅 Bootstrap 类 memory_entries 的投影：preference / constraint / fact / …；citation / procedure 不在此）
<!-- CodePapr:managed-memory:end -->
```

写入规则：

| 写入者 | User Zone | Managed Zone |
|---|---|---|
| 用户手编 | 允许 | 下次投影修正 |
| Agent 普通 `write` | 拦截 → 自动写入策略 | 拦截 |
| Agent `memory_write` 工具 | 不直写 | 按种类自动 persist 或 drop |
| 冷启动 bootstrap | 不写入 | 经 projector |
| 投影器 | 保留 | 覆盖生成（仅 Bootstrap 类条目） |

四个现有写者的处置（PR4 必须显式执行；写入策略见 ADR-010）：

1. Agent `write` 工具：拦截 `.CodePapr/memory.md` 写入 → 自动 persist/drop；
2. 冷启动 bootstrap：不再直接 `write_text_file`，改走 ledger/projector；
3. 回合后 consolidation：**退役**，由 memory_write + 自动写入策略替代；
4. 用户手编：进入 user zone，读入 ledger 时标记
   `trust = trusted / source = user-edit / confidence = confirmed`。

### 安全边界

- 路径拦截是 best-effort（`bash` 等可绕过），**写入策略才是真正防线**；
- web / MCP 不可进入 Bootstrap / 约束；可进 citation 供按需召回；
- 不可信内容不能 mutate：工具权限、沙箱策略、外部访问策略、memory 规则、项目约束。
- **不设用户审核队列**（ADR-010）。

### 记忆工具（PR4 / ADR-010）

`reported` 内容有 400 字上限（ADR-014）：一次一条事实，清单/摘要类 blob 不记。

```text
memory_write(content, category, evidence?)   → 立刻 persist 或 drop，不排队
memory_search(query, category?)
memory_forget(id, reason?)
memory_list()                                → 列出已写入目录（无 admit；原 memory_review_candidates）
```

注意：新增工具会改变 tool schema → prefix hash → 全量一次性缓存失效（可接受，需提前声明）。

## 后果

- 用户可编辑体验与机器 provenance 并存；
- 现有三个内部写者必须在 PR4 内迁移完毕，否则与投影器互踩同一文件。
