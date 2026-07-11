use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// A temporary workspace directory that is automatically cleaned up on drop.
pub(crate) struct TestWorkspace {
    pub(crate) path: PathBuf,
}

impl TestWorkspace {
    pub(crate) fn new(label: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("codepapr-{label}-{unique}-{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("should create test workspace");
        Self { path }
    }

    pub(crate) fn file_path(&self, relative: &str) -> PathBuf {
        self.path.join(relative)
    }

    pub(crate) fn workspace_arg(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
