# CodePapr 审计状态

- 日期：2026-09-30
- 本文是当前审计账本。下面三份旧清单已删除，不再当作待办：
  - `docs/AUDIT-2026-08-22.md`（全库点状审查）
  - `docs/AUDIT-2026-09-04-batch-c-d.md`（App / 市场 / 插件批次 C、D）
  - `docs/PROBLEMS.md`（2026-06 Windows MSI 与 LSP 打包记录）

旧文档里的行号和「请按此修复」步骤都已过时。结论以本页和代码为准。

## 已关闭

### 2026-06 Windows 打包

MSI 安装后的 LSP 根路径、`DOTNET_ROOT`、捆绑 `csharp-ls`、`HOME` / `USERPROFILE` 与 `CARGO_HOME` / `GOPATH` 拼接、JDTLS `.manager` 临时文件，都已进当前打包与运行时查找逻辑。

### 2026-08-22 抽查过的高危项

那份报告是当时的快照，不逐条重开。抽查后已不在原形态的包括：`assetProtocol.scope` 现为空数组；DeepSeek / Claude / Responses 流里的 `chunk.error` 会分类而不是无限重连；Claude `stop_reason: max_tokens` 会归一成 `length`；窗口 `CloseRequested` 不再同步跑两遍 `run_shutdown_cleanup`（清理只挂在进程 `Exit`）。

### 2026-09-04 批次 C / D

| 项 | 状态 |
| --- | --- |
| C-1 iframe 热重载取消在飞 `papr.agent.run` | 已落地 |
| C-2 权限缓存与 app override 按工作区隔开 | 已落地 |
| C-3 `allowCodepaprApps: false` 不再被短路放行 | 已落地 |
| C-4 离线 app 安装 npm 依赖不再静默联网 | 已落地 |
| C-5 非 macOS 进程沙箱 | 见下方「仍在的边界」，不是漏修 |
| D-1 … D-16（appId、CORS、市场脏数据、Hooks 早退、文案、死代码、`pruneOptions`、MCP local 轴、app agent todo、运行态对账、双作用域卸载、truncated tree、apps-lock） | 已落地。`exhaustive-deps` 仍有一批抑制注释，是接入插件时留下的存量，不是待修清单 |

### 2026-09-30 记忆整理门

ADR-017 的三处行为已改到和文档一致：

1. 文件超过预算 90% 时，整理未落盘且内容未变，会挡住后续回合。成功的测试 / 构建命令不能破墙。显式记住、持久禁令、记忆候选可以。
2. `consolidate` 的输出必须落在目标线以内（约 3200 tokens / 100 行），否则拒写（`over-target`），不会靠「略低于 4000」的重写一直循环。
3. 更新模式仍拒绝「零新增且删过半」。整理模式允许删过时条目，但新文本必须仍对得上旧事实（`consolidate-wash`）。

## 仍在的边界

这些是已知限制，不是上面清单里漏掉的待修项。

- **进程沙箱只在 macOS 强制。** Windows / Linux 上，app 的 `network: false` 与 `local ≤ read` 约束不到 bash 和后端进程。iframe 侧 CSP 仍然有效。启动和 Agent 运行时会打告警，`docs/USAGE.md` 写明了这一点。跨平台进程沙箱单独立项。
- **桌面 `http:default` 仍放行 `https://**` 与 `http://**`，只拒绝少量链路本地地址。** 这是 Tauri capability 的面，不是本次记忆改动的范围。
