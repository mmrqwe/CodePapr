use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
};

use tauri::{AppHandle, Emitter};

use crate::tts::default_gpt_sovits_path;

pub(crate) const VENV_DIR_NAME: &str = ".codepapr_venv";

/// Endpoints for downloading the HuggingFace model repo (lj1995/GPT-SoVITS).
/// Tried in order — first successful one wins.
const MODEL_ENDPOINTS: &[&str] = &[
    "https://hf-mirror.com",
    "https://huggingface.co",
];

/// Endpoints (Git URLs) for cloning the GPT-SoVITS source code.
/// Tried in order — first successful one wins.
const CODE_GIT_REPOS: &[&str] = &[
    "https://github.com/RVC-Boss/GPT-SoVITS.git",
    "https://gitcode.com/mirrors/RVC-Boss/GPT-SoVITS.git",
    "https://gitee.com/yumeluck/GPT-SoVITS.git",
    "https://ghproxy.com/https://github.com/RVC-Boss/GPT-SoVITS.git",
];

/// PyPI index URLs to try in order for pip install.
/// First one that has the package wins. pip itself doesn't auto-fallback,
/// so we retry the install command with each index until one succeeds.
const PIP_INDEXES: &[&str] = &[
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.org/simple",
];

static CANCELLED: AtomicBool = AtomicBool::new(false);

pub(crate) fn cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct InstallProgress {
    pub step_id: String,
    pub label: String,
    pub status: String,
    pub percent: Option<u8>,
    pub log_line: String,
}

impl InstallProgress {
    fn new(step_id: &str, label: &str, status: &str, percent: Option<u8>, log_line: &str) -> Self {
        Self {
            step_id: step_id.to_string(),
            label: label.to_string(),
            status: status.to_string(),
            percent,
            log_line: log_line.to_string(),
        }
    }

    fn pending(step_id: &str, label: &str) -> Self {
        Self::new(step_id, label, "pending", None, "")
    }

    fn running(step_id: &str, label: &str, log: &str) -> Self {
        Self::new(step_id, label, "running", None, log)
    }

    fn ok(step_id: &str, label: &str, log: &str) -> Self {
        Self::new(step_id, label, "ok", Some(100), log)
    }

    fn cancelled(step_id: &str, label: &str) -> Self {
        Self::new(step_id, label, "cancelled", None, "Installation cancelled")
    }

    fn fail(step_id: &str, label: &str, log: &str) -> Self {
        Self::new(step_id, label, "fail", None, log)
    }
}

fn emit(app: &AppHandle, progress: &InstallProgress) {
    let _ = app.emit("tts-install-progress", progress.clone());
}

/// Drains both stdout and stderr from a child process concurrently to prevent
/// pipe deadlocks. Emits each non-empty output line as a "running" progress event.
fn run_and_stream(
    mut cmd: Command,
    app: &AppHandle,
    step_id: &str,
    label: &str,
) -> Result<(), String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start: {e}"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let app_out = app.clone();
    let step_out = step_id.to_string();
    let label_out = label.to_string();
    let stdout_handle = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if CANCELLED.load(Ordering::SeqCst) {
                break;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                emit(&app_out, &InstallProgress::running(&step_out, &label_out, trimmed));
            }
        }
    });

    let app_err = app.clone();
    let step_err = step_id.to_string();
    let label_err = label.to_string();
    let stderr_handle = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if CANCELLED.load(Ordering::SeqCst) {
                break;
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                emit(&app_err, &InstallProgress::running(&step_err, &label_err, trimmed));
            }
        }
    });

    // Poll for cancellation while waiting for the process to exit.
    loop {
        if CANCELLED.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            return Err("Cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                if status.success() {
                    return Ok(());
                } else {
                    return Err(format!("Command exited with code {:?}", status.code()));
                }
            }
            Ok(None) => thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => return Err(format!("Process error: {e}")),
        }
    }
}

pub(crate) fn install(app: AppHandle, source: Option<String>) {
    CANCELLED.store(false, Ordering::SeqCst);

    let model_source = source.as_deref().unwrap_or("hf-mirror");

    let target_path = default_gpt_sovits_path();
    let venv_path = target_path.join(VENV_DIR_NAME);
    let venv_python = venv_python_path(&venv_path);
    let pretrained_dir = target_path.join("GPT_SoVITS").join("pretrained_models");

    // ---------- Fast-path: if everything is already installed, skip all steps ----------
    if target_path.join("api.py").exists()
        && venv_python_is_compatible(&venv_python)
        && deps_marker_ok(&venv_path, &target_path)
        && has_complete_model_set(&pretrained_dir)
    {
        emit(&app, &InstallProgress::ok("check-python", "Checking Python", "Already set up"));
        emit(&app, &InstallProgress::ok("clone-code", "Cloning code repository", "Already present"));
        emit(&app, &InstallProgress::ok("install-deps", "Installing Python packages", "Already installed"));
        emit(&app, &InstallProgress::ok("download-models", "Downloading pretrained models", "Already downloaded"));
        emit(&app, &InstallProgress::ok("verify", "Verifying installation", "All ready. Click the speaker icon to start."));
        return;
    }

    // ---------- Step 1: Python ----------
    emit(&app, &InstallProgress::pending("check-python", "Checking Python"));
    let system_python = match check_python(&app) {
        Ok(p) => p,
        Err(e) => {
            emit(&app, &InstallProgress::fail("check-python", "Checking Python", &e));
            return;
        }
    };

    if cancelled_emit(&app, "check-python", "Checking Python") { return; }

    // ---------- Step 2: Clone code ----------
    let api_py_present = target_path.join("api.py").exists();
    let req_present = target_path.join("requirements.txt").exists();
    let code_complete = api_py_present && req_present;

    if !code_complete {
        // Detect & report partial state
        if target_path.exists() && !target_path.join(VENV_DIR_NAME).exists() {
            emit(&app, &InstallProgress::running(
                "clone-code",
                "Cloning code repository",
                "Removing partial/corrupt previous clone...",
            ));
            let _ = std::fs::remove_dir_all(&target_path);
        } else if target_path.exists() {
            // venv exists but code is corrupt — preserve venv, only delete code files
            emit(&app, &InstallProgress::running(
                "clone-code",
                "Cloning code repository",
                "Code files corrupt; cleaning up while preserving venv...",
            ));
            cleanup_code_preserve_venv(&target_path);
        }

        if let Err(e) = std::fs::create_dir_all(&target_path) {
            emit(&app, &InstallProgress::fail("clone-code", "Cloning code repository", &format!("Cannot create dir: {e}")));
            return;
        }

        emit(&app, &InstallProgress::pending("clone-code", "Cloning code repository"));
        if let Err(e) = clone_code(&app, &target_path) {
            emit(&app, &InstallProgress::fail("clone-code", "Cloning code repository", &e));
            return;
        }
    } else {
        emit(&app, &InstallProgress::ok("clone-code", "Cloning code repository", "Already present"));
    }

    if cancelled_emit(&app, "install-deps", "Installing Python packages") { return; }

    // ---------- Step 3: Create venv + install deps ----------
    emit(&app, &InstallProgress::pending("install-deps", "Installing Python packages"));

    // Detect incompatible venv: either it doesn't run, OR it runs but the
    // Python version is too old (e.g., venv built with /usr/bin/python3 = 3.9
    // before we improved Python detection). Either way, blow it away and rebuild.
    if venv_python.exists() && !venv_python_is_compatible(&venv_python) {
        let reason = if venv_python_runs_ok(&venv_python) {
            "incompatible Python version (need 3.10+)"
        } else {
            "broken or incomplete"
        };
        emit(&app, &InstallProgress::running(
            "install-deps",
            "Installing Python packages",
            &format!("Existing venv is {reason}; recreating with new Python..."),
        ));
        let _ = std::fs::remove_dir_all(&venv_path);
        // Also clear deps marker so dependencies will be re-installed in the fresh venv.
        let _ = std::fs::remove_file(deps_marker_path(&venv_path));
    }

    let venv_python = match install_deps(&app, &system_python, &target_path) {
        Ok(p) => p,
        Err(e) => {
            emit(&app, &InstallProgress::fail("install-deps", "Installing Python packages", &e));
            return;
        }
    };

    // Post-install: download NLTK data (required by GPT-SoVITS for text processing).
    if !nltk_data_present() {
        emit(&app, &InstallProgress::running(
            "install-deps", "Installing Python packages",
            "Downloading NLTK data (averaged_perceptron_tagger_eng, punkt)...",
        ));
        let mut nltk_cmd = Command::new(&venv_python);
        nltk_cmd.args(["-m", "nltk.downloader", "averaged_perceptron_tagger_eng", "punkt", "-q"]);
        let _ = run_and_stream(nltk_cmd, &app, "install-deps", "Installing Python packages");
    }

    // Create fast_langdetect cache dir (required for language detection during TTS).
    let fld_dir = target_path.join("GPT_SoVITS").join("pretrained_models").join("fast_langdetect");
    if !fld_dir.exists() {
        let _ = std::fs::create_dir_all(&fld_dir);
    }

    // Post-install: deploy fully patched api.py (soundfile + WS + bug fixes).
    deploy_patched_api_py(&app, &target_path);
    // Post-install: deploy the fine-tuning script.
    deploy_finetune_script(&app, &target_path);
    // Post-install: patch load_audio to use soundfile (no ffmpeg dependency).
    apply_load_audio_patch(&app, &target_path);

    if cancelled_emit(&app, "download-models", "Downloading pretrained models") { return; }

    // ---------- Step 4: Download models ----------
    // Run the script unless we already have a complete model set.
    // The script itself is idempotent — it skips files that exist with size > 0.
    emit(&app, &InstallProgress::pending("download-models", "Downloading pretrained models"));
    if has_complete_model_set(&pretrained_dir) {
        emit(&app, &InstallProgress::ok(
            "download-models",
            "Downloading pretrained models",
            "Models already present",
        ));
    } else {
        // Clean up any orphaned .part files from interrupted previous runs
        let _ = cleanup_part_files(&pretrained_dir);

        if let Err(e) = download_models(&app, &target_path, &venv_python, model_source) {
            emit(&app, &InstallProgress::fail("download-models", "Downloading pretrained models", &e));
            return;
        }
    }

    if cancelled_emit(&app, "verify", "Verifying installation") { return; }

    // ---------- Step 5: Verify ----------
    emit(&app, &InstallProgress::pending("verify", "Verifying installation"));
    if let Err(e) = verify_files(&app, &target_path, &venv_python) {
        emit(&app, &InstallProgress::fail("verify", "Verifying installation", &e));
        return;
    }

    emit(&app, &InstallProgress::ok("verify", "Verifying installation", "Ready. Click the speaker icon to start the server."));
}

fn cancelled_emit(app: &AppHandle, step_id: &str, label: &str) -> bool {
    if CANCELLED.load(Ordering::SeqCst) {
        emit(app, &InstallProgress::cancelled(step_id, label));
        true
    } else {
        false
    }
}

/// Minimum Python version required by GPT-SoVITS dependencies.
/// x_transformers, ctranslate2, and others use PEP 604 union syntax (3.10+).
pub(crate) const MIN_PYTHON_MAJOR: u32 = 3;
pub(crate) const MIN_PYTHON_MINOR: u32 = 10;

/// Probes a Python executable and returns (major, minor, sys.executable).
/// Returns None if the path is not a valid Python or fails to execute.
pub(crate) fn probe_python_version(path: &str) -> Option<(u32, u32, String)> {
    let output = Command::new(path)
        .arg("-c")
        .arg("import sys; print(sys.executable); print(sys.version_info.major, sys.version_info.minor)")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let exe = lines.next()?.trim().to_string();
    let ver_line = lines.next()?.trim();
    let mut parts = ver_line.split_whitespace();
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    if exe.is_empty() {
        return None;
    }
    Some((major, minor, exe))
}

/// Returns true if the given Python (major, minor) meets the minimum required version.
fn version_ok(major: u32, minor: u32) -> bool {
    major > MIN_PYTHON_MAJOR || (major == MIN_PYTHON_MAJOR && minor >= MIN_PYTHON_MINOR)
}

/// Collects every plausible Python interpreter on the system. Tauri-spawned
/// processes inherit a minimal PATH (no shell rc), so we hardcode common
/// install paths in addition to PATH lookup.
pub(crate) fn collect_python_candidates() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let push = |out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, p: String| {
        if !p.is_empty() && !seen.contains(&p) {
            seen.insert(p.clone());
            out.push(p);
        }
    };

    // 1. PATH lookup (covers the rare case where shell PATH is inherited).
    for cmd in &[
        "python3.13", "python3.12", "python3.11", "python3.10",
        "python3", "python",
    ] {
        if let Ok(output) = Command::new(cmd)
            .arg("-c")
            .arg("import sys; print(sys.executable)")
            .output()
        {
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                push(&mut out, &mut seen, p);
            }
        }
    }

    // 2. Common macOS install locations.
    let mac_paths = [
        "/opt/homebrew/bin/python3.13",
        "/opt/homebrew/bin/python3.12",
        "/opt/homebrew/bin/python3.11",
        "/opt/homebrew/bin/python3.10",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3.13",
        "/usr/local/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/local/bin/python3.10",
        "/usr/local/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3",
    ];
    for p in mac_paths {
        if Path::new(p).exists() {
            push(&mut out, &mut seen, p.to_string());
        }
    }

    // 3. conda-style locations under $HOME.
    if let Ok(home) = std::env::var("HOME") {
        for base in &["miniconda3", "anaconda3", "miniforge3", "mambaforge"] {
            let p = format!("{home}/{base}/bin/python3");
            if Path::new(&p).exists() {
                push(&mut out, &mut seen, p);
            }
        }
    }

    // 4. Windows-specific (conda, python.org, Microsoft Store).
    #[cfg(target_os = "windows")]
    {
        for base in &[
            "C:\\Python313",
            "C:\\Python312",
            "C:\\Python311",
            "C:\\Python310",
        ] {
            let p = format!("{base}\\python.exe");
            if Path::new(&p).exists() {
                push(&mut out, &mut seen, p);
            }
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            for ver in &["Python313", "Python312", "Python311", "Python310"] {
                let p = format!("{local}\\Programs\\Python\\{ver}\\python.exe");
                if Path::new(&p).exists() {
                    push(&mut out, &mut seen, p);
                }
            }
        }
        // conda on Windows
        if let Ok(profile) = std::env::var("USERPROFILE") {
            for base in &["miniconda3", "anaconda3", "miniforge3"] {
                let p = format!("{profile}\\{base}\\python.exe");
                if Path::new(&p).exists() {
                    push(&mut out, &mut seen, p);
                }
            }
        }
    }

    // 5. /usr/bin/python3 (Apple/Xcode) — last resort, often too old.
    if Path::new("/usr/bin/python3").exists() {
        push(&mut out, &mut seen, "/usr/bin/python3".to_string());
    }

    out
}

fn check_python(app: &AppHandle) -> Result<String, String> {
    let candidates = collect_python_candidates();
    let mut probed: Vec<(u32, u32, String)> = Vec::new();
    let mut all_versions: Vec<String> = Vec::new();

    for path in &candidates {
        if let Some((major, minor, exe)) = probe_python_version(path) {
            all_versions.push(format!("  • {exe} → Python {major}.{minor}"));
            if version_ok(major, minor) {
                probed.push((major, minor, exe));
            }
        }
    }

    // Pick highest version that meets the minimum.
    probed.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    if let Some((major, minor, exe)) = probed.into_iter().next() {
        emit(app, &InstallProgress::ok(
            "check-python",
            "Checking Python",
            &format!("Python {major}.{minor} at {exe}"),
        ));
        return Ok(exe);
    }

    // No suitable Python found. Build a helpful error message.
    let summary = if all_versions.is_empty() {
        "No Python interpreters were found on this system.".to_string()
    } else {
        format!(
            "No Python {}.{}+ found. Detected interpreters:\n{}",
            MIN_PYTHON_MAJOR,
            MIN_PYTHON_MINOR,
            all_versions.join("\n"),
        )
    };
    Err(format!(
        "{summary}\n\nGPT-SoVITS requires Python {}.{}+ (its dependencies use modern syntax).\n\
         Install one of:\n  • brew install python@3.12   (recommended)\n  \
         • Download from https://www.python.org/downloads/\n  \
         • conda install python=3.12\n\
         Then click Install again.",
        MIN_PYTHON_MAJOR, MIN_PYTHON_MINOR,
    ))
}

fn clone_code(app: &AppHandle, target_path: &Path) -> Result<(), String> {
    let parent = target_path.parent().unwrap_or(target_path);
    let target_name = target_path
        .file_name()
        .ok_or_else(|| format!("Invalid install path (no file name): {}", target_path.display()))?;

    let mut last_err = String::new();
    for (idx, repo) in CODE_GIT_REPOS.iter().enumerate() {
        if CANCELLED.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }

        emit(app, &InstallProgress::running(
            "clone-code",
            "Cloning code repository",
            &format!("Trying source {}/{}: {}", idx + 1, CODE_GIT_REPOS.len(), repo),
        ));

        // Clean up any half-cloned directory from a previous failed attempt.
        if target_path.exists() && !target_path.join("api.py").exists() {
            let _ = std::fs::remove_dir_all(target_path);
        }

        let mut cmd = Command::new("git");
        cmd.args(["clone", "--depth=1", repo])
            .arg(target_name)
            .current_dir(parent);

        match run_and_stream(cmd, app, "clone-code", "Cloning code repository") {
            Ok(()) => {
                if target_path.join("api.py").exists() {
                    emit(app, &InstallProgress::ok(
                        "clone-code",
                        "Cloning code repository",
                        &format!("Code cloned from {repo}"),
                    ));
                    return Ok(());
                } else {
                    last_err = format!("Clone from {repo} succeeded but api.py is missing");
                }
            }
            Err(e) => {
                last_err = format!("Clone from {repo} failed: {e}");
                emit(app, &InstallProgress::running(
                    "clone-code",
                    "Cloning code repository",
                    &format!("Source {} failed, trying next...", idx + 1),
                ));
            }
        }
    }

    Err(format!("All {} code repository sources failed. Last error: {}", CODE_GIT_REPOS.len(), last_err))
}

/// Creates a Python venv inside target_path and installs requirements there.
/// Returns the absolute path to the venv's python interpreter.
fn install_deps(app: &AppHandle, system_python: &str, target_path: &Path) -> Result<PathBuf, String> {
    let venv_path = target_path.join(VENV_DIR_NAME);
    let venv_python = venv_python_path(&venv_path);

    // Create venv (skip if already exists and is healthy)
    if !venv_python.exists() {
        emit(app, &InstallProgress::running("install-deps", "Installing Python packages", "Creating virtual environment..."));
        let mut cmd = Command::new(system_python);
        cmd.args(["-m", "venv"]).arg(&venv_path);
        run_and_stream(cmd, app, "install-deps", "Installing Python packages")
            .map_err(|e| format!("venv creation failed: {e}"))?;
    } else {
        emit(app, &InstallProgress::running("install-deps", "Installing Python packages", "Using existing virtual environment"));
    }

    if !venv_python.exists() {
        return Err(format!(
            "venv python not found at {}. venv creation may have failed silently.",
            venv_python.display()
        ));
    }

    // Resume optimization: if marker file exists and matches current requirements.txt hash,
    // assume packages are installed and skip pip install entirely.
    if deps_marker_ok(&venv_path, target_path) {
        emit(app, &InstallProgress::ok(
            "install-deps",
            "Installing Python packages",
            "Dependencies already installed (matching requirements.txt unchanged)",
        ));
        return Ok(venv_python);
    }

    // Upgrade pip first (try multiple indexes; non-fatal if it fails).
    emit(app, &InstallProgress::running("install-deps", "Installing Python packages", "Upgrading pip..."));
    let _ = pip_install_with_fallback(app, &venv_python, &["--upgrade", "pip"]);

    // Install requirements with index fallback
    let requirements = target_path.join("requirements.txt");
    if !requirements.exists() {
        return Err(format!(
            "requirements.txt not found at {}. The repository may not have been cloned correctly.",
            requirements.display()
        ));
    }

    emit(app, &InstallProgress::running(
        "install-deps",
        "Installing Python packages",
        "Installing GPT-SoVITS dependencies (this may take a few minutes)...",
    ));

    let req_str = requirements.to_string_lossy().to_string();
    pip_install_with_fallback(
        app,
        &venv_python,
        &["--no-cache-dir", "-r", &req_str],
    )
    .map_err(|e| format!("pip install failed on all mirrors: {e}"))?;

    // Write marker file so we can skip on next run.
    let _ = write_deps_marker(&venv_path, target_path);

    emit(app, &InstallProgress::ok("install-deps", "Installing Python packages", "Packages installed"));
    Ok(venv_python)
}

/// Runs `pip install <args>` against each PyPI index in order until one succeeds.
fn pip_install_with_fallback(
    app: &AppHandle,
    venv_python: &Path,
    extra_args: &[&str],
) -> Result<(), String> {
    let mut last_err = String::new();
    for (idx, index) in PIP_INDEXES.iter().enumerate() {
        if CANCELLED.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }

        emit(app, &InstallProgress::running(
            "install-deps",
            "Installing Python packages",
            &format!("Trying PyPI index {}/{}: {}", idx + 1, PIP_INDEXES.len(), index),
        ));

        let mut cmd = Command::new(venv_python);
        cmd.args(["-m", "pip", "install", "-i", index]);
        for a in extra_args {
            cmd.arg(a);
        }

        match run_and_stream(cmd, app, "install-deps", "Installing Python packages") {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                emit(app, &InstallProgress::running(
                    "install-deps",
                    "Installing Python packages",
                    &format!("Index {} failed, trying next...", idx + 1),
                ));
            }
        }
    }
    Err(last_err)
}

pub(crate) fn venv_python_path(venv_path: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        venv_path.join("Scripts").join("python.exe")
    } else {
        venv_path.join("bin").join("python3")
    }
}

fn download_models(
    app: &AppHandle,
    target_path: &Path,
    venv_python: &Path,
    _source: &str,
) -> Result<(), String> {
    let pretrained_dir = target_path.join("GPT_SoVITS").join("pretrained_models");
    std::fs::create_dir_all(&pretrained_dir)
        .map_err(|e| format!("Cannot create pretrained_models dir: {e}"))?;

    let endpoints_json: Vec<String> = MODEL_ENDPOINTS
        .iter()
        .map(|e| format!("{e:?}"))
        .collect();
    let endpoints_py = format!("[{}]", endpoints_json.join(", "));

    emit(app, &InstallProgress::running(
        "download-models",
        "Downloading pretrained models",
        &format!("Will try {} model source(s) with auto-fallback", MODEL_ENDPOINTS.len()),
    ));
    emit(app, &InstallProgress::running(
        "download-models",
        "Downloading pretrained models",
        "This may take 5-15 minutes (~5GB total)",
    ));

    // Embed the downloader script — uses urllib only (no third-party deps).
    // For each file, tries each endpoint in order until one succeeds.
    let script = format!(
        r#"
import json, os, sys, time, urllib.request, urllib.error
ENDPOINTS = {endpoints_py}
REPO_ID = "lj1995/GPT-SoVITS"
LOCAL_DIR = {local_dir:?}

def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={{"User-Agent": "codepapr-installer/1.0"}})
    return urllib.request.urlopen(req, timeout=timeout)

# 1. List files via API — try each endpoint until one works.
files = None
list_endpoint = None
for ep in ENDPOINTS:
    api_url = f"{{ep}}/api/models/{{REPO_ID}}"
    print(f"LIST  trying {{api_url}}", flush=True)
    try:
        with http_get(api_url, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        files = [f["rfilename"] for f in data.get("siblings", []) if not f["rfilename"].startswith(".")]
        list_endpoint = ep
        print(f"LIST  ok via {{ep}}, {{len(files)}} files", flush=True)
        break
    except Exception as e:
        print(f"LIST  fail at {{ep}}: {{e}}", flush=True)

if files is None:
    print(f"FATAL: file list unavailable from any of {{len(ENDPOINTS)}} endpoints", flush=True)
    sys.exit(1)

# 2. Download each file. For each file, try endpoints in order (preferring the one that worked for listing).
endpoints_for_files = [list_endpoint] + [e for e in ENDPOINTS if e != list_endpoint]
errors = []
for idx, name in enumerate(files, 1):
    out = os.path.join(LOCAL_DIR, name)
    if os.path.exists(out) and os.path.getsize(out) > 0:
        print(f"[{{idx}}/{{len(files)}}] SKIP {{name}} (exists)", flush=True)
        continue
    os.makedirs(os.path.dirname(out) or LOCAL_DIR, exist_ok=True)

    success = False
    last_err = ""
    for ep in endpoints_for_files:
        url = f"{{ep}}/{{REPO_ID}}/resolve/main/{{name}}"
        try:
            print(f"[{{idx}}/{{len(files)}}] GET  {{name}} via {{ep}}", flush=True)
            t0 = time.time()
            with http_get(url, timeout=600) as resp:
                tmp = out + ".part"
                with open(tmp, "wb") as fp:
                    while True:
                        chunk = resp.read(1 << 16)
                        if not chunk:
                            break
                        fp.write(chunk)
                os.rename(tmp, out)
            sz = os.path.getsize(out)
            dt = time.time() - t0
            rate = sz / max(dt, 0.001)
            print(f"[{{idx}}/{{len(files)}}] OK   {{name}} ({{sz}} bytes, {{rate/1024/1024:.1f}} MB/s)", flush=True)
            success = True
            break
        except Exception as e:
            last_err = str(e)
            print(f"[{{idx}}/{{len(files)}}] FAIL via {{ep}}: {{e}}", flush=True)
            try:
                if os.path.exists(out + ".part"):
                    os.remove(out + ".part")
            except Exception:
                pass

    if not success:
        errors.append((name, last_err))
        print(f"[{{idx}}/{{len(files)}}] GIVE UP {{name}}: tried all {{len(endpoints_for_files)}} endpoints", flush=True)

if errors:
    print(f"DONE WITH ERRORS: {{len(errors)}} files failed", flush=True)
    sys.exit(1)
print("DONE OK", flush=True)
"#,
        endpoints_py = endpoints_py,
        local_dir = pretrained_dir.to_string_lossy(),
    );

    let mut cmd = Command::new(venv_python);
    cmd.arg("-c").arg(&script);
    run_and_stream(cmd, app, "download-models", "Downloading pretrained models")?;

    emit(app, &InstallProgress::ok(
        "download-models",
        "Downloading pretrained models",
        "Models downloaded",
    ));
    Ok(())
}

/// Returns true only when pretrained_models contains the expected set of large model
/// files. This is intentionally strict so that partial / interrupted downloads
/// do NOT cause the download step to be skipped.
///
/// Heuristic: count files >50 MB recursively. The model repo has ~10+ such files
/// totalling ~5 GB; if we have at least 5, assume the install is complete.
pub(crate) fn has_complete_model_set(pretrained_dir: &Path) -> bool {
    if !pretrained_dir.exists() {
        return false;
    }
    let mut large_count = 0usize;
    let _ = visit_files_recursive(pretrained_dir, &mut |path, size| {
        // Skip hidden files and .part temp files
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') || name.ends_with(".part") {
                return;
            }
        }
        if size > 50 * 1024 * 1024 {
            large_count += 1;
        }
    });
    large_count >= 5
}

fn visit_files_recursive(
    dir: &Path,
    visitor: &mut dyn FnMut(&Path, u64),
) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden directories like .cache and .git
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') {
                    continue;
                }
            }
            let _ = visit_files_recursive(&path, visitor);
        } else if path.is_file() {
            if let Ok(meta) = entry.metadata() {
                visitor(&path, meta.len());
            }
        }
    }
    Ok(())
}

/// Probes the venv python by running it and verifying both that it executes
/// AND meets the minimum version requirement. Returns true only if the venv is
/// usable for GPT-SoVITS. Detects venvs that were created with too-old Python
/// (e.g., Apple's /usr/bin/python3 = 3.9.6) which would crash on import.
pub(crate) fn venv_python_is_compatible(venv_python: &Path) -> bool {
    if !venv_python.exists() {
        return false;
    }
    match probe_python_version(&venv_python.to_string_lossy()) {
        Some((major, minor, _)) => version_ok(major, minor),
        None => false,
    }
}

/// Lightweight check: does the venv python execute (regardless of version)?
/// Used only for diagnostics where we want to differentiate "missing" from "broken".
pub(crate) fn venv_python_runs_ok(venv_python: &Path) -> bool {
    if !venv_python.exists() {
        return false;
    }
    Command::new(venv_python)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_or(false, |s| s.success())
}

/// Marker file that records which requirements.txt was used to populate the venv.
/// If requirements.txt has not changed since last install, we skip pip install.
fn deps_marker_path(venv_path: &Path) -> PathBuf {
    venv_path.join(".codepapr_deps_marker")
}

fn requirements_signature(target_path: &Path) -> Option<String> {
    let req_path = target_path.join("requirements.txt");
    let bytes = std::fs::read(&req_path).ok()?;
    let meta = std::fs::metadata(&req_path).ok()?;
    let len = bytes.len();
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in &bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("len={len},mtime={:?},fnv={hash:x}", meta.modified().ok()))
}

fn write_deps_marker(venv_path: &Path, target_path: &Path) -> std::io::Result<()> {
    if let Some(sig) = requirements_signature(target_path) {
        std::fs::write(deps_marker_path(venv_path), sig)?;
    }
    Ok(())
}

fn deps_marker_ok(venv_path: &Path, target_path: &Path) -> bool {
    let marker_path = deps_marker_path(venv_path);
    let Ok(current_sig) = std::fs::read_to_string(&marker_path) else {
        return false;
    };
    match requirements_signature(target_path) {
        Some(expected) => current_sig.trim() == expected,
        None => false,
    }
}

/// Removes code files from target_path while preserving the venv directory.
/// Used when the code files are corrupt but the venv is intact.
fn cleanup_code_preserve_venv(target_path: &Path) {
    let Ok(entries) = std::fs::read_dir(target_path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name == VENV_DIR_NAME {
                continue;
            }
        }
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Removes orphaned `*.part` files (interrupted downloads) recursively.
fn cleanup_part_files(dir: &Path) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            let _ = cleanup_part_files(&path);
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(".part") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

fn verify_files(_app: &AppHandle, target_path: &Path, venv_python: &Path) -> Result<(), String> {
    if !target_path.join("api.py").exists() {
        return Err("api.py not found".to_string());
    }
    if !venv_python.exists() {
        return Err(format!("venv python missing at {}", venv_python.display()));
    }
    let pretrained = target_path.join("GPT_SoVITS").join("pretrained_models");
    if !pretrained.exists() {
        return Err("pretrained_models directory not found".to_string());
    }
    // Check that pretrained_models has at least one file beyond ".git"
    let has_models = std::fs::read_dir(&pretrained)
        .map(|d| d.filter_map(|e| e.ok()).any(|e| e.file_name() != ".git"))
        .unwrap_or(false);
    if !has_models {
        return Err("pretrained_models directory is empty".to_string());
    }

    // Optional: probe the venv python to confirm it runs.
    let probe = Command::new(venv_python)
        .arg("--version")
        .output()
        .map_err(|e| format!("venv python failed to run: {e}"))?;
    if !probe.status.success() {
        return Err("venv python returned non-zero".to_string());
    }

    Ok(())
}

/// Returns true if NLTK data is already downloaded.
fn nltk_data_present() -> bool {
    if let Ok(home) = std::env::var("HOME") {
        let nltk_dir = std::path::PathBuf::from(home).join("nltk_data");
        nltk_dir.join("taggers").join("averaged_perceptron_tagger_eng").exists()
            || nltk_dir.join("tokenizers").join("punkt").exists()
    } else {
        false
    }
}

/// Deploy the fully patched api.py bundled as a resource.
///
/// Uses a version marker (`# [codepapr-api-version] N`) to decide whether
/// the bundled version is newer than what's deployed. This ensures bug
/// fixes ship on every app update — the old marker-only check (`# [codepapr-ws] endpoint`)
/// skipped deployment once the marker existed, so fixes to top_p/temperature
/// defaults and the v4 ref-strip bug never reached users who already had
/// an older patched api.py deployed.
fn deploy_patched_api_py(app: &AppHandle, target_path: &Path) {
    let api_path = target_path.join("api.py");
    let bundled = include_str!("../../resources/api_patched.py");

    let bundled_version = extract_api_version(bundled);
    let needs_write = match std::fs::read_to_string(&api_path) {
        Ok(existing) => {
            let deployed_version = extract_api_version(&existing);
            match (deployed_version, bundled_version) {
                (Some(d), Some(b)) => d < b,
                // No version marker in deployed file → it's an old format, update it.
                (None, _) => true,
                // Bundled has no version (shouldn't happen) → fall back to marker check.
                (_, None) => !existing.contains("# [codepapr-ws] endpoint"),
            }
        }
        Err(_) => true,
    };

    if needs_write {
        // Back up the original api.py before overwriting so user modifications
        // (custom endpoints, model tweaks, etc.) are not silently destroyed.
        if api_path.exists() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let bak_path = target_path.join(format!("api.py.{ts}.bak"));
            match std::fs::copy(&api_path, &bak_path) {
                Ok(_) => {
                    let _ = app.emit("tts-install-progress", InstallProgress::running(
                        "install-deps", "Installing Python packages",
                        &format!("Backed up original api.py → api.py.{ts}.bak"),
                    ));
                }
                Err(e) => {
                    let _ = app.emit("tts-install-progress", InstallProgress::running(
                        "install-deps", "Installing Python packages",
                        &format!("Warning: could not back up api.py before overwrite: {e}"),
                    ));
                }
            }
        }

        if let Err(e) = std::fs::write(&api_path, bundled) {
            let _ = app.emit("tts-install-progress", InstallProgress::running(
                "install-deps", "Installing Python packages",
                &format!("Warning: could not deploy api.py: {e}"),
            ));
        } else {
            let _ = app.emit("tts-install-progress", InstallProgress::running(
                "install-deps", "Installing Python packages",
                "Deployed api.py with WebSocket batch synthesis, soundfile, and bug fixes",
            ));
        }
    }
}

/// Extract the `[codepapr-api-version] N` marker from api.py content.
/// Returns `None` if the marker is absent (old / unpatched file).
fn extract_api_version(content: &str) -> Option<u32> {
    let marker = "# [codepapr-api-version] ";
    let line = content.lines().find(|l| l.starts_with(marker))?;
    let num_str = line.strip_prefix(marker)?.trim();
    let end = num_str
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(num_str.len());
    num_str[..end].parse().ok()
}

fn deploy_finetune_script(app: &AppHandle, target_path: &Path) {
    let script_path = target_path.join("codepapr_finetune.py");
    let script_content = include_str!("../../resources/codepapr_finetune.py");

    let needs_write = match std::fs::read_to_string(&script_path) {
        Ok(existing) => existing != script_content,
        Err(_) => true,
    };

    if needs_write {
        match std::fs::write(&script_path, script_content) {
            Ok(()) => {
                emit(app, &InstallProgress::running(
                    "install-deps", "Installing Python packages",
                    "Deployed fine-tuning script",
                ));
            }
            Err(e) => {
                emit(app, &InstallProgress::running(
                    "install-deps", "Installing Python packages",
                    &format!("Warning: could not deploy fine-tuning script: {e}"),
                ));
            }
        }
    }
}

/// Patches `tools/my_utils.py` to use `soundfile` as primary audio
/// loader instead of requiring ffmpeg. soundfile uses libsndfile
/// which handles WAV natively without external dependencies.
fn apply_load_audio_patch(app: &AppHandle, target_path: &Path) {
    let utils_path = target_path.join("tools").join("my_utils.py");
    if !utils_path.exists() {
        return;
    }
    let content = match std::fs::read_to_string(&utils_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    if content.contains("# [codepapr] soundfile fallback") {
        return;
    }

    // Replace the entire load_audio function
    let old_fn = "def load_audio(file, sr):";
    let new_fn = r#"def load_audio(file, sr):
    file = clean_path(file)
    if os.path.exists(file) is False:
        raise RuntimeError("You input a wrong audio path that does not exists, please fix it!")
    # [codepapr] soundfile fallback — no ffmpeg dependency
    try:
        import soundfile as _sf
        data, orig_sr = _sf.read(file)
        if data.ndim > 1:
            data = data.mean(axis=1)
        if orig_sr != sr:
            num_samples = int(len(data) * sr / orig_sr)
            from scipy import signal as _scipy_sig
            data = _scipy_sig.resample(data.astype(float), num_samples)
        return data.astype(np.float32)
    except Exception:
        pass
    # Fall back to ffmpeg
    try:
        out, _ = (
            ffmpeg.input(file, threads=0)
            .output("-", format="f32le", acodec="pcm_f32le", ac=1, ar=sr)
            .run(cmd=["ffmpeg", "-nostdin"], capture_stdout=True, capture_stderr=True)
        )
    except Exception:
        out, _ = (
            ffmpeg.input(file, threads=0)
            .output("-", format="f32le", acodec="pcm_f32le", ac=1, ar=sr)
            .run(cmd=["ffmpeg", "-nostdin"], capture_stdout=True)
        )
        raise RuntimeError(i18n("音频加载失败"))
    return np.frombuffer(out, np.float32).flatten()"#;

    if let Some(pos) = content.find(old_fn) {
        // Find the end of the old function (next `def ` at column 0)
        let after_fn = &content[pos..];
        let end = after_fn.find("\ndef ").unwrap_or(after_fn.len());
        let patched = format!("{}{}{}", &content[..pos], new_fn, &after_fn[end..]);
        if let Err(e) = std::fs::write(&utils_path, &patched) {
            let _ = app.emit("tts-install-progress", InstallProgress::running(
                "install-deps", "Installing Python packages",
                &format!("Warning: could not patch load_audio: {e}"),
            ));
        } else {
            let _ = app.emit("tts-install-progress", InstallProgress::running(
                "install-deps", "Installing Python packages",
                "Patched load_audio to use soundfile (no ffmpeg needed)",
            ));
        }
    }
}
