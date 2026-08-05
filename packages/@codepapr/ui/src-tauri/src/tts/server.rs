use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::blocking::Client;
use tauri::{AppHandle, Emitter};

pub(crate) const GPT_SOVITS_API_PORT: u16 = 9880;
const HEALTH_CHECK_TIMEOUT_SECS: u64 = 90;
const HEALTH_CHECK_INTERVAL_MS: u64 = 500;
const LOG_BUFFER_MAX_LINES: usize = 1000;

pub(crate) struct GptSovitsServer {
    child: Option<Arc<Mutex<Child>>>,
    python_path: Option<String>,
    api_path: PathBuf,
    running: bool,
    log_buffer: Arc<Mutex<VecDeque<String>>>,
    /// The model version the server reported from its startup log
    /// ("v1", "v2", "v3", "v4"). Empty until parsed from logs.
    model_version: String,
    /// Whether the server is running in half precision mode.
    half_precision: bool,
}

/// Model version preference for server startup.
/// `"v4"` loads the v4 pretrained SoVITS + s1v3 GPT (default, recommended).
/// `"v1"` loads the legacy v1 pretrained models.
pub(crate) const MODEL_VERSION_V4: &str = "v4";
#[allow(dead_code)]
pub(crate) const MODEL_VERSION_V1: &str = "v1";

impl GptSovitsServer {
    pub(crate) fn new(api_path: PathBuf) -> Self {
        Self {
            child: None,
            python_path: None,
            api_path,
            running: false,
            log_buffer: Arc::new(Mutex::new(VecDeque::new())),
            model_version: String::new(),
            half_precision: false,
        }
    }

    pub(crate) fn model_version(&self) -> &str {
        &self.model_version
    }

    pub(crate) fn half_precision(&self) -> bool {
        self.half_precision
    }

    pub(crate) fn start(&mut self, app_handle: Option<AppHandle>, device: &str, model_version: &str) -> Result<(), String> {
        if self.child.is_some() {
            return Err("TTS server is already running".to_string());
        }

        let python = self.detect_python()?;
        self.python_path = Some(python.clone());

        if !self.api_path.join("api.py").is_file() {
            return Err(format!(
                "api.py not found at {}. Please ensure GPT-SoVITS is installed.",
                self.api_path.display()
            ));
        }

        let mut cmd = Command::new(&python);
        cmd.arg("api.py")
            .arg("-p")
            .arg(GPT_SOVITS_API_PORT.to_string())
            .arg("-a")
            // 只绑回环地址：所有客户端调用都走 127.0.0.1，绑 0.0.0.0 会把
            // GPT-SoVITS API（含 /set_model 等接受文件路径的端点）暴露给局域网。
            .arg("127.0.0.1")
            .arg("-d")
            .arg(device)
            .current_dir(&self.api_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Load pretrained models based on the requested version.
        if model_version == MODEL_VERSION_V4 {
            let sovits_v4 = self.api_path.join("GPT_SoVITS/pretrained_models/gsv-v4-pretrained/s2Gv4.pth");
            if sovits_v4.exists() {
                cmd.arg("-s").arg(&sovits_v4);
            }
            let gpt_v3 = self.api_path.join("GPT_SoVITS/pretrained_models/s1v3.ckpt");
            if gpt_v3.exists() {
                cmd.arg("-g").arg(&gpt_v3);
            }
        } else {
            // v1: use the legacy pretrained models.
            let sovits_v1 = self.api_path.join("GPT_SoVITS/pretrained_models/s2G488k.pth");
            if sovits_v1.exists() {
                cmd.arg("-s").arg(&sovits_v1);
            }
            let gpt_v1 = self.api_path.join("GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt");
            if gpt_v1.exists() {
                cmd.arg("-g").arg(&gpt_v1);
            }
        }

        // Force half precision for ~2x faster synthesis on all devices.
        cmd.arg("-hp");

        // Force unbuffered Python stdout/stderr so we get logs in real time.
        cmd.env("PYTHONUNBUFFERED", "1");
        // Enable MPS fallback for ops not supported on MPS.
        cmd.env("PYTORCH_ENABLE_MPS_FALLBACK", "1");
        // Suppress tokenizers parallelism warning.
        cmd.env("TOKENIZERS_PARALLELISM", "false");

        // Set LD_LIBRARY_PATH for ffmpeg shared libs if available.
        for lib_dir in &[
            "/opt/homebrew/opt/ffmpeg@6/lib",
            "/opt/homebrew/opt/ffmpeg@7/lib",
            "/opt/homebrew/opt/ffmpeg@5/lib",
        ] {
            if std::path::Path::new(lib_dir).exists() {
                cmd.env("DYLD_LIBRARY_PATH", lib_dir);
                break;
            }
        }

        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to start GPT-SoVITS server: {e}"))?;

        // Reset log buffer for the new process.
        if let Ok(mut buf) = self.log_buffer.lock() {
            buf.clear();
            buf.reserve(LOG_BUFFER_MAX_LINES);
        }

        // Spawn reader threads that pump stdout & stderr into a shared buffer
        // and emit each line as a `tts-server-log` event.
        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(stdout, "stdout", self.log_buffer.clone(), app_handle.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(stderr, "stderr", self.log_buffer.clone(), app_handle.clone());
        }

        let child_arc = Arc::new(Mutex::new(child));
        self.child = Some(child_arc);
        self.wait_healthy(HEALTH_CHECK_TIMEOUT_SECS)?;
        self.running = true;

        // Parse startup logs for model version and precision mode.
        // GPT-SoVITS logs lines like "INFO:     模型版本: v4" and "INFO:     半精: True".
        self.parse_startup_info();

        // Watchdog: poll the child process directly via try_wait so PID
        // reuse cannot cause false-alive detection.
        if let Some(app) = app_handle {
            let watchdog_child = Arc::clone(self.child.as_ref().unwrap());
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(2));
                    let exited = match watchdog_child.lock() {
                        Ok(mut c) => c.try_wait().is_ok_and(|s| s.is_some()),
                        Err(_) => true,
                    };
                    if exited {
                        let _ = app.emit("tts-server-stopped", ());
                        break;
                    }
                }
            });
        }

        Ok(())
    }

    pub(crate) fn stop(&mut self) -> Result<(), String> {
        self.running = false;
        let child_arc = match self.child.take() {
            Some(c) => c,
            None => return Ok(()),
        };

        let mut child = match child_arc.lock() {
            Ok(c) => c,
            Err(_) => {
                self.python_path = None;
                return Ok(());
            }
        };

        let _ = child.kill();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }

        self.python_path = None;
        Ok(())
    }

    pub(crate) fn is_running(&self) -> bool {
        self.running
    }

    pub(crate) fn check_alive(&mut self) -> bool {
        if !self.running && self.child.is_none() {
            return false;
        }
        if let Some(ref child_arc) = self.child {
            match child_arc.lock() {
                Ok(mut child) => match child.try_wait() {
                    Ok(Some(_)) => {
                        self.running = false;
                        false
                    }
                    Ok(None) => true,
                    Err(_) => false,
                },
                Err(_) => {
                    self.running = false;
                    false
                }
            }
        } else {
            false
        }
    }

    pub(crate) fn health_check(&self) -> Result<(), String> {
        let url = format!("http://127.0.0.1:{GPT_SOVITS_API_PORT}/?text=&text_language=zh");
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;

        let _resp = client
            .get(&url)
            .send()
            .map_err(|e| format!("Health check failed: {e}"))?;
        // Any HTTP response means the server is alive and accepting connections.
        Ok(())
    }

    pub(crate) fn api_base_url() -> String {
        format!("http://127.0.0.1:{GPT_SOVITS_API_PORT}")
    }

    fn wait_healthy(&mut self, timeout_secs: u64) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        let mut last_err = String::new();

        while Instant::now() < deadline {
            if !self.check_alive() {
                // Give reader threads a moment to flush remaining output.
                std::thread::sleep(Duration::from_millis(300));
                let captured = self.captured_logs();
                let trimmed = captured.trim();
                if trimmed.is_empty() {
                    return Err(
                        "Server process exited unexpectedly with no error output. \
                         The Python install may be broken — try reinstalling via the installer.".to_string()
                    );
                }
                return Err(format!(
                    "Server process exited unexpectedly. Output:\n────\n{trimmed}\n────"
                ));
            }

            match self.health_check() {
                Ok(()) => return Ok(()),
                Err(e) => last_err = e,
            }

            std::thread::sleep(Duration::from_millis(HEALTH_CHECK_INTERVAL_MS));
        }

        // Timeout — surface whatever the server logged.
        let captured = self.captured_logs();
        let captured_trimmed = captured.trim();
        if !captured_trimmed.is_empty() {
            return Err(format!(
                "Server did not become healthy within {timeout_secs}s.\n\
                 Last health check error: {last_err}\n\
                 Server output:\n────\n{captured_trimmed}\n────"
            ));
        }
        Err(format!(
            "Server did not become healthy within {timeout_secs}s. Last error: {last_err}"
        ))
    }

    /// Parse the startup log to extract model version and precision mode.
    /// Called after `wait_healthy` succeeds.
    fn parse_startup_info(&mut self) {
        let logs = self.captured_logs();
        for line in logs.lines() {
            let trimmed = line.trim();
            // Match "模型版本: v4" or "模型版本: v1"
            if trimmed.contains("模型版本:") {
                if let Some(pos) = trimmed.rfind(':') {
                    let ver = trimmed[pos + 1..].trim().to_lowercase();
                    if !ver.is_empty() {
                        self.model_version = ver;
                    }
                }
            }
            // Match "半精: True" or "半精: False"
            if trimmed.contains("半精:") {
                if trimmed.contains("true") || trimmed.contains("True") {
                    self.half_precision = true;
                } else {
                    self.half_precision = false;
                }
            }
        }
    }

    fn captured_logs(&self) -> String {
        self.log_buffer
            .lock()
            .map(|buf| {
                let mut s = String::with_capacity(buf.len() * 128);
                for line in buf.iter() {
                    s.push_str(line);
                    s.push('\n');
                }
                s
            })
            .unwrap_or_default()
    }

    /// Returns the last `max_lines` lines from the server log buffer.
    /// Used by error messages elsewhere in the module to surface the real
    /// Python traceback alongside whatever generic transport error reqwest
    /// reports.
    pub(crate) fn recent_log_excerpt(&self, max_lines: usize) -> String {
        let buf = match self.log_buffer.lock() {
            Ok(g) => {
                let start = g.len().saturating_sub(max_lines);
                let range = g.range(start..);
                let mut s = String::new();
                for line in range {
                    s.push_str(line);
                    s.push('\n');
                }
                s
            }
            Err(_) => return String::new(),
        };
        buf
    }

    fn detect_python(&self) -> Result<String, String> {
        // 1) Prefer venv python created by the installer (if it's compatible).
        let venv_candidates = if cfg!(target_os = "windows") {
            vec![
                self.api_path.join(".codepapr_venv").join("Scripts").join("python.exe"),
            ]
        } else {
            vec![
                self.api_path.join(".codepapr_venv").join("bin").join("python3"),
                self.api_path.join(".codepapr_venv").join("bin").join("python"),
            ]
        };
        for path in &venv_candidates {
            if crate::tts::installer::venv_python_is_compatible(path) {
                return Ok(path.to_string_lossy().to_string());
            }
        }

        // 2) Fall back to system Python — but use the same strict version check
        //    as the installer (Python 3.10+ required) to avoid using Apple's 3.9.
        let candidates = crate::tts::installer::collect_python_candidates();
        for path in &candidates {
            if let Some((major, minor, exe)) = crate::tts::installer::probe_python_version(path) {
                let ok = major > 3 || (major == 3 && minor >= 10);
                if ok {
                    return Ok(exe);
                }
            }
        }

        Err("No compatible Python (3.10+) found. Please reinstall GPT-SoVITS via the installer.".to_string())
    }
}

impl Drop for GptSovitsServer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Pick the best PyTorch device argument for this platform.
///
/// On Apple Silicon (`aarch64` macOS) we prefer Metal Performance Shaders
/// which gives 3-5x speedup over CPU for v4 inference. Some operators may
/// fall back to CPU at runtime — that's handled by the env var
/// `PYTORCH_ENABLE_MPS_FALLBACK=1` set during process spawn.
///
/// Everywhere else (Intel macOS, Windows, Linux) we default to CPU. CUDA
/// is not auto-detected here because we don't ship a CUDA-enabled PyTorch
/// in the bundled venv; users with NVIDIA hardware can override via the
/// `device` parameter manually if they reinstall PyTorch with CUDA.
pub(crate) fn recommended_device() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "mps"
    } else {
        "cpu"
    }
}

#[derive(serde::Serialize, Clone)]
struct ServerLogPayload {
    stream: &'static str,
    line: String,
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    pipe: R,
    stream_name: &'static str,
    buffer: Arc<Mutex<VecDeque<String>>>,
    app_handle: Option<AppHandle>,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line_result in reader.lines() {
            let Ok(line) = line_result else {
                break;
            };
            // Skip internal PyTorch/model noise that isn't useful during normal operation.
            if line.is_empty() { continue; }
            if line.contains("Removing weight norm") { continue; }
            if line.contains("All keys matched successfully") { continue; }
            if line.contains("pkg_resources is deprecated") { continue; }

            if let Ok(mut buf) = buffer.lock() {
                let cur_len = buf.len();
                if cur_len >= LOG_BUFFER_MAX_LINES {
                    let trim_to = LOG_BUFFER_MAX_LINES / 2;
                    buf.drain(..cur_len.saturating_sub(trim_to));
                }
                buf.push_back(format!("[{stream_name}] {line}"));
            }
            if let Some(ref app) = app_handle {
                let _ = app.emit(
                    "tts-server-log",
                    ServerLogPayload { stream: stream_name, line: line.clone() },
                );
            }
        }
    });
}
