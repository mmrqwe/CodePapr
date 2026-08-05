use std::path::Path;
use std::time::Duration;

/// 锁文件存活超过该阈值才视为崩溃残留。正常的 stage/commit/snapshot 操作秒级
/// 完成，远小于此值。
pub(crate) const GIT_LOCK_STALE_AFTER: Duration = Duration::from_secs(300);

/// 仅清理「可证明陈旧」的 git 锁文件：正常的 stage/commit/snapshot 操作秒级完成，
/// 锁文件存活超过该阈值才视为崩溃残留予以删除。旧实现每次打开仓库都无条件
/// 删除全部锁文件——两个操作并发时（双实例、快照撞提交）会把另一个操作正在
/// 使用的活锁删掉，导致 index/ref 写到一半被破坏。锁删掉后 libgit2 自身的
/// index.lock 机制即可保护并发写入者互斥。
pub(crate) fn remove_stale_git_locks(dot_git: &Path) {
    for lock_name in &["config.lock", "index.lock", "HEAD.lock", "packed-refs.lock"] {
        let lock_file = dot_git.join(lock_name);
        let Ok(meta) = std::fs::metadata(&lock_file) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified.elapsed().is_ok_and(|age| age >= GIT_LOCK_STALE_AFTER) {
            let _ = std::fs::remove_file(&lock_file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dot_git(label: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "codepapr-gitlocks-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        fs::create_dir_all(&path).unwrap();
        path
    }

    // P2-34 的核心安全保证：刚创建的活锁（并发操作正在使用）绝不能被删。
    // 旧实现无条件删除，会在并发时破坏写到一半的 index/ref。
    #[test]
    fn fresh_lock_files_are_preserved() {
        let dot_git = temp_dot_git("fresh");
        for name in &["config.lock", "index.lock", "HEAD.lock", "packed-refs.lock"] {
            fs::write(dot_git.join(name), "locked").unwrap();
        }

        remove_stale_git_locks(&dot_git);

        for name in &["config.lock", "index.lock", "HEAD.lock", "packed-refs.lock"] {
            assert!(
                dot_git.join(name).exists(),
                "新建的活锁 {name} 不应被删除"
            );
        }
        fs::remove_dir_all(&dot_git).ok();
    }

    // 把 mtime 回拨到阈值之前，验证陈旧锁会被清理。
    #[cfg(unix)]
    #[test]
    fn stale_lock_files_are_removed() {
        let dot_git = temp_dot_git("stale");
        let lock = dot_git.join("index.lock");
        fs::write(&lock, "locked").unwrap();

        // 将 mtime 回拨 (STALE_AFTER + 60)s
        let path_cstr =
            std::ffi::CString::new(lock.to_string_lossy().as_ref()).unwrap();
        let backdate = (GIT_LOCK_STALE_AFTER.as_secs() + 60) as i64;
        unsafe {
            let now = libc::time(std::ptr::null_mut());
            let old = libc::timeval { tv_sec: now - backdate, tv_usec: 0 };
            let times = [old, old];
            libc::utimes(path_cstr.as_ptr(), times.as_ptr());
        }

        remove_stale_git_locks(&dot_git);
        assert!(!lock.exists(), "陈旧锁应被清理");
        fs::remove_dir_all(&dot_git).ok();
    }
}
