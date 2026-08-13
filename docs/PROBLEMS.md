# Windows 版编译打包问题记录

## 时间

2026-06-10

## 问题概览

Windows MSI 安装包在安装后 LSP 功能普遍不可用，原因涉及资源路径解析错误和 csharp-ls 未捆绑。

---

## 问题一：MSI 安装后运行时找不到捆绑的 LSP 工具

### 根因

`lsp_managed_tools.rs:625-674` 的 `managed_tool_roots()` 函数在运行时搜索 9 个路径来发现捆绑的 LSP 工具，但缺少 MSI 实际安装位置。

Tauri v2 打包 MSI 时，`resources: ["../generated/lsp-tools/**/*"]` 会将资源安装到：
```
C:\Program Files\CodePapr\_up_\generated\lsp-tools\
```

`_up_` 表示资源 glob 中的 `../` 父目录遍历。

### 原代码（修复前）

`managed_tool_roots()` 中基于 `current_exe()` 的搜索路径：
```
exe_dir/lsp-tools                                  ← 不存在
exe_dir/resources/lsp-tools                         ← 不存在
exe_dir/../Resources/lsp-tools                      ← macOS 路径，Windows 上不存在
exe_dir/../Resources/_up_/generated/lsp-tools       ← macOS 路径
exe_dir/../resources/lsp-tools                      ← Linux 路径
exe_dir/../resources/_up_/generated/lsp-tools       ← Linux 路径
```

**缺失的关键路径**：`exe_dir/_up_/generated/lsp-tools` ← MSI 实际安装位置

### 影响范围

所有捆绑的 LSP 工具在 MSI 安装后均不可用：
- TypeScript / HTML / CSS / JSON / YAML / Python / Shell（基于 Node.js）
- C/C++（clangd）
- C#（Roslyn Analyzer sidecar）
- Rust（rust-analyzer）
- Go（gopls）
- Java（JDTLS）
- SQL（sqls）
- Markdown（marksman）
- .NET SDK（影响运行时 `dotnet tool install`）

### 修复

**文件**：`packages/@codepapr/ui/src-tauri/src/lsp_managed_tools.rs` 行 638

在 `exe_dir/resources/lsp-tools` 之后插入：
```rust
roots.push(
    executable_dir
        .join("_up_")
        .join("generated")
        .join("lsp-tools"),
);
```

---

## 问题二：DOTNET_ROOT 环境变量使用 macOS 路径

### 根因

`lsp.rs:1060-1072` 在启动 LSP 进程时设置 `DOTNET_ROOT`，但只查找 macOS/Unix 风格路径，没有 MSI 安装路径。

### 原代码（修复前）

```rust
for prefix in &[
    exe_dir.join("..").join("Resources").join("_up_").join("generated").join("lsp-tools").join("dotnet-sdk"),
    exe_dir.join("..").join("resources").join("_up_").join("generated").join("lsp-tools").join("dotnet-sdk"),
] {
```

两个路径都经过 `exe_dir/../`，在 Windows MSI 安装下均不存在。

### 影响

- 捆绑的 .NET SDK（773 MB）在 MSI 安装后无法被找到
- `dotnet tool install --global csharp-ls` 在无系统 .NET SDK 时失败
- Roslyn C# Analyzer sidecar 依赖 .NET runtime 时可能启动失败

### 修复

**文件**：`packages/@codepapr/ui/src-tauri/src/lsp.rs` 行 1063

在路径列表最前面插入 MSI 路径：
```rust
for prefix in &[
    exe_dir.join("_up_").join("generated").join("lsp-tools").join("dotnet-sdk"),
    exe_dir.join("..").join("Resources").join("_up_").join("generated").join("lsp-tools").join("dotnet-sdk"),
    exe_dir.join("..").join("resources").join("_up_").join("generated").join("lsp-tools").join("dotnet-sdk"),
] {
```

---

## 问题三：csharp-ls 未捆绑到安装包

### 根因

`build.rs:128-152` 的 `prepare_bundled_lsp_assets()` 捆绑了 10 个 LSP 工具（node、typeshed、dotnet-sdk、java、clangd、sqls、marksman、rust-analyzer、gopls、csharp-analyzer），**唯独没有 csharp-ls**。

`lsp_managed_tools.rs:919-962` 的逻辑是运行时通过 `dotnet tool install --global csharp-ls` 联网安装，这在离线环境或受限网络中不可用。

### 原代码

`managed_csharp_commands()` 的候选链：
1. 系统 PATH / `~/.dotnet/tools` 中查找 `csharp-ls`
2. 如果没有，使用捆绑的 `CodePapr.CSharp.Analyzer`（Roslyn sidecar）
3. 均失败 → C# LSP 不可用

### 修复

**文件**：`packages/@codepapr/ui/src-tauri/build.rs`

新增 `ensure_bundled_csharp_ls()` 函数，在 `ensure_bundled_dotnet_sdk()` 之后调用，使用已下载的 .NET SDK 执行：
```
dotnet tool install csharp-ls --tool-path generated/lsp-tools/csharp-ls/bin
```

**文件**：`packages/@codepapr/ui/src-tauri/src/lsp_managed_tools.rs`

`managed_csharp_commands()` 新增第二步，在系统 csharp-ls 和 Roslyn sidecar 之间查找捆绑的 csharp-ls：
1. 系统 PATH / dotnet tools → `csharp-ls`
2. **捆绑的 `csharp-ls/` 目录**（新增）
3. 捆绑的 `csharp-analyzer/` → `CodePapr.CSharp.Analyzer`
4. `dotnet run`（debug 模式）
5. 外部 PATH → `omnisharp`

---

## 问题四：`HOME` 环境变量在 Windows 上为空

### 根因

`lsp_managed_tools.rs` 多处使用 `env::var("HOME")`，但 Windows 使用 `USERPROFILE`。

影响以下 LSP 的 fallback 路径查找：
- **gopls**（行 310）：`HOME`/`GOPATH` → `{home}/go/bin/gopls`
- **rust-analyzer**（行 265）：`HOME`/`CARGO_HOME` → `{home}/.cargo/bin/rust-analyzer`

### 状态

✅ **已修复**（2026-08-14）。此问题影响的是 **系统安装工具的 fallback 路径**，捆绑版（如果 MSI 路径正确）不受影响。但 Go 用户在自行安装 `gopls` 后，运行时无法通过 GOPATH fallback 找到它。

`expanded_path()` 函数（`lsp.rs`）已正确处理 `USERPROFILE` fallback：
```rust
let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
```
原实现中 `lsp_managed_tools.rs` 的 gopls 和 rust-analyzer 查找未做同样处理。

### 修复

**文件**：`packages/@codepapr/ui/src-tauri/src/lsp_managed_tools.rs`

1. `managed_rust_commands()` / `managed_go_commands()` 的 home 目录改用
   `shared::paths::home_dir()`（HOME → USERPROFILE 回退，与 `expanded_path()` 同口径）。
2. 修复同时发现的**路径拼接错误**：原实现对 `HOME` 与 `CARGO_HOME`/`GOPATH`
   使用同一拼接式，产生 `$CARGO_HOME/.cargo/bin/rust-analyzer` 与
   `$GOPATH/go/bin/gopls` 两个不存在的路径——`CARGO_HOME` 本身就是 `.cargo`
   目录（正确为 `$CARGO_HOME/bin/`），`GOPATH` 是工作区根（正确为 `$GOPATH/bin/`）。
   即使 Unix 上设置了这些环境变量，fallback 也永远命中不了。现已分别改为
   `$HOME/.cargo/bin/` + `$CARGO_HOME/bin/` 与 `$HOME/go/bin/` + `$GOPATH/bin/`。

---

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `packages/@codepapr/ui/src-tauri/src/lsp_managed_tools.rs` | `managed_tool_roots()` 添加 MSI 路径；`managed_csharp_commands()` 添加捆绑 csharp-ls 查找 |
| `packages/@codepapr/ui/src-tauri/src/lsp.rs` | `DOTNET_ROOT` 路径列表添加 MSI 路径 |
| `packages/@codepapr/ui/src-tauri/build.rs` | 新增 `ensure_bundled_csharp_ls()`；`prepare_bundled_lsp_assets()` 添加调用 |

---

## 验证方法

### MSI 路径验证

将 CodePapr 安装到 `C:\Program Files\CodePapr\`，验证以下目录存在：
```
C:\Program Files\CodePapr\_up_\generated\lsp-tools\
├── clangd/
├── csharp-analyzer/
├── csharp-ls/          ← 新增
├── dotnet-sdk/
├── gopls/
├── java/
├── marksman/
├── node-packages/
├── node-runtime/
├── rust-analyzer/
└── sqls/
```

### LSP 功能验证

打开以下类型文件，确认 LSP 功能正常（hover/跳转/诊断）：
- `.ts` / `.tsx` → TypeScript
- `.html` → HTML
- `.css` → CSS
- `.cs` → C#（应优先使用捆绑的 csharp-ls）
- `.rs` → Rust
- `.go` → Go（需 Go 工具链安装 gopls）
- `.java` → Java
- `.cpp` / `.c` → C/C++
- `.py` → Python
- `.sql` → SQL
- `.md` → Markdown


## 问题五：JDTLS 临时文件导致 WiX light.exe 打包失败

### 根因

Eclipse JDTLS 的 `config_win/` 目录中包含 OSGi 运行时状态目录 `.manager`，内有 `.tmp*.instance`、`.fileTable` 等锁文件。这些文件在 Windows 上可能被进程锁定（WiX `candle.exe` 遍历文件时、或前次构建残留），导致 `light.exe` 打包 MSI 时无法读取：

```
light.exe : error LGHT0001 : 文件...\.manager\.tmp3.instance
正在被另一个进程使用，因此该进程无法访问此文件。
```

### 修复

**文件**：`packages/@codepapr/ui/src-tauri/build.rs`

新增 `remove_jdtls_runtime_temp_files()` 函数，在 `normalize_bundled_lsp_assets()` 中调用，在打包前递归搜索并删除 JDTLS `config_win/` 下所有 `.manager*` 临时目录。这些目录由 JDTLS 在首次启动时自动重建，删除不影响功能。

### 临时处理

如果构建机已有锁定的 JDTLS 文件，需手动删除 `generated/lsp-tools/java/jdtls/` 目录后重新构建，让 `build.rs` 重新下载并应用清理逻辑。
