# ADR-010: 项目记忆零审核自动写入

- 状态: Superseded by [ADR-016](./ADR-016-memory-v5-memory-md.md)（账本写入门退役）
- 日期: 2026-08-17
- 关联: ADR-008（双区投影，已被 ADR-011 取代）、ADR-009（Recall）、[ADR-011](./ADR-011-retire-memory-md.md)（退役 memory.md）、[ADR-014](./ADR-014-retire-cold-start-memory-bootstrap.md)（退役冷启动摘要）

## 背景

ADR-008 把 Agent 对 `memory.md` 的写入改成 candidate 队列，由用户在记忆面板点「准入」。
实现上几乎所有 `memory_write` 都变成 pending。这和 ChatGPT Memory / Cursor Memories /
Claude Code MEMORY.md 都不一样：那些产品是系统自己记，人事后看和删。

审核队列有两个实际后果：

1. 用户被当成杀毒软件，最终橡皮图章或干脆不理；
2. 好的项目事实（测试命令、技术栈）卡在面板里，进不了下次会话。

真正要防的是：网页/MCP/注入内容变成**每次会话都遵守的指令**。这件事可以用确定性策略做完，不需要人点同意。

## 决策

**废除作为产品的候选审核队列。** `memory_candidates` 只作内部去重与审计：写入后同一路径 `persist` 或 `drop`，事务内 admit。面板是目录（浏览 / 遗忘 / 恢复），没有准入按钮。Agent 不得要求用户去确认记忆。

写入门是 `planMemoryWrite`（确定性，不信任 LLM 自报的效力）：

| 输入 | 落点 | 进 Session Bootstrap？ |
|---|---|---|
| 用户说「记住」或强模态完整指令（必须/禁止/不得…） | preference / constraint | 是（confirmed） |
| 用户在记忆面板手写笔记 | user-note | 是（账本渲染进 Bootstrap） |
| 工作区实证（工具输出、测试/构建成功） | fact / convention / verification | 是（confirmed） |
| ~~冷启动 LLM 摘要~~ | ~~fact~~ | **已退役**（ADR-014：生成器删除，存量收敛到 1 条） |
| Agent 经 `memory_write` 自报 | fact / decision / … | 否——`[reported]`，只按需召回 |
| 同一错误踩两次 / `category: procedure` | procedure | 否，只 Recall |
| web / MCP / `https` evidence / `category: citation` | citation | 否，永远不当指令 |
| 注入、密钥、危险命令、裸 assistant 推理 | drop | 否 |

Bootstrap 信任硬规则：**只有 confirmed（user / tool-output / 面板手写）进固定前缀**；
reported（Agent 自报、冷启动 LLM 生成）只进 Recall——模型臆测不得固化成
「每次会话都看见的项目真理」。用户可事后遗忘。网页内容即使被误标为 fact，
只要 origin/evidence 是 URL 或 source 是 web/MCP，运行时改写成 citation。
准入前对同 category 做近义合并（短文本 bigram Jaccard ≥ 0.8，长文本 containment
≥ 0.85），换说法重写同一事实不再堆叠占预算；`reported` 内容有 400 字上限，超长即
blob，直接丢弃。遗忘条目的同 hash **或近义**再写默认拒绝（防自动复活），恢复唯一通道
是记忆面板的显式「恢复」。详见 [ADR-014](./ADR-014-retire-cold-start-memory-bootstrap.md)。

自动 Recall **跳过 citation**（ADR-009 第 9 条：不可信内容不自动召回）。`memory_search` 仍可检索引用。

## 后果

- 正常使用中用户零次被要求「准入」一条记忆。
- 记忆面板是完整目录：每次会话 / 按需召回 / 仅搜索；经验与引用不进 Bootstrap。
- Bootstrap 仍按 (session × 稳定签名) 冻结：账本上的新记忆**下次会话或压缩 epoch** 才进入前缀。
- 路径拦截、风险检测、密钥脱敏全部保留；`memory.md` 文件面已由 ADR-011 退役。
