# ADR-016: 记忆 v5 —— MEMORY.md 文件 + 双卡点管家

- 状态: Accepted
- 日期: 2026-09-12
- 关联: 取代 [ADR-009](./ADR-009-memory-recall-b3.md)（Recall B3）与 [ADR-011](./ADR-011-retire-memory-md.md)（账本 + 面板为唯一记忆面）；废止 [ADR-010](./ADR-010-memory-zero-inbox.md) 的账本入队机制与 [ADR-014](./ADR-014-retire-cold-start-memory-bootstrap.md) 的账本语境；沿用 [ADR-001](./ADR-001-context-architecture-layers.md) / [ADR-004](./ADR-004-bootstrap-exclusion.md) 的分层与 Bootstrap 契约、[ADR-015](./ADR-015-skeleton-compaction-v4.md) 的 epoch 提交

## 背景

账本体系（SQLite `memory_entries` + 零审核写入 + Turn Recall + 面板目录 + FTS + 近义合并 + v8 收敛 + 双区迁移）经过 PR4/PR5/M1–M8 多轮加固后仍有结构性问题：

1. **写着复杂，用着简单**：绝大多数用户只需要一份「项目记忆文件」——可读、可编辑、可 diff、可进 git。账本把这件事拆成候选/条目/召回/审计四张表和一条只有系统自己懂的召回链。
2. **本会话不可见**：Bootstrap 按「会话 × 稳定签名」冻结（ADR-001），写入/遗忘要等下一次压缩 epoch 或新会话才生效。用户说「记住这个」，当回合看不到任何确认。
3. **写入质量靠启发式**：`planMemoryWrite` 只能区分 confirmed/reported 与几类风险，Agent 自报的长文、近义改述、同源冷启动摘要仍需 v8 一次性收敛来收拾。
4. **生态一致性**：业界通行做法（CLAUDE.md、AGENTS.md、rules 文件）就是工作区内的一个 Markdown 文件；文件是事实源，模型与用户共享同一面。

## 决策

### 1. 单一存储：`.CodePapr/MEMORY.md`

项目级唯一记忆文件，三节结构（缺失节可省）：

```markdown
# 项目与用户长期记忆

## 用户偏好与约束
## 技术栈与环境约束
## 架构与业务已知事实
```

硬上限 `MEMORY_MD_MAX_LINES = 60` 行 / `MEMORY_MD_MAX_TOKENS = 2000`（约 8 KB）——写入端（管家 + 面板保存）与注入端共用同一常量，注入永远全量、不截断。这是 Recall 消失后「全量注入」可控的代价边界。

### 2. 管家维护：内置 `memory-curator` 子代理

internal 子代理（零工具、fast 档、复用压缩模型/温度、prompt 运行时注入）。两个卡点：

- **交付卡点**：回合结束，多信号门命中才跑——显式记忆意图（「记住 / 以后都 / please remember…」）、持久禁令（「不要再用 / never … again」）、**Agent 主动提议**（最终答复里以「记忆候选：」/`Memory candidate:` 标记的稳定事实），或本回合有验证成功的测试/构建命令。命中则 fire-and-forget（不阻塞回合收尾）。**Ask 模式永不触发**；普通模态词（必须 / 务必 / always…）不触发——它们是日常任务指令的高频词，纳入会每回合误触（费 token + 前缀缓存抖动），兜底交给压缩前卡点。
- **压缩前卡点**：任意压缩入口（回合末 epoch、`/compact`、Goal force、mid-loop 提交前）**无条件**运行，20s 超时。压缩本来就重置前缀缓存，这一刀零额外成本；写入发生在 epoch 重渲染 Bootstrap 之前，新记忆立刻随 epoch 生效。

管家输出三选一：完整 MEMORY.md 内容 / `NO_CHANGE` / 拒绝说明。写入走 `requestMemoryMdWrite` 单飞队列 + `expectedContent` 并发守卫（读取后被并发修改则拒绝，面板重载后再试）。

### 3. 素材边界与机械门

- **素材只含**：本回合用户原话 + assistant 最终文本（交付卡点）/ 将被折叠的 v4 骨架 + 活动文本（压缩卡点）。**绝不含原始工具输出**（防注入、防大段转录）。
- **机械门**（LLM 之外）：`redactSecrets` 强制脱敏；`envelopeContent` 风险标记（注入指令 / 危险命令 / 策略绕过）拒写；行数/token 上限；**mass-drop 规则**——零新增条目且删除超过一半 = 拒写（防管家把用户记忆整段洗掉）。

### 4. Agent 无记忆工具

`memory_write` / `memory_search` / `memory_list` / `memory_forget` 全部退役。Agent 被明确告知：「不要自己写 MEMORY.md——直接写入会被拒绝。发现值得长期记住的事实，在最终答复末尾另起一行以『记忆候选：』写明。」`workspaceFileTools` 对 `.CodePapr/MEMORY.md` 的 `write` / `patch` / `diff` 直接抛错拒绝。Agent 由此获得的是**受控提议通道**（标记 → 交付门 → 管家校验落盘），不是裸写权限；提议与实际落盘之间永远隔着管家提示词 + 机械门。

**shell 路径补齐**：`exec` / `bash` 无法走文件工具的拦截。macOS 由 `sandbox-exec` profile 对 `.CodePapr` 整树 `deny file-write*`（内核级，见 `shell/sandbox.rs`）；Windows/Linux 进程级沙箱不生效，由 `memoryShellGuard` 兜底——命令前后比对 MEMORY.md，内容被非受信通道改动则用单飞队列回滚（`getMemoryMdWriteSeq` 区分「curator/面板合法写入赢得竞态」，不回滚用户并发保存；命令新建文件只告警不删，避免误删）。

### 5. 注入：每回合直读，不再冻结

`loadMemorySectionForPrompt(workspacePath)` 每回合读文件，渲染进 Session Bootstrap。文件没变 → promptKey 相同 → 复用 agent；文件变了 → promptKey 变化 → 下回合重建 agent（一次性前缀 miss）。契约从「缓存稳定优先」反转为「保存即下回合生效优先」。

### 6. v9 迁移

`migrate_project_db_v9`：`confirmed + active` 条目按内容去重导出为 MEMORY.md 种子（文件已存在则跳过，不覆盖用户手写），随后 `DROP memory_entries / memory_candidates / memory_recalls / memory_entries_fts`。`PROJECT_SCHEMA_VERSION` 8 → 9。

### 7. 面板即编辑器

`MemoryFilePanel`：文件编辑器 + 预算条（行/token 双指标）+ 保存（并发守卫）+ curator 状态行（最近一次动作：空闲 / 已更新 / 已拒绝 / 失败 / 超时）。

## 后果

- **删除**：`memory_*` 工具、账本读写/召回/审计、FTS 与近义合并、`cold-start` 派生收敛、memory IPC 路由与 Tauri 命令、`sessionBootstrapCache` 冻结与 `refreshBootstrap` epoch 机器、re-recall anchor 插入机制、`planMemoryWrite` 写入门与 `RequestContextInsertion`。
- **保留**：`envelopeContent` / `redactSecrets`（供管家机械门复用）、Session Bootstrap 分层（ADR-001/004）。
- 记忆可见性：从「最迟下次压缩有效」变为「保存后下一回合生效」。
- Recall 消失：所有记忆每回合全量注入；120 行硬上限就是预算。
- 质量责任转移：从确定性门 + 条目级规则转移到「管家提示词 + 机械兜底 + 用户可编辑」。
- 不支持按种类差异化注入（citation / procedure 等概念随账本一起退役）。
