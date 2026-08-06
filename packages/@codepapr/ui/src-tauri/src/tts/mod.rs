pub(crate) mod finetune;
pub(crate) mod installer;
pub(crate) mod player;
pub(crate) mod server;
pub(crate) mod ws;

#[cfg(test)]
mod tests;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use reqwest::blocking::Client;
use tauri::Emitter;

use crate::shared::run_blocking_workspace_task;
use server::GptSovitsServer;

static TTS_SERVER: std::sync::OnceLock<Mutex<Option<GptSovitsServer>>> = std::sync::OnceLock::new();
static AUDIO_PLAYER: std::sync::OnceLock<Mutex<player::AudioPlayer>> = std::sync::OnceLock::new();
static STARTING: AtomicBool = AtomicBool::new(false);
static FIRST_SYNTH_COMPLETED: AtomicBool = AtomicBool::new(false);
/// Set by `tts_stop_playback` so long-running HTTP response readers can
/// abort early instead of consuming a thread for the full timeout.
static SYNTHESIS_CANCELLED: AtomicBool = AtomicBool::new(false);
/// Persistent HTTP client with connection pooling for GPT-SoVITS requests.
/// Avoids TCP handshake per synthesis call.
static HTTP_CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
/// Tracks the (ref_path, prompt_text, lang) key of the last `/change_refer`
/// call so we skip it when the speaker hasn't changed.
static LAST_REFER_KEY: std::sync::OnceLock<Mutex<Option<String>>> = std::sync::OnceLock::new();
/// Tracks the last model name sent via `/set_model`.
static LAST_MODEL_NAME: std::sync::OnceLock<Mutex<Option<String>>> = std::sync::OnceLock::new();
/// Default v4 SoVITS model path, set during server start. Used to reset
/// the model when switching from a fine-tuned character to one without.
static DEFAULT_SOVITS_V4_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn tts_server_lock() -> &'static Mutex<Option<GptSovitsServer>> {
    TTS_SERVER.get_or_init(|| Mutex::new(None))
}

fn tts_player_lock() -> &'static Mutex<player::AudioPlayer> {
    AUDIO_PLAYER.get_or_init(|| Mutex::new(player::AudioPlayer::new()))
}

fn tts_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .pool_max_idle_per_host(2)
            .build()
            .expect("Failed to build reqwest client")
    })
}

fn refer_key(ref_path: &str, prompt_text: &str, lang: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    ref_path.hash(&mut h);
    prompt_text.hash(&mut h);
    lang.hash(&mut h);
    if let Ok(meta) = std::fs::metadata(ref_path) {
        if let Ok(mtime) = meta.modified() {
            if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                dur.as_nanos().hash(&mut h);
            }
        }
    }
    format!("{:016x}", h.finish())
}

fn normalize_lang_code(code: &str) -> &str {
    match code {
        "zh" | "all_zh" => "all_zh",
        "yue" | "all_yue" => "all_yue",
        "ja" | "all_ja" => "all_ja",
        "ko" | "all_ko" => "all_ko",
        "auto" | "all_auto" => "auto",
        other => other,
    }
}

fn last_refer_lock() -> &'static Mutex<Option<String>> {
    LAST_REFER_KEY.get_or_init(|| Mutex::new(None))
}

fn last_model_lock() -> &'static Mutex<Option<String>> {
    LAST_MODEL_NAME.get_or_init(|| Mutex::new(None))
}

pub(crate) fn default_gpt_sovits_path() -> PathBuf {
    crate::shared::home_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".codepapr")
        .join("gpt-sovits")
}

fn voices_dir() -> PathBuf {
    crate::shared::home_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".codepapr")
        .join("voices")
}

/// 判断端口上的进程是否是我们自己启动的 GPT-SoVITS 服务（python api.py）。
/// 只有它才允许被 `kill_port_process` 清理；无法确认时一律视为「不是我们的」
/// （安全方向）——绝不因端口冲突杀掉用户无关的进程。
fn is_gpt_sovits_process(pid: &str) -> bool {
    #[cfg(unix)]
    {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-p", pid, "-o", "command="])
            .output()
        else {
            return false;
        };
        if !out.status.success() {
            return false;
        }
        let cmd = String::from_utf8_lossy(&out.stdout).to_ascii_lowercase();
        cmd.contains("python") && cmd.contains("api.py")
    }
    #[cfg(windows)]
    {
        let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
        else {
            return false;
        };
        if !out.status.success() {
            return false;
        }
        // tasklist 只能给出映像名（如 python.exe）：要求是 python 进程。
        String::from_utf8_lossy(&out.stdout)
            .to_ascii_lowercase()
            .contains("python")
    }
}

/// Forcefully free a TCP port by killing whatever process is bound to it.
///
/// Strategy: SIGTERM (polite) → wait up to 1.5s for graceful shutdown
/// → SIGKILL (forceful) if still alive → verify port is free.
///
/// We need this because GPT-SoVITS api.py installs uvicorn signal handlers
/// that try to gracefully drain the server on SIGTERM. That drain can hang
/// indefinitely if PyTorch background threads or in-flight HTTP requests
/// don't cooperate. The previous version of this function sent SIGTERM and
/// hoped 500ms was enough — it usually wasn't, leaving zombie servers
/// orphaned to launchd and blocking port 9880 for the next CodePapr launch.
///
/// Returns `true` if the port is confirmed free after the cleanup attempt.
fn kill_port_process(port: u16) -> bool {
    let pids = pids_on_port(port);
    if pids.is_empty() {
        return true;
    }
    // 只清理我们自己的 GPT-SoVITS 进程。端口被未知进程占用（用户自己的
    // 9880 服务）时拒绝动手，返回 false 让调用方提示用户手动处理。
    if !pids.iter().all(|pid| is_gpt_sovits_process(pid)) {
        return false;
    }

    #[cfg(unix)]
    {
        // Round 1: polite shutdown.
        for pid in &pids {
            let _ = std::process::Command::new("kill").arg(pid).output();
        }
        // Wait up to ~1.5s for graceful exit, polling every 250ms.
        for _ in 0..6 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if pids_on_port(port).is_empty() {
                return true;
            }
        }
        // Round 2: SIGKILL anything still squatting on the port.
        // 重新确认归属：等待期间端口可能被别的进程接管。
        let stubborn = pids_on_port(port);
        for pid in stubborn.iter().filter(|pid| is_gpt_sovits_process(pid)) {
            let _ = std::process::Command::new("kill")
                .args(["-9", pid])
                .output();
        }
        // Final 500ms grace for the kernel to release the socket.
        std::thread::sleep(std::time::Duration::from_millis(500));
        pids_on_port(port).is_empty()
    }
    #[cfg(windows)]
    {
        // On Windows, /F (forceful) is the default. Run twice with a short
        // pause to handle the (rare) case where a child process is spawned
        // between our enumeration and the kill.
        for pid in &pids {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/PID", pid])
                .output();
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        let stubborn = pids_on_port(port);
        for pid in stubborn.iter().filter(|pid| is_gpt_sovits_process(pid)) {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/PID", pid])
                .output();
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        pids_on_port(port).is_empty()
    }
}

#[cfg(windows)]
fn pids_on_port(port: u16) -> Vec<String> {
    let output = std::process::Command::new("cmd")
        .args([
            "/c",
            &format!("for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{port}') do @echo %a"),
        ])
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
        }
    }
    Vec::new()
}

#[cfg(unix)]
fn pids_on_port(port: u16) -> Vec<String> {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
        }
    }

    // Fallback: some container/CI environments lack lsof.
    // Try ss first, then netstat.
    for cmd in &["ss", "netstat"] {
        let output = std::process::Command::new(cmd).args(["-tlnp"]).output();
        if let Ok(out) = output {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let needle = &format!(":{port}");
                return stdout
                    .lines()
                    .filter(|l| l.contains(needle))
                    .filter_map(|l| {
                        l.split_whitespace()
                            .find(|w| w.contains('/'))
                            .and_then(|w| w.split('/').next())
                            .map(|s| s.to_string())
                    })
                    .collect();
            }
        }
    }

    Vec::new()
}

/// Convert an audio file to 16kHz mono WAV using ffmpeg.
fn convert_to_wav(input: &std::path::Path, output: &std::path::Path) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "ffmpeg not found".to_string())?;
    let status = std::process::Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            &input.to_string_lossy(),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-sample_fmt",
            "s16",
            &output.to_string_lossy(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status()
        .map_err(|e| format!("ffmpeg spawn error: {e}"))?;

    if !status.success() {
        return Err(format!("ffmpeg exited with status {}", status));
    }
    Ok(())
}

fn candidate_works(candidate: &str) -> bool {
    std::process::Command::new(candidate)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

fn find_ffmpeg() -> Option<String> {
    let candidates: &[&str] = &[
        "ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
    ];
    for candidate in candidates {
        if candidate_works(candidate) {
            return Some(candidate.to_string());
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let exe = std::path::PathBuf::from(local_app_data)
                .join("codepapr")
                .join("bin")
                .join("ffmpeg.exe");
            if exe.exists() && candidate_works(&exe.to_string_lossy()) {
                return Some(exe.to_string_lossy().to_string());
            }
        }
    }
    None
}

// ---- Server lifecycle ----

#[tauri::command]
pub fn tts_server_start(
    app_handle: tauri::AppHandle,
    gpt_sovits_path: Option<String>,
    model_version: Option<String>,
    fine_tuned_model_path: Option<String>,
) -> Result<(), String> {
    ws::set_ws_app_handle(app_handle.clone());
    // Each new server lifecycle starts with a fresh "first synthesis" flag
    // so the perf-warning heuristic correctly treats the first request after
    // restart as a Metal-warmup outlier.
    FIRST_SYNTH_COMPLETED.store(false, Ordering::SeqCst);

    // Reject concurrent / repeated start attempts. The user-visible scenario:
    // Python takes 30-60s to warm up on CPU, during which time `tts_server_status`
    // returns false and the UI may say "stopped". A frustrated user clicking
    // again would otherwise spawn a second Python process — and our
    // `kill_port_process` cleanup would then murder the first one.
    if STARTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("TTS server is already starting. Please wait...".to_string());
    }

    let path = gpt_sovits_path
        .map(PathBuf::from)
        .unwrap_or_else(default_gpt_sovits_path);

    let lock = tts_server_lock();
    {
        let guard = match lock.lock() {
            Ok(g) => g,
            Err(e) => {
                STARTING.store(false, Ordering::SeqCst);
                return Err(format!("Lock error: {e}"));
            }
        };
        if guard.is_some() {
            STARTING.store(false, Ordering::SeqCst);
            return Err("TTS server is already running. Stop it first.".to_string());
        }
    }

    let app_handle_for_thread = app_handle.clone();
    let mv = model_version.unwrap_or_else(|| server::MODEL_VERSION_V4.to_string());
    let ft_path = fine_tuned_model_path.clone();
    // Spawn a thread because start() does a blocking health-check loop (up to 90s).
    // The command returns immediately so the frontend doesn't freeze.
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // ── Pre-flight: make sure port 9880 is actually free ──
            // A previous CodePapr session may have crashed and left its Python TTS
            // server orphaned to launchd, holding port 9880 indefinitely. If we
            // skip this check, every start attempt below will hit "address already
            // in use" until the user manually kills the zombie. We proactively
            // clean any squatter — including respecting the SIGTERM→SIGKILL
            // escalation in `kill_port_process`.
            if !pids_on_port(server::GPT_SOVITS_API_PORT).is_empty() {
                let _ = app_handle_for_thread.emit(
                "tts-server-log",
                ServerLogEvent {
                    stream: "system",
                    line: format!(
                        "Port {} is occupied by a stale process (likely a leftover from a previous CodePapr session). Cleaning up before starting...",
                        server::GPT_SOVITS_API_PORT
                    ),
                },
            );
                let cleared = kill_port_process(server::GPT_SOVITS_API_PORT);
                if !cleared {
                    let msg = format!(
                    "Could not free port {}: another process is holding it and refused to terminate. Please kill it manually:\n  lsof -ti :{} | xargs kill -9",
                    server::GPT_SOVITS_API_PORT,
                    server::GPT_SOVITS_API_PORT
                );
                    let _ = app_handle_for_thread.emit("tts-server-error", msg.clone());
                    STARTING.store(false, Ordering::SeqCst);
                    return;
                }
            }

            // Tell the user upfront which compute backend we're trying. Saves a
            // lot of confusion when MPS gives the user a 3-5x speedup vs CPU.
            let device = server::recommended_device();
            let _ = app_handle_for_thread.emit(
            "tts-server-log",
            ServerLogEvent {
                stream: "system",
                line: format!(
                    "Starting GPT-SoVITS server on {} backend{}...",
                    device,
                    if device == "mps" {
                        " (Apple Silicon GPU acceleration; first synthesis after start may take longer due to Metal kernel compilation)"
                    } else {
                        ""
                    }
                ),
            },
        );

            // Store the default v4 SoVITS path BEFORE path is consumed by start_with_retry.
            // Used later by tts_set_model to reset from fine-tuned back to default.
            let default_v4 = path.join("GPT_SoVITS/pretrained_models/gsv-v4-pretrained/s2Gv4.pth");
            if default_v4.exists() {
                let _ = DEFAULT_SOVITS_V4_PATH.set(default_v4.to_string_lossy().to_string());
            }

            let result = start_with_retry(path, app_handle_for_thread.clone(), &mv);
            match result {
                Ok((srv, used_device)) => {
                    let reported_version = srv.model_version().to_string();
                    let half_prec = srv.half_precision();
                    // New Python process has no refer/model state — reset caches
                    if let Ok(mut g) = last_refer_lock().lock() {
                        *g = None;
                    }
                    if let Ok(mut g) = last_model_lock().lock() {
                        *g = None;
                    }
                    if let Ok(mut g) = lock.lock() {
                        *g = Some(srv);
                    }

                    // Load the fine-tuned model BEFORE emitting tts-server-started.
                    // This eliminates the race condition between /set_model and the
                    // first synthesis that caused "Broken pipe" WS errors.
                    if let Some(ref ft) = ft_path {
                        if !ft.is_empty() {
                            let _ = app_handle_for_thread.emit(
                                "tts-server-log",
                                ServerLogEvent {
                                    stream: "system",
                                    line: format!("Loading fine-tuned model: {}", ft),
                                },
                            );
                            let client = tts_client();
                            let base_url = GptSovitsServer::api_base_url();
                            // GET + query matches the synthesis hot-path
                            // (`synthesize_blocking`) and api.py's `/set_model`
                            // handler — keep all set_model calls on one method.
                            if let Ok(resp) = client
                                .get(format!("{base_url}/set_model"))
                                .query(&[("sovits_model_path", ft.as_str())])
                                .send()
                            {
                                if resp.status().is_success() {
                                    if let Ok(mut g) = last_model_lock().lock() {
                                        *g = Some(ft.clone());
                                    }
                                }
                            }
                        }
                    }

                    let _ = app_handle_for_thread.emit(
                        "tts-server-started",
                        ServerStartedPayload {
                            device: used_device,
                            model_version: reported_version,
                            half_precision: half_prec,
                        },
                    );
                }
                Err(e) => {
                    let _ = app_handle_for_thread.emit("tts-server-error", e.clone());
                    eprintln!("Failed to start TTS server: {e}");
                }
            }
        })); // catch_unwind
        STARTING.store(false, Ordering::SeqCst);
        if let Err(panic_err) = result {
            let msg = if let Some(s) = panic_err.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = panic_err.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "Unknown panic".to_string()
            };
            let _ = app_handle_for_thread.emit(
                "tts-server-error",
                format!("TTS server start panicked: {}", msg),
            );
        }
    });
    Ok(())
}

#[derive(serde::Serialize, Clone)]
struct ServerStartedPayload {
    device: String,
    model_version: String,
    half_precision: bool,
}

/// Try to start the server with smart fallback.
///
/// Strategy:
/// 1. Try the recommended device (mps on Apple Silicon, cpu elsewhere).
/// 2. If port is already taken — `start_once` already retries once after
///    cleaning the port; no extra fallback needed for that case.
/// 3. If preferred device is non-cpu and start fails for some OTHER reason
///    (driver issues, unsupported ops, model loading errors), fall back to
///    cpu. CPU is the universal lowest-common-denominator that always works
///    if the install is healthy at all.
fn start_with_retry(
    path: PathBuf,
    app_handle: tauri::AppHandle,
    model_version: &str,
) -> Result<(GptSovitsServer, String), String> {
    let preferred = server::recommended_device();
    match start_once(&path, &app_handle, preferred, model_version) {
        Ok(srv) => Ok((srv, preferred.to_string())),
        // If the failure was a port conflict, `start_once` already did its own
        // cleanup-and-retry. If we're here with a port-conflict error it means
        // the port is genuinely stuck — switching to CPU won't help.
        Err(e) if is_port_in_use_error(&e) => Err(e),
        // Real device failure (e.g. MPS not available, driver crash, OOM,
        // unsupported operator). Fall back to CPU.
        Err(e) if preferred != "cpu" => {
            let _ = app_handle.emit(
                "tts-server-log",
                ServerLogEvent {
                    stream: "system",
                    line: format!(
                        "{preferred} backend failed: {}. Falling back to CPU (slower but always works).",
                        first_line(&e)
                    ),
                },
            );
            // Make sure the port is clean before the fallback attempt.
            kill_port_process(server::GPT_SOVITS_API_PORT);
            start_once(&path, &app_handle, "cpu", model_version)
                .map(|srv| (srv, "cpu".to_string()))
                .map_err(|e2| {
                    format!(
                        "Both {preferred} and cpu backends failed to start.\n\
                         {preferred} error: {e}\n\
                         cpu error: {e2}"
                    )
                })
        }
        Err(e) => Err(e),
    }
}

/// Single-device start attempt with at most one retry on port conflict.
fn start_once(
    path: &PathBuf,
    app_handle: &tauri::AppHandle,
    device: &str,
    model_version: &str,
) -> Result<GptSovitsServer, String> {
    let mut srv = GptSovitsServer::new(path.clone());
    match srv.start(Some(app_handle.clone()), device, model_version) {
        Ok(()) => Ok(srv),
        Err(e) if is_port_in_use_error(&e) => {
            // Stale Python from a previous session is squatting on port 9880.
            let _ = app_handle.emit(
                "tts-server-log",
                ServerLogEvent {
                    stream: "system",
                    line: format!(
                        "Port {} is in use by a stale process — escalating cleanup and retrying...",
                        server::GPT_SOVITS_API_PORT
                    ),
                },
            );
            let cleared = kill_port_process(server::GPT_SOVITS_API_PORT);
            if !cleared {
                return Err(format!(
                    "Port {} could not be freed after SIGKILL. There is a stuck process holding it. \
                     Please run this in a terminal and try again:\n  \
                     lsof -ti :{} | xargs kill -9\n\n\
                     Original error: {}",
                    server::GPT_SOVITS_API_PORT,
                    server::GPT_SOVITS_API_PORT,
                    e
                ));
            }
            drop(srv);
            let mut srv2 = GptSovitsServer::new(path.clone());
            srv2.start(Some(app_handle.clone()), device, model_version)?;
            Ok(srv2)
        }
        Err(e) => Err(e),
    }
}

/// Take the first non-empty line of a multi-line error so we can include it
/// in a status message without exploding the UI.
fn first_line(s: &str) -> String {
    s.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or(s)
        .to_string()
}

#[derive(serde::Serialize, Clone)]
struct ServerLogEvent {
    stream: &'static str,
    line: String,
}

fn is_port_in_use_error(e: &str) -> bool {
    let lower = e.to_ascii_lowercase();
    lower.contains("address already in use")
        || lower.contains("only one usage of each socket address")
        || lower.contains("errno 48")
}

#[tauri::command]
pub fn tts_server_stop(app_handle: tauri::AppHandle) -> Result<(), String> {
    let lock = tts_server_lock();
    let mut guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(mut srv) = guard.take() {
        srv.stop()?;
        let _ = app_handle.emit("tts-server-stopped", ());
        Ok(())
    } else {
        Ok(())
    }
}

/// Stop the server without requiring an AppHandle. Used during application
/// shutdown so we never leave a zombie Python process on port 9880.
pub(crate) fn tts_server_stop_internal() {
    if let Some(lock) = TTS_SERVER.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(mut srv) = guard.take() {
                let _ = srv.stop();
            }
        }
    }
}

#[tauri::command]
pub fn tts_server_status() -> Result<bool, String> {
    let lock = tts_server_lock();
    let guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    Ok(guard.as_ref().map_or(false, |s| s.is_running()))
}

/// Synthesise a short dummy phrase to trigger Metal GPU kernel JIT
/// compilation before the first real synthesis. This avoids the 5-15s
/// first-sentence penalty on Apple Silicon.
///
/// GPT-SoVITS v4 requires a reference audio — pass `ref_audio_path` from
/// the character's voice config. If the user hasn't uploaded one yet,
/// the caller should reject at the frontend level rather than hit the API.
#[tauri::command]
pub async fn tts_warmup_gpu(
    app_handle: tauri::AppHandle,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
) -> Result<(), String> {
    {
        let lock = tts_server_lock();
        let guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
        if !guard.as_ref().map_or(false, |s| s.is_running()) {
            return Err("TTS server is not running. Start it first.".to_string());
        }
    }

    let _ = app_handle.emit(
        "tts-server-log",
        ServerLogEvent {
            stream: "system",
            line: "GPU warmup: triggering Metal kernel compilation with a dummy phrase..."
                .to_string(),
        },
    );

    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Use the prompt text if available (matches the voice language),
            // otherwise a minimal neutral utterance. Avoids sending English
            // "test" to a Chinese-only model.
            let warmup_text = prompt_text
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| "嗯".to_string());
            synthesize_blocking(
                warmup_text,
                None,
                ref_audio_path,
                prompt_text,
                prompt_language.clone(),
                prompt_language,
                MODE_STREAMED_PIPELINE,
                4,   // minimum steps — just want the kernel compiled
                1.0, // default speed
            )
        }));
        let _ = tx.send(match result {
            Ok(r) => r,
            Err(_) => Err("GPU warmup thread panicked".to_string()),
        });
    });

    match rx.await {
        Ok(Ok(())) => {
            let _ = app_handle.emit(
                "tts-server-log",
                ServerLogEvent {
                    stream: "system",
                    line: "GPU warmup complete — Metal kernels are now compiled and cached for this session.".to_string(),
                },
            );
            FIRST_SYNTH_COMPLETED.store(true, Ordering::SeqCst);
            Ok(())
        }
        Ok(Err(e)) => Err(format!("GPU warmup failed: {e}")),
        Err(_) => Err("GPU warmup cancelled".to_string()),
    }
}

// ---- Installation status ----

#[derive(serde::Serialize)]
pub struct TtsInstallStatus {
    pub installed: bool,
    pub api_py: bool,
    pub venv_ok: bool,
    pub models_ok: bool,
}

#[tauri::command]
pub fn tts_check_installed() -> Result<TtsInstallStatus, String> {
    let target = default_gpt_sovits_path();
    let venv_path = target.join(installer::VENV_DIR_NAME);
    let venv_python = installer::venv_python_path(&venv_path);
    let pretrained = target.join("GPT_SoVITS").join("pretrained_models");

    let api_py = target.join("api.py").exists();
    let venv_ok = installer::venv_python_is_compatible(&venv_python);
    let models_ok = installer::has_complete_model_set(&pretrained);
    let installed = api_py && venv_ok && models_ok;

    Ok(TtsInstallStatus {
        installed,
        api_py,
        venv_ok,
        models_ok,
    })
}

// ---- Model management ----

/// Load a SoVITS model file (.pth) on the running server via `/set_model`.
/// Used to preload the fine-tuned model right after server start so the
/// first synthesis doesn't fall back to the default pretrained model.
#[tauri::command]
pub async fn tts_set_model(model_name: String) -> Result<(), String> {
    run_blocking_workspace_task(move || {
        {
            let lock = tts_server_lock();
            let guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
            if !guard.as_ref().map_or(false, |s| s.is_running()) {
                return Err("TTS server is not running.".to_string());
            }
        }
        if model_name.is_empty() {
            // Reset to default v4 pretrained model.
            let default_path = DEFAULT_SOVITS_V4_PATH.get().cloned().unwrap_or_default();
            if default_path.is_empty() {
                return Err("Default model path not set. Start the server first.".to_string());
            }
            let base_url = GptSovitsServer::api_base_url();
            let client = tts_client();
            let resp = client
                .get(format!("{base_url}/set_model"))
                .query(&[("sovits_model_path", default_path.as_str())])
                .send()
                .map_err(|e| format!("set_model request failed: {e}"))?;
            if !resp.status().is_success() {
                let body = resp.text().unwrap_or_default();
                return Err(format!("set_model failed: {body}"));
            }
            if let Ok(mut g) = last_model_lock().lock() {
                *g = None;
            }
            return Ok(());
        }
        let base_url = GptSovitsServer::api_base_url();
        let client = tts_client();
        let resp = client
            .get(format!("{base_url}/set_model"))
            .query(&[("sovits_model_path", model_name.as_str())])
            .send()
            .map_err(|e| format!("set_model request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().unwrap_or_default();
            return Err(format!("set_model failed: {body}"));
        }
        // Update the model cache so the first synthesis doesn't redundantly
        // call /set_model again.
        if let Ok(mut g) = last_model_lock().lock() {
            *g = Some(model_name);
        }
        Ok(())
    })
    .await
}

// ---- Synthesis ----

/// Playback strategy for synthesis. Mirrors the TypeScript `TtsPlaybackMode`
/// union — kept as plain string matching at the Tauri boundary so the Rust
/// side doesn't depend on a serde enum the frontend has to perfectly match.
const MODE_STREAMED_PIPELINE: &str = "streamed-pipeline";
const MODE_STREAMED_PCM: &str = "streamed-pcm";

/// Synthesise `text` via GPT-SoVITS and play it through the local audio
/// device.
///
/// `playback_mode` selects the strategy:
/// * `"whole"` — read the full WAV, then `play_wav` (rebuild sink).
/// * `"streamed-pipeline"` (default) — read the full WAV, then
///   `enqueue_wav` (append to shared sink for seamless joins).
/// * `"streamed-pcm"` — experimental PCM direct push; may fall back.
///
/// `sample_steps` is the GPT-SoVITS v4 diffusion step count. Lower values
/// trade some quality for substantial speed gains. Range 4-32, default 8.
///
/// `speed` — voice speed factor. GPT-SoVITS expects 0.5-2.0, default 1.0.
#[tauri::command]
pub async fn tts_synthesize_and_play(
    app_handle: tauri::AppHandle,
    text: String,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    playback_mode: Option<String>,
    sample_steps: Option<u32>,
    speed: Option<f32>,
) -> Result<(), String> {
    // Fail fast if the server isn't running yet — otherwise we'd waste time
    // making an HTTP request to a dead port and surface a confusing
    // "request or response body error" from reqwest.
    {
        let lock = tts_server_lock();
        let guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
        let running = guard.as_ref().map_or(false, |s| s.is_running());
        if !running {
            return Err(
                "TTS server is not running. Click the speaker icon to start it.".to_string(),
            );
        }
    }

    let mode = playback_mode
        .as_deref()
        .unwrap_or(MODE_STREAMED_PIPELINE)
        .to_string();
    let steps = sample_steps.unwrap_or(8).clamp(4, 32);
    let spd = speed.unwrap_or(1.0).clamp(0.5, 2.0);

    let app_handle_for_thread = app_handle.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let started = std::time::Instant::now();
            let result = synthesize_blocking(
                text,
                model_name,
                ref_audio_path,
                prompt_text,
                prompt_language,
                text_language,
                &mode,
                steps,
                spd,
            );
            // Telemetry: a successful synthesis that takes longer than this is
            // probably running on CPU even though we asked for MPS. Surface it
            // to the live log panel so the user can spot configuration issues
            // without having to install profiling tools.
            if result.is_ok() {
                let elapsed = started.elapsed();
                let elapsed_secs = elapsed.as_secs_f32();
                let line = format!(
                    "Synthesis completed in {:.1}s (mode={}, sample_steps={})",
                    elapsed_secs, mode, steps
                );
                let _ = app_handle_for_thread.emit(
                    "tts-server-log",
                    ServerLogEvent {
                        stream: "system",
                        line: line.clone(),
                    },
                );
                // 12s+ for a single sentence on MPS strongly suggests the
                // backend silently fell back to CPU. The first synthesis after
                // server start is exempt because Metal kernel compilation is
                // a known one-time cost.
                if elapsed_secs > 12.0 && !FIRST_SYNTH_COMPLETED.load(Ordering::SeqCst) {
                    // First synth — Metal warmup, expected to be slow.
                } else if elapsed_secs > 12.0 {
                    let _ = app_handle_for_thread.emit(
                    "tts-server-log",
                    ServerLogEvent {
                        stream: "system",
                        line: "⚠ Synthesis is taking longer than expected. If you have an Apple Silicon Mac, MPS may have fallen back to CPU. Check the log above for PyTorch fallback warnings.".to_string(),
                    },
                );
                }
                FIRST_SYNTH_COMPLETED.store(true, Ordering::SeqCst);
            }
            result
        }));
        let _ = tx.send(match result {
            Ok(r) => r,
            Err(_) => Err("Synthesis thread panicked".to_string()),
        });
    });
    match rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Synthesis cancelled unexpectedly".to_string()),
    }
}

/// Batch-synthesise multiple sentences via a single WebSocket connection.
///
/// Sends all texts in one JSON message, receives WAV audio for each
/// sentence as it completes (prefixed with a 4-byte big-endian index),
/// and enqueues each to the audio player via `enqueue_wav` for seamless
/// playback. Also caches each WAV to disk for instant replay.
///
/// Falls back to HTTP per-sentence synthesis when the WebSocket path is
/// unavailable (e.g. api.py hasn't been patched yet).
#[tauri::command]
pub async fn tts_synthesize_batch_ws(
    sentences: Vec<String>,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    sample_steps: Option<u32>,
    speed: Option<f32>,
    top_k: Option<u32>,
    top_p: Option<f64>,
    temperature: Option<f64>,
    seq: u64,
) -> Result<(), String> {
    {
        let lock = tts_server_lock();
        let guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
        if !guard.as_ref().map_or(false, |s| s.is_running()) {
            return Err("TTS server is not running.".to_string());
        }
    }

    let steps = sample_steps.unwrap_or(8).clamp(4, 32);
    let spd = speed.unwrap_or(1.0).clamp(0.5, 2.0);
    // top_p=1.0 / temperature=1.0: benchmarked 9x faster than 0.6/0.6 on
    // Japanese text (all_ja frontend). The T2S model converges to EOS
    // much faster with wider sampling. No prompt-text leakage observed
    // in 20-sentence real-data test (all audio durations within bounds).
    let tk = top_k.unwrap_or(15).max(1);
    let tp = top_p.unwrap_or(1.0).clamp(0.0, 1.0) as f32;
    let temp = temperature.unwrap_or(1.0).clamp(0.0, 2.0) as f32;

    let sentences_clone = sentences.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result = ws::synthesize_batch_ws(
            sentences_clone,
            model_name,
            ref_audio_path,
            prompt_text,
            prompt_language,
            text_language,
            steps,
            spd,
            tk,
            tp,
            temp,
            seq,
        );
        let _ = tx.send(result);
    });
    match rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Batch synthesis cancelled unexpectedly".to_string()),
    }
}

/// Non-blocking batch WebSocket synthesis.
///
/// Spawns a background task that connects via WebSocket, sends all
/// sentences, and enqueues each received WAV to the audio player.
/// Returns immediately — the caller doesn't wait for synthesis to
/// complete. Used for concurrent chunk streaming.
#[tauri::command]
pub async fn tts_synthesize_batch_ws_nonblocking(
    sentences: Vec<String>,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    sample_steps: Option<u32>,
    speed: Option<f32>,
    top_k: Option<u32>,
    top_p: Option<f64>,
    temperature: Option<f64>,
    seq: u64,
) -> Result<(), String> {
    {
        let lock = tts_server_lock();
        let guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
        if !guard.as_ref().map_or(false, |s| s.is_running()) {
            return Err("TTS server is not running.".to_string());
        }
    }

    let steps = sample_steps.unwrap_or(8).clamp(4, 32);
    let spd = speed.unwrap_or(1.0).clamp(0.5, 2.0);
    // top_p=1.0 / temperature=1.0: benchmarked 9x faster than 0.6/0.6 on
    // Japanese text (all_ja frontend). 0.6/0.6 causes GPT to generate
    // degenerate super-long token sequences on complex grammar. No leakage
    // observed in 20-sentence real-data test with fine-tuned models.
    let tk = top_k.unwrap_or(15).max(1);
    let tp = top_p.unwrap_or(1.0).clamp(0.0, 1.0) as f32;
    let temp = temperature.unwrap_or(1.0).clamp(0.0, 2.0) as f32;

    ws::synthesize_batch_ws_nonblocking(
        sentences,
        model_name,
        ref_audio_path,
        prompt_text,
        prompt_language,
        text_language,
        steps,
        spd,
        tk,
        tp,
        temp,
        seq,
    );
    Ok(())
}

fn synthesize_blocking(
    text: String,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    mode: &str,
    sample_steps: u32,
    speed: f32,
) -> Result<(), String> {
    let base_url = GptSovitsServer::api_base_url();
    let client = tts_client();

    // /set_model — only when the model name actually changed.
    if let Some(ref model) = model_name {
        if !model.is_empty() {
            let should_set = last_model_lock()
                .lock()
                .map(|g| g.as_ref() != Some(model))
                .unwrap_or(true);
            if should_set {
                // Only record the model as "loaded" when the server actually
                // accepted it. Caching a failed/errored request would poison
                // the cache: every subsequent call would skip /set_model
                // (believing the model is already loaded) and synthesis would
                // silently run on the wrong model until a server restart.
                let set_ok = client
                    .get(format!("{base_url}/set_model"))
                    .query(&[("sovits_model_path", model.as_str())])
                    .send()
                    .map(|r| r.status().is_success())
                    .unwrap_or(false);
                if set_ok {
                    if let Ok(mut g) = last_model_lock().lock() {
                        *g = Some(model.clone());
                    }
                }
            }
        }
    }

    let sample_steps_str = sample_steps.to_string();
    let text_lang = text_language.as_deref().unwrap_or("zh");
    let mut params: Vec<(&str, String)> = vec![
        ("text", text),
        ("text_language", text_lang.to_string()),
        ("sample_steps", sample_steps_str),
        ("speed_factor", format!("{:.2}", speed)),
    ];
    if let Some(ref audio_path) = ref_audio_path {
        if !audio_path.is_empty() {
            params.push(("refer_wav_path", audio_path.clone()));
            if let Some(ref pt) = prompt_text {
                if !pt.is_empty() {
                    params.push(("prompt_text", pt.clone()));
                }
            }
            let lang = prompt_language.as_deref().unwrap_or("zh");
            params.push(("prompt_language", lang.to_string()));

            let key = refer_key(audio_path, prompt_text.as_deref().unwrap_or(""), lang);
            let should_refer = last_refer_lock()
                .lock()
                .map(|g| g.as_ref() != Some(&key))
                .unwrap_or(true);
            if should_refer {
                // Only cache the refer key on success — caching a failed
                // request would poison the cache the same way as /set_model
                // above, leaving the wrong reference voice stuck.
                let refer_ok = client
                    .get(format!("{base_url}/change_refer"))
                    .query(&[
                        ("refer_wav_path", audio_path.as_str()),
                        ("prompt_text", prompt_text.as_deref().unwrap_or("")),
                        ("prompt_language", lang),
                    ])
                    .send()
                    .map(|r| r.status().is_success())
                    .unwrap_or(false);
                if refer_ok {
                    if let Ok(mut g) = last_refer_lock().lock() {
                        *g = Some(key);
                    }
                }
            }
        }
    }

    let query_params: Vec<(&str, &str)> = params
        .iter()
        .map(|(k, v)| (k.as_ref(), v.as_str()))
        .collect();

    let mut resp = client
        .get(format!("{base_url}/"))
        .query(&query_params)
        .send()
        .map_err(|e| format!("TTS request failed: {e}"))?;

    if !resp.status().is_success() {
        // Try to extract the JSON error body the API returns on 400/500.
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("TTS API returned status {status}. Body: {body}"));
    }

    // Dispatch on playback mode.
    // Modes B and F: stream PCM directly from HTTP response into rodio,
    // bypassing full-WAV buffer → decode → play. No intermediate WAV file.
    // Mode A: read the full WAV and play_wav (hard sink reset).
    if mode == MODE_STREAMED_PIPELINE || mode == MODE_STREAMED_PCM {
        return synthesize_streaming_pcm(&mut resp);
    }

    // Mode A: read the whole WAV body.
    let all_bytes = read_response_to_end(&mut resp)?;
    if all_bytes.len() < 44 {
        return Err(format!(
            "TTS API returned an incomplete WAV (only {} bytes){}",
            all_bytes.len(),
            server_log_excerpt(),
        ));
    }

    {
        let lock = tts_player_lock();
        let mut guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
        guard.stop();
        guard
            .play_wav(&all_bytes)
            .map_err(|e| format!("Play error: {e}{}", server_log_excerpt()))?;
    }

    Ok(())
}

/// Read the full response body. Used only by Mode A (whole-passage synthesis).
fn read_response_to_end(resp: &mut reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    const MAX_BYTES: u64 = 50 * 1024 * 1024;
    let mut all_bytes = Vec::with_capacity(64 * 1024);
    let mut buf = [0u8; 16384];
    let mut total: u64 = 0;
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("Read error: {e}{}", server_log_excerpt()))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_BYTES {
            return Err(format!(
                "Response exceeded {MAX_BYTES} bytes — possible server error"
            ));
        }
        all_bytes.extend_from_slice(&buf[..n]);
    }
    Ok(all_bytes)
}

/// Mode B / Mode F: stream raw PCM samples into rodio as they arrive.
///
/// The first chunks contain the WAV header (RIFF + fmt + ... + data
/// sub-chunk). We accumulate bytes until we've located the start of the
/// PCM `data` sub-chunk, parse the format from the `fmt ` chunk, then
/// initialise the player's PCM stream. Subsequent bytes are interpreted
/// as raw 16-bit PCM samples and pushed straight into the sink.
fn synthesize_streaming_pcm(resp: &mut reqwest::blocking::Response) -> Result<(), String> {
    const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
    let mut buf = [0u8; 16384];
    let mut header_buf: Vec<u8> = Vec::with_capacity(4096);
    let mut header_parsed = false;
    let mut leftover_byte: Option<u8> = None;
    let mut total: u64 = 0;

    loop {
        if SYNTHESIS_CANCELLED.load(Ordering::Relaxed) {
            SYNTHESIS_CANCELLED.store(false, Ordering::Relaxed);
            return Err("Synthesis cancelled by user".to_string());
        }
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("Read error: {e}{}", server_log_excerpt()))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(format!(
                "Streaming response exceeded {MAX_TOTAL_BYTES} bytes — possible server error"
            ));
        }

        let chunk = &buf[..n];

        if !header_parsed {
            header_buf.extend_from_slice(chunk);
            // Try to locate the `data` sub-chunk start within what we've
            // collected so far. If the header isn't complete yet, keep
            // reading.
            match parse_wav_header(&header_buf) {
                Some(parsed) => {
                    {
                        let lock = tts_player_lock();
                        let mut guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
                        guard
                            .start_pcm_stream(parsed.sample_rate, parsed.channels)
                            .map_err(|e| format!("PCM init error: {e}{}", server_log_excerpt()))?;
                    }
                    // Push the PCM that was already read past the header.
                    let pcm_tail = &header_buf[parsed.data_offset..];
                    push_pcm_chunk(pcm_tail, &mut leftover_byte)?;
                    header_parsed = true;
                    // Drop the header buffer to free memory; we don't need
                    // it any more for routing.
                    header_buf = Vec::new();
                }
                None if header_buf.len() > 64 * 1024 => {
                    // 64 KB and still no `data` chunk found → this isn't a
                    // standard WAV. Bail out so the caller can show a
                    // useful error rather than hang forever.
                    return Err(format!(
                        "Streaming PCM mode: WAV header not found in first 64 KB of response.{}",
                        server_log_excerpt()
                    ));
                }
                None => {
                    // Still gathering header, continue reading.
                }
            }
        } else {
            push_pcm_chunk(chunk, &mut leftover_byte)?;
        }
    }

    if !header_parsed {
        return Err(format!(
            "Streaming PCM mode: response ended before WAV header was complete ({} bytes received).{}",
            header_buf.len(),
            server_log_excerpt()
        ));
    }

    if leftover_byte.is_some() {
        eprintln!("[tts] 1 leftover PCM byte discarded at end of stream");
    }

    Ok(())
}

/// Convert a chunk of raw bytes into 16-bit PCM samples. Pure function:
/// no I/O, no locks. Carries a single odd-length byte across chunk
/// boundaries via `leftover_byte` so we never split a 16-bit sample.
///
/// Returns the decoded samples (may be empty if input + leftover is
/// odd-length and 1 byte short of a sample).
fn decode_pcm_chunk(chunk: &[u8], leftover_byte: &mut Option<u8>) -> Vec<i16> {
    if chunk.is_empty() && leftover_byte.is_none() {
        return Vec::new();
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(chunk.len() + 1);
    if let Some(b) = leftover_byte.take() {
        bytes.push(b);
    }
    bytes.extend_from_slice(chunk);
    let usable_len = bytes.len() & !1; // round down to even
    if usable_len < bytes.len() {
        *leftover_byte = Some(bytes[bytes.len() - 1]);
    }
    if usable_len == 0 {
        return Vec::new();
    }
    let mut samples: Vec<i16> = Vec::with_capacity(usable_len / 2);
    for pair in bytes[..usable_len].chunks_exact(2) {
        // GPT-SoVITS api.py emits little-endian s16 PCM (matches the
        // server's INFO log: "数据类型: int16").
        samples.push(i16::from_le_bytes([pair[0], pair[1]]));
    }
    samples
}

/// Convert a chunk of raw bytes into 16-bit PCM samples and push them to
/// the player. Carries a single odd-length byte across chunk boundaries
/// so we never split a 16-bit sample.
fn push_pcm_chunk(chunk: &[u8], leftover_byte: &mut Option<u8>) -> Result<(), String> {
    let samples = decode_pcm_chunk(chunk, leftover_byte);
    if samples.is_empty() {
        return Ok(());
    }

    let lock = tts_player_lock();
    let mut guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    guard
        .push_pcm_samples(samples)
        .map_err(|e| format!("PCM push error: {e}{}", server_log_excerpt()))?;
    Ok(())
}

#[derive(Debug)]
struct ParsedWavHeader {
    sample_rate: u32,
    channels: u16,
    /// Byte offset within the input buffer where the PCM `data` sub-chunk
    /// payload starts (i.e. just past the 8-byte "data" + size header).
    data_offset: usize,
}

/// Parse a WAV/RIFF header to find the PCM data offset and format.
///
/// Returns `Some(ParsedWavHeader)` when we have enough bytes to locate the
/// `data` sub-chunk. Returns `None` if the header is incomplete (caller
/// should keep reading more bytes).
///
/// Only supports PCM (audio_format == 1) with 16 bits per sample, which is
/// what GPT-SoVITS api.py always emits. We surface clear errors for
/// anything else so future format changes are debuggable.
fn parse_wav_header(buf: &[u8]) -> Option<ParsedWavHeader> {
    // Smallest possible: RIFF(4) + size(4) + WAVE(4) + fmt header(8) +
    // fmt body(16) + data header(8) = 44 bytes.
    if buf.len() < 12 {
        return None;
    }
    if &buf[0..4] != b"RIFF" || &buf[8..12] != b"WAVE" {
        // Not a WAV — no point waiting for more bytes.
        // Returning Some with bogus data_offset would mislead the caller;
        // returning None lets the bytes-budget check eventually trip.
        return None;
    }
    // Walk sub-chunks: each is 4-byte id + 4-byte little-endian size + body.
    let mut pos: usize = 12;
    let mut sample_rate: Option<u32> = None;
    let mut channels: Option<u16> = None;
    while pos + 8 <= buf.len() {
        let id = &buf[pos..pos + 4];
        let size =
            u32::from_le_bytes([buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = body_start.checked_add(size)?;
        if id == b"fmt " {
            // Need at least the 16-byte canonical fmt body to extract
            // channels + sample rate.
            if body_end > buf.len() || size < 16 {
                return None;
            }
            // WAV fmt chunk body (canonical 16-byte PCM):
            //   +0: audio_format (u16) → should be 1 for PCM
            //   +2: num_channels (u16)
            //   +4: sample_rate  (u32)
            channels = Some(u16::from_le_bytes([
                buf[body_start + 2],
                buf[body_start + 3],
            ]));
            sample_rate = Some(u32::from_le_bytes([
                buf[body_start + 4],
                buf[body_start + 5],
                buf[body_start + 6],
                buf[body_start + 7],
            ]));
            pos = body_end;
        } else if id == b"data" {
            // Found the data chunk. Even if `size` extends past what we've
            // received so far (chunked transfer in flight), the OFFSET to
            // the start of the PCM payload is fixed.
            return match (sample_rate, channels) {
                (Some(rate), Some(ch)) => Some(ParsedWavHeader {
                    sample_rate: rate,
                    channels: ch,
                    data_offset: body_start,
                }),
                _ => None, // saw `data` before `fmt ` — malformed, treat as not-yet
            };
        } else {
            // Unknown sub-chunk (LIST, fact, etc) — skip it.
            if body_end > buf.len() {
                return None; // need more bytes to skip past it
            }
            pos = body_end;
        }
    }
    None
}

/// Pull recent log lines from the running TTS server (if any) so we can
/// surface them to the user when synthesis fails. Returns an empty string
/// when the server isn't running or has no logs yet.
fn server_log_excerpt() -> String {
    let lock = tts_server_lock();
    let Ok(guard) = lock.lock() else {
        return String::new();
    };
    let Some(srv) = guard.as_ref() else {
        return String::new();
    };
    let logs = srv.recent_log_excerpt(40);
    if logs.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\n────── recent server log ──────\n{}\n──────────────────────────────",
            logs.trim()
        )
    }
}

#[tauri::command]
pub fn tts_stop_playback() -> Result<(), String> {
    SYNTHESIS_CANCELLED.store(true, Ordering::Relaxed);
    ws::clear_reorder_buffer();
    let lock = tts_player_lock();
    let mut guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    guard.stop();
    Ok(())
}

// ---- Voice file management ----

/// Validate that a voice file path resolves inside the given voices root.
/// The path is canonicalized so symlinks and `..` components are resolved
/// before the bounds check. When `must_exist` is true the file must already
/// be present on disk (read path); when false it may not exist yet (write
/// path — the parent directory is checked instead).
fn validate_voice_path_in(
    file_path: &str,
    voices_root: &Path,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let path = Path::new(file_path);

    if file_path.is_empty() {
        return Err("Voice file path is empty".to_string());
    }

    if must_exist {
        let meta = path
            .metadata()
            .map_err(|e| format!("Cannot access voice file: {e}"))?;
        if !meta.is_file() {
            return Err("Voice path is not a regular file".to_string());
        }
    }

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid voice file path: {e}"))?;

    let voices = voices_root
        .canonicalize()
        .map_err(|_| "Voices directory is not accessible".to_string())?;

    if !canonical.starts_with(&voices) {
        return Err("Voice file path is outside the allowed voices directory".to_string());
    }

    if !must_exist {
        if let Some(parent) = canonical.parent() {
            if !parent.starts_with(&voices) {
                return Err("Voice file parent is outside the allowed voices directory".to_string());
            }
        }
    }

    Ok(canonical)
}

fn validate_voice_path(file_path: &str, must_exist: bool) -> Result<PathBuf, String> {
    validate_voice_path_in(file_path, &voices_dir(), must_exist)
}

/// Allow only alphanumeric characters, underscores, and hyphens in character
/// IDs that are used as filename components. Length is clamped to 1..64.
fn sanitize_character_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 64 {
        return Err("Character ID must be 1-64 characters".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(
            "Character ID contains invalid characters (only A-Z, a-z, 0-9, _, - allowed)"
                .to_string(),
        );
    }
    Ok(id)
}

#[tauri::command]
pub fn tts_save_voice_file(
    character_id: String,
    base64_data: String,
    extension: String,
) -> Result<String, String> {
    sanitize_character_id(&character_id)?;

    let dir = voices_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create voices dir: {e}"))?;

    let ext_lower = extension.to_lowercase();
    if ext_lower.is_empty()
        || ext_lower.len() > 16
        || !ext_lower.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err("Invalid file extension".to_string());
    }

    let filename = format!("{character_id}_ref.{ext_lower}");
    let path = dir.join(&filename);

    // Decode base64 (strip data URL prefix if present).
    let b64 = if let Some(idx) = base64_data.find(";base64,") {
        &base64_data[idx + 8..]
    } else {
        &base64_data
    };
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Base64 decode error: {e}"))?;

    std::fs::write(&path, &bytes).map_err(|e| format!("Write error: {e}"))?;

    let validated = validate_voice_path(&path.to_string_lossy(), false)?;

    // Convert non-WAV uploads to WAV so soundfile can read them.
    if ext_lower != "wav" {
        let wav_path = dir.join(format!("{character_id}_ref.wav"));
        if let Err(e) = convert_to_wav(validated.as_path(), &wav_path) {
            eprintln!("Voice file conversion to WAV failed: {e}");
            return Ok(validated.to_string_lossy().to_string());
        }
        let _ = std::fs::remove_file(&validated);
        let wav_validated = validate_voice_path(&wav_path.to_string_lossy(), true)?;
        return Ok(wav_validated.to_string_lossy().to_string());
    }

    Ok(validated.to_string_lossy().to_string())
}

#[tauri::command]
pub fn tts_read_voice_file(file_path: String) -> Result<String, String> {
    let safe_path = validate_voice_path(&file_path, true)?;

    let bytes = std::fs::read(&safe_path).map_err(|e| format!("Cannot read voice file: {e}"))?;
    use base64::Engine;
    let lower = safe_path.to_string_lossy().to_ascii_lowercase();
    let mime = if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".m4a") {
        "audio/mp4"
    } else if lower.ends_with(".aac") {
        "audio/aac"
    } else {
        "audio/wav"
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

// ---- Install ----

#[tauri::command]
pub fn tts_install(app_handle: tauri::AppHandle, source: Option<String>) -> Result<(), String> {
    std::thread::spawn(move || {
        installer::install(app_handle, source);
    });
    Ok(())
}

#[tauri::command]
pub fn tts_install_cancel() -> Result<(), String> {
    installer::cancel();
    Ok(())
}

// ---- Fine-tuning ----

/// Start fine-tuning a voice model for the given character.
///
/// `train_audio_dir` must contain WAV files (3-5 minutes total) of the
/// target speaker. Training runs in a background thread and emits
/// `tts-finetune-progress`, `tts-finetune-done`, and `tts-finetune-error`
/// events.
#[tauri::command]
pub fn tts_finetune_start(
    app_handle: tauri::AppHandle,
    character_id: String,
    train_audio_dir: String,
) -> Result<(), String> {
    sanitize_character_id(&character_id)?;
    finetune::start_finetune(app_handle, character_id, PathBuf::from(train_audio_dir))
}

/// Collect all training recordings for a character and start fine-tuning.
#[tauri::command]
pub fn tts_finetune_collect_and_start(
    app_handle: tauri::AppHandle,
    character_id: String,
) -> Result<(), String> {
    sanitize_character_id(&character_id)?;
    finetune::collect_and_start_finetune(app_handle, character_id)
}

#[tauri::command]
pub fn tts_finetune_cancel() -> Result<(), String> {
    finetune::cancel();
    Ok(())
}

/// Returns the path to the fine-tuned model for a character, or None.
#[tauri::command]
pub fn tts_finetune_status(character_id: String) -> Result<Option<String>, String> {
    sanitize_character_id(&character_id)?;
    Ok(finetune::check_finetune_status(&character_id))
}

/// Check whether training data (metadata.list + WAV files) exists for a character.
#[tauri::command]
pub fn tts_check_training_data_exists(character_id: String) -> Result<bool, String> {
    sanitize_character_id(&character_id)?;
    let meta = voices_dir()
        .join(&character_id)
        .join("train")
        .join("metadata.list");
    Ok(meta.exists())
}

/// Resolve the SoVITS model path for a character.
///
/// If a fine-tuned model exists at `~/.codepapr/voices/{character_id}/exp/{character_id}/s2Gv4.pth`,
/// returns that path. Otherwise returns None (caller should use the default pretrained model).
#[allow(dead_code)]
fn resolve_character_model(character_id: &str) -> Option<String> {
    finetune::check_finetune_status(&character_id)
}

// ---- Training data generation ----

/// Predefined Chinese script (~500 chars, ~2 minutes spoken) covering
/// diverse phonemes for voice fine-tuning.
const TRAINING_SCRIPT: &str = "\
春天的风轻轻吹过湖面，带来泥土和花草的清香。\
远处的山峦在薄雾中若隐若现，像一幅淡雅的水墨画。\
我站在小桥上，看着水中的倒影随风摇摆。\
这个城市有我太多的回忆了，每一条街道都写满了故事。\
你知道吗？有时候最简单的答案反而最容易被忽略。\
他拿出手机看了一眼时间，然后匆匆走出了咖啡馆。\
今天的天气真不错，我们一起去公园散步吧。\
学习新知识需要耐心和坚持，但不能一味地死记硬背。\
窗外传来孩子们嬉笑的声音，让人忍不住想加入他们。\
这本书我已经读了三遍了，每次都有新的体会和感悟。\
科技的进步正在改变我们生活的方方面面，从出行到购物。\
你还记得我们第一次见面的那天吗？下着蒙蒙细雨。\
河水静静地流淌，仿佛在诉说着千百年来的往事。\
我决定从今天开始，每天早起半小时锻炼身体。\
这道菜的做法很简单，先把配料准备好，然后大火快炒。\
音乐是人类共同的语言，不管来自哪个国家都能被感动。\
夜幕降临后，整座城市的灯火逐渐亮了起来。\
她说她喜欢秋天，因为秋天既不热也不冷，刚刚好。\
请大家注意安全，乘车时系好安全带，走路不要看手机。\
人生就像一场旅行，不在乎目的地，在乎的是沿途的风景。";

#[derive(Clone, serde::Serialize)]
struct GenerateProgress {
    character_id: String,
    current: usize,
    total: usize,
    sentence: String,
}

/// Split text into sentences while preserving the original punctuation.
/// Delimiter characters: 。 ！ ？ ! ? . \n
/// Sentences that end without any delimiter get a language-appropriate
/// ending: "." for en/ko, "。" for CJK languages.
fn split_sentences(text: &str, lang: &str) -> Vec<String> {
    const ENDINGS: &[char] = &['。', '！', '？', '!', '?', '.', '\n'];
    let fallback_punct = if matches!(lang, "en" | "all_ko" | "ko") {
        "."
    } else {
        "。"
    };
    let mut sentences = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if ENDINGS.contains(&ch) {
            let trimmed = current.trim().to_string();
            // Drop fragments that are only a terminator (e.g. from "。。" or
            // "..") — symmetric for the CJK full stop and the ASCII period.
            if !trimmed.is_empty() && trimmed != "." && trimmed != "。" {
                sentences.push(trimmed);
            }
            current.clear();
        }
    }
    let remaining = current.trim().to_string();
    if !remaining.is_empty() {
        sentences.push(format!("{remaining}{fallback_punct}"));
    }
    sentences
}

/// Generate training data by synthesising a script with the current
/// reference voice. Each sentence is saved as a WAV file to
/// `~/.codepapr/voices/{character_id}/train/`. Progress is reported
/// via `tts-generate-progress` events.
///
/// If `custom_script` is provided, it is used as the training script
/// (split into sentences by punctuation). Otherwise a default Chinese
/// script is used.
///
/// If training data already exists, it is reused unless `force` is true.
#[tauri::command]
pub fn tts_generate_training_data(
    app_handle: tauri::AppHandle,
    character_id: String,
    ref_audio_path: String,
    prompt_text: String,
    prompt_language: String,
    training_language: Option<String>,
    custom_script: Option<String>,
    force: Option<bool>,
) -> Result<(), String> {
    sanitize_character_id(&character_id)?;
    {
        let lock = tts_server_lock();
        let guard = lock.lock().map_err(|e| format!("Lock error: {e}"))?;
        if !guard.as_ref().map_or(false, |s| s.is_running()) {
            return Err("TTS server is not running.".to_string());
        }
    }

    let train_dir = voices_dir().join(&character_id).join("train");
    let meta_path = train_dir.join("metadata.list");

    // Reuse existing training data unless force is set
    if meta_path.exists() && !force.unwrap_or(false) {
        let count = std::fs::read_to_string(&meta_path)
            .map(|s| s.lines().count())
            .unwrap_or(0);
        // Emit done immediately with existing data
        let app = app_handle.clone();
        let cid = character_id.clone();
        let train_dir_str = train_dir.to_string_lossy().to_string();
        std::thread::spawn(move || {
            let _ = app.emit(
                "tts-generate-done",
                serde_json::json!({
                    "character_id": cid,
                    "train_dir": train_dir_str,
                    "count": count,
                    "reused": true,
                }),
            );
        });
        return Ok(());
    }

    let _ = std::fs::create_dir_all(&train_dir);

    // Use custom script if provided, otherwise default
    let script = custom_script.unwrap_or_else(|| TRAINING_SCRIPT.to_string());

    let text_lang = training_language.unwrap_or_else(|| "all_zh".to_string());

    // Split script into sentences, preserving original punctuation.
    let sentences: Vec<String> = split_sentences(&script, &text_lang);

    if !std::path::Path::new(&ref_audio_path).exists() {
        return Err(format!("参考音频文件不存在: {ref_audio_path}"));
    }

    let ref_prompt_trimmed = prompt_text.trim().to_string();
    if ref_prompt_trimmed.is_empty() {
        return Err("参考音频对应的文本不能为空，请在角色设置中填写".to_string());
    }

    if sentences.is_empty() {
        return Err("训练脚本中没有可用的句子".to_string());
    }

    let total = sentences.len();
    let cid = character_id.clone();
    let app = app_handle.clone();
    let ref_path = ref_audio_path.clone();
    let ref_prompt = ref_prompt_trimmed;
    let ref_lang = prompt_language.clone();

    std::thread::spawn(move || {
        let base_url = GptSovitsServer::api_base_url();
        let client = tts_client();
        let mut metadata_lines: Vec<String> = Vec::new();
        let mut failed_count: u32 = 0;
        let clean_lang = normalize_lang_code(&text_lang);

        for (i, sentence) in sentences.iter().enumerate() {
            let _ = app.emit(
                "tts-generate-progress",
                GenerateProgress {
                    character_id: cid.clone(),
                    current: i + 1,
                    total,
                    sentence: sentence.clone(),
                },
            );

            let resp = client
                .get(&base_url)
                .query(&[
                    ("text", sentence.as_str()),
                    ("text_language", text_lang.as_str()),
                    ("refer_wav_path", ref_path.as_str()),
                    ("prompt_text", ref_prompt.as_str()),
                    ("prompt_language", ref_lang.as_str()),
                    ("sample_steps", "8"),
                    ("speed_factor", "1.00"),
                ])
                .send();

            match resp {
                Ok(mut r) if r.status().is_success() => {
                    let mut bytes = Vec::new();
                    if r.copy_to(&mut bytes).is_ok() && bytes.len() >= 44 {
                        let filename = format!("{:03}.wav", i);
                        let path = train_dir.join(&filename);
                        let _ = std::fs::write(&path, &bytes);
                        // metadata.list 以 | 分列：句子里的 | 会破坏训练数据
                        // 格式，换成全角；控制字符一并剔除。
                        let safe_sentence: String = sentence
                            .chars()
                            .map(|ch| if ch == '|' { '｜' } else { ch })
                            .filter(|ch| !ch.is_control())
                            .collect();
                        metadata_lines.push(format!("{filename}|default|{clean_lang}|{safe_sentence}"));
                    }
                }
                _ => {
                    failed_count += 1;
                }
            }
        }

        if !metadata_lines.is_empty() {
            let meta_path = train_dir.join("metadata.list");
            let _ = std::fs::write(&meta_path, metadata_lines.join("\n"));
        }

        let actual_count = metadata_lines.len();
        let _ = app.emit(
            "tts-generate-done",
            serde_json::json!({
                "character_id": cid,
                "train_dir": train_dir.to_string_lossy(),
                "count": actual_count,
                "failed_count": failed_count,
                "error": if actual_count == 0 && failed_count > 0 {
                    "所有句子合成失败，请检查参考音频和文本是否正确配置"
                } else { "" },
            }),
        );
    });

    Ok(())
}
