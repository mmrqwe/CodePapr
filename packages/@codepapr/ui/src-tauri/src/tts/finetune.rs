use std::{
    io::{BufRead, BufReader}, path::PathBuf,
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter};
use crate::tts::{default_gpt_sovits_path, voices_dir};
use crate::tts::installer::VENV_DIR_NAME;

static CANCELLED: AtomicBool = AtomicBool::new(false);
static ACTIVE_PID: Mutex<Option<u32>> = Mutex::new(None);

fn remember_child_pid(pid: u32) {
    if let Ok(mut guard) = ACTIVE_PID.lock() {
        *guard = Some(pid);
    }
}

fn clear_child_pid(pid: u32) {
    if let Ok(mut guard) = ACTIVE_PID.lock() {
        if *guard == Some(pid) {
            *guard = None;
        }
    }
}

pub(crate) fn cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
    let pid = ACTIVE_PID.lock().ok().and_then(|mut guard| guard.take());
    if let Some(pid) = pid {
        crate::shell::process_tree::kill_process_group_by_pid(pid);
    }
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct FinetuneProgress {
    pub character_id: String,
    pub step: String,
    pub percent: u8,
    pub log_line: String,
}

impl FinetuneProgress {
    fn new(character_id: &str, step: &str, percent: u8, log_line: &str) -> Self {
        Self {
            character_id: character_id.to_string(),
            step: step.to_string(),
            percent,
            log_line: log_line.to_string(),
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct FinetuneDone {
    pub character_id: String,
    pub model_path: String,
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct FinetuneError {
    pub character_id: String,
    pub error: String,
}

fn emit_progress(app: &AppHandle, cid: &str, step: &str, percent: u8, log: &str) {
    let _ = app.emit("tts-finetune-progress", FinetuneProgress::new(cid, step, percent, log));
}

pub(crate) fn start_finetune(
    app: AppHandle,
    character_id: String,
    train_audio_dir: PathBuf,
) -> Result<(), String> {
    CANCELLED.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = ACTIVE_PID.lock() {
        *guard = None;
    }

    let gpt_sovits_path = default_gpt_sovits_path();
    let venv_python = if cfg!(target_os = "windows") {
        gpt_sovits_path.join(VENV_DIR_NAME).join("Scripts").join("python.exe")
    } else {
        gpt_sovits_path.join(VENV_DIR_NAME).join("bin").join("python3")
    };

    if !venv_python.exists() {
        return Err("GPT-SoVITS not installed. Please install TTS first.".to_string());
    }

    let finetune_script = gpt_sovits_path.join("codepapr_finetune.py");
    if !finetune_script.exists() {
        return Err(format!("Fine-tuning script not found at {}", finetune_script.display()));
    }

    let output_dir = voices_dir().join(&character_id);
    let _ = std::fs::create_dir_all(&output_dir);

    let tune_dir = output_dir.join("codepapr_tune");
    if tune_dir.exists() {
        let _ = std::fs::remove_dir_all(&tune_dir);
    }

    // Relative paths like `voices/{id}/train` resolve against CWD, not
    // ~/.codepapr. Fall back to the canonical character train dir when the
    // caller didn't pass an absolute tree that already contains metadata.
    let default_train = voices_dir().join(&character_id).join("train");
    let train_audio_dir = if train_audio_dir.join("metadata.list").exists()
        || train_audio_dir.join("train").join("metadata.list").exists()
    {
        train_audio_dir
    } else {
        default_train
    };

    let train_dir = if train_audio_dir.join("metadata.list").exists() {
        train_audio_dir
    } else if train_audio_dir.join("train").join("metadata.list").exists() {
        train_audio_dir.join("train")
    } else {
        return Err("Training data must contain metadata.list. Generate training data first.".to_string());
    };

    let cid = character_id.clone();
    let app_clone = app.clone();

    thread::spawn(move || {
        let mut cmd = Command::new(&venv_python);
        cmd.arg("-u")
            .arg(&finetune_script)
            .arg("--train_dir").arg(&train_dir)
            .arg("--output_dir").arg(&output_dir)
            .arg("--epochs").arg("30")
            .arg("--batch_size").arg("1")
            .current_dir(&gpt_sovits_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.env("PYTHONUNBUFFERED", "1");
        cmd.env("PYTORCH_ENABLE_MPS_FALLBACK", "1");
        cmd.env("TOKENIZERS_PARALLELISM", "false");

        crate::shell::process_tree::prepare_new_process_group(&mut cmd);
        crate::shell::process_tree::prepare_parent_death_signal(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_clone.emit("tts-finetune-error", FinetuneError {
                    character_id: cid.clone(), error: format!("Failed to start: {e}"),
                });
                return;
            }
        };
        remember_child_pid(child.id());

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let app_out = app_clone.clone();
        let cid_out = cid.clone();
        let total_epochs: f32 = 30.0;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut base_percent: u8 = 0;
            'lines: for line in reader.lines().flatten() {
                if CANCELLED.load(Ordering::SeqCst) { break; }
                let t = line.trim();
                if t.is_empty() { continue; }
                if let Some(json_str) = t.strip_prefix("PROGRESS::") {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
                        let step = parsed.get("step").and_then(|s| s.as_str()).unwrap_or("preprocess");
                        let percent = parsed.get("percent").and_then(|p| p.as_u64()).unwrap_or(0) as u8;
                        let log_line = format!("[structured] step={step}");
                        emit_progress(&app_out, &cid_out, step, percent, &log_line);
                        continue 'lines;
                    }
                }
                if t.contains("Step 1/4") { base_percent = 0; }
                else if t.contains("Step 2/4") || t.contains("HuBERT:") { base_percent = 5; }
                else if t.contains("Step 3/4") { base_percent = 15; }
                else if t.contains("Step 4/4") { base_percent = 20; }
                else if t.contains("Epoch:") {
                    let epoch_num: f32 = t
                        .split("Epoch:")
                        .nth(1)
                        .and_then(|s| s.trim().split_whitespace().next())
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0.0);
                    let pct = 25.0 + (epoch_num / total_epochs) * 70.0;
                    base_percent = (pct as u32).min(95) as u8;
                }
                emit_progress(&app_out, &cid_out, if base_percent < 25 { "preprocess" } else { "train" }, base_percent, t);
            }
        });

        let app_err = app_clone.clone();
        let cid_err = cid.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                let t = line.trim();
                if !t.is_empty() {
                    emit_progress(&app_err, &cid_err, "train", 25, t);
                }
            }
        });

        loop {
            if CANCELLED.load(Ordering::SeqCst) {
                let pid = child.id();
                let _ = crate::shell::process_tree::kill_process_tree(&mut child);
                crate::shell::process_tree::wait_for_child_exit(
                    &mut child,
                    crate::shared::child_reap_timeout(),
                );
                clear_child_pid(pid);
                return;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    clear_child_pid(child.id());
                    if status.success() {
                        let model_path = output_dir.join("s2Gv4.pth").to_string_lossy().to_string();
                        if std::path::Path::new(&model_path).exists() {
                            let _ = app_clone.emit("tts-finetune-done", FinetuneDone {
                                character_id: cid, model_path,
                            });
                        } else {
                            let _ = app_clone.emit("tts-finetune-error", FinetuneError {
                                character_id: cid,
                                error: "Training completed but model not found. Check training output.".to_string(),
                            });
                        }
                    } else {
                        let _ = app_clone.emit("tts-finetune-error", FinetuneError {
                            character_id: cid,
                            error: format!("Training exited with code {:?}", status.code()),
                        });
                    }
                    return;
                }
                Ok(None) => thread::sleep(std::time::Duration::from_millis(200)),
                Err(e) => {
                    clear_child_pid(child.id());
                    let _ = app_clone.emit("tts-finetune-error", FinetuneError {
                        character_id: cid, error: format!("Process error: {e}"),
                    });
                    return;
                }
            }
        }
    });

    Ok(())
}

pub(crate) fn collect_and_start_finetune(
    app: AppHandle,
    character_id: String,
) -> Result<(), String> {
    let voices = voices_dir();
    let train_dir = voices.join(&character_id).join("train");
    if !train_dir.join("metadata.list").exists() {
        return Err("No training data. Generate it first.".to_string());
    }
    start_finetune(app, character_id, train_dir)
}

pub(crate) fn check_finetune_status(character_id: &str) -> Option<String> {
    let p = voices_dir().join(character_id).join("s2Gv4.pth");
    if p.exists() { Some(p.to_string_lossy().to_string()) } else { None }
}
