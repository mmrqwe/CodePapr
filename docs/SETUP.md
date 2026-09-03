# 安装、验证与运维

日常交互见 docs/USAGE.md。架构全貌见 docs/ARCHITECTURE.md。

## 2. 支持环境

### 2.1 开发机要求

- Node.js 20.19+
- npm 9+
- Rust toolchain 和 Cargo

**Rust 不是可选项。** 仓库是 Node workspace + Cargo workspace 双栈：

- `crates/codepapr-core`、`crates/codepapr-server`、`crates/codepapr-cli`、`packages/@codepapr/ui/src-tauri` 都是 Rust crate（见根 `Cargo.toml`）；
- CLI（`codepapr-cli`）是 Rust 二进制，不是 Node 脚本，必须 `cargo build -p codepapr-cli`；
- 连 `npm run build` 都需要 cargo——`@codepapr/ui` 的 build 是 `typecheck && build:host-server && build:sidecar && build:frontend`，其中 `build:host-server` 会调用 `scripts/prepare-host-server.mjs` 编译 `codepapr-server`。

只有单跑 `npm run lint`、`npm run test`（纯 vitest 部分）这类命令时才不碰 Rust。浏览器烟测需要本机 Chrome / Chromium。

### 2.2 当前主要开发环境

- macOS arm64
- Windows

### 2.3 外部依赖

根据你要执行的操作，可能还需要：

- DeepSeek、OpenAI 或 Claude 兼容 provider 的 API key
- 可用的浏览器二进制，用于页面交互与截图链路
- VS Code，用于使用工作区任务和调试配置
- Python 3.10+，用于 TTS 语音合成功能（GPT-SoVITS）；语音功能还需要 ffmpeg（macOS 可通过 Homebrew 安装）
- .NET SDK，用于 release 打包内置的 C# Roslyn analyzer，或开发态通过 `dotnet run` 拉起 analyzer；debug / test 会优先使用源码 sidecar，release 会优先使用打包 sidecar
- 桌面端多语言 LSP server：官方桌面 release / publish 构建会把 `typescript-language-server`、`vscode-langservers-extracted`、`yaml-language-server`、`pyright`、`bash-language-server`、Node.js runtime、Roslyn sidecar、`jdtls`、Temurin JRE、`clangd`、`rust-analyzer` 一并打进安装包，用户首次使用这些默认语言时不需要再额外下载。开发态或自定义构建如果缺少这些资产，桌面端仍会按需走托管安装；Go 额外可复用本机 `gopls`

托管下载/安装的上游工具与许可证：Eclipse JDTLS（EPL-2.0）、Eclipse Temurin JRE（GPL-2.0 with Classpath Exception）、clangd（Apache-2.0 with LLVM exception）、rust-analyzer（MIT / Apache-2.0）。如需禁用自动托管下载，可设置 `CODEPAPR_DISABLE_MANAGED_LSP_DOWNLOAD=1`。

## 3. 安装与引导

### 3.1 标准安装

```bash
npm install
npm run build
```

桌面端构建（`cargo check` / `npm run debug` / `release` / `publish`）通过 crates.io 拉取 tree-sitter 及各语言 grammar 的最新兼容版本，不再依赖 `.cargo-vendor/*` 子模块。

`npm run build` 已经包含了 `codepapr-server` 的编译，所以这两步跑完你手上就有一个可用的宿主二进制。
如果你要对仓库做提交级别修改，建议继续跑完整验证。

### 3.2 安装验收

最小验收标准：

```bash
npm run verify
```

通过这一步，说明当前机器至少满足：

- Node 依赖安装正确
- workspace build 正常（含 codepapr-server 编译）
- workspace tests 正常
- Tauri cargo check 正常

### 3.3 只要 Rust 侧

```bash
cargo check --workspace          # core + server + cli + 桌面 crate
cargo build -p codepapr-server   # 宿主守护进程
cargo build -p codepapr-cli      # CLI 客户端
cargo test -p codepapr-core      # 领域库单测，不需要 Tauri
```

## 4. 配置与本地运行前提

### 4.1 应用级配置

CodePapr 当前将应用级配置保存在：

- ~/.codepapr/codepapr.sqlite

其中包括 provider、model、API key、system prompt、语言和采样参数。

> 注意所有权：这个库由 `codepapr-core::db` 打开和写入，也就是**宿主进程（codepapr-server）**在写，桌面端通过 `db/loadSettings`、`db/saveSettings` 等 RPC 访问，不再自己拿着 SQLite 句柄。API key 是例外：明文只在客户端的 Stronghold vault / keyring 里，启动后经 `secrets/import` 单向推给宿主的内存态存储。

全局 App（.papr 插件）安装在：

- ~/.codepapr/apps/&lt;appId&gt;/

角色参考音频和 TTS 语音模型数据保存在：

- ~/.codepapr/voices
- ~/.codepapr/gpt-sovits

### 4.2 项目级状态

工作区被打开后，项目级状态保存在：

- &lt;workspace&gt;/.CodePapr

这部分现在主要包括 project.sqlite、项目级 store 和 skills；旧版 state.json / project.json 会在首次打开或保存时自动导入到 SQLite。工作区作用域的 App 装在 `&lt;workspace&gt;/.CodePapr/apps/&lt;appId&gt;/`，同 `appId` 时优先于全局安装。

### 4.3 真实模型相关前提

以下场景依赖有效模型配置：

- 桌面端实际对话与执行
- CLI 真实 chat / run 调用
- smoke:agent-tools

如果只跑 test、verify:ci，通常不需要真实模型凭据。

### 4.4 宿主进程与两个 sidecar

运行期一共会牵扯三个可执行体，别搞混：

| 名字 | 是什么 | 谁编译 / 谁拉起 |
| --- | --- | --- |
| `codepapr-server` | Rust 宿主守护进程，Tauri `externalBin` sidecar | `scripts/prepare-host-server.mjs`（`npm run build:host-server`）编译并 stage 到 `src-tauri/binaries`；运行时由桌面端 `host.rs` 拉起 |
| `agent-runtime.mjs` | Node ESM agent 运行时，Tauri `resources` | `packages/@codepapr/ui/scripts/build-sidecar.mjs`（esbuild）打包；运行时由 **宿主侧** `codepapr-core::agent_runtime` 拉起（桌面端只在 `agent/start` 里把 `resourceDir` 传过去） |
| `codepapr`（Tauri bin）/ `codepapr-cli` | 客户端 | `cargo` |

桌面端启动宿主的规则（`src-tauri/src/host.rs`）：

1. 设置了 `CODEPAPR_SERVER_URL`（例如 `127.0.0.1:9090`）→ 直接连该地址，**不**拉子进程、退出时也不杀它；
2. 否则查找二进制：`CODEPAPR_SERVER_BIN` → 与当前可执行文件同目录 → Tauri `resourceDir`（含 `bin/`、`_up_/`）→ `target/{debug,release}` → `../../../../target/{debug,release}` → `PATH`；
3. 以 `--port 0 --port-file <temp>/codepapr-server-<pid>.port` 拉起，从 port-file 或 stderr 行 `[codepapr-server] listening on <addr>` 拿到实际端口（15s 超时、40ms 轮询）；
4. 连上后发 `initialize`。

找不到二进制时报错是 `Could not locate 'codepapr-server' binary. Build it with 'cargo build -p codepapr-server' or set CODEPAPR_SERVER_BIN.`

开发时想把宿主拆出来单独调试：

```bash
# 终端 A：手工起宿主（带工作区默认值）
cargo run -p codepapr-server -- --port 9090 --workspace /absolute/path/to/workspace

# 终端 B：让桌面端挂上去，而不是自己再拉一个
CODEPAPR_SERVER_URL=127.0.0.1:9090 npm run debug
```

不带 `--port` 时 `codepapr-server` 走 stdio 模式，这也是 `codepapr-cli` 在没有 `--server` 时自动拉起的形态。

## 5. 验证策略

CodePapr 当前的验证链路可以按“范围”和“成本”来理解。

### 5.1 命令矩阵

| 命令 | 范围 | 适合场景 |
| --- | --- | --- |
| npm run build | 全 workspace 构建（含 codepapr-server 编译 + agent sidecar 打包） | 改完源码后确认产物可生成（UI 包构建前会先跑 `tsc --noEmit`） |
| npm run test | 全 workspace 测试 | 日常主回归 |
| npm run test:e2e:ui | Playwright UI E2E | 改到桌面端 UI 组件、Toast、权限对话框、代码审查面板 |
| npm run test:e2e:ui:install | 安装 Playwright Chromium | 首次运行 UI E2E 或 CI 环境准备 |
| npm run lint | 静态检查 | 提交前质量门禁 |
| npm run audit | 依赖安全检查 | 发布前或依赖变更后 |
| cargo check --workspace | Rust 四个 crate 类型检查 | 改到 core / server / cli / 桌面 crate |
| cargo test -p codepapr-core | 领域库单测 | 改到 fs / git / shell / lsp / db / snapshot 实现 |
| CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics | 外部 workspace 桌面烟测 | 改到工作台项目诊断、文件树、代码预览、本地标记降级 |
| npm run smoke:lsp-preview | 真实多语言 LSP 烟测 | 改到代码预览的 hover、definition、后台预热，或外部 LSP / 内建 fallback 接线 |
| npm run verify:ci | lint + audit + build + test | 提交前一键本地检查 |
| npm run verify | verify:ci + check:tauri | 本地最完整验证 |
| npm run smoke:agent-tools | 真实模型工具烟测 | 改到工具选择、预览、shell、浏览器交互、project diagnostics 或绝对路径文件读取 |

> `npm run audit` 对注册表不可达默认**按失败处理**（避免网络波动时静默放行含已知漏洞的依赖进入发布链路）。确需离线跳过时，显式设置 `CODEPAPR_AUDIT_SKIP_ON_NETWORK_FAILURE=1`。

### 5.2 推荐回归顺序

提交前推荐顺序：

1. npm run build
2. npm run test
3. npm run test:e2e:ui
4. npm run verify

首次运行 UI E2E 前需要安装浏览器依赖：

```bash
npm run test:e2e:ui:install
```

如果你改到了 RPC 路由（`crates/codepapr-server/src/handler.rs`）、领域库或桌面端的 RPC 代理，先补：

```bash
cargo check --workspace
cargo test -p codepapr-core
```

如果你改到了桌面端原生桥接、后台命令、浏览器交互、预览会话或工具选择，再补跑一次：

```bash
npm run smoke:agent-tools
```

如果你改到了桌面工作台里的项目诊断、文件树、代码预览，或者“项目诊断正常、本地编辑器标记降级”这条判定链，再补跑一次：

```bash
CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics
```

如果你改到了代码预览里的 LSP hover、definition、后台预热，或者补了新的语言 server / 缺失安装提示，再补跑一次：

```bash
npm run smoke:lsp-preview
```

这条 smoke 会生成 TypeScript、C#、Rust、Java、Python、C++ 小工程，并验证真实 LSP 的 hover、definition、`documentSymbol`。对官方桌面发布包，这些默认语言资产应当已随安装包内置；开发态或非官方构建缺少 Node.js runtime、`rust-analyzer` component、`jdtls` 或 `clangd` 时，仍会按真实运行路径补齐。需要完全离线验证时可先准备好这些工具，或设置 `CODEPAPR_DISABLE_MANAGED_LSP_DOWNLOAD=1`。

### 5.3 各验证项说明

#### workspace tests

```bash
npm run test
```

这条链路覆盖 core、api、ui 等主路径的 vitest 测试，是最常用的本地回归入口。注意它不覆盖 Rust 侧，Rust 走 `cargo test`。

#### 完整验证

```bash
npm run verify
```

这是当前仓库默认的本地发布前验证入口（`verify:ci` 再加 `check:tauri`）。

#### Agent 工具烟测

```bash
npm run smoke:agent-tools
```

这条链路更接近真实使用场景，但依赖：

- 真实模型配置
- 浏览器环境
- 当前机器的桌面端运行条件

当前 smoke:agent-tools 默认覆盖 5 类强制场景：文件搜索、远程下载、页面交互、持续 shell 会话，以及“必须调用 diagnostics + 使用带绝对路径锚点的 read”。

因此它更像本地运维级回归，不是最基础的 CI 门禁。

#### 宿主连通性自检

```bash
cargo run -p codepapr-cli -- doctor
cargo run -p codepapr-cli -- ping
cargo run -p codepapr-cli -- --server 127.0.0.1:9090 server info
```

`doctor` 即使连不上宿主也会输出环境报告，适合排查“桌面端起不来到底是前端还是宿主的问题”。

#### 桌面端 LSP 检查

代码预览现在会按语言族启动对应的 stdio LSP server，并在同一工作区内按 family 复用 server。LSP 进程由**宿主侧** `codepapr-core::lsp` 管理，桌面端只通过 `lsp/*` RPC 驱动。默认随 `npm install` 安装的语言族包括：

- TypeScript / TSX / JavaScript / JSX
- HTML / CSS / SCSS / LESS
- JSON / JSONC
- YAML
- Python

此外，TypeScript / JavaScript、HTML / CSS / JSON、YAML、Python、ShellScript 这组 Node 系语言会优先使用安装包内置的 Node.js runtime 和内置语言服务器，其次才回退到本机 `node` 或托管缓存；C# 会按优先级依次尝试系统 `csharp-ls`（dotnet tool）、应用内置的 `CodePapr.CSharp.Analyzer`（Roslyn sidecar）、`omnisharp -lsp`，均支持跨文件与跨 `ProjectReference` 解析；Java / C/C++ 会先查找应用打包资源，再尝试托管下载 `jdtls` / `clangd`，然后才退回到本机 PATH 里的同名 server，最后落到应用内建 fallback。Rust 会优先使用安装包内置的 `rust-analyzer`，缺失时才回退到 rustup 或系统 PATH。Go 仍优先依赖本机 `gopls`。Swift 在 macOS 上走 Xcode toolchain 的 `sourcekit-lsp`。SQL 和 Markdown 分别走内置的 `sqls` 和 `marksman`。依赖变更或 LSP 桥接改动后，至少确认：

```bash
npm run check:tauri
node ./scripts/run-module-bin.mjs typescript/bin/tsc -p packages/@codepapr/ui/tsconfig.json --noEmit
```

运行桌面端时至少打开一个 `.ts`/`.tsx`/`.js`/`.jsx`/`.html`/`.css`/`.json`/`.yaml`/`.py` 文件，预览应先尽快显示文件内容；随后只有当前打开文件才会在后台异步懒加载 LSP、符号和 diagnostics，工作区启动本身不应批量触发 `lsp/openDocument`、lint、typecheck 或项目诊断。再分别打开 `.cs`、`.rs`、`.java`、`.c` 或 `.cpp`、`.sh` 文件确认：`.cs` 会按优先级依次尝试系统 `csharp-ls`、内置 Roslyn sidecar 和 `omnisharp`，并能跨文件 / 跨项目跳转；`.rs` 会优先接到内置或缓存的 `rust-analyzer`；`.java` / `.c` / `.cpp` 会优先查找打包资源，再回退到托管缓存。代码区不再常驻显示行数、LSP 成功态、静态检查或项目诊断；没有问题就不提示，只有 LSP 不可用、托管安装失败、安装进行中或检测到问题才会显示提示。若上层 server 不可用，CodePapr 会继续回退到内建符号能力；对没有内建 fallback 的语言，预览会明确提示缺哪个 server。

## 6. 日常开发运维

### 6.1 桌面端调试

```bash
npm run debug
```

从当前版本开始，`debug / release / publish` 都会先走统一的桌面前置检查脚本：

- 缺少 workspace `node_modules` 时会自动执行 `npm install`
- 缺少或损坏 Rust toolchain（`cargo/rustc` 不可用）时会自动尝试修复或安装
- release / publish 额外会检查 `.NET SDK`，缺失时自动安装

`packages/@codepapr/ui/scripts/tauri-cli.mjs` 会在 `dev` 和 `build` 两条路径上都先调用 `prepareHostServerBinary()`，所以开发态也能拿到最新编译的 `codepapr-server`——改了 `crates/codepapr-*` 之后重启 `npm run debug` 即可生效，不需要手工 `cargo build`。

如果自动安装失败，通常是网络或代理导致无法访问官方源（例如 `static.rust-lang.org` 或 `dot.net`），排除网络后重新执行同一命令即可继续。

VS Code 工作区提供三种同名任务和调试配置：`CodePapr: Debug`、`CodePapr: Release`、`CodePapr: Publish`。

如果需要以 release profile 编译并直接运行优化过的桌面端（不打包安装包）：

```bash
npm run release
```

`release` 会先执行根 workspace 的 `npm run build`，然后构建并启动当前平台的优化桌面程序，因此在你改了很多共享包、前端或 Rust 代码之后，能确保最新代码已经被重新编译，同时保留应用图标等 bundle 资源。Roslyn release sidecar 的最终产物会生成到 `packages/@codepapr/ui/generated/lsp-tools`，dotnet 中间产物会写到 `packages/@codepapr/ui/src-tauri/target/csharp-analyzer-dotnet`。这些生成产物和 dotnet `bin/obj` 目录不应提交到 Git；发布或 smoke 流程会按需重新生成。

### 6.2 修改源码后的构建原则

这个仓库的一个重要约束是：不少 package 在测试和引用时会通过各自的 dist 入口参与执行。

这意味着：

- 改了源码，不一定立刻反映在所有下游验证里
- 当结果看起来像“没生效”时，先怀疑 build 没补，而不是先怀疑运行时异常

对 Rust 侧同理：改了 `crates/codepapr-core` 或 `crates/codepapr-server` 之后，运行中的桌面端不会热更新宿主；必须重启（或重新 `npm run debug`）让新的 `codepapr-server` 被 stage 和拉起。

推荐做法：

- 改动后先跑 build
- 再跑受影响测试
- 再跑更大范围验证

### 6.3 工作区运行方式

CLI / 烟测工具启动：

```bash
npm run smoke:agent-tools
cargo run -p codepapr-cli -- chat
```

桌面端常用启动：

```bash
npm run debug
```

Release 原生版本直接启动：

```bash
npm run release
```

桌面端发布主入口：

```bash
npm run publish
```

桌面端发布脚本：

- macOS: `./publish-codepapr.command`
- Windows: `publish-codepapr.cmd`

## 7. 发布运维

### 7.1 发布前检查

```bash
npm run release:prep
```

这一步会执行：

- npm run verify
- node scripts/release-readiness.mjs

### 7.2 发布 dry-run

```bash
npm run publish:dry-run
```

这一步会先执行 `release:prep`，再对所有非 private workspace 包逐个运行 `npm pack --dry-run --json`。桌面 UI 包是 private 包，不进入 npm 包发布 dry-run。

### 7.3 构建桌面包

```bash
npm run publish
```

也可以直接使用根目录脚本：

- macOS: `./publish-codepapr.command`
- Windows: `publish-codepapr.cmd`

`tauri.conf.json` 里 `codepapr-server` 是 `externalBin`、`agent-runtime.mjs` 是 `resources`，两者都会被打进安装包，所以最终用户不需要装 Rust 或 Node 也能跑起完整的宿主链路。

桌面端打包现在会在 `tauri build` 前自动清理 `target/*/bundle/macos` 与 `target/*/bundle/dmg` 中残留的 `.dmg` / `rw.*.dmg` 临时产物，避免上一次失败或中断后，下一次 macOS DMG 构建继续被旧产物污染。构建成功后，最终运行文件和安装包会从 Tauri 默认 target 目录同步到仓库根目录 `Release/`，作为统一对外输出目录。

### 7.4 发布前人工检查建议

建议在正式发布前再次确认：

- README 与 docs 没有残留旧链接
- release-readiness 通过
- verify 通过
- 如果改到了桌面端工具链，smoke:agent-tools 也已通过或已明确说明未跑原因

## 8. CI / CD

当前仓库没有配置自动化 CI 工作流，所有验证都在本地手动执行：

- `npm run verify`（= `verify:ci` + `check:tauri`）是本地最完整的验证，覆盖 lint、audit、build、test 与 Tauri crate 检查。
- `cargo check --workspace` / `cargo test -p codepapr-core` 覆盖 Rust 四个 crate。
- `scripts/release-readiness.mjs` 是发布前文档与关键资源完整性的最后一道静态门禁，由 `npm run release:prep` 调用。

如果后续需要接入 CI，建议至少覆盖：PR 门禁（lint + build + test + cargo check）、定期依赖安全扫描（audit / cargo audit）、以及打 tag 时的发布前校验。

## 9. 运维注意事项

### 9.1 OneDrive 工作区注意事项

这个仓库当前位于 OneDrive 路径下。已知问题是 npm .bin shim 可能被同步层压平为普通文本文件，因此仓库脚本尽量通过 scripts/run-module-bin.mjs 或 UI 内部脚本调用 Node CLI，而不是直接依赖 .bin 软链接。

### 9.2 浏览器环境注意事项

浏览器交互和截图工具当前依赖本机可检测到的 Chrome 或 Chromium 兼容浏览器。
如果机器上没有可用浏览器，相关工具链会直接失败。

### 9.3 真实模型烟测注意事项

smoke:agent-tools 更适合本地回归，不建议把它当作最基础 CI 门禁，因为它依赖真实模型配置和本机环境。

### 9.4 宿主进程残留

桌面端正常退出时会依次发 `lsp/stopAll`、`agent/stopAll`、`fs/stopWatcher`、`shell/stopAllBackground`、`mcp/disconnectAll`，然后 kill 并回收它自己拉起的 `codepapr-server`。强杀桌面端（或用 `CODEPAPR_SERVER_URL` 挂外部宿主）时不会走这套清理，可能留下宿主进程和它管理的 LSP / shell 子进程，需要手工确认。

## 10. 常见问题运行手册

### 10.1 npm install 后某些脚本仍异常

优先排查：

- OneDrive 下的 .bin shim 是否失真
- 仓库脚本是否仍通过 run-module-bin.mjs 调起 Node CLI

### 10.2 改完源码后测试像没更新

优先排查：

- 是否已经重新 build 受影响包
- 下游测试是否走了 dist 入口
- 改的是 Rust 侧的话，桌面端是否重启过（宿主不热更新）

### 10.3 cargo check 或桌面端调试失败

优先排查：

- Rust toolchain 是否安装完整
- Cargo 是否在 PATH 中

### 10.4 桌面端启动后报“codepapr-server 尚未连接”或定位不到二进制

优先排查：

- 是否跑过 `npm run build`（或至少 `npm run build:host-server --workspace=@codepapr/ui` / `cargo build -p codepapr-server`）
- `CODEPAPR_SERVER_BIN` 指向的路径是否真实存在
- 设了 `CODEPAPR_SERVER_URL` 但对应端口上没有宿主在听
- 15 秒内没拿到端口：看桌面端 stderr 里有没有 `[codepapr-server] listening on ...`，以及临时目录里的 `codepapr-server-<pid>.port`

### 10.5 Agent 工具烟测失败

优先排查：

- API key 是否有效
- 默认模型配置是否可用
- 浏览器是否可检测
- 当前失败是否来自环境问题而不是仓库逻辑问题
