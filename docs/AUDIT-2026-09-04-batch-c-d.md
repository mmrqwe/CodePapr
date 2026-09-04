# CodePapr 审计交接：批次 C / D 待修复问题

- 日期：2026-09-04
- 来源：App 模式 / 应用市场 / 插件调用三链路审计（批次 A「安全根」、批次 B「功能正确性」已修复合入）
- 使用说明：
  - 本文所有行号为审计时参考值，**批次 A/B 改动后可能漂移**（尤其 `app_runtime_pt1.rs`、`marketAppInstall.ts`、`app_market_install.rs`、`workspaceAppTools.ts`），定位时**优先按函数名/符号名搜索**。
  - 每项含：位置、症状、根因、修复建议、验证方法。

---

## 批次 C：运行时一致性（P1 级，5 项）

### C-1 iframe 热重载遗留孤儿 `papr.agent.run`

- 位置：
  - `packages/@codepapr/ui/src/papr/usePaprBridge.ts:656-665`（订阅 effect 的 cleanup）
  - `packages/@codepapr/ui/src/components/AppModal.tsx:82-108`（1.5s mtime 轮询自动 reload）、`AppModal.tsx:298`（`key={appId}-${updatedAt}` 换 iframe 文档）
- 症状：开发迭代中 agent 改一行 app 文件 → mtime 变化 → iframe 文档被换（key 变更）但宿主组件不卸载 → `handleMessage` identity 刻意稳定（见 usePaprBridge.ts:650-653 注释），cleanup 不触发 → 旧文档在飞的 `papr.agent.run` 继续烧 token；结果 `respond` 打到新文档被丢弃（iframe 内 `__papr_sdk.js` 的 pending map 查不到 reqId），新文档也无法 `agent.cancel`（不知道旧 reqId）。
- 根因：`activeAgentRuns` 生命周期绑定的是 `handleMessage`（稳定），而非「iframe 文档纪元」。
- 修复建议：
  1. `usePaprBridge` 返回值增加 `cancelAllRuns()`（遍历 `activeAgentRuns.current` 调 cancel 并 clear）；
  2. `AppModal` / `PluginOverlayHost` 在 `openedApp.updatedAt` 变化导致 key 更换前调用它（用 `useEffect(() => () => cancelAllRuns(), [updatedAt])` 或在换 key 的渲染路径上显式调用）。
- 验证：新增测试——模拟 updatedAt 变化后，断言旧 runId 的 cancel 被调用（可参照 `usePaprBridge` 现有测试基建 mock `ensureAgentForApp`）。

### C-2 papr 权限缓存跨项目串档 + overrides 无命名空间

- 位置：
  - `packages/@codepapr/ui/src/papr/permissionStore.ts`（`clearAll` 定义于 :35，全仓生产代码零调用，仅测试引用）
  - `packages/@codepapr/ui/src/App.tsx:147-169`（workspace 切换 effect 清了 runtime store，没清 permissionStore）
  - `packages/@codepapr/ui/src/papr/usePaprBridge.ts:183`（`manifestRef.current ?? manifests[appId]` 回退命中陈旧缓存）
  - `packages/@codepapr/ui/src-tauri/src/papr_runtime/permission.rs:88`（`app_overrides: HashMap<String, PaprAccess>` 全局按 appId 键）
- 症状：项目 A 的 app `demo`（manifest 解析失败 → prop 为 null）切到项目 B 的同 id app 时命中 A 的陈旧 manifest（错误的 agents/访问档）；`manifests` 缓存无界增长。用户逐 app 覆盖（appOverrides）也是全局按 appId 存——跨项目同名 app 互相收窄/放大权限。
- 修复建议：
  1. `App.tsx` workspace 切换 effect 中调 `usePermissionStore.getState().clearAll()`（注意与 C-1 的 run 取消顺序无冲突）；
  2. overrides 键加 workspace 命名空间：Rust `permission.rs` 与 TS `levelGrants.resolveEffectiveAccess` 的 `appOverrides[appId]` 改为 `appOverrides[<workspaceKey>::<appId>]`（或嵌套 map），带旧格式迁移（读时兼容裸 appId 一次并回写）。
- 验证：测试「切 workspace 后 manifests 为空」；同名 app 在两个工作区分别设置不同 override 互不影响。

### C-3 `allowCodepaprApps` 是死参数（短路吞掉）

- 位置：`packages/@codepapr/ui/src/tools/codepaprAgentAccess.ts:103`
  ```ts
  return mode === 'app' || appAccess?.allowCodepaprApps === true || Boolean(appAccess);
  ```
  Rust 同款：`crates/codepapr-core/src/agent_runtime_tools.rs`（搜 `allow_codepapr_apps` / `unwrap_or(true)`）；`crates/codepapr-core/src/shell/sandbox.rs` 注释却称该位"默认关"。
- 症状：第二个子句被第三个 `Boolean(appAccess)` 吞掉——任何带 `appAccess` 的调用一律放行 `.CodePapr/apps`，想以 `{ allowCodepaprApps: false }` 收窄无效。当前调用方（`agentRuntimeLoop.ts` 恒传 true）行为不变，但参数语义已死，且 `effectiveCodePaprMode` docstring 与实现矛盾。
- 修复建议：改为 `mode === 'app' || appAccess?.allowCodepaprApps === true`；Rust 侧同步收紧；更新 `codepaprAgentAccess.test.ts`（现有用例把该行为固化为"特性"，搜 `allowCodepaprApps`）。
- 验证：单测 `appAccess: { allowCodepaprApps: false }` 时 `effectiveCodePaprMode` 返回非 'app'。

### C-4 `install_app_npm_deps` 恒定联网，无视 app `network:false`

- 位置：`packages/@codepapr/ui/src-tauri/src/app_runtime_pt1.rs:242-247`（批次 B 后行号，原 :209）
  ```rust
  let access = SandboxAccess { network: true, workspace_write: false, allow_bind: true, allow_codepapr_apps: false };
  ```
  调用方：`packages/@codepapr/ui/src/tools/workspaceAppTools.ts` `launchAppBackend`（invoke 'install_app_npm_deps' 处）。
- 症状：声明"完全离线"（network:false）的本地后端 app 启动时仍从 npm registry 拉任意包；macOS 上 sandbox-exec 按 network:true 放行，CSP 管不到这一层。
- 修复建议：`launchAppBackend` 已有 `appAccess`（生效档），把 `network` 传入命令（新参 `allowNetwork: Option<bool>`，缺省 true 保持兼容）；false 时：若 `node_modules` 已存在则跳过，否则返回明确错误「该应用声明离线，需要用户放开网络后重试」而不是静默联网。
- 验证：Rust 单测断言 `allow_network=false && node_modules 缺失` 时返回 Err；TS 测试断言 invoke 参数携带 network。

### C-5 两轴沙箱仅 macOS 生效，Windows/Linux 静默失效（原 P0-3 降级处理）

- 位置：`crates/codepapr-core/src/shell/sandbox.rs:487-503`（`#[cfg(not(target_os = "macos"))]` 分支 `let _ = access;`，只校验 cwd 在工作区内）
- 症状：Windows（目标平台）上 `local:read`/`network:false` 的 app agent 经 `bash` 可写任意工作区文件、可 `curl` 联网；后端进程同理。UI/权限面板按"完全断网"呈现，属虚假承诺。
- 修复建议（本批次只做告警，完整沙箱另立项）：
  1. 非 macOS 平台：当 `access.network == false || access.workspace_write == false` 时，`sandboxed_command` / `sandboxed_shell_command` 走 `start_app_background_command` 与 app agent bash 的路径上返回明确警告（或拒绝 + 引导用户在设置里确认风险）；
  2. 至少：`launchAppBackend` 与 `handleRunAppAgent` 在非 mac 平台检测到收窄档时向 UI 推一条 warning 日志；
  3. 文档修正：`docs/USAGE.md`（搜「JS 无法绕过」/CSP 段，约 :158）与 `USAGE.en.md` 补注「bash/后端进程级隔离仅 macOS 生效」。
- 验证：Windows 上以 network:false 的 app 起后端，UI 出现告警；USAGE 文案更新。

---

## 批次 D：P2 清理（10 项）

### D-1 appId 校验收紧统一

- 位置：
  - `packages/@codepapr/ui/src-tauri/src/app_runtime_pt1.rs:57`（`is_valid_app_id`：允许 `.` 段、大写、空格）
  - `packages/@codepapr/ui/src-tauri/src/app_market_install.rs:7`（同款拷贝）
  - agent 侧已强制 kebab-case：`workspaceAppTools.ts`（app_render/app_publish 的 `/^[a-z0-9][a-z0-9-]{0,62}$/`）
- 症状：appId 是 URL host（`codepapr-app://<appId>/`），host 会被浏览器引擎小写化——`MyApp` 装完即 404（Linux/macOS 大小写敏感 FS）；`MyApp` 与 `myapp` 协议层无法区分；带空格/点的 id 生成畸形 origin。
- 修复：两处 `is_valid_app_id` 统一为 kebab-case 正则；TS 安装前对 `listing.id` 预检（`marketAppInstall.ts`）给出友好错误。注意：收紧后老用户已装的非规范 id 目录会失效——在 scan/uninstall 保留宽校验、install/register 收紧，或带一次性迁移提示。
- 验证：Rust 单测 + `marketAppInstall.test.ts` 拒绝 `My App`。

### D-2 协议 `Access-Control-Allow-Origin: *` 削弱 app 间隔离

- 位置：`packages/@codepapr/ui/src-tauri/src/app_runtime_pt2.rs:448`（serve 响应）、`app_runtime_pt1.rs:49`（`resp()` 错误响应）
- 症状：每个 app 独立 origin（`codepapr-app://<appId>`）的设计意图是 app 间隔离，但 ACAO `*` 允许 app A 的 JS `fetch('codepapr-app://B/...')` 读取 app B 的静态文件（manifest.json、JS 源码；db.sqlite 已被 `is_unservable_app_file` 挡住）。
- 修复：协议响应按请求 origin 回 `Access-Control-Allow-Origin`，默认不回 CORS 头（同源 iframe 自己加载资源不需要 ACAO；后端跨源走 `http://127.0.0.1:port` 与 CSP 白名单）。改后跑 `app_runtime` 全套测试防回归。
- 验证：新增测试：serve 响应不再含 `*`；AppModal 加载（同源）不受影响。

### D-3 registry 条目零校验，缺字段炸弹窗

- 位置：`packages/@codepapr/ui/src/tools/marketAppApi.ts`（`registry.apps ?? []` 原样透传）、`components/AppMarketModalViews.tsx`（搜 `listing.tags.length`——条目缺 `tags` 直接 TypeError）
- 症状：registry 一条脏数据（缺 tags/id/directory）→ 整个市场弹窗白屏。
- 修复：`fetchMarketAppListings` 里逐条运行时校验（id/version/directory 为 string、tags 数组、kind ∈ {app,plugin}），非法条目过滤并 console.warn。
- 验证：`marketAppApi.test.ts` 加脏条目用例。

### D-4 `AppModal` Rules of Hooks 违例 + eslint 无 react-hooks

- 位置：`packages/@codepapr/ui/src/components/AppModal.tsx:152-158`（`if (!openedApp) return ...` 早于 `usePaprPermissionStore(...)`）；`eslint.config.mjs` 未启用 `eslint-plugin-react-hooks`
- 症状：当前靠「openedAppId 非空但 app 不在列表」窗口极窄未爆；任何异步 closeApp 竞态会触发 "Rendered more hooks..."。
- 修复：把该 hook 提到 early return 之上；eslint 配置引入 `react-hooks` 插件（rules: rules-of-hooks=error，exhaustive-deps 可先 warn）。

### D-5 ModeSelector 硬编码文案 + i18n 死键

- 位置：`components/chat/ModeSelector.tsx`（搜 `lang === 'en' ? 'App'` 与内联提示字典）；`utils/i18n.ts`（`appMode/agentMode/planMode/askMode/currentMode` 键，搜 `appMode: '应用'`）
- 症状：i18n 定义了 `appMode: '应用'` 等键但无组件消费；中文界面实际显示硬编码 "App"。
- 修复：ModeSelector 改用 `getTranslation(lang)` 现有键（或删死键，二选一保持单一事实源）。

### D-6 `app_market_install.rs` plugin-data 清理是死代码

- 位置：`packages/@codepapr/ui/src-tauri/src/app_market_install.rs`（`workspace_plugin_data_dir` 函数与 `papr_uninstall_app` 中 `remove_data` 第二段清理块）
- 症状：全仓无任何写入 `.CodePapr/plugin-data/<id>` 的代码（真实数据在 `<appDir>/db.sqlite`）；卸载全局应用时却删**当前工作区**的 plugin-data——方向错误的残留逻辑。
- 修复：删除 `workspace_plugin_data_dir` 与其调用块；顺带 grep 确认无外部约定后再动。

### D-7 `streamingWorkspaceCommand.ts` 死代码

- 位置：`packages/@codepapr/ui/src/tools/streamingWorkspaceCommand.ts`（`runStreamingWorkspaceCommand` 无生产调用方，仅自身测试引用）
- 修复：连同测试一并删除，或接入实际调用点（若原计划替换 workspaceExecTools 的阻塞路径，开 TODO 注明）。

### D-8 `createAgent` 主线程兜底丢 `pruneOptions`

- 位置：`packages/@codepapr/ui/src/store/internals/agentFactory.ts`（搜 `createAgent` 内重建 `Agent` 处，审计时 :610）
- 症状：worker 路径带 `pruneOptions`（ADR-006 渲染参数冻结），主线程兜底重建不带——同一会话两条运行时上下文裁剪行为不一致。
- 修复：兜底路径透传 `pruneOptions`，与 `buildAgentSessionParts` 对齐。

### D-9 `buildModeSwitchMessage` 的 app 分支不可达

- 位置：`packages/@codepapr/ui/src/store/internals/sendMessage.ts`（搜 `buildModeSwitchMessage`，审计时 :299-310）
- 症状：该消息仅在历史含 ask 回复时注入；ask 起始会话被锁为 coding、app 起始会话锁为 app → app 分支是死文案。
- 修复：删 app 分支或在锁逻辑变更时恢复；补注释说明可达性依赖会话锁规则。

### D-10 `AppAgentPayload.mode` 注释与实现不符

- 位置：`packages/@codepapr/ui/src/agent/agentWorkerProtocol.ts`（搜 `AppAgentPayload`，mode 字段注释称"Sidecar 文件闸门用"，审计时 :361-362）；`agentRuntimeLoop.ts` `handleRunAppAgent`（系统提示恒以 `mode:'agent'` 构建，审计时 :1192-1199）
- 症状：mode 字段从不被读取，`WorkerBackedAgent.ts` 的转发是空转。
- 修复：要么让 handleRunAppAgent 真正使用 payload.mode 构建闸门上下文，要么删字段+注释+转发。

### D-11（安全设计项）app agent 的 `mcp__` 工具面过宽

- 位置：`packages/@codepapr/ui/src/store/internals/agentRuntimeLoop.ts`（搜 `mcp__`，审计时 :1156-1158）
- 症状：app 内 agent 只要 `network:true` + manifest 白名单字符串即可调用**用户配置的任意 MCP server**（含本机文件/命令类 server）。权限模型把 MCP 当纯网络能力，与 `local:none` 的用户直觉不符。
- 修复建议：把 MCP 调用按 server 类型计入 local 轴（stdio/本地命令类 server 要求 local≥read）；或首次 app 调用某 MCP server 时走 `pendingMcpConfirm` 逐 app 确认（UI 已有该基建）。

### D-12 `ensureAgentForApp` 悄悄新建会话并把 todo 绑到它

- 位置：`packages/@codepapr/ui/src/store/internals/agentStore.ts`（搜 `ensureAgentForAppInternal`，审计时 :353-357）；`agentRuntimeLoop.ts`（`registerTodoListTools(registry, config.sessionId)`）
- 症状：用户从未发过聊天消息时，`papr.agent.run` 会创建一个隐藏会话承载 app agent；app agent 的 `todo` 工具输出出现在该会话 UI 清单里（跨边界副作用），用户不知情。
- 修复建议：给 app agent 宿主会话打标记（如 `kind:'app-agent-host'`）在会话列表隐藏/只读；或 app agent 直接去掉 `todo` 工具（`agentToolsFor` 里可配）。

### D-13 `app_stop` 与 `app_list` 的运行态判定不一致

- 位置：`packages/@codepapr/ui/src/tools/workspaceAppTools.ts`（app_stop 只看 store `app.pid`；app_list 的 `isRunning` 还看 Rust 注册表端口对账，搜 `regRunning`）
- 症状：store 未对账（webview reload 后）时 list 显示 running、stop 报"未在运行"。
- 修复：app_stop 复用 app_list 的判定：store 无 pid 时按 `manifest.port`/运行时端口从 `list_background_processes` 找回 pid 再停（restoreWorkspaceApps 已有同款对账代码可提取复用）。

### D-14 市场卸载/双作用域管理盲区

- 位置：`components/AppMarketModalBody.tsx`（搜 `purgeData: true` 写死；卸载成功后无 rescan）、`app_runtime_pt3.rs` `scan_workspace_apps`（同名合并只留 workspace）、`AppMarketModalViews.tsx`（卡片单一 scope 角标）
- 症状：(a)「保留数据卸载」（remove_data=false 分支）UI 不可达，确认文案却如实说永久删除；(b) 同名双装（global+workspace）时全局副本不可见不可卸，卸掉 workspace 版后卡片状态误导；(c) 卸载后不重扫。
- 修复：确认框加"保留数据"复选框；列表按 scope 分行/双角标；卸载成功后 `remountDiscoveredApps(workspacePath || '', ...)` 或最小化——从 store 移除并刷新 installed 集合。

### D-15 Tree API `truncated` 未处理

- 位置：`packages/@codepapr/ui/src/tools/marketAppInstall.ts` `fetchAppTreeFileList`（读 `data.tree` 处）
- 症状：GitHub tree 响应 `truncated:true`（大仓库）时拿到残缺文件清单仍继续 → "成功"安装缺文件的应用。
- 修复：`data.truncated === true` 时视为策略失败（返回 null 降级到策略 3，或直接报错）。

### D-16 更新判定的双事实源

- 位置：`packages/@codepapr/ui/src/utils/marketAppVersion.ts`（比较盘上 manifest.version 与 registry listing.version）
- 症状：两个独立维护的字符串，不匹配时"可更新"角标永久失真。
- 修复：安装时把 `listing.version` 写入安装记录（apps 需要自己的 lock 文件，参照 `utils/skillsLock.ts` 先例：`.CodePapr/apps-lock.json` 记录 id/version/sha256/来源），更新判定读 lock 文件而非盘上 manifest。
- 关联遗留（批次 A 尾巴）：registry 仓库侧（`mmrqwe/codepapr-apps`）需配合产出 per-file `sha256` 字段与 commit-SHA 固定 pin——客户端校验逻辑已就绪（`verifyFileIntegrity`），registry 补字段即生效。

---

## 建议实施顺序

C-3（一行改动、恢复参数语义）→ C-4 → C-1 → C-2 → C-5（告警先行）→ D-1（注意存量 id 兼容）→ D-3/D-15（市场健壮性小项打包）→ D-14/D-16（市场 UX+lock 文件）→ D-2（需跑回归）→ D-4~D-13 按文件就近清理。

## 回归基线（批次 A+B 完成后）

- TS：core 629 项、ui 1746 项通过；已知预存在失败 3 项（settingsNormalizer ×2、SettingsModal ×1，均为 maxContextTokens 200k/220k 默认值断言，与本审计无关）。
- Rust：codepapr-core 319、tauri crate 161 通过；`cargo fmt` 仓库整体未强制（大量预存在 diff），不要全量 `cargo fmt`。
- 编译 tauri crate 需占位 sidecar：`packages/@codepapr/ui/src-tauri/binaries/codepapr-server-x86_64-pc-windows-msvc.exe`（空文件即可过 build script，测完删除）。
