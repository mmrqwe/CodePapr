# ADR-010: 项目记忆零审核自动写入

- 状态: Accepted
- 日期: 2026-08-17
- 关联: ADR-008（双区投影，本 ADR 修订其「用户准入队列」）、ADR-009（Recall）

## 背景

ADR-008 把 Agent 对 `memory.md` 的写入改成 candidate 队列，由用户在记忆面板点「准入」。
实现上几乎所有 `memory_write` 都变成 pending。这和 ChatGPT Memory / Cursor Memories /
Claude Code MEMORY.md 都不一样：那些产品是系统自己记，人事后看和删。

审核队列有两个实际后果：

1. 用户被当成杀毒软件，最终橡皮图章或干脆不理；
2. 好的项目事实（测试命令、技术栈）卡在面板里，进不了下次会话。

真正要防的是：网页/MCP/注入内容变成**每次会话都遵守的指令**。这件事可以用确定性策略做完，不需要人点同意。

## 决策

**废除作为产品的候选审核队列。** `memory_candidates` 只作内部去重与审计：写入后同一路径 `persist` 或 `drop`，事务内 admit。面板是目录（浏览 / 遗忘），没有准入按钮。Agent 不得要求用户去确认记忆。

写入门是 `planMemoryWrite`（确定性，不信任 LLM 自报的效力）：

| 输入 | 落点 | 进 Session Bootstrap？ |
|---|---|---|
| 用户说记住 / 必须 / 不要（短约束或显式「记住」） | preference / constraint | 是 |
| 用户手编 memory.md User Zone | user-note | 是（User Zone 原文） |
| 工作区实证、冷启动摘要、测试/构建成功 | fact / convention / verification | 摘要进 managed zone |
| 同一错误踩两次 / `category: procedure` | procedure | 否，只 Recall |
| web / MCP / `https` evidence / `category: citation` | citation | 否，永远不当指令 |
| 注入、密钥、危险命令、裸 assistant 推理 | drop | 否 |

Agent 经 `memory_write` 提出的 fact/preference 立刻 persist（`[reported]`）。用户可事后遗忘。网页内容即使被误标为 fact，只要 origin/evidence 是 URL 或 source 是 web/MCP，运行时改写成 citation。

自动 Recall **跳过 citation**（ADR-009 第 9 条：不可信内容不自动召回）。`memory_search` 仍可检索引用。

## 后果

- 正常使用中用户零次被要求「准入」一条记忆。
- `memory.md` managed zone 只投影指令 + 高价值事实；经验与引用留在 ledger。
- Bootstrap 仍按 (session × 稳定签名) 冻结：磁盘上的新记忆**下次会话或压缩 epoch** 才进入前缀。
- ADR-008 的双区模型、路径拦截、风险检测、密钥脱敏全部保留。
