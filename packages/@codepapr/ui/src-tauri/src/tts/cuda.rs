use codepapr_core::shell::process_tree::background_command;
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const TORCH_VERSION: &str = "2.11.0";

pub(crate) struct CudaSetup {
    wheel_tag: &'static str,
    stamp: String,
}

impl CudaSetup {
    pub(crate) fn pending(venv: &Path) -> Option<Self> {
        if !cfg!(target_arch = "x86_64") {
            return None;
        }
        let output = background_command("nvidia-smi")
            .args(["--query-gpu=driver_version", "--format=csv,noheader"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let driver = std::str::from_utf8(&output.stdout).ok()?.lines().next()?.trim();
        let (major, minor) = driver.split_once('.')?;
        let version = (major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?);
        let wheel_tag = if version >= (580, 0) {
            "cu130"
        } else if version >= (570, 65) {
            "cu128"
        } else {
            return None;
        };
        let stamp = format!("{TORCH_VERSION}:{wheel_tag}:{driver}");
        if fs::read_to_string(venv.join(".codepapr_cuda_attempt")).ok().as_deref() == Some(stamp.as_str()) {
            return None;
        }
        Some(Self { wheel_tag, stamp })
    }

    pub(crate) fn install_command(&self, python: &Path, venv: &Path) -> Command {
        let mut cmd = background_command(python);
        cmd.args([
            "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
            "--upgrade", "--no-deps", "--timeout", "30", "--retries", "2", "--index-url",
            &format!("https://download.pytorch.org/whl/{}", self.wheel_tag),
        ])
        .args([
            format!("torch=={TORCH_VERSION}+{}", self.wheel_tag),
            format!("torchaudio=={TORCH_VERSION}+{}", self.wheel_tag),
        ])
        .arg("--target")
        .arg(cuda_packages(venv));
        cmd
    }

    pub(crate) fn record_attempt(&self, venv: &Path) -> io::Result<()> {
        fs::write(venv.join(".codepapr_cuda_attempt"), &self.stamp)
    }
}

fn cuda_packages(venv: &Path) -> PathBuf {
    venv.join("codepapr-cuda")
}

pub(crate) fn configure_python(cmd: &mut Command, venv: &Path) {
    // Keep the CUDA wheels separate so even a failed or interrupted download
    // leaves the default Python packages available for the CPU fallback.
    let packages = cuda_packages(venv);
    if packages.join("torch").is_dir() {
        let inherited = env::var_os("PYTHONPATH").unwrap_or_default();
        if let Ok(path) = env::join_paths(std::iter::once(packages).chain(env::split_paths(&inherited))) {
            cmd.env("PYTHONPATH", path);
        }
    }
}

pub(crate) fn is_usable(python: &Path, venv: &Path) -> bool {
    if !python.is_file() {
        return false;
    }
    let mut cmd = background_command(python);
    configure_python(&mut cmd, venv);
    cmd.args([
        "-c",
        "import torch, torchaudio; x = torch.ones(1, device='cuda', dtype=torch.float16); (x + 1).item()",
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .is_ok_and(|status| status.success())
}
