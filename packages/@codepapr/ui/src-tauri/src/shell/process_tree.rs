use std::process::{Child, Command};

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

/// 杀掉子进程及其全部后代。
///
/// Unix：子进程由 `prepare_new_process_group` 以独立进程组启动，pid == pgid，
/// 用 `kill(-pid, SIGKILL)` 杀整组。防御性地先用 getpgid 确认组确实归子进程
/// 所有（绝不误杀自身所在进程组），否则退回只杀子进程。
/// Windows：`taskkill /T /F` 递归杀进程树，失败时退回只杀子进程。
pub(crate) fn kill_process_tree(child: &mut Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        let group_leader = unsafe { libc::getpgid(pid) };
        if group_leader == pid {
            if unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
                return Ok(());
            }
            let err = std::io::Error::last_os_error();
            // ESRCH：进程组已不存在（子进程及后代均已退出）
            if err.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(err);
        }
        return child.kill();
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
