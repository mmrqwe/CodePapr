use std::{
    process::{Child, Command},
    time::{Duration, Instant},
};

/// 让命令在独立进程组中启动（Unix）。停止/超时时据此杀整个进程树：
/// 只杀直接子进程（shell 包装器）会让真正的工作进程（`npm run dev`、
/// `vite`、管道下游等）变成孤儿继续运行、占用端口。
#[cfg(unix)]
pub(crate) fn prepare_new_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
pub(crate) fn prepare_new_process_group(_cmd: &mut Command) {}

/// 杀进程组（无 Child 句柄版）：按 pid 对整组先 SIGTERM 再 SIGKILL。
/// 适用于只有 pid 的场景（如 CDP 浏览器主进程）。同样先 getpgid 确认
/// 该 pid 是自身进程组组长，绝不用 `kill(-pid)` 误杀调用方所在组；
/// 非组长则退回只杀该进程自身。
#[cfg(unix)]
pub(crate) fn kill_process_group_by_pid(pid: u32) {
    let pid = pid as libc::pid_t;
    let group_leader = unsafe { libc::getpgid(pid) };
    let target: libc::pid_t = if group_leader == pid { -pid } else { pid };

    let _ = unsafe { libc::kill(target, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if unsafe { libc::kill(pid, 0) } != 0 {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = unsafe { libc::kill(target, libc::SIGKILL) };
}

/// 杀进程树（仅 pid 版，Windows）：`taskkill /T /F` 递归杀整棵树，
/// 而不是只杀主进程。
#[cfg(windows)]
pub(crate) fn kill_process_group_by_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// 有界等待子进程退出：`child.wait()` 在进程处于 D 状态（不可中断）时可能无限
/// 阻塞。应用关闭/退出路径绝不能被清理调用卡住，否则进程残留在后台并触发
/// macOS「正在后台运行」通知。到截止时间仍未退出则放弃等待（进程已 SIGKILL，
/// 僵尸会被 init 收养回收）。
pub(crate) fn wait_for_child_exit(child: &mut Child, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return,
        }
    }
}

/// 杀掉子进程及其全部后代，并等待其退出。
///
/// Unix：先对进程组发 SIGTERM，给进程优雅退出的机会（后端服务可借此落日志、
/// 刷 WAL，也便于事后勘验「是谁停的」）；3 秒内未退出再 SIGKILL。子进程由
/// `prepare_new_process_group` 以独立进程组启动，pid == pgid，用
/// `kill(-pid, SIG)` 作用于整组。防御性地先用 getpgid 确认组确实归子进程
/// 所有（绝不误杀自身所在进程组），否则退回只对子进程本身发信号。
/// Windows：`taskkill /T /F` 递归杀进程树，失败时退回只杀子进程。
pub(crate) fn kill_process_tree(child: &mut Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        // SAFETY: `pid` is the child's own process id (a valid pgid/pgid
        // argument per POSIX; `getpgid` accepts any pid, including 0, and
        // negative values are handled via the `kill(-pid)` form below).
        let group_leader = unsafe { libc::getpgid(pid) };
        let target: libc::pid_t = if group_leader == pid {
            // SAFETY: `-pid` is a valid negative pid signalling the whole
            // process group; verified above that `pid` is its own group
            // leader, so we can never kill our own group.
            -pid
        } else {
            pid
        };

        let _ = unsafe { libc::kill(target, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }

        if unsafe { libc::kill(target, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        // ESRCH：进程组已不存在（子进程及后代均已退出）
        if err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        return Err(err);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let pid = child.id().to_string();
        let killed = std::process::Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if killed {
            return Ok(());
        }
        child.kill()
    }
}
