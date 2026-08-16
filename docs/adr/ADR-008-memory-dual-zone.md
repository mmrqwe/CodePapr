# ADR-008: .CodePapr/memory.md 双区模型与四个写者的迁移

- 状态: Accepted
- 日期: 2026-08-16
- 关联: ADR-001（L4 层）

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
（仅来自 verified / admitted memory_entries 的投影）
<!-- CodePapr:managed-memory:end -->
```

写入规则：

| 写入者 | User Zone | Managed Zone |
|---|---|---|
| 用户手编 | 允许 | 下次投影修正 |
| Agent 普通 `write` | 拦截 → memory_candidate | 拦截 |
| Agent `memory_write` 工具 | 创建 candidate | 创建 candidate |
| 冷启动 bootstrap | 改走 projector（写入 managed zone 对应的 ledger entry） | 经 projector |
| Ledger admission | 生成 user-confirmed entry | 生成 verified entry |
| 投影器 | 保留 | 覆盖生成 |

四个现有写者的处置（PR4 必须显式执行）：

1. Agent `write` 工具：拦截 `.CodePapr/memory.md` 写入 → 转 candidate；
2. 冷启动 bootstrap：不再直接 `write_text_file`，改走 ledger/projector；
3. 回合后 consolidation：**退役**，由 memory_write + 准入策略替代；
4. 用户手编：进入 user zone，读入 ledger 时标记
   `trust = trusted / source = user-edit / confidence = confirmed`。

### 安全边界

- 路径拦截是 best-effort（`bash` 等可绕过），**准入策略才是真正防线**；
- web / MCP / tool output 不可自动进入任一区域；
- 不可信内容不能 mutate：工具权限、沙箱策略、外部访问策略、memory 规则、项目约束。

### 记忆工具（PR4）

```text
memory_write(content, category, evidence?)   → 只创建 candidate，不直接写 stable memory
memory_search(query, category?)
memory_forget(id, reason?)
memory_review_candidates()
```

注意：新增工具会改变 tool schema → prefix hash → 全量一次性缓存失效（可接受，需提前声明）。

## 后果

- 用户可编辑体验与机器 provenance 并存；
- 现有三个内部写者必须在 PR4 内迁移完毕，否则与投影器互踩同一文件。
