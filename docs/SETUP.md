# 安装、验证与运维

日常交互见 docs/USAGE.md。

## 2. 支持环境

### 2.1 开发机要求

- Node.js 20.19+
- npm 9+
- Rust toolchain 和 Cargo

CLI 只需 Node。桌面端、cargo check、打包需要 Rust。浏览器烟测需要本机 Chrome / Chromium。

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
git submodule update --init --recursive   # 首次克隆必需：.cargo-vendor 下的 9 个 tree-sitter grammar
npm install
npm run build
```

桌面端构建（`cargo check` / `npm run debug` / `release` / `publish`）依赖 `.cargo-vendor/*` 下以 git 子模块形式 vendor 的 tree-sitter grammar（PHP、C#、CSS、HTML、JSON、Ruby、Kotlin、Swift、SQL）。如果克隆时没有带 `--recurse-submodules`，必须先执行上面的命令；否则 Cargo 解析依赖时会报与子模块毫无关联的 path 依赖错误。通过 `npm run debug` / `release` / `publish` / `check:tauri` 入口执行时脚本会自动探测缺失并补跑 `git submodule update`。

如果你只打算阅读源码或使用 CLI，完成这两步通常就够了。
如果你要对仓库做提交级别修改，建议继续跑完整验证。

### 3.2 安装验收

最小验收标准：

```bash
npm run verify
```

通过这一步，说明当前机器至少满足：

- Node 依赖安装正确
- workspace build 正常
- workspace tests 正常
- Tauri cargo check 正常

## 4. 配置与本地运行前提

### 4.1 应用级配置

CodePapr 当前将应用级配置保存在：

- ~/.codepapr/codepapr.sqlite

其中包括 provider、model、API key、system prompt、语言和采样参数。

角色参考音频和 TTS 语音模型数据保存在：

- ~/.codepapr/voices
- ~/.codepapr/gpt-sovits

### 4.2 项目级状态

工作区被打开后，项目级状态保存在：

- <workspace>/.CodePapr

这部分现在主要包括 project.sqlite、项目级 store 和 skills；旧版 state.json / project.json 会在首次打开或保存时自动导入到 SQLite。

### 4.3 真实模型相关前提

以下场景依赖有效模型配置：

- 桌面端实际对话与执行
- CLI 真实 ask、plan、agent 调用
- smoke:agent-tools

如果只跑 test、verify:ci，通常不需要真实模型凭据。

## 5. 验证策略

CodePapr 当前的验证链路可以按“范围”和“成本”来理解。

### 5.1 命令矩阵

| 命令 | 范围 | 适合场景 |
| --- | --- | --- |
| npm run build | 全 workspace 构建 | 改完源码后确认产物可生成（UI 包构建前会先跑 `tsc --noEmit`） |
| npm run test | 全 workspace 测试 | 日常主回归 |
| npm run test:e2e:ui | Playwright UI E2E | 改到桌面端 UI 组件、Toast、权限对话框、代码审查面板 |
| npm run test:e2e:ui:install | 安装 Playwright Chromium | 首次运行 UI E2E 或 CI 环境准备 |
| npm run lint | 静态检查 | 提交前质量门禁 |
| npm run audit | 依赖安全检查 | 发布前或依赖变更后 |
| CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics | 外部 workspace 桌面烟测 | 改到工作台项目诊断、文件树、代码预览、本地标记降级 |
| npm run smoke:lsp-preview | 真实多语言 LSP 烟测 | 改到代码预览的 hover、definition、后台预热，或外部 LSP / 内建 fallback 接线 |
| npm run verify:ci | lint + audit + build + test | 提交前一键本地检查 |
| npm run verify | verify:ci + cargo check | 本地最完整验证 |
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

这条链路覆盖 core、api、ui 等主路径的 vitest 测试，是最常用的本地回归入口。

#### 完整验证

```bash
npm run verify
```

这是当前仓库默认的本地发布前验证入口。

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

#### 桌面端 LSP 检查

代码预览现在会按语言族启动对应的 stdio LSP server，并在同一工作区内按 family 复用 server。默认随 `npm install` 安装的语言族包括：

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

运行桌面端时至少打开一个 `.ts`/`.tsx`/`.js`/`.jsx`/`.html`/`.css`/`.json`/`.yaml`/`.py` 文件，预览应先尽快显示文件内容；随后只有当前打开文件才会在后台异步懒加载 LSP、符号和 diagnostics，工作区启动本身不应批量触发 `lsp_open_document`、lint、typecheck 或项目诊断。再分别打开 `.cs`、`.rs`、`.java`、`.c` 或 `.cpp`、`.sh` 文件确认：`.cs` 会按优先级依次尝试系统 `csharp-ls`、内置 Roslyn sidecar 和 `omnisharp`，并能跨文件 / 跨项目跳转；`.rs` 会优先接到内置或缓存的 `rust-analyzer`；`.java` / `.c` / `.cpp` 会优先查找打包资源，再回退到托管缓存。代码区不再常驻显示行数、LSP 成功态、静态检查或项目诊断；没有问题就不提示，只有 LSP 不可用、托管安装失败、安装进行中或检测到问题才会显示提示。若上层 server 不可用，CodePapr 会继续回退到内建符号能力；对没有内建 fallback 的语言，预览会明确提示缺哪个 server。

## 6. 日常开发运维

### 6.1 桌面端调试

```bash
npm run debug
```

从当前版本开始，`debug / release / publish` 都会先走统一的桌面前置检查脚本：

- 缺少 workspace `node_modules` 时会自动执行 `npm install`
- `.cargo-vendor/*` 子模块未初始化时会自动执行 `git submodule update --init --recursive`
- 缺少或损坏 Rust toolchain（`cargo/rustc` 不可用）时会自动尝试修复或安装
- release / publish 额外会检查 `.NET SDK`，缺失时自动安装

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

推荐做法：

- 改动后先跑 build
- 再跑受影响测试
- 再跑更大范围验证

### 6.3 工作区运行方式

CLI / 烟测工具启动：

```bash
npm run smoke:agent-tools
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

桌面端打包现在会在 `tauri build` 前自动清理 `target/*/bundle/macos` 与 `target/*/bundle/dmg` 中残留的 `.dmg` / `rw.*.dmg` 临时产物，避免上一次失败或中断后，下一次 macOS DMG 构建继续被旧产物污染。构建成功后，最终运行文件和安装包会从 Tauri 默认 target 目录同步到仓库根目录 `Release/`，作为统一对外输出目录。

### 7.4 发布前人工检查建议

建议在正式发布前再次确认：

- README 与 docs 没有残留旧链接
- release-readiness 通过
- verify 通过
- 如果改到了桌面端工具链，smoke:agent-tools 也已通过或已明确说明未跑原因

## 8. CI / CD

当前仓库没有配置自动化 CI 工作流，所有验证都在本地手动执行：

- `npm run verify`（= `verify:ci` + `cargo check`）是本地最完整的验证，覆盖 lint、audit、build、test 与 Rust 类型检查。
- `scripts/release-readiness.mjs` 是发布前文档与关键资源完整性的最后一道静态门禁，由 `npm run release:prep` 调用。

如果后续需要接入 CI，建议至少覆盖：PR 门禁（lint + build + test）、定期依赖安全扫描（audit / cargo audit）、以及打 tag 时的发布前校验。

## 9. 运维注意事项

### 9.1 OneDrive 工作区注意事项

这个仓库当前位于 OneDrive 路径下。已知问题是 npm .bin shim 可能被同步层压平为普通文本文件，因此仓库脚本尽量通过 scripts/run-module-bin.mjs 或 UI 内部脚本调用 Node CLI，而不是直接依赖 .bin 软链接。

### 9.2 浏览器环境注意事项

浏览器交互和截图工具当前依赖本机可检测到的 Chrome 或 Chromium 兼容浏览器。
如果机器上没有可用浏览器，相关工具链会直接失败。

### 9.3 真实模型烟测注意事项

smoke:agent-tools 更适合本地回归，不建议把它当作最基础 CI 门禁，因为它依赖真实模型配置和本机环境。

## 10. 常见问题运行手册

### 10.1 npm install 后某些脚本仍异常

优先排查：

- OneDrive 下的 .bin shim 是否失真
- 仓库脚本是否仍通过 run-module-bin.mjs 调起 Node CLI

### 10.2 改完源码后测试像没更新

优先排查：

- 是否已经重新 build 受影响包
- 下游测试是否走了 dist 入口

### 10.3 cargo check 或桌面端调试失败

优先排查：

- `.cargo-vendor/*` 子模块是否已初始化（`git submodule update --init --recursive`）。缺失时 Cargo 报的是 path 依赖找不到，与子模块毫无关联
- Rust toolchain 是否安装完整
- Cargo 是否在 PATH 中

### 10.4 Agent 工具烟测失败

优先排查：

- API key 是否有效
- 默认模型配置是否可用
- 浏览器是否可检测
- 当前失败是否来自环境问题而不是仓库逻辑问题
