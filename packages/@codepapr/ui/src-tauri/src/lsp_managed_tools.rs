#![forbid(unsafe_code)]

use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};
use tar::Archive;
use xz2::read::XzDecoder;
use zip::ZipArchive;

#[derive(Clone)]
pub struct ManagedLspCommand {
    pub command: String,
    pub args: Vec<String>,
    pub tool_origin: String,
    pub tool_source: String,
    pub tool_label: String,
    pub managed_cache_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedLspProgress {
    pub phase: String,
    pub tool_label: String,
    pub detail: String,
    pub cache_path: Option<String>,
}

#[derive(Clone, Copy)]
enum ArchiveKind {
    TarGz,
    TarXz,
    Zip,
}

const CSHARP_ANALYZER_PROJECT: &str =
    "tools/CodePapr.CSharp.Analyzer/CodePapr.CSharp.Analyzer.csproj";
const CLANGD_VERSION: &str = "22.1.6";
// 钉死到 milestone 版本：快照 URL 浮动且无法锁定哈希。
// 该 URL 同时存在于 src/download_verification.rs 的锁定清单中，升级时两处同步。
const JDTLS_DOWNLOAD_URL: &str =
    "https://download.eclipse.org/jdtls/milestones/1.54.0/jdt-language-server-1.54.0-202511261751.tar.gz";
const JAVA_RUNTIME_VERSION: &str = "21";
const NODE_RUNTIME_VERSION: &str = "v20.12.2";
// 钉死版本 + 锁定哈希（见 src/download_verification.rs），禁止使用 latest 浮动 URL。
const SQLS_VERSION: &str = "0.2.48";
const MARKSMAN_VERSION: &str = "2026-02-08";
const MANAGED_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const MANAGED_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_MANAGED_DOWNLOAD_BYTES: usize = 300_000_000;
// 解压防护上限：远超现有工具实际体积（clangd 解压后约 600MB 为最大者）。
const MAX_EXTRACTED_TOTAL_BYTES: u64 = 2_000_000_000;
const MAX_EXTRACTED_ENTRIES: usize = 100_000;

struct ManagedNodeRuntime {
    command: PathBuf,
    npm_cli: Option<PathBuf>,
}

pub fn managed_lsp_commands(workspace: &Path, language_id: &str) -> Vec<ManagedLspCommand> {
    match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            managed_node_package_command(
                "typescript-language-server",
                "typescript-language-server/lib/cli.mjs",
                &["--stdio"],
                "TypeScript language server",
            )
        }
        "html" => managed_node_package_command(
            "vscode-langservers-extracted",
            "vscode-langservers-extracted/bin/vscode-html-language-server",
            &["--stdio"],
            "HTML language server",
        ),
        "css" | "scss" | "less" => managed_node_package_command(
            "vscode-langservers-extracted",
            "vscode-langservers-extracted/bin/vscode-css-language-server",
            &["--stdio"],
            "CSS language server",
        ),
        "json" | "jsonc" => managed_node_package_command(
            "vscode-langservers-extracted",
            "vscode-langservers-extracted/bin/vscode-json-language-server",
            &["--stdio"],
            "JSON language server",
        ),
        "yaml" => managed_node_package_command(
            "yaml-language-server",
            "yaml-language-server/bin/yaml-language-server",
            &["--stdio"],
            "YAML language server",
        ),
        "python" => managed_node_package_command(
            "pyright",
            "pyright/langserver.index.js",
            &["--stdio"],
            "Pyright",
        ),
        "shellscript" => managed_node_package_command(
            "bash-language-server",
            "bash-language-server/out/cli.js",
            &["start"],
            "Bash language server",
        ),
        "csharp" => managed_csharp_commands(),
        "java" => managed_java_commands(workspace),
        "c" | "cpp" => managed_clangd_commands(),
        "rust" => managed_rust_commands(),
        "go" => managed_go_commands(),
        "swift" => managed_swift_commands(),
        "sql" => managed_sql_commands(),
        "markdown" => managed_markdown_commands(),
        _ => Vec::new(),
    }
}

pub fn ensure_managed_language_server(
    workspace: &Path,
    language_id: &str,
    reporter: Option<&dyn Fn(ManagedLspProgress)>,
) -> Result<(), String> {
    if !managed_install_enabled() {
        return Ok(());
    }

    if language_id == "csharp" {
        return ensure_csharp_support(workspace, reporter);
    }

    if !managed_lsp_commands(workspace, language_id).is_empty() {
        return Ok(());
    }

    match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            ensure_node_lsp_support(
                "TypeScript language server",
                &["typescript-language-server", "typescript"],
                reporter,
            )
        }
        "html" | "css" | "scss" | "less" | "json" | "jsonc" => ensure_node_lsp_support(
            "VS Code web language servers",
            &["vscode-langservers-extracted"],
            reporter,
        ),
        "yaml" => {
            ensure_node_lsp_support("YAML language server", &["yaml-language-server"], reporter)
        }
        "python" => ensure_node_lsp_support("Pyright", &["pyright"], reporter),
        "shellscript" => {
            ensure_node_lsp_support("Bash language server", &["bash-language-server"], reporter)
        }
        "java" => ensure_java_support(reporter),
        "c" | "cpp" => ensure_clangd_support(reporter),
        "rust" => ensure_rust_support(reporter),
        "go" => ensure_go_support(reporter),
        "swift" => ensure_swift_support(reporter),
        "sql" => ensure_sql_support(reporter),
        "markdown" => ensure_markdown_support(reporter),
        _ => Ok(()),
    }
}

fn managed_node_package_command(
    package_name: &str,
    module_specifier: &str,
    args: &[&str],
    tool_label: &str,
) -> Vec<ManagedLspCommand> {
    let managed_roots = managed_tool_roots();
    let mut commands = Vec::new();

    for root in &managed_roots {
        commands.extend(managed_node_package_command_for_root(
            root,
            &managed_roots,
            package_name,
            module_specifier,
            args,
            tool_label,
            false,
        ));
    }

    if let Some(root) = repo_root() {
        commands.extend(managed_node_package_command_for_root(
            &root,
            &managed_roots,
            package_name,
            module_specifier,
            args,
            tool_label,
            true,
        ));
    }

    dedupe(commands)
}

fn managed_node_package_command_for_root(
    root: &Path,
    managed_roots: &[PathBuf],
    package_name: &str,
    module_specifier: &str,
    args: &[&str],
    tool_label: &str,
    is_workspace_root: bool,
) -> Vec<ManagedLspCommand> {
    let Some(package_root) = node_package_dir(root, package_name, is_workspace_root) else {
        return Vec::new();
    };

    let Some(node_command) = resolve_node_command_for_root(root, managed_roots) else {
        return Vec::new();
    };

    let entry_path = package_module_entry_path(&package_root, package_name, module_specifier);
    let mut command_args = vec![entry_path.to_string_lossy().to_string()];
    command_args.extend(args.iter().map(|arg| (*arg).to_string()));

    vec![ManagedLspCommand {
        command: node_command,
        args: command_args,
        tool_origin: "managed".to_string(),
        tool_source: if is_workspace_root {
            "workspace-node-package".to_string()
        } else {
            managed_root_source(root).to_string()
        },
        tool_label: tool_label.to_string(),
        managed_cache_path: Some(package_root.to_string_lossy().to_string()),
    }]
}

fn managed_rust_commands() -> Vec<ManagedLspCommand> {
    let executable = executable_name("rust-analyzer");
    let mut commands = managed_binary_commands_no_args(
        &[
            vec!["rust-analyzer".to_string(), executable.clone()],
            vec![
                "rust-analyzer".to_string(),
                "bin".to_string(),
                executable.clone(),
            ],
        ],
        "rust-analyzer",
    );

    if let Some(rust_analyzer) = rustup_which_rust_analyzer() {
        commands.push(ManagedLspCommand {
            command: rust_analyzer.to_string_lossy().to_string(),
            args: Vec::new(),
            tool_origin: "managed".to_string(),
            tool_source: "rustup-component".to_string(),
            tool_label: "rust-analyzer".to_string(),
            managed_cache_path: rust_analyzer
                .parent()
                .map(|path| path.to_string_lossy().to_string()),
        });
    }

    for home_var in &["HOME", "CARGO_HOME"] {
        if let Ok(home) = env::var(home_var) {
            let cargo_bin = PathBuf::from(&home)
                .join(".cargo")
                .join("bin")
                .join(&executable);
            if cargo_bin.is_file() {
                commands.push(ManagedLspCommand {
                    command: cargo_bin.to_string_lossy().to_string(),
                    args: Vec::new(),
                    tool_origin: "managed".to_string(),
                    tool_source: "cargo-install".to_string(),
                    tool_label: "rust-analyzer".to_string(),
                    managed_cache_path: None,
                });
            }
        }
    }

    dedupe(commands)
}

fn managed_go_commands() -> Vec<ManagedLspCommand> {
    let executable = executable_name("gopls");
    let exec_clone = executable.clone();
    let mut commands = managed_binary_commands_no_args(
        &[
            vec!["gopls".to_string(), exec_clone],
            vec!["gopls".to_string(), "bin".to_string(), executable.clone()],
        ],
        "gopls",
    );

    if command_exists("gopls") {
        if let Some(path) = resolve_command_path("gopls") {
            commands.push(ManagedLspCommand {
                command: path.to_string_lossy().to_string(),
                args: Vec::new(),
                tool_origin: "managed".to_string(),
                tool_source: "system-path".to_string(),
                tool_label: "gopls".to_string(),
                managed_cache_path: path.parent().map(|p| p.to_string_lossy().to_string()),
            });
        }
    }

    for home_var in &["HOME", "GOPATH"] {
        if let Ok(home) = env::var(home_var) {
            let go_bin = PathBuf::from(&home)
                .join("go")
                .join("bin")
                .join(&executable);
            if go_bin.is_file() {
                commands.push(ManagedLspCommand {
                    command: go_bin.to_string_lossy().to_string(),
                    args: Vec::new(),
                    tool_origin: "managed".to_string(),
                    tool_source: "go-install".to_string(),
                    tool_label: "gopls".to_string(),
                    managed_cache_path: None,
                });
            }
        }
    }

    dedupe(commands)
}

fn managed_swift_commands() -> Vec<ManagedLspCommand> {
    let mut commands = Vec::new();

    if cfg!(target_os = "macos") {
        if let Some(path) = resolve_command_path("sourcekit-lsp") {
            commands.push(ManagedLspCommand {
                command: path.to_string_lossy().to_string(),
                args: vec!["--stdio".to_string()],
                tool_origin: "managed".to_string(),
                tool_source: "system-path".to_string(),
                tool_label: "sourcekit-lsp".to_string(),
                managed_cache_path: None,
            });
        }

        if commands.is_empty() {
            if let Ok(output) = std::process::Command::new("xcrun")
                .args(["-f", "sourcekit-lsp"])
                .output()
            {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    commands.push(ManagedLspCommand {
                        command: path,
                        args: vec!["--stdio".to_string()],
                        tool_origin: "managed".to_string(),
                        tool_source: "xcode-toolchain".to_string(),
                        tool_label: "sourcekit-lsp".to_string(),
                        managed_cache_path: None,
                    });
                }
            }
        }
    }

    commands
}

fn managed_sql_commands() -> Vec<ManagedLspCommand> {
    let executable = executable_name("sqls");
    let mut commands = managed_binary_commands_no_args(
        &[
            vec!["sqls".to_string(), executable.clone()],
            vec!["sqls".to_string(), "bin".to_string(), executable],
        ],
        "sqls",
    );

    if command_exists("sqls") {
        if let Some(path) = resolve_command_path("sqls") {
            commands.push(ManagedLspCommand {
                command: path.to_string_lossy().to_string(),
                args: Vec::new(),
                tool_origin: "managed".to_string(),
                tool_source: "system-path".to_string(),
                tool_label: "sqls".to_string(),
                managed_cache_path: path.parent().map(|p| p.to_string_lossy().to_string()),
            });
        }
    }

    dedupe(commands)
}

fn managed_markdown_commands() -> Vec<ManagedLspCommand> {
    let executable = executable_name("marksman");
    let mut commands = Vec::new();

    for root in managed_tool_roots() {
        for relative_path in &[
            vec!["marksman".to_string(), executable.clone()],
            vec![
                "marksman".to_string(),
                "bin".to_string(),
                executable.clone(),
            ],
        ] {
            let candidate = relative_path
                .iter()
                .fold(root.clone(), |path, segment| path.join(segment));
            if candidate.is_file() {
                let tool_root = root.join(relative_path.first().cloned().unwrap_or_default());
                commands.push(ManagedLspCommand {
                    command: candidate.to_string_lossy().to_string(),
                    args: vec!["server".to_string()],
                    tool_origin: "managed".to_string(),
                    tool_source: managed_root_source(&root).to_string(),
                    tool_label: "marksman".to_string(),
                    managed_cache_path: Some(tool_root.to_string_lossy().to_string()),
                });
            }
        }
    }

    if command_exists("marksman") {
        if let Some(path) = resolve_command_path("marksman") {
            commands.push(ManagedLspCommand {
                command: path.to_string_lossy().to_string(),
                args: vec!["server".to_string()],
                tool_origin: "managed".to_string(),
                tool_source: "system-path".to_string(),
                tool_label: "marksman".to_string(),
                managed_cache_path: path.parent().map(|p| p.to_string_lossy().to_string()),
            });
        }
    }

    dedupe(commands)
}

fn managed_csharp_commands() -> Vec<ManagedLspCommand> {
    let mut commands: Vec<ManagedLspCommand> = Vec::new();

    let csharp_ls_path = find_in_path_or_dotnet_tools("csharp-ls");
    if let Some(path) = csharp_ls_path {
        commands.push(ManagedLspCommand {
            command: path,
            args: vec![],
            tool_origin: "managed".to_string(),
            tool_source: "system".to_string(),
            tool_label: "csharp-ls".to_string(),
            managed_cache_path: None,
        });
    }

    if commands.is_empty() {
        let bundled = managed_binary_commands_no_args(
            &[
                vec!["csharp-ls".to_string(), executable_name("csharp-ls")],
                vec![
                    "csharp-ls".to_string(),
                    "bin".to_string(),
                    executable_name("csharp-ls"),
                ],
            ],
            "csharp-ls",
        );
        commands.extend(bundled);
    }

    if commands.is_empty() {
        let executable = executable_name("CodePapr.CSharp.Analyzer");
        let bundled_commands = managed_binary_commands(
            &[
                vec!["csharp-analyzer".to_string(), executable.clone()],
                vec!["csharp-analyzer".to_string(), "bin".to_string(), executable],
            ],
            "Roslyn sidecar",
        );
        commands.extend(bundled_commands);
    }

    if cfg!(debug_assertions) && command_exists(dotnet_binary()) {
        let project_path = manifest_dir().join(CSHARP_ANALYZER_PROJECT);
        if project_path.is_file() {
            commands.push(ManagedLspCommand {
                command: "dotnet".to_string(),
                args: vec![
                    "run".to_string(),
                    "--project".to_string(),
                    project_path.to_string_lossy().to_string(),
                    "--no-launch-profile".to_string(),
                    "--".to_string(),
                    "--stdio".to_string(),
                ],
                tool_origin: "managed".to_string(),
                tool_source: "source-sidecar".to_string(),
                tool_label: "Roslyn sidecar".to_string(),
                managed_cache_path: None,
            });
        }
    }

    if commands.is_empty() && command_exists("dotnet") {
        let project_path = manifest_dir().join(CSHARP_ANALYZER_PROJECT);
        if project_path.is_file() {
            commands.push(ManagedLspCommand {
                command: "dotnet".to_string(),
                args: vec![
                    "run".to_string(),
                    "--project".to_string(),
                    project_path.to_string_lossy().to_string(),
                    "--no-launch-profile".to_string(),
                    "--".to_string(),
                    "--stdio".to_string(),
                ],
                tool_origin: "managed".to_string(),
                tool_source: "source-sidecar".to_string(),
                tool_label: "Roslyn sidecar".to_string(),
                managed_cache_path: None,
            });
        }
    }

    commands
}

fn managed_java_commands(workspace: &Path) -> Vec<ManagedLspCommand> {
    let mut commands = Vec::new();
    for root in managed_tool_roots() {
        let java_root = root.join("java");
        let jdtls_root = java_root.join("jdtls");
        let Some(launcher_jar) = find_jdtls_launcher(&jdtls_root) else {
            continue;
        };
        let Some(configuration_dir) = jdtls_configuration_dir(&jdtls_root) else {
            continue;
        };

        let java_command = managed_java_executable(&java_root)
            .map(|path| path.to_string_lossy().to_string())
            .or_else(|| command_exists("java").then(|| "java".to_string()));
        let Some(java_command) = java_command else {
            continue;
        };

        let workspace_data = java_root.join("workspaces").join(workspace_hash(workspace));
        let _ = fs::create_dir_all(&workspace_data);
        commands.push(ManagedLspCommand {
            command: java_command,
            args: vec![
                "-Declipse.application=org.eclipse.jdt.ls.core.id1".to_string(),
                "-Dosgi.bundles.defaultStartLevel=4".to_string(),
                "-Declipse.product=org.eclipse.jdt.ls.core.product".to_string(),
                "-Dlog.protocol=true".to_string(),
                "-Dlog.level=ALL".to_string(),
                "-DwatchParentProcess=false".to_string(),
                "-Xmx1G".to_string(),
                "--add-modules=ALL-SYSTEM".to_string(),
                "--add-opens".to_string(),
                "java.base/java.util=ALL-UNNAMED".to_string(),
                "--add-opens".to_string(),
                "java.base/java.lang=ALL-UNNAMED".to_string(),
                "-jar".to_string(),
                launcher_jar.to_string_lossy().to_string(),
                "-configuration".to_string(),
                configuration_dir.to_string_lossy().to_string(),
                "-data".to_string(),
                workspace_data.to_string_lossy().to_string(),
            ],
            tool_origin: "managed".to_string(),
            tool_source: managed_root_source(&root).to_string(),
            tool_label: "JDTLS".to_string(),
            managed_cache_path: Some(java_root.to_string_lossy().to_string()),
        });
    }

    dedupe(commands)
}

fn managed_clangd_commands() -> Vec<ManagedLspCommand> {
    let executable = executable_name("clangd");
    managed_binary_commands(
        &[
            vec!["clangd".to_string(), executable.clone()],
            vec!["clangd".to_string(), "bin".to_string(), executable],
        ],
        "clangd",
    )
}

fn managed_binary_commands(
    relative_paths: &[Vec<String>],
    tool_label: &str,
) -> Vec<ManagedLspCommand> {
    let mut commands = Vec::new();
    for root in managed_tool_roots() {
        for relative_path in relative_paths {
            let candidate = relative_path
                .iter()
                .fold(root.clone(), |path, segment| path.join(segment));
            if candidate.is_file() {
                let tool_root = root.join(relative_path.first().cloned().unwrap_or_default());
                commands.push(ManagedLspCommand {
                    command: candidate.to_string_lossy().to_string(),
                    args: vec!["--stdio".to_string()],
                    tool_origin: "managed".to_string(),
                    tool_source: managed_root_source(&root).to_string(),
                    tool_label: tool_label.to_string(),
                    managed_cache_path: Some(tool_root.to_string_lossy().to_string()),
                });
            }
        }
    }
    dedupe(commands)
}

fn managed_binary_commands_no_args(
    relative_paths: &[Vec<String>],
    tool_label: &str,
) -> Vec<ManagedLspCommand> {
    let mut commands = Vec::new();
    for root in managed_tool_roots() {
        for relative_path in relative_paths {
            let candidate = relative_path
                .iter()
                .fold(root.clone(), |path, segment| path.join(segment));
            if candidate.is_file() {
                let tool_root = root.join(relative_path.first().cloned().unwrap_or_default());
                commands.push(ManagedLspCommand {
                    command: candidate.to_string_lossy().to_string(),
                    args: Vec::new(),
                    tool_origin: "managed".to_string(),
                    tool_source: managed_root_source(&root).to_string(),
                    tool_label: tool_label.to_string(),
                    managed_cache_path: Some(tool_root.to_string_lossy().to_string()),
                });
            }
        }
    }
    dedupe(commands)
}

fn managed_tool_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(ui_dir) = manifest_dir().parent() {
        roots.push(ui_dir.join("generated").join("lsp-tools"));
    }

    roots.push(manifest_dir().join("generated").join("lsp-tools"));

    if let Some(app_data_root) = app_data_root() {
        roots.push(app_data_root.join("lsp-tools"));
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(executable_dir) = current_exe.parent() {
            roots.push(executable_dir.join("lsp-tools"));
            roots.push(executable_dir.join("resources").join("lsp-tools"));
            roots.push(
                executable_dir
                    .join("_up_")
                    .join("generated")
                    .join("lsp-tools"),
            );
            roots.push(
                executable_dir
                    .join("..")
                    .join("Resources")
                    .join("lsp-tools"),
            );
            roots.push(
                executable_dir
                    .join("..")
                    .join("Resources")
                    .join("_up_")
                    .join("generated")
                    .join("lsp-tools"),
            );
            roots.push(
                executable_dir
                    .join("..")
                    .join("resources")
                    .join("lsp-tools"),
            );
            roots.push(
                executable_dir
                    .join("..")
                    .join("resources")
                    .join("_up_")
                    .join("generated")
                    .join("lsp-tools"),
            );
        }
    }

    dedupe_paths(roots)
}

fn managed_root_source(root: &Path) -> &'static str {
    if let Some(app_data_root) = app_data_root() {
        let managed_cache_root = app_data_root.join("lsp-tools");
        if root.starts_with(&managed_cache_root) {
            return "managed-cache";
        }
    }

    "bundled-resource"
}

fn manifest_dir() -> &'static Path {
    static MANIFEST_DIR: OnceLock<PathBuf> = OnceLock::new();
    MANIFEST_DIR
        .get_or_init(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
        .as_path()
}

fn repo_root() -> Option<PathBuf> {
    let ui_dir = manifest_dir().parent()?;
    let codepapr_scope_dir = ui_dir.parent()?;
    let packages_dir = codepapr_scope_dir.parent()?;
    packages_dir.parent().map(Path::to_path_buf)
}

fn node_package_dir(root: &Path, package_name: &str, is_workspace_root: bool) -> Option<PathBuf> {
    let package_dir = if is_workspace_root {
        root.join("node_modules").join(package_name)
    } else {
        root.join("node-packages")
            .join("node_modules")
            .join(package_name)
    };
    package_dir
        .join("package.json")
        .is_file()
        .then_some(package_dir)
}

fn bundled_node_package_root(install_root: &Path) -> PathBuf {
    install_root.join("node-packages")
}

fn bundled_node_package_installed(install_root: &Path, package_name: &str) -> bool {
    bundled_node_package_root(install_root)
        .join("node_modules")
        .join(package_name)
        .join("package.json")
        .is_file()
}

fn node_package_installed_in_any_root(package_name: &str) -> bool {
    managed_tool_roots().iter().any(|root| {
        root.join("node-packages")
            .join("node_modules")
            .join(package_name)
            .join("package.json")
            .is_file()
            || root
                .join("node_modules")
                .join(package_name)
                .join("package.json")
                .is_file()
    })
}

fn package_module_entry_path(
    package_root: &Path,
    package_name: &str,
    module_specifier: &str,
) -> PathBuf {
    let relative = module_specifier
        .strip_prefix(package_name)
        .and_then(|value| value.strip_prefix('/'))
        .unwrap_or(module_specifier);
    package_root.join(relative)
}

fn app_data_root() -> Option<PathBuf> {
    if let Some(home) = env::var_os("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home).join(".codepapr"));
        }
    }

    if let Some(profile) = env::var_os("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile).join(".codepapr"));
        }
    }

    None
}

fn managed_install_root() -> Result<PathBuf, String> {
    let app_data = app_data_root().ok_or_else(|| "无法确定托管 LSP 安装目录".to_string())?;
    let root = app_data.join("lsp-tools");
    fs::create_dir_all(&root).map_err(|err| format!("创建托管 LSP 目录失败: {err}"))?;
    Ok(root)
}

fn managed_install_enabled() -> bool {
    if cfg!(test) && !env_flag_enabled("CODEPAPR_ENABLE_MANAGED_LSP_DOWNLOAD_IN_TESTS") {
        return false;
    }

    env::var("CODEPAPR_DISABLE_MANAGED_LSP_DOWNLOAD")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            normalized != "1" && normalized != "true" && normalized != "yes" && normalized != "on"
        })
        .unwrap_or(true)
}

fn env_flag_enabled(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

fn ensure_java_support(reporter: Option<&dyn Fn(ManagedLspProgress)>) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let install_root = managed_install_root()?;
        let java_root = install_root.join("java");
        let jdtls_root = java_root.join("jdtls");
        let jre_root = java_root.join("jre");

        emit_progress(
            reporter,
            "checking",
            "Java LSP",
            String::new(),
            Some(&java_root),
        );

        if find_jdtls_launcher(&jdtls_root).is_none() {
            install_archive(
                JDTLS_DOWNLOAD_URL,
                ArchiveKind::TarGz,
                &jdtls_root,
                "jdtls",
                "JDTLS",
                reporter,
            )?;
        }

        if managed_java_executable(&java_root).is_none() {
            let (url, archive_kind) = managed_java_download()?;
            install_archive(
                &url,
                archive_kind,
                &jre_root,
                "jre",
                "Temurin JRE",
                reporter,
            )?;
            let java_executable = managed_java_executable(&java_root).ok_or_else(|| {
                "托管 Java runtime 安装完成，但未找到 java 可执行文件".to_string()
            })?;
            ensure_executable(&java_executable)?;
        }

        Ok(())
    })();

    if let Err(err) = &result {
        let cache_path = managed_install_root().ok().map(|root| root.join("java"));
        emit_progress(
            reporter,
            "failed",
            "Java LSP",
            err.clone(),
            cache_path.as_deref(),
        );
    }

    result
}

fn ensure_csharp_support(
    workspace: &Path,
    reporter: Option<&dyn Fn(ManagedLspProgress)>,
) -> Result<(), String> {
    let cache_path = managed_csharp_commands()
        .first()
        .and_then(|command| command.managed_cache_path.as_ref().map(PathBuf::from))
        .or_else(app_data_root);

    let has_csproj = std::fs::read_dir(workspace)
        .map(|entries| {
            entries.filter_map(|e| e.ok()).any(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "csproj" || ext == "sln")
            })
        })
        .unwrap_or(false);

    if has_csproj {
        let assets = workspace.join("obj").join("project.assets.json");
        if !assets.is_file() {
            emit_progress(
                reporter,
                "checking",
                "NuGet restore",
                "正在恢复 NuGet 包...".to_string(),
                cache_path.as_deref(),
            );
            let restore = std::process::Command::new(dotnet_binary())
                .args(["restore"])
                .current_dir(workspace)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .output();
            match restore {
                Ok(output) if output.status.success() => {
                    emit_progress(
                        reporter,
                        "ready",
                        "NuGet restore",
                        "NuGet 包恢复完成".to_string(),
                        cache_path.as_deref(),
                    );
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let msg = format!("dotnet restore 失败: {}", stderr.trim());
                    emit_progress(
                        reporter,
                        "failed",
                        "NuGet restore",
                        msg,
                        cache_path.as_deref(),
                    );
                }
                Err(e) => {
                    emit_progress(
                        reporter,
                        "failed",
                        "NuGet restore",
                        format!("无法运行 dotnet restore: {e}"),
                        cache_path.as_deref(),
                    );
                }
            }
        }
    }

    let has_csharp_ls = find_in_path_or_dotnet_tools("csharp-ls").is_some();

    if has_csharp_ls {
        return Ok(());
    }

    if command_exists(dotnet_binary()) {
        emit_progress(
            reporter,
            "checking",
            "csharp-ls",
            "正在安装 csharp-ls...".to_string(),
            cache_path.as_deref(),
        );

        let install_output = std::process::Command::new(dotnet_binary())
            .args(["tool", "install", "--global", "csharp-ls"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output();

        let install_succeeded = install_output.as_ref().is_ok_and(|o| o.status.success());
        let already_installed = install_output.as_ref().is_ok_and(|o| {
            let stderr = String::from_utf8_lossy(&o.stderr);
            stderr.contains("already installed")
        });

        if already_installed {
            let _ = std::process::Command::new(dotnet_binary())
                .args(["tool", "update", "--global", "csharp-ls"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }

        if install_succeeded || already_installed {
            crate::lsp::refresh_expanded_path();
        }

        if find_in_path_or_dotnet_tools("csharp-ls").is_some() {
            emit_progress(
                reporter,
                "ready",
                "csharp-ls",
                String::new(),
                cache_path.as_deref(),
            );
            return Ok(());
        }
    }

    if !managed_csharp_commands().is_empty() {
        return Ok(());
    }

    let err =
        "C# 语言服务不可用，请安装 .NET SDK 或 dotnet tool install --global csharp-ls".to_string();
    emit_progress(
        reporter,
        "failed",
        "C# analyzer",
        err.clone(),
        cache_path.as_deref(),
    );
    Err(err)
}

fn ensure_swift_support(reporter: Option<&dyn Fn(ManagedLspProgress)>) -> Result<(), String> {
    emit_progress(reporter, "checking", "sourcekit-lsp", String::new(), None);
    if !managed_swift_commands().is_empty() {
        return Ok(());
    }
    Err("sourcekit-lsp 不可用。macOS 用户请安装 Xcode，Linux 用户请安装 Swift 工具链。".to_string())
}

fn ensure_sql_support(reporter: Option<&dyn Fn(ManagedLspProgress)>) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let cache_path = managed_sql_commands()
            .first()
            .and_then(|c| c.managed_cache_path.as_ref().map(PathBuf::from))
            .or_else(app_data_root);
        emit_progress(
            reporter,
            "checking",
            "sqls",
            String::new(),
            cache_path.as_deref(),
        );

        if sqls_command_works() || !managed_sql_commands().is_empty() {
            return Ok(());
        }

        let install_root = managed_install_root()?;
        let sqls_root = install_root.join("sqls");
        let (url, archive_kind) = managed_sqls_download()?;
        install_archive(&url, archive_kind, &sqls_root, "sqls", "sqls", reporter)?;

        let bin_dir = sqls_root.join("bin");
        fs::create_dir_all(&bin_dir).map_err(|e| format!("创建 sqls bin 目录失败: {e}"))?;
        if let Some(binary) = find_extracted_binary(&sqls_root, "sqls") {
            let dest = bin_dir.join(executable_name("sqls"));
            fs::rename(&binary, &dest).map_err(|e| format!("移动 sqls 失败: {e}"))?;
            ensure_executable(&dest)?;
        }

        if sqls_command_works() || !managed_sql_commands().is_empty() {
            return Ok(());
        }

        Err("sqls 安装完成但不可用".to_string())
    })();

    if let Err(err) = &result {
        emit_progress(
            reporter,
            "failed",
            "sqls",
            err.clone(),
            app_data_root().as_deref(),
        );
    }
    result
}

fn ensure_markdown_support(reporter: Option<&dyn Fn(ManagedLspProgress)>) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let cache_path = managed_markdown_commands()
            .first()
            .and_then(|c| c.managed_cache_path.as_ref().map(PathBuf::from))
            .or_else(app_data_root);
        emit_progress(
            reporter,
            "checking",
            "marksman",
            String::new(),
            cache_path.as_deref(),
        );

        if marksman_command_works() || !managed_markdown_commands().is_empty() {
            return Ok(());
        }

        let install_root = managed_install_root()?;
        let marksman_root = install_root.join("marksman");
        let url = managed_marksman_url()?;
        install_single_binary(&url, &marksman_root, "marksman", "marksman", reporter)?;

        if marksman_command_works() || !managed_markdown_commands().is_empty() {
            return Ok(());
        }

        Err("marksman 安装完成但不可用".to_string())
    })();

    if let Err(err) = &result {
        emit_progress(
            reporter,
            "failed",
            "marksman",
            err.clone(),
            app_data_root().as_deref(),
        );
    }
    result
}

fn find_extracted_binary(root: &Path, name: &str) -> Option<PathBuf> {
    let exe = executable_name(name);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path
                    .file_name()
                    .map(|n| n.to_string_lossy() == exe.as_str())
                    .unwrap_or(false)
                {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn sqls_command_works() -> bool {
    command_exists("sqls")
        && run_command_with_timeout(
            "sqls",
            &["--version"],
            &std::env::current_dir().unwrap_or_default(),
            Duration::from_secs(10),
        )
        .map(|o| o.status_code == Some(0))
        .unwrap_or(false)
}

fn marksman_command_works() -> bool {
    command_exists("marksman")
        && run_command_with_timeout(
            "marksman",
            &["--version"],
            &std::env::current_dir().unwrap_or_default(),
            Duration::from_secs(10),
        )
        .map(|o| o.status_code == Some(0))
        .unwrap_or(false)
}

fn managed_sqls_download() -> Result<(String, ArchiveKind), String> {
    // sqls 官方仅提供 x86_64 构建：macOS ARM 经 Rosetta 运行；Linux ARM 无可用构建。
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") {
            return Err("sqls 官方未提供 Linux ARM64 构建，请手动安装 sqls".to_string());
        }
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        return Err("当前平台不支持 sqls 下载".to_string());
    };
    Ok((
        format!(
            "https://github.com/sqls-server/sqls/releases/download/v{SQLS_VERSION}/sqls-{os}-{SQLS_VERSION}.zip"
        ),
        ArchiveKind::Zip,
    ))
}

fn managed_marksman_url() -> Result<String, String> {
    // marksman 自 2024-12 起以裸二进制发布（无压缩包）；linux 用 musl 静态构建，
    // 兼容任意发行版。macOS 为 universal binary。URL 与锁定清单一一对应。
    let name = if cfg!(target_os = "macos") {
        "marksman-macos".to_string()
    } else if cfg!(target_os = "linux") {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        format!("marksman-linux-musl-{arch}")
    } else if cfg!(target_os = "windows") {
        "marksman.exe".to_string()
    } else {
        return Err("当前平台不支持 marksman 下载".to_string());
    };
    Ok(format!(
        "https://github.com/artempyanykh/marksman/releases/download/{MARKSMAN_VERSION}/{name}"
    ))
}

fn ensure_clangd_support(reporter: Option<&dyn Fn(ManagedLspProgress)>) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let install_root = managed_install_root()?;
        let clangd_root = install_root.join("clangd");
        let executable = clangd_root.join("bin").join(executable_name("clangd"));
        emit_progress(
            reporter,
            "checking",
            "clangd",
            String::new(),
            Some(&clangd_root),
        );
        if executable.is_file() {
            return Ok(());
        }

        let (url, archive_kind) = managed_clangd_download()?;
        install_archive(
            &url,
            archive_kind,
            &clangd_root,
            "clangd",
            "clangd",
            reporter,
        )?;
        let executable = clangd_root.join("bin").join(executable_name("clangd"));
        if !executable.is_file() {
            return Err("托管 clangd 安装完成，但未找到 clangd 可执行文件".to_string());
        }
        ensure_executable(&executable)
    })();

    if let Err(err) = &result {
        let cache_path = managed_install_root().ok().map(|root| root.join("clangd"));
        emit_progress(
            reporter,
            "failed",
            "clangd",
            err.clone(),
            cache_path.as_deref(),
        );
    }

    result
}

fn ensure_node_lsp_support(
    tool_label: &str,
    package_names: &[&str],
    reporter: Option<&dyn Fn(ManagedLspProgress)>,
) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let install_root = managed_install_root()?;
        let package_root = bundled_node_package_root(&install_root);
        emit_progress(
            reporter,
            "checking",
            tool_label,
            String::new(),
            Some(&package_root),
        );

        let mut managed_runtime = managed_node_runtime_from_roots(&managed_tool_roots());
        if managed_runtime.is_none() && (!command_exists("node") || !command_exists(npm_command()))
        {
            ensure_managed_node_runtime(reporter)?;
            managed_runtime = managed_node_runtime_from_roots(&managed_tool_roots());
        }

        if !command_exists("node") && managed_runtime.is_none() {
            return Err("缺少 Node.js runtime，不能启动托管 Node LSP".to_string());
        }

        let missing = package_names
            .iter()
            .copied()
            .filter(|package_name| {
                !bundled_node_package_installed(&install_root, package_name)
                    && !node_package_installed_in_any_root(package_name)
            })
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return Ok(());
        }

        emit_progress(
            reporter,
            "downloading",
            tool_label,
            format!("正在安装 {}", missing.join(", ")),
            Some(&package_root),
        );
        run_node_package_install(&package_root, &missing, managed_runtime.as_ref())?;

        let still_missing = package_names
            .iter()
            .copied()
            .filter(|package_name| !bundled_node_package_installed(&install_root, package_name))
            .collect::<Vec<_>>();
        if !still_missing.is_empty() {
            return Err(format!(
                "npm install 已结束，但仍缺少托管 LSP 包: {}",
                still_missing.join(", ")
            ));
        }

        emit_progress(
            reporter,
            "ready",
            tool_label,
            String::new(),
            Some(&package_root),
        );
        Ok(())
    })();

    if let Err(err) = &result {
        let cache_path = managed_install_root()
            .ok()
            .map(|root| bundled_node_package_root(&root));
        emit_progress(
            reporter,
            "failed",
            tool_label,
            err.clone(),
            cache_path.as_deref(),
        );
    }

    result
}

fn ensure_managed_node_runtime(
    reporter: Option<&dyn Fn(ManagedLspProgress)>,
) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let install_root = managed_install_root()?;
        let node_root = install_root.join("node-runtime");
        emit_progress(
            reporter,
            "checking",
            "Node.js runtime",
            String::new(),
            Some(&node_root),
        );

        if let Some(runtime) = managed_node_runtime_in_root(&install_root) {
            return ensure_executable(&runtime.command);
        }

        let (url, archive_kind) = managed_node_download()?;
        install_archive(
            &url,
            archive_kind,
            &node_root,
            "node-runtime",
            "Node.js runtime",
            reporter,
        )?;
        let runtime = managed_node_runtime_in_root(&install_root)
            .ok_or_else(|| "托管 Node.js runtime 安装完成，但未找到 node 可执行文件".to_string())?;
        ensure_executable(&runtime.command)
    })();

    if let Err(err) = &result {
        let cache_path = managed_install_root()
            .ok()
            .map(|root| root.join("node-runtime"));
        emit_progress(
            reporter,
            "failed",
            "Node.js runtime",
            err.clone(),
            cache_path.as_deref(),
        );
    }

    result
}

fn ensure_rust_support(reporter: Option<&dyn Fn(ManagedLspProgress)>) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let cache_path = managed_rust_commands()
            .first()
            .and_then(|command| command.managed_cache_path.as_ref().map(PathBuf::from))
            .or_else(|| {
                rustup_which_rust_analyzer().and_then(|path| path.parent().map(Path::to_path_buf))
            })
            .or_else(app_data_root);
        emit_progress(
            reporter,
            "checking",
            "rust-analyzer",
            String::new(),
            cache_path.as_deref(),
        );

        if rust_analyzer_command_works() || !managed_rust_commands().is_empty() {
            return Ok(());
        }

        if !command_exists("rustup") {
            return Err("缺少 rustup，不能自动安装 rust-analyzer".to_string());
        }

        emit_progress(
            reporter,
            "downloading",
            "rust-analyzer",
            "正在安装 rustup component rust-analyzer".to_string(),
            cache_path.as_deref(),
        );
        let output = run_command_with_timeout(
            "rustup",
            &["component", "add", "rust-analyzer"],
            &env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            MANAGED_COMMAND_TIMEOUT,
        )?;
        if output.status_code != Some(0) {
            return Err(format_command_failure(
                "rustup component add rust-analyzer",
                &output,
            ));
        }
        crate::lsp::refresh_expanded_path();

        if rust_analyzer_command_works() || !managed_rust_commands().is_empty() {
            emit_progress(
                reporter,
                "ready",
                "rust-analyzer",
                String::new(),
                cache_path.as_deref(),
            );
            return Ok(());
        }

        Err("rust-analyzer 安装完成，但未能定位可执行文件".to_string())
    })();

    if let Err(err) = &result {
        emit_progress(
            reporter,
            "failed",
            "rust-analyzer",
            err.clone(),
            app_data_root().as_deref(),
        );
    }

    result
}

fn ensure_go_support(reporter: Option<&dyn Fn(ManagedLspProgress)>) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        let cache_path = managed_go_commands()
            .first()
            .and_then(|command| command.managed_cache_path.as_ref().map(PathBuf::from))
            .or_else(app_data_root);
        emit_progress(
            reporter,
            "checking",
            "gopls",
            String::new(),
            cache_path.as_deref(),
        );

        if gopls_command_works() || !managed_go_commands().is_empty() {
            return Ok(());
        }

        if command_exists("go") {
            emit_progress(
                reporter,
                "downloading",
                "gopls",
                "正在通过 go install 安装 gopls".to_string(),
                cache_path.as_deref(),
            );
            let go_path_output = run_command_with_timeout(
                "go",
                &["env", "GOPATH"],
                &env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                Duration::from_secs(10),
            )?;
            let go_path = go_path_output.stdout.trim();
            let gopls_bin = if go_path.is_empty() {
                None
            } else {
                let candidate = PathBuf::from(go_path)
                    .join("bin")
                    .join(executable_name("gopls"));
                candidate.is_file().then_some(candidate)
            };

            let install_output = run_command_with_timeout(
                "go",
                &["install", "golang.org/x/tools/gopls@latest"],
                &env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                MANAGED_COMMAND_TIMEOUT,
            )?;
            if install_output.status_code != Some(0) {
                return Err(format_command_failure("go install gopls", &install_output));
            }

            let resolved_gopls = resolve_command_path("gopls");
            if let Some(gopls_path) = gopls_bin.as_ref().or(resolved_gopls.as_ref()) {
                let install_root = managed_install_root()?;
                let dest_dir = install_root.join("gopls").join("bin");
                fs::create_dir_all(&dest_dir)
                    .map_err(|err| format!("创建 gopls 托管目录失败: {err}"))?;
                let dest = dest_dir.join(executable_name("gopls"));
                if !dest.is_file() {
                    fs::copy(gopls_path, &dest)
                        .map_err(|err| format!("复制 gopls 到托管目录失败: {err}"))?;
                    ensure_executable(&dest)?;
                }
            }

            if gopls_command_works() || !managed_go_commands().is_empty() {
                emit_progress(
                    reporter,
                    "ready",
                    "gopls",
                    String::new(),
                    cache_path.as_deref(),
                );
                return Ok(());
            }
        }

        Err(
            "gopls 不可用，请安装 Go 工具链后运行 go install golang.org/x/tools/gopls@latest"
                .to_string(),
        )
    })();

    if let Err(err) = &result {
        emit_progress(
            reporter,
            "failed",
            "gopls",
            err.clone(),
            app_data_root().as_deref(),
        );
    }

    result
}

fn gopls_command_works() -> bool {
    if !command_exists("gopls") {
        return false;
    }

    run_command_with_timeout(
        "gopls",
        &["version"],
        &env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        Duration::from_secs(10),
    )
    .map(|output| output.status_code == Some(0))
    .unwrap_or(false)
}

fn install_archive(
    url: &str,
    archive_kind: ArchiveKind,
    destination: &Path,
    label: &str,
    tool_label: &str,
    reporter: Option<&dyn Fn(ManagedLspProgress)>,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("无法确定 {label} 安装目录"))?;
    fs::create_dir_all(parent).map_err(|err| format!("创建 {label} 安装目录失败: {err}"))?;

    let unique = format!("{}-{}", std::process::id(), monotonic_nanos());
    let archive_path = parent.join(format!(".{label}-{unique}.download"));
    let stage_root = parent.join(format!(".{label}-{unique}.stage"));

    let install_result = (|| {
        emit_progress(
            reporter,
            "downloading",
            tool_label,
            String::new(),
            Some(destination),
        );
        download_to_file(url, &archive_path)?;
        // 解压前强校验：哈希不匹配直接中止（临时文件由下方统一清理）。
        let verification = crate::download_verification::verify_download(url, &archive_path)
            .map_err(|err| format!("{label} 下载校验失败，已中止安装: {err}"))?;
        log_verification(tool_label, url, &verification);
        fs::create_dir_all(&stage_root)
            .map_err(|err| format!("创建 {label} 暂存目录失败: {err}"))?;
        emit_progress(
            reporter,
            "extracting",
            tool_label,
            String::new(),
            Some(destination),
        );
        extract_archive(&archive_path, archive_kind, &stage_root)?;
        let extracted_root = select_extracted_root(&stage_root)?;
        if destination.exists() {
            fs::remove_dir_all(destination)
                .map_err(|err| format!("清理旧的 {label} 目录失败: {err}"))?;
        }
        if extracted_root == stage_root {
            fs::rename(&stage_root, destination)
                .map_err(|err| format!("写入 {label} 目录失败: {err}"))?;
        } else {
            fs::rename(&extracted_root, destination)
                .map_err(|err| format!("写入 {label} 目录失败: {err}"))?;
            let _ = fs::remove_dir_all(&stage_root);
        }
        write_install_manifest(destination, tool_label, url, &verification);
        emit_progress(
            reporter,
            "ready",
            tool_label,
            String::new(),
            Some(destination),
        );
        Ok(())
    })();

    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir_all(&stage_root);
    install_result
}

/// 下载单个二进制文件（marksman 等无压缩包发布的工具），同样执行强校验。
fn install_single_binary(
    url: &str,
    destination_root: &Path,
    binary_name: &str,
    tool_label: &str,
    reporter: Option<&dyn Fn(ManagedLspProgress)>,
) -> Result<(), String> {
    fs::create_dir_all(destination_root)
        .map_err(|err| format!("创建 {tool_label} 安装目录失败: {err}"))?;

    let unique = format!("{}-{}", std::process::id(), monotonic_nanos());
    let download_path = destination_root.join(format!(".{binary_name}-{unique}.download"));

    let install_result = (|| {
        emit_progress(
            reporter,
            "downloading",
            tool_label,
            String::new(),
            Some(destination_root),
        );
        download_to_file(url, &download_path)?;
        let verification = crate::download_verification::verify_download(url, &download_path)
            .map_err(|err| format!("{tool_label} 下载校验失败，已中止安装: {err}"))?;
        log_verification(tool_label, url, &verification);

        let bin_dir = destination_root.join("bin");
        fs::create_dir_all(&bin_dir)
            .map_err(|err| format!("创建 {tool_label} bin 目录失败: {err}"))?;
        let dest = bin_dir.join(executable_name(binary_name));
        if dest.exists() {
            fs::remove_file(&dest)
                .map_err(|err| format!("清理旧的 {tool_label} 二进制失败: {err}"))?;
        }
        fs::rename(&download_path, &dest)
            .map_err(|err| format!("写入 {tool_label} 二进制失败: {err}"))?;
        ensure_executable(&dest)?;
        write_install_manifest(destination_root, tool_label, url, &verification);
        emit_progress(
            reporter,
            "ready",
            tool_label,
            String::new(),
            Some(destination_root),
        );
        Ok(())
    })();

    let _ = fs::remove_file(&download_path);
    install_result
}

fn log_verification(
    tool_label: &str,
    url: &str,
    outcome: &crate::download_verification::VerificationOutcome,
) {
    match outcome {
        crate::download_verification::VerificationOutcome::Verified { .. } => {
            eprintln!("[managed-lsp] {tool_label} {}", outcome.description());
        }
        _ => {
            eprintln!(
                "[managed-lsp] 警告: {tool_label} {url} {}",
                outcome.description()
            );
        }
    }
}

/// 记录安装来源与校验信息，便于事后审计（版本、来源、哈希、安装时间）。
fn write_install_manifest(
    install_root: &Path,
    tool_label: &str,
    url: &str,
    outcome: &crate::download_verification::VerificationOutcome,
) {
    let (verified, source, sha256) = match outcome {
        crate::download_verification::VerificationOutcome::Verified { source, .. } => {
            (true, source.to_string(), String::new())
        }
        crate::download_verification::VerificationOutcome::NoChecksumSource { computed_sha256 } => {
            (false, String::new(), computed_sha256.clone())
        }
        crate::download_verification::VerificationOutcome::ChecksumUnavailable {
            computed_sha256,
            ..
        } => (false, String::new(), computed_sha256.clone()),
    };
    let manifest = serde_json::json!({
        "tool": tool_label,
        "url": url,
        "verified": verified,
        "verificationSource": source,
        "sha256": sha256,
        "installedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let path = install_root.join(".codepapr-install-manifest.json");
    let _ = fs::write(
        path,
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    );
}

fn emit_progress(
    reporter: Option<&dyn Fn(ManagedLspProgress)>,
    phase: &str,
    tool_label: &str,
    detail: String,
    cache_path: Option<&Path>,
) {
    let Some(reporter) = reporter else {
        return;
    };

    reporter(ManagedLspProgress {
        phase: phase.to_string(),
        tool_label: tool_label.to_string(),
        detail,
        cache_path: cache_path.map(|path| path.to_string_lossy().to_string()),
    });
}

fn download_to_file(url: &str, target: &Path) -> Result<(), String> {
    let client = Client::builder()
        .timeout(MANAGED_DOWNLOAD_TIMEOUT)
        .user_agent("CodePapr/0.1")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| format!("初始化托管 LSP 下载客户端失败: {err}"))?;

    let mut response = client
        .get(url)
        .send()
        .map_err(|err| format!("下载托管 LSP 资源失败: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载托管 LSP 资源失败: HTTP {status}"));
    }

    if let Some(length) = response.content_length() {
        if length > MAX_MANAGED_DOWNLOAD_BYTES as u64 {
            return Err(format!(
                "托管 LSP 下载体积超过上限 {MAX_MANAGED_DOWNLOAD_BYTES} bytes"
            ));
        }
    }

    let mut file =
        fs::File::create(target).map_err(|err| format!("创建托管 LSP 下载文件失败: {err}"))?;
    let mut downloaded = 0_usize;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|err| format!("读取托管 LSP 下载响应失败: {err}"))?;
        if read == 0 {
            break;
        }

        downloaded += read;
        if downloaded > MAX_MANAGED_DOWNLOAD_BYTES {
            return Err(format!(
                "托管 LSP 下载体积超过上限 {MAX_MANAGED_DOWNLOAD_BYTES} bytes"
            ));
        }

        file.write_all(&buffer[..read])
            .map_err(|err| format!("写入托管 LSP 下载文件失败: {err}"))?;
    }

    Ok(())
}

fn extract_archive(
    archive_path: &Path,
    archive_kind: ArchiveKind,
    destination: &Path,
) -> Result<(), String> {
    match archive_kind {
        ArchiveKind::TarGz => extract_tar_gz(archive_path, destination),
        ArchiveKind::TarXz => extract_tar_xz(archive_path, destination),
        ArchiveKind::Zip => extract_zip(archive_path, destination),
    }
}

fn extract_tar_gz(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file =
        fs::File::open(archive_path).map_err(|err| format!("打开 tar.gz 归档失败: {err}"))?;
    let decoder = GzDecoder::new(archive_file);
    extract_tar_entries(Archive::new(decoder), archive_path, destination)
}

fn extract_tar_xz(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file =
        fs::File::open(archive_path).map_err(|err| format!("打开 tar.xz 归档失败: {err}"))?;
    let decoder = XzDecoder::new(archive_file);
    extract_tar_entries(Archive::new(decoder), archive_path, destination)
}

/// 逐条目解压 tar 归档，施加安全限制：
/// - `unpack_in` 保证路径与符号链接/硬链接目标不逃逸出目标目录；
/// - 条目总数与解压后总体积受限，防止解压炸弹。
fn extract_tar_entries<R: Read>(
    mut archive: Archive<R>,
    archive_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    let mut entry_count = 0_usize;
    let mut total_bytes = 0_u64;

    let entries = archive
        .entries()
        .map_err(|err| format!("读取 tar 归档条目失败 ({}): {err}", archive_path.display()))?;
    for entry in entries {
        let mut entry = entry
            .map_err(|err| format!("读取 tar 归档条目失败 ({}): {err}", archive_path.display()))?;

        entry_count += 1;
        if entry_count > MAX_EXTRACTED_ENTRIES {
            return Err(format!(
                "tar 归档条目数超过上限 {MAX_EXTRACTED_ENTRIES} ({})",
                archive_path.display()
            ));
        }
        let size = entry.header().size().unwrap_or(0);
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_EXTRACTED_TOTAL_BYTES {
            return Err(format!(
                "tar 归档解压体积超过上限 {MAX_EXTRACTED_TOTAL_BYTES} bytes ({})",
                archive_path.display()
            ));
        }

        let unpacked = entry
            .unpack_in(destination)
            .map_err(|err| format!("解压 tar 归档条目失败 ({}): {err}", archive_path.display()))?;
        if !unpacked {
            return Err(format!(
                "tar 归档包含非法路径条目，已拒绝解压 ({})",
                archive_path.display()
            ));
        }
    }

    Ok(())
}

fn extract_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file =
        fs::File::open(archive_path).map_err(|err| format!("打开 zip 归档失败: {err}"))?;
    let mut archive =
        ZipArchive::new(archive_file).map_err(|err| format!("解析 zip 归档失败: {err}"))?;

    let mut entry_count = 0_usize;
    let mut total_bytes = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("读取 zip 条目失败: {err}"))?;

        entry_count += 1;
        if entry_count > MAX_EXTRACTED_ENTRIES {
            return Err(format!(
                "zip 归档条目数超过上限 {MAX_EXTRACTED_ENTRIES} ({})",
                archive_path.display()
            ));
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > MAX_EXTRACTED_TOTAL_BYTES {
            return Err(format!(
                "zip 归档解压体积超过上限 {MAX_EXTRACTED_TOTAL_BYTES} bytes ({})",
                archive_path.display()
            ));
        }

        // enclosed_name 拒绝绝对路径与 `..` 组件；非法条目直接报错而非跳过。
        let Some(entry_path) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            return Err(format!(
                "zip 归档包含非法路径条目，已拒绝解压 ({})",
                archive_path.display()
            ));
        };
        let target = destination.join(entry_path);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|err| format!("创建 zip 目录失败: {err}"))?;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建 zip 父目录失败: {err}"))?;
        }

        let mut file =
            fs::File::create(&target).map_err(|err| format!("创建 zip 文件失败: {err}"))?;
        std::io::copy(&mut entry, &mut file).map_err(|err| format!("写入 zip 文件失败: {err}"))?;

        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
        }
    }

    Ok(())
}

fn select_extracted_root(stage_root: &Path) -> Result<PathBuf, String> {
    let entries = fs::read_dir(stage_root)
        .map_err(|err| format!("读取托管 LSP 暂存目录失败: {err}"))?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();
    if entries.len() == 1 {
        let path = entries[0].path();
        if path.is_dir() {
            return Ok(path);
        }
    }
    Ok(stage_root.to_path_buf())
}

fn managed_java_download() -> Result<(String, ArchiveKind), String> {
    let os = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        return Err("当前平台暂不支持托管 Java runtime 下载".to_string());
    };

    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err("当前架构暂不支持托管 Java runtime 下载".to_string());
    };

    let archive_kind = if cfg!(target_os = "windows") {
        ArchiveKind::Zip
    } else {
        ArchiveKind::TarGz
    };

    Ok((
        format!(
            "https://api.adoptium.net/v3/binary/latest/{JAVA_RUNTIME_VERSION}/ga/{os}/{arch}/jre/hotspot/normal/eclipse"
        ),
        archive_kind,
    ))
}

fn managed_clangd_download() -> Result<(String, ArchiveKind), String> {
    let platform = if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        if !cfg!(target_arch = "x86_64") {
            return Err("当前 Linux 架构暂不支持托管 clangd 下载".to_string());
        }
        "linux"
    } else if cfg!(target_os = "windows") {
        if !cfg!(target_arch = "x86_64") {
            return Err("当前 Windows 架构暂不支持托管 clangd 下载".to_string());
        }
        "windows"
    } else {
        return Err("当前平台暂不支持托管 clangd 下载".to_string());
    };

    Ok((
        format!(
            "https://github.com/clangd/clangd/releases/download/{CLANGD_VERSION}/clangd-{platform}-{CLANGD_VERSION}.zip"
        ),
        ArchiveKind::Zip,
    ))
}

fn managed_node_download() -> Result<(String, ArchiveKind), String> {
    let (platform, archive_kind) = if cfg!(target_os = "macos") {
        ("darwin", ArchiveKind::TarGz)
    } else if cfg!(target_os = "linux") {
        ("linux", ArchiveKind::TarXz)
    } else if cfg!(target_os = "windows") {
        ("win", ArchiveKind::Zip)
    } else {
        return Err("当前平台暂不支持托管 Node.js runtime 下载".to_string());
    };

    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err("当前架构暂不支持托管 Node.js runtime 下载".to_string());
    };

    let extension = match archive_kind {
        ArchiveKind::TarGz => "tar.gz",
        ArchiveKind::TarXz => "tar.xz",
        ArchiveKind::Zip => "zip",
    };

    Ok((
        format!(
            "https://nodejs.org/dist/{NODE_RUNTIME_VERSION}/node-{NODE_RUNTIME_VERSION}-{platform}-{arch}.{extension}"
        ),
        archive_kind,
    ))
}

fn managed_java_executable(java_root: &Path) -> Option<PathBuf> {
    let candidates = [
        java_root
            .join("jre")
            .join("bin")
            .join(executable_name("java")),
        java_root
            .join("jre")
            .join("Contents")
            .join("Home")
            .join("bin")
            .join(executable_name("java")),
        java_root.join("bin").join(executable_name("java")),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn managed_node_runtime_from_roots(roots: &[PathBuf]) -> Option<ManagedNodeRuntime> {
    roots
        .iter()
        .find_map(|root| managed_node_runtime_in_root(root))
}

fn managed_node_runtime_in_root(root: &Path) -> Option<ManagedNodeRuntime> {
    let runtime_root = root.join("node-runtime");
    let command = [
        runtime_root.join("bin").join(executable_name("node")),
        runtime_root.join(executable_name("node")),
    ]
    .into_iter()
    .find(|path| path.is_file())?;

    let npm_cli = [
        runtime_root
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
        runtime_root
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
    ]
    .into_iter()
    .find(|path| path.is_file());

    Some(ManagedNodeRuntime { command, npm_cli })
}

fn find_jdtls_launcher(jdtls_root: &Path) -> Option<PathBuf> {
    let plugins_dir = jdtls_root.join("plugins");
    let entries = fs::read_dir(plugins_dir).ok()?;
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| {
                    name.starts_with("org.eclipse.equinox.launcher_") && name.ends_with(".jar")
                })
                .unwrap_or(false)
        })
}

fn jdtls_configuration_dir(jdtls_root: &Path) -> Option<PathBuf> {
    let config_name = if cfg!(target_os = "macos") {
        "config_mac"
    } else if cfg!(target_os = "windows") {
        "config_win"
    } else if cfg!(target_os = "linux") {
        "config_linux"
    } else {
        return None;
    };

    let path = jdtls_root.join(config_name);
    path.is_dir().then_some(path)
}

fn workspace_hash(workspace: &Path) -> String {
    // FNV-1a：算法固定，跨 Rust 版本稳定。DefaultHasher 的输出无稳定性保证，
    // 工具链升级后 JDTLS -data 目录名会漂移，强制整个工作区重新索引。
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in workspace.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}", hash)
}

fn monotonic_nanos() -> u128 {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as u128
}

fn ensure_executable(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata =
            fs::metadata(_path).map_err(|err| format!("读取可执行文件权限失败: {err}"))?;
        let mode = metadata.permissions().mode();
        if mode & 0o111 == 0 {
            fs::set_permissions(_path, fs::Permissions::from_mode(mode | 0o755))
                .map_err(|err| format!("设置可执行权限失败: {err}"))?;
        }
    }

    Ok(())
}

struct ManagedCommandOutput {
    status_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn run_command_with_timeout_owned(
    command: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<ManagedCommandOutput, String> {
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_command_with_timeout(command, &arg_refs, cwd, timeout)
}

fn run_command_with_timeout(
    command: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<ManagedCommandOutput, String> {
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new(command);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("启动命令 `{}` 失败: {err}", command_display(command, args)))?;

    // 必须用独立线程实时抽干 stdout/stderr：输出一旦超过 OS 管道缓冲（~64KB），
    // 子进程会阻塞在 write 上永不退出，旧实现（退出后才 wait_with_output）
    // 会空转到满超时（npm install 等可达 300s）才杀进程。
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });
    let stderr_handle = thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });

    let started = Instant::now();
    let mut timed_out = false;
    let status_code = loop {
        if child
            .try_wait()
            .map_err(|err| {
                format!(
                    "检查命令 `{}` 状态失败: {err}",
                    command_display(command, args)
                )
            })?
            .is_some()
        {
            break child.wait().map_err(|err| {
                format!(
                    "读取命令 `{}` 输出失败: {err}",
                    command_display(command, args)
                )
            })?.code();
        }

        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait().map_err(|err| {
                format!(
                    "停止超时命令 `{}` 失败: {err}",
                    command_display(command, args)
                )
            })?.code();
        }

        thread::sleep(Duration::from_millis(100));
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();

    Ok(ManagedCommandOutput {
        status_code,
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        timed_out,
    })
}

fn rustup_which_rust_analyzer() -> Option<PathBuf> {
    if !command_exists("rustup") {
        return None;
    }

    let output = run_command_with_timeout(
        "rustup",
        &["which", "rust-analyzer"],
        &env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        Duration::from_secs(10),
    )
    .ok()?;
    if output.status_code != Some(0) {
        return None;
    }

    let path = PathBuf::from(output.stdout.trim());
    path.is_file().then_some(path)
}

fn rust_analyzer_command_works() -> bool {
    if !command_exists("rust-analyzer") {
        return false;
    }

    run_command_with_timeout(
        "rust-analyzer",
        &["--version"],
        &env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        Duration::from_secs(10),
    )
    .map(|output| output.status_code == Some(0))
    .unwrap_or(false)
}

fn format_command_failure(command: &str, output: &ManagedCommandOutput) -> String {
    let mut details = Vec::new();
    if output.timed_out {
        details.push("命令超时".to_string());
    }
    if let Some(status) = output.status_code {
        details.push(format!("退出码 {status}"));
    }
    let stdout = output.stdout.trim();
    if !stdout.is_empty() {
        details.push(format!("stdout: {stdout}"));
    }
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        details.push(format!("stderr: {stderr}"));
    }
    format!("{command} 失败: {}", details.join("; "))
}

fn resolve_node_command(managed_roots: &[PathBuf]) -> Option<String> {
    managed_node_runtime_from_roots(managed_roots)
        .map(|runtime| runtime.command.to_string_lossy().to_string())
        .or_else(|| command_exists("node").then(|| "node".to_string()))
}

fn resolve_node_command_for_root(root: &Path, managed_roots: &[PathBuf]) -> Option<String> {
    managed_node_runtime_in_root(root)
        .map(|runtime| runtime.command.to_string_lossy().to_string())
        .or_else(|| resolve_node_command(managed_roots))
}

fn npm_command() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn run_node_package_install(
    root: &Path,
    package_names: &[&str],
    managed_runtime: Option<&ManagedNodeRuntime>,
) -> Result<(), String> {
    if package_names.is_empty() {
        return Ok(());
    }

    fs::create_dir_all(root).map_err(|err| format!("创建托管 Node 包目录失败: {err}"))?;
    let package_json = root.join("package.json");
    if !package_json.is_file() {
        fs::write(
            &package_json,
            r#"{"name":"codepapr-managed-node-packages","private":true}"#,
        )
        .map_err(|err| format!("写入托管 Node package.json 失败: {err}"))?;
    }

    if let Some(runtime) = managed_runtime {
        if let Some(npm_cli) = &runtime.npm_cli {
            let mut args = vec![
                npm_cli.to_string_lossy().to_string(),
                "install".to_string(),
                "--no-audit".to_string(),
                "--no-fund".to_string(),
                "--omit=dev".to_string(),
            ];
            args.extend(package_names.iter().map(|name| (*name).to_string()));
            let output = run_command_with_timeout_owned(
                &runtime.command.to_string_lossy(),
                &args,
                root,
                MANAGED_COMMAND_TIMEOUT,
            )?;
            if output.status_code != Some(0) {
                return Err(format_command_failure("node npm-cli.js install", &output));
            }
            return Ok(());
        }
    }

    if !command_exists(npm_command()) {
        return Err("缺少 npm，不能安装托管 Node LSP 包".to_string());
    }

    let mut args = vec![
        "install".to_string(),
        "--no-audit".to_string(),
        "--no-fund".to_string(),
        "--omit=dev".to_string(),
    ];
    args.extend(package_names.iter().map(|name| (*name).to_string()));
    let output =
        run_command_with_timeout_owned(npm_command(), &args, root, MANAGED_COMMAND_TIMEOUT)?;
    if output.status_code != Some(0) {
        return Err(format_command_failure("npm install", &output));
    }

    Ok(())
}

fn command_display(command: &str, args: &[&str]) -> String {
    format!("{} {}", command, args.join(" ")).trim().to_string()
}

fn executable_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn find_in_path_or_dotnet_tools(command: &str) -> Option<String> {
    let path = Path::new(command);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_string_lossy().to_string());
    }

    let extensions = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };

    let mut search_dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect())
        .unwrap_or_default();

    if let Ok(home) = env::var("HOME") {
        let dotnet_tools = PathBuf::from(home).join(".dotnet").join("tools");
        if dotnet_tools.is_dir() {
            search_dirs.push(dotnet_tools);
        }
    }

    if let Ok(profile) = env::var("USERPROFILE") {
        let dotnet_tools = PathBuf::from(profile).join(".dotnet").join("tools");
        if dotnet_tools.is_dir() {
            search_dirs.push(dotnet_tools);
        }
    }

    for dir in &search_dirs {
        for extension in &extensions {
            let candidate = if extension.is_empty() {
                dir.join(command)
            } else {
                dir.join(format!("{command}{extension}"))
            };
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

fn command_exists(command: &str) -> bool {
    find_in_path_or_dotnet_tools(command).is_some()
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let extensions = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string())
            .split(';')
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
        for ext in &extensions {
            let with_ext = dir.join(format!("{command}{ext}"));
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

pub fn dotnet_binary() -> &'static str {
    static DOTNET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DOTNET.get_or_init(|| {
        let name = if cfg!(windows) {
            "dotnet.exe"
        } else {
            "dotnet"
        };

        find_on_path(name)
            .map(|p| p.to_string_lossy().to_string())
            .or_else(|| {
                let home = env::var("HOME").or_else(|_| env::var("USERPROFILE")).ok()?;
                let home_dotnet = PathBuf::from(&home).join(".dotnet").join(name);
                home_dotnet
                    .is_file()
                    .then(|| home_dotnet.to_string_lossy().to_string())
            })
            .or_else(|| {
                let dotnet_root = env::var("DOTNET_ROOT").ok()?;
                let bin = PathBuf::from(&dotnet_root).join(name);
                bin.is_file().then(|| bin.to_string_lossy().to_string())
            })
            .or_else(|| {
                #[cfg(target_os = "macos")]
                {
                    [
                        "/opt/homebrew/bin/dotnet",
                        "/usr/local/bin/dotnet",
                        "/usr/local/share/dotnet/dotnet",
                    ]
                    .iter()
                    .find(|p| Path::new(p).is_file())
                    .map(|s| s.to_string())
                }
                #[cfg(target_os = "windows")]
                {
                    [r"C:\Program Files\dotnet\dotnet.exe"]
                        .iter()
                        .find(|p| Path::new(p).is_file())
                        .map(|s| s.to_string())
                }
                #[cfg(target_os = "linux")]
                {
                    [
                        "/usr/share/dotnet/dotnet",
                        "/usr/local/share/dotnet/dotnet",
                        "/usr/lib/dotnet/dotnet",
                    ]
                    .iter()
                    .find(|p| Path::new(p).is_file())
                    .map(|s| s.to_string())
                }
                #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
                {
                    None
                }
            })
            .unwrap_or_else(|| name.to_string())
    })
}

fn resolve_command_path(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }

    let extensions = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };

    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths).find_map(|dir| {
            extensions.iter().find_map(|extension| {
                let candidate = if extension.is_empty() {
                    dir.join(command)
                } else {
                    dir.join(format!("{command}{extension}"))
                };
                candidate.is_file().then_some(candidate)
            })
        })
    })
}

fn dedupe(commands: Vec<ManagedLspCommand>) -> Vec<ManagedLspCommand> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::new();
    for command in commands {
        let key = format!("{}::{}", command.command, command.args.join("\u{1f}"));
        if seen.insert(key) {
            deduped.push(command);
        }
    }
    deduped
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::new();
    for path in paths {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            deduped.push(path);
        }
    }
    deduped
}

#[cfg(test)]
mod tests {
    use super::{
        managed_clangd_download, managed_java_download, managed_lsp_commands,
        managed_node_download, managed_node_package_command_for_root, workspace_hash,
        NODE_RUNTIME_VERSION,
    };
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    // P3：workspace_hash 用作 JDTLS -data 目录名，必须跨 Rust 版本稳定。
    // DefaultHasher 无稳定性保证，已换成 FNV-1a；此值固定，算法漂移会立刻暴露。
    #[test]
    fn workspace_hash_is_stable_fnv1a() {
        assert_eq!(workspace_hash(Path::new("/tmp/ws")), "40884622fba0c3c6");
        // 确定性 + 不同输入不同输出
        assert_eq!(
            workspace_hash(Path::new("/a/b")),
            workspace_hash(Path::new("/a/b"))
        );
        assert_ne!(
            workspace_hash(Path::new("/a/b")),
            workspace_hash(Path::new("/a/c"))
        );
    }

    #[test]
    fn csharp_managed_commands_include_analyzer_strategy() {
        let commands = managed_lsp_commands(Path::new("/tmp"), "csharp");
        assert!(!commands.is_empty());
        assert!(commands.iter().any(|command| {
            command.command.contains("CodePapr.CSharp.Analyzer") || command.command == "dotnet"
        }));
    }

    #[test]
    fn node_package_lsp_commands_are_available_from_workspace_dependencies() {
        assert!(!managed_lsp_commands(Path::new("/tmp"), "typescript").is_empty());
        assert!(!managed_lsp_commands(Path::new("/tmp"), "python").is_empty());
        assert!(!managed_lsp_commands(Path::new("/tmp"), "html").is_empty());
        assert!(!managed_lsp_commands(Path::new("/tmp"), "yaml").is_empty());
    }

    #[test]
    fn managed_node_runtime_download_mapping_is_available() {
        let (url, archive_kind) = managed_node_download().expect("node runtime mapping");
        assert!(url.contains("nodejs.org/dist"));
        assert!(url.contains(NODE_RUNTIME_VERSION));
        match archive_kind {
            super::ArchiveKind::TarGz | super::ArchiveKind::TarXz | super::ArchiveKind::Zip => {}
        }
    }

    #[test]
    fn node_package_command_can_use_managed_node_without_system_node() {
        let temp_root = std::env::temp_dir().join(format!(
            "codepapr-lsp-managed-node-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("unix epoch")
                .as_nanos()
        ));
        let repo_root = temp_root.join("repo");
        let managed_root = temp_root.join("managed");
        let script = repo_root.join("scripts").join("run-module-bin.mjs");
        let package_json = repo_root
            .join("node_modules")
            .join("typescript-language-server")
            .join("package.json");
        let node_binary = managed_root
            .join("node-runtime")
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });

        fs::create_dir_all(script.parent().expect("script parent")).expect("script dir");
        fs::create_dir_all(package_json.parent().expect("package parent")).expect("package dir");
        fs::create_dir_all(node_binary.parent().expect("node parent")).expect("node dir");
        fs::write(&script, "").expect("script file");
        fs::write(&package_json, "{}").expect("package file");
        fs::write(&node_binary, "").expect("node binary");

        let commands = managed_node_package_command_for_root(
            &repo_root,
            &[managed_root],
            "typescript-language-server",
            "typescript-language-server/lib/cli.mjs",
            &["--stdio"],
            "TypeScript language server",
            true,
        );
        assert_eq!(commands.len(), 1);
        assert!(commands[0].command.contains("node"));
        assert!(commands[0].command.contains("node-runtime"));

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn shellscript_managed_command_uses_bash_language_server_entrypoint() {
        let temp_root = std::env::temp_dir().join(format!(
            "codepapr-lsp-shell-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("unix epoch")
                .as_nanos()
        ));
        let repo_root = temp_root.join("repo");
        let managed_root = temp_root.join("managed");
        let script = repo_root.join("scripts").join("run-module-bin.mjs");
        let package_json = repo_root
            .join("node_modules")
            .join("bash-language-server")
            .join("package.json");
        let node_binary = managed_root
            .join("node-runtime")
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });

        fs::create_dir_all(script.parent().expect("script parent")).expect("script dir");
        fs::create_dir_all(package_json.parent().expect("package parent")).expect("package dir");
        fs::create_dir_all(node_binary.parent().expect("node parent")).expect("node dir");
        fs::write(&script, "").expect("script file");
        fs::write(&package_json, "{}").expect("package file");
        fs::write(&node_binary, "").expect("node binary");

        let commands = managed_node_package_command_for_root(
            &repo_root,
            &[managed_root],
            "bash-language-server",
            "bash-language-server/out/cli.js",
            &["start"],
            "Bash language server",
            true,
        );
        assert_eq!(commands.len(), 1);
        assert!(commands[0]
            .args
            .iter()
            .any(|arg| arg.contains("bash-language-server/out/cli.js")));
        assert_eq!(commands[0].args.last().map(String::as_str), Some("start"));

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn java_runtime_download_mapping_is_available() {
        let (url, _) = managed_java_download().expect("java runtime mapping");
        assert!(url.contains("api.adoptium.net"));
        assert!(url.contains("/jre/hotspot/normal/eclipse"));
    }

    #[test]
    fn clangd_download_mapping_is_available() {
        let (url, _) = managed_clangd_download().expect("clangd mapping");
        assert!(url.contains("github.com/clangd/clangd/releases/download"));
        assert!(url.contains("clangd-"));
    }

    /// 篡改检测：文件内容与锁定哈希不匹配时必须硬失败。
    #[test]
    fn pinned_checksum_rejects_tampered_file() {
        let url = super::JDTLS_DOWNLOAD_URL;
        assert!(
            crate::download_verification::pinned_checksum(url).is_some(),
            "jdtls URL 必须命中锁定清单"
        );
        let temp = std::env::temp_dir().join(format!(
            "codepapr-tamper-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("unix epoch")
                .as_nanos()
        ));
        fs::write(&temp, b"tampered content").expect("write temp");
        let result = crate::download_verification::verify_download(url, &temp);
        let _ = fs::remove_file(&temp);
        assert!(
            result.is_err(),
            "篡改文件必须校验失败，实际: {:?}",
            result.map(|outcome| outcome.description())
        );
    }

    /// 每个托管下载 URL 必须有校验覆盖：锁定清单哈希，或已知官方校验源。
    /// 升级工具版本时若忘记同步锁定清单，此测试在当前平台立即失败。
    #[test]
    fn every_managed_download_has_checksum_coverage() {
        let mut urls = vec![super::JDTLS_DOWNLOAD_URL.to_string()];
        if let Ok((url, _)) = managed_clangd_download() {
            urls.push(url);
        }
        if let Ok((url, _)) = super::managed_sqls_download() {
            urls.push(url);
        }
        if let Ok(url) = super::managed_marksman_url() {
            urls.push(url);
        }
        if let Ok((url, _)) = managed_node_download() {
            urls.push(url);
        }
        if let Ok((url, _)) = managed_java_download() {
            urls.push(url);
        }

        for url in urls {
            let has_pinned = crate::download_verification::pinned_checksum(&url).is_some();
            let has_official_source = url.starts_with("https://nodejs.org/dist/")
                || url.starts_with("https://api.adoptium.net/v3/binary/")
                || url.starts_with("https://download.eclipse.org/jdtls/");
            assert!(
                has_pinned || has_official_source,
                "托管下载缺少校验覆盖: {url}"
            );
        }
    }

    /// 真实压缩包解压冒烟测试（含符号链接处理）。需要网络下载夹具，默认跳过；
    /// 设置 CODEPAPR_EXTRACT_SMOKE_DIR 指向包含以下文件的目录启用：
    /// node.tar.gz / jdtls.tar.gz / sqls.zip / clangd.zip
    #[test]
    fn extract_archive_smoke_with_real_fixtures() {
        let Some(dir) = std::env::var_os("CODEPAPR_EXTRACT_SMOKE_DIR") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);

        let cases: &[(&str, super::ArchiveKind, &[&str])] = &[
            ("node.tar.gz", super::ArchiveKind::TarGz, &["node", "npm"]),
            ("jdtls.tar.gz", super::ArchiveKind::TarGz, &["plugins"]),
            ("sqls.zip", super::ArchiveKind::Zip, &["sqls"]),
            ("clangd.zip", super::ArchiveKind::Zip, &["clangd"]),
        ];

        fn contains_entry(root: &std::path::Path, name: &str) -> bool {
            let mut stack = vec![root.to_path_buf()];
            while let Some(dir) = stack.pop() {
                let Ok(entries) = fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    if path
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy() == name)
                    {
                        return true;
                    }
                    if path.is_dir()
                        && !path
                            .symlink_metadata()
                            .is_ok_and(|m| m.file_type().is_symlink())
                    {
                        stack.push(path);
                    }
                }
            }
            false
        }

        for (name, kind, expected) in cases {
            let archive = dir.join(name);
            if !archive.is_file() {
                continue;
            }
            let dest = std::env::temp_dir().join(format!(
                "codepapr-extract-smoke-{}-{}",
                name,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("unix epoch")
                    .as_nanos()
            ));
            fs::create_dir_all(&dest).expect("create dest");
            super::extract_archive(&archive, *kind, &dest)
                .unwrap_or_else(|err| panic!("extract {name}: {err}"));
            for entry_name in *expected {
                assert!(
                    contains_entry(&dest, entry_name),
                    "{name}: missing {entry_name} after extraction"
                );
            }
            let _ = fs::remove_dir_all(&dest);
        }

        // 锁定清单哈希端到端验证（离线）：夹具文件必须通过其锁定 URL 的校验。
        // 夹具需与当前平台的下载 URL 对应。
        let mut pinned_cases: Vec<(String, String)> = vec![(
            "jdtls.tar.gz".to_string(),
            super::JDTLS_DOWNLOAD_URL.to_string(),
        )];
        if let Ok((url, _)) = super::managed_sqls_download() {
            pinned_cases.push(("sqls.zip".to_string(), url));
        }
        if let Ok((url, _)) = managed_clangd_download() {
            pinned_cases.push(("clangd.zip".to_string(), url));
        }
        if let Ok((url, _)) = managed_node_download() {
            pinned_cases.push(("node.tar.gz".to_string(), url));
        }
        for (name, url) in &pinned_cases {
            let file = dir.join(name);
            if !file.is_file() {
                continue;
            }
            let outcome = crate::download_verification::verify_download(url, &file)
                .unwrap_or_else(|err| panic!("verify {name}: {err}"));
            assert!(
                matches!(
                    outcome,
                    crate::download_verification::VerificationOutcome::Verified { .. }
                ),
                "{name}: {}",
                outcome.description()
            );
        }
    }
}
