# Installation, Verification & Operations

Day-to-day use: docs/USAGE.en.md. Full architecture: docs/ARCHITECTURE.en.md.

## 2. Supported Environments

### 2.1 Development Machine Requirements

- Node.js 20.19+
- npm 9+
- Rust toolchain and Cargo

**Rust is not optional.** The repository is a dual stack — an npm workspace plus a Cargo workspace:

- `crates/codepapr-core`, `crates/codepapr-server`, `crates/codepapr-cli`, and `packages/@codepapr/ui/src-tauri` are all Rust crates (see the root `Cargo.toml`);
- the CLI (`codepapr-cli`) is a Rust binary, not a Node script — build it with `cargo build -p codepapr-cli`;
- even `npm run build` needs cargo: the `@codepapr/ui` build is `typecheck && build:host-server && build:sidecar && build:frontend`, and `build:host-server` runs `scripts/prepare-host-server.mjs`, which compiles `codepapr-server`.

Only narrow commands such as `npm run lint` or the pure-vitest part of `npm run test` avoid Rust entirely. Browser smoke tests need Chrome / Chromium.

### 2.2 Current Primary Development Environments

- macOS arm64
- Windows

### 2.3 External Dependencies

Depending on what you need to do, you may also need:

- DeepSeek, OpenAI, or Claude-compatible provider API key
- An available browser binary for page interaction and screenshot workflows
- VS Code for workspace tasks and debug configurations
- **Python 3.10+** for TTS voice synthesis (GPT-SoVITS); voice features also require ffmpeg (macOS: install via Homebrew)
- .NET SDK for release-packaged C# Roslyn analyzer, or `dotnet run` in dev mode; debug/test prefer source sidecar, release prefers packaged sidecar
- Desktop multi-language LSP servers: official desktop release/publish builds bundle `typescript-language-server`, `vscode-langservers-extracted`, `yaml-language-server`, `pyright`, `bash-language-server`, Node.js runtime, Roslyn sidecar, `jdtls`, Temurin JRE, `clangd`, `rust-analyzer` into the installer. Users of default languages don't need additional downloads on first use. In dev mode or custom builds without these assets, the desktop will still perform on-demand managed installation; Go additionally reuses local `gopls`

Managed download/installation upstream tools and licenses: Eclipse JDTLS (EPL-2.0), Eclipse Temurin JRE (GPL-2.0 with Classpath Exception), clangd (Apache-2.0 with LLVM exception), rust-analyzer (MIT / Apache-2.0). Set `CODEPAPR_DISABLE_MANAGED_LSP_DOWNLOAD=1` to disable auto-managed downloads.

## 3. Installation & Bootstrapping

### 3.1 Standard Installation

```bash
npm install
npm run build
```

The desktop build (`cargo check` / `npm run debug` / `release` / `publish`) pulls tree-sitter and language grammars from crates.io. `.cargo-vendor/*` git submodules are no longer required.

`npm run build` already compiles `codepapr-server`, so after these two steps you have a working host binary on disk. If you plan to make commit-level changes to the repository, continue with full verification.

### 3.2 Installation Acceptance

Minimum acceptance:

```bash
npm run verify
```

Passing verifies that your machine meets at least:
- Node dependencies are correctly installed
- Workspace build succeeds (including the codepapr-server compile)
- Workspace tests pass
- Tauri cargo check succeeds

### 3.3 Rust side only

```bash
cargo check --workspace          # core + server + cli + desktop crate
cargo build -p codepapr-server   # host daemon
cargo build -p codepapr-cli      # CLI client
cargo test -p codepapr-core      # domain library unit tests, no Tauri needed
```

## 4. Configuration & Local Prerequisites

### 4.1 Application-Level Configuration

CodePapr currently stores application-level configuration at:

- ~/.codepapr/codepapr.sqlite

This includes provider, model, API key, system prompt, language, and sampling parameters.

> Ownership note: this database is opened and written by `codepapr-core::db`, i.e. by the **host process (codepapr-server)**. The desktop reaches it through RPC methods such as `db/loadSettings` and `db/saveSettings`; it no longer holds a SQLite handle itself. API keys are the exception: plaintext lives only in the client-side Stronghold vault / keyring and is pushed one-way to the in-memory secret store of the host via `secrets/import` at startup.

Global apps (.papr plugins) are installed at:

- ~/.codepapr/apps/&lt;appId&gt;/

Character reference audio and TTS voice model data are stored at:

- ~/.codepapr/voices
- ~/.codepapr/gpt-sovits

### 4.2 Project-Level State

When a workspace is opened, project-level state is stored at:

- &lt;workspace&gt;/.CodePapr

This currently includes project.sqlite, project-level store, and skills; legacy state.json / project.json are auto-imported to SQLite on first open or save. Workspace-scoped apps live in `&lt;workspace&gt;/.CodePapr/apps/&lt;appId&gt;/` and take precedence over a global install of the same `appId`.

### 4.3 Live Model Prerequisites

The following scenarios depend on valid model configuration:

- Desktop actual conversations and execution
- CLI real chat / run calls
- smoke:agent-tools

Running test and verify:ci typically does not require live model credentials.

### 4.4 The host process and the two sidecars

Three executables are involved at runtime — do not confuse them:

| Name | What it is | Who builds / who launches it |
| --- | --- | --- |
| `codepapr-server` | Rust host daemon, a Tauri `externalBin` sidecar | `scripts/prepare-host-server.mjs` (`npm run build:host-server`) compiles and stages it into `src-tauri/binaries`; at runtime the desktop `host.rs` launches it |
| `agent-runtime.mjs` | Node ESM agent runtime, a Tauri `resources` entry | bundled by `packages/@codepapr/ui/scripts/build-sidecar.mjs` (esbuild); at runtime it is launched by the **host side**, `codepapr-core::agent_runtime` (the desktop only passes `resourceDir` in `agent/start`) |
| `codepapr` (Tauri bin) / `codepapr-cli` | Clients | `cargo` |

How the desktop brings up the host (`src-tauri/src/host.rs`):

1. If `CODEPAPR_SERVER_URL` is set (e.g. `127.0.0.1:9090`) it connects to that address, **does not** spawn a child, and does not kill it on exit;
2. otherwise it locates the binary: `CODEPAPR_SERVER_BIN` → next to the current executable → Tauri `resourceDir` (including `bin/` and `_up_/`) → `target/{debug,release}` → `../../../../target/{debug,release}` → `PATH`;
3. it spawns `--port 0 --port-file <temp>/codepapr-server-<pid>.port` and reads the real port from the port file or from the stderr line `[codepapr-server] listening on <addr>` (15 s deadline, 40 ms poll);
4. once connected it sends `initialize`.

When the binary cannot be found the error is `Could not locate 'codepapr-server' binary. Build it with 'cargo build -p codepapr-server' or set CODEPAPR_SERVER_BIN.`

To debug the host separately during development:

```bash
# Terminal A: run the host by hand (with a default workspace)
cargo run -p codepapr-server -- --port 9090 --workspace /absolute/path/to/workspace

# Terminal B: attach the desktop instead of letting it spawn its own
CODEPAPR_SERVER_URL=127.0.0.1:9090 npm run debug
```

Without `--port`, `codepapr-server` runs in stdio mode — the same shape `codepapr-cli` auto-spawns when no `--server` is given.

## 5. Verification Strategy

CodePapr's current verification pipeline can be understood in terms of "scope" and "cost".

### 5.1 Command Matrix

| Command | Scope | Best For |
| --- | --- | --- |
| npm run build | Full workspace build (includes the codepapr-server compile and agent sidecar bundle) | Confirming artifacts after source changes (UI package runs `tsc --noEmit` before build) |
| npm run test | Full workspace tests | Daily main regression |
| npm run test:e2e:ui | Playwright UI E2E | Changing desktop UI components, Toast, permissions dialog, code review panel |
| npm run test:e2e:ui:install | Install Playwright Chromium | First-time UI E2E or CI environment prep |
| npm run lint | Static analysis | Pre-commit quality gate |
| npm run audit | Dependency security audit | Before release or after dependency changes |
| cargo check --workspace | Type check for all four Rust crates | Changing core / server / cli / desktop crate |
| cargo test -p codepapr-core | Domain library unit tests | Changing fs / git / shell / lsp / db / snapshot implementations |
| CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics | External workspace desktop smoke | Changing workbench project diagnostics, file tree, code preview, local marker fallback |
| npm run smoke:lsp-preview | Real multi-language LSP smoke | Changing code preview hover, definition, background warmup, or external LSP / built-in fallback wiring |
| npm run verify:ci | lint + audit + build + test | One-shot pre-commit local check |
| npm run verify | verify:ci + check:tauri | Most complete local verification |
| npm run smoke:agent-tools | Live model tool smoke | Changing tool selection, preview, shell, browser interaction, project diagnostics, or absolute path file reading |

> `npm run audit` now **fails by default** when the registry is unreachable (so a transient network issue can't silently pass dependencies with known vulnerabilities into the release path). To skip while offline, explicitly set `CODEPAPR_AUDIT_SKIP_ON_NETWORK_FAILURE=1`.

### 5.2 Recommended Regression Order

Pre-commit recommended order:

1. npm run build
2. npm run test
3. npm run test:e2e:ui
4. npm run verify

Install browser dependencies before first UI E2E run:

```bash
npm run test:e2e:ui:install
```

If you changed the RPC router (`crates/codepapr-server/src/handler.rs`), the domain library, or the RPC proxies on the desktop side, add:

```bash
cargo check --workspace
cargo test -p codepapr-core
```

If you changed desktop native bridges, background commands, browser interaction, preview sessions, or tool selection, also run:

```bash
npm run smoke:agent-tools
```

If you changed project diagnostics, file tree, or code preview in the desktop workbench, also run:

```bash
CODEPAPR_EXTERNAL_WORKSPACE=/absolute/path/to/workspace npm run smoke:desktop-diagnostics
```

If you changed LSP hover, definition, background warmup in code preview, or added new language servers, also run:

```bash
npm run smoke:lsp-preview
```

This smoke generates small TypeScript, C#, Rust, Java, Python, and C++ projects and validates real LSP hover, definition, and `documentSymbol`. For official desktop release packages, these default language assets should be bundled with the installer. In dev mode or non-official builds without Node.js runtime, `rust-analyzer` component, `jdtls`, or `clangd`, the test will still follow the real runtime path to fill in missing pieces. For fully offline validation, prepare these tools beforehand or set `CODEPAPR_DISABLE_MANAGED_LSP_DOWNLOAD=1`.

### 5.3 Verification Item Descriptions

#### Workspace Tests

```bash
npm run test
```

Covers core, api, ui and other primary path vitest tests. Most commonly used local regression entry point. Note it does not cover the Rust side — that is `cargo test`.

#### Full Verification

```bash
npm run verify
```

Default local pre-release verification entry point for this repository (`verify:ci` plus `check:tauri`).

#### Agent Tool Smoke

```bash
npm run smoke:agent-tools
```

Closer to real usage scenarios, but depends on:
- Live model configuration
- Browser environment
- Current machine's desktop runtime conditions

Currently smoke:agent-tools covers 5 required scenarios by default: file search, remote download, page interaction, persistent shell sessions, and "must call diagnostics + use absolute-path-anchored read".

This is more of a local operations-level regression, not the most basic CI gate.

#### Host connectivity self-check

```bash
cargo run -p codepapr-cli -- doctor
cargo run -p codepapr-cli -- ping
cargo run -p codepapr-cli -- --server 127.0.0.1:9090 server info
```

`doctor` still prints an environment report even when it cannot reach a host, which makes it the fastest way to tell whether a desktop startup failure is a frontend problem or a host problem.

#### Desktop LSP Check

Code preview launches per-language-family stdio LSP servers, reusing them within the same workspace by family. Those LSP processes are owned by the **host side** (`codepapr-core::lsp`); the desktop only drives them over `lsp/*` RPC. Default language families installed with `npm install` include:

- TypeScript / TSX / JavaScript / JSX
- HTML / CSS / SCSS / LESS
- JSON / JSONC
- YAML
- Python

Additionally, TypeScript/JavaScript, HTML/CSS/JSON, YAML, Python, ShellScript — this group of Node-based languages prefer the installer-bundled Node.js runtime and bundled language servers, falling back to local `node` or managed cache only if needed. C# tries system `csharp-ls` (dotnet tool), then the app-bundled `CodePapr.CSharp.Analyzer` (Roslyn sidecar), then `omnisharp -lsp`, all supporting cross-file and cross-`ProjectReference` resolution. Java/C/C++ first look for app-bundled resources, then try managed download of `jdtls`/`clangd`, then fall back to local PATH servers, then the app's built-in fallback. Rust prefers the installer-bundled `rust-analyzer`, falling back to rustup or system PATH. Go still prefers local `gopls`. Swift on macOS uses Xcode toolchain's `sourcekit-lsp`. SQL and Markdown use built-in `sqls` and `marksman` respectively. After dependency changes or LSP bridge modifications, at minimum confirm:

```bash
npm run check:tauri
node ./scripts/run-module-bin.mjs typescript/bin/tsc -p packages/@codepapr/ui/tsconfig.json --noEmit
```

When running the desktop, open at least one `.ts`/`.tsx`/`.js`/`.jsx`/`.html`/`.css`/`.json`/`.yaml`/`.py` file. The preview should quickly display file content; only the currently open file will then lazily load LSP, symbols, and diagnostics in the background. Workspace startup itself should not batch-trigger `lsp/openDocument`, lint, typecheck, or project diagnostics. Then open `.cs`, `.rs`, `.java`, `.c` or `.cpp`, `.sh` files to confirm: `.cs` tries system `csharp-ls`, then built-in Roslyn sidecar, then `omnisharp` by priority, and can cross-file/cross-project jump; `.rs` preferentially uses built-in or cached `rust-analyzer`; `.java`/`.c`/`.cpp` search for packaged resources first, then fall back to managed cache. The code area no longer permanently shows line count, LSP success status, static analysis, or project diagnostics; only prompts when LSP is unavailable, managed installation fails, installation is in progress, or issues are detected. If the upper-layer server is unavailable, CodePapr will continue to fall back to built-in symbol capabilities; for languages without built-in fallback, the preview explicitly notes which server is missing.

## 6. Daily Development Operations

### 6.1 Desktop Debugging

```bash
npm run debug
```

From the current version, `debug / release / publish` all first run a unified desktop pre-check script:

- Auto-runs `npm install` if workspace `node_modules` is missing
- Auto-attempts to fix or install Rust toolchain if `cargo/rustc` is missing or broken
- release / publish additionally checks for `.NET SDK` and auto-installs if missing

`packages/@codepapr/ui/scripts/tauri-cli.mjs` calls `prepareHostServerBinary()` on both the `dev` and `build` paths, so dev mode also picks up a freshly compiled `codepapr-server` — after editing `crates/codepapr-*` a restart of `npm run debug` is enough, no manual `cargo build` needed.

If auto-install fails, it's typically network or proxy issues preventing access to official sources (e.g. `static.rust-lang.org` or `dot.net`). After resolving network issues, re-run the same command to continue.

The VS Code workspace provides three same-name tasks and debug configurations: `CodePapr: Debug`, `CodePapr: Release`, `CodePapr: Publish`.

To compile with release profile and run the optimized desktop directly (without packaging an installer):

```bash
npm run release
```

`release` first runs root workspace `npm run build`, then builds and launches the current platform's optimized desktop program, ensuring the latest code is compiled after changes to shared packages, frontend, or Rust code, while preserving app icon and bundle resources. Roslyn release sidecar final artifacts are generated to `packages/@codepapr/ui/generated/lsp-tools`, dotnet intermediate artifacts are written to `packages/@codepapr/ui/src-tauri/target/csharp-analyzer-dotnet`. These generated artifacts and dotnet `bin/obj` directories should not be committed to Git; release or smoke processes regenerate them as needed.

### 6.2 Build Principles After Source Changes

An important constraint of this repository: many packages participate in execution through their dist entry points during testing and referencing.

This means:

- Source changes don't necessarily immediately reflect in all downstream verification
- When results look like they "didn't take effect", suspect a missing build before suspecting a runtime anomaly

The same applies on the Rust side: after editing `crates/codepapr-core` or `crates/codepapr-server`, a running desktop will not hot-reload the host — restart it (or re-run `npm run debug`) so the new `codepapr-server` is staged and spawned.

Recommended practice:

- Run build after changes
- Then run affected tests
- Then run broader verification

### 6.3 Workspace Run Methods

CLI / Smoke tools launch:

```bash
npm run smoke:agent-tools
cargo run -p codepapr-cli -- chat
```

Common desktop launch:

```bash
npm run debug
```

Release native direct launch:

```bash
npm run release
```

Desktop release main entry:

```bash
npm run publish
```

Desktop release scripts:

- macOS: `./publish-codepapr.command`
- Windows: `publish-codepapr.cmd`

## 7. Release Operations

### 7.1 Pre-Release Check

```bash
npm run release:prep
```

Runs:
- npm run verify
- node scripts/release-readiness.mjs

### 7.2 Release Dry-Run

```bash
npm run publish:dry-run
```

Runs `release:prep` first, then `npm pack --dry-run --json` on all non-private workspace packages. The desktop UI package is private and excluded from npm pack dry-run.

### 7.3 Building Desktop Packages

```bash
npm run publish
```

Or use root directory scripts directly:

- macOS: `./publish-codepapr.command`
- Windows: `publish-codepapr.cmd`

In `tauri.conf.json`, `codepapr-server` is an `externalBin` and `agent-runtime.mjs` is a `resources` entry, so both ship inside the installer — end users need neither Rust nor Node to run the full host pipeline.

Desktop packaging now auto-cleans leftover `.dmg` / `rw.*.dmg` artifacts in `target/*/bundle/macos` and `target/*/bundle/dmg` before `tauri build`, preventing contamination from previous failed or interrupted builds. After a successful build, the final runtime files and installers are synced from Tauri's default target directory to the repo root `Release/` directory as the unified output directory.

### 7.4 Pre-Release Manual Check Suggestions

Before releasing, confirm:
- README and docs contain no stale links
- release-readiness passes
- verify passes
- If desktop toolchain was changed, smoke:agent-tools has also passed or the reason for skipping is documented

## 8. CI / CD

This repository does not currently configure automated CI workflows; all verification is run locally by hand:

- `npm run verify` (= `verify:ci` + `check:tauri`) is the most complete local verification, covering lint, audit, build, test and the Tauri crate check.
- `cargo check --workspace` / `cargo test -p codepapr-core` cover the four Rust crates.
- `scripts/release-readiness.mjs` is the final static gate for doc and key resource integrity before release, invoked by `npm run release:prep`.

If CI is added later, it should at least cover: a PR gate (lint + build + test + cargo check), periodic dependency security scans (audit / cargo audit), and pre-release validation on tag push.

## 9. Operational Notes

### 9.1 OneDrive Workspace Notes

This repository is currently located under a OneDrive path. A known issue is that npm .bin shims may be flattened to plain text files by the sync layer. Repository scripts therefore prefer using scripts/run-module-bin.mjs or UI internal scripts to call Node CLIs rather than directly depending on .bin symlinks.

### 9.2 Browser Environment Notes

Browser interaction and screenshot tools currently depend on a detectable Chrome or Chromium-compatible browser on the local machine. If no compatible browser is available, the related tool chains will fail directly.

### 9.3 Live Model Smoke Test Notes

smoke:agent-tools is better suited for local regression, not as the most basic CI gate, because it depends on live model configuration and local environment.

### 9.4 Leftover host processes

On a clean desktop exit the client sends `lsp/stopAll`, `agent/stopAll`, `fs/stopWatcher`, `shell/stopAllBackground`, `mcp/disconnectAll`, then kills and reaps the `codepapr-server` it spawned. Force-killing the desktop (or attaching to an external host via `CODEPAPR_SERVER_URL`) skips that cleanup and can leave the host process plus the LSP / shell children it manages running — check manually.

## 10. Troubleshooting Runbook

### 10.1 Scripts still misbehaving after npm install

First check:
- Whether OneDrive has flattened .bin shims
- Whether repo scripts still invoke Node CLI via run-module-bin.mjs

### 10.2 Tests don't seem updated after source changes

First check:
- Whether affected packages have been rebuilt
- Whether downstream tests use dist entry points
- For Rust changes, whether the desktop was restarted (the host does not hot-reload)

### 10.3 cargo check or desktop debugging fails

First check:
- Whether Rust toolchain is fully installed
- Whether Cargo is in PATH

### 10.4 Desktop reports that codepapr-server is not connected, or the binary cannot be located

First check:
- Whether `npm run build` has been run (or at least `npm run build:host-server --workspace=@codepapr/ui` / `cargo build -p codepapr-server`)
- Whether the path in `CODEPAPR_SERVER_BIN` actually exists
- Whether `CODEPAPR_SERVER_URL` is set but nothing is listening on that port
- If the port never arrives within 15 s: look for `[codepapr-server] listening on ...` in the desktop stderr, and for `codepapr-server-<pid>.port` in the temp directory

### 10.5 Agent tool smoke fails

First check:
- Whether API key is valid
- Whether default model configuration is available
- Whether a browser is detectable
- Whether the failure is from an environment issue rather than a repository logic issue
