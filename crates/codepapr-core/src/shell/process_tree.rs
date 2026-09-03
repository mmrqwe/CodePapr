use std::{
    process::{Child, Command},
    time::{Duration, Instant},
};

/// 让命令在独立进程组中启动（Unix）。停止/超时时据此杀整个进程树：
/// 只杀直接子进程（shell 包装器）会让真正的工作进程（`npm run dev`、
/// `vite`、管道下游等）变成孤儿继续运行、占用端口。
#[cfg(unix)]
pub fn prepare_new_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
pub fn prepare_new_process_group(_cmd: &mut Command) {}

/// Windows：把子进程放进 Job Object（KILL_ON_JOB_CLOSE）。宿主退出时关掉
/// 泄漏的 job handle，后端进程树一并结束，不依赖 lsof。
#[cfg(windows)]
pub(crate) fn assign_kill_on_close_job(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info = JobObjectExtendedLimitInformation::default();
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformationClass,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
        );
        if ok == 0 {
            let _ = CloseHandle(job);
            return;
        }
        let process = child.as_raw_handle();
        if AssignProcessToJobObject(job, process) == 0 {
            let _ = CloseHandle(job);
            return;
        }
        // 必须保持 job handle 存活；关掉会立刻杀掉进程。泄漏到宿主退出即可。
        std::mem::forget(JobHandle(job));
    }
}

#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
#[cfg(windows)]
const JobObjectExtendedLimitInformationClass: i32 = 9;

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    _pad0: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    _pad1: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    _a: u64,
    _b: u64,
    _c: u64,
    _d: u64,
    _e: u64,
    _f: u64,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct JobObjectExtendedLimitInformation {
    basic: JobObjectBasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
struct JobHandle(*mut core::ffi::c_void);

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(
        lp_job_attributes: *mut core::ffi::c_void,
        lp_name: *const u16,
    ) -> *mut core::ffi::c_void;
    fn SetInformationJobObject(
        h_job: *mut core::ffi::c_void,
        info_class: i32,
        lp_info: *mut core::ffi::c_void,
        cb_info: u32,
    ) -> i32;
    fn AssignProcessToJobObject(
        h_job: *mut core::ffi::c_void,
        h_process: *mut core::ffi::c_void,
    ) -> i32;
    fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
}

/// Linux：父进程死后杀子进程，避免宿主崩溃留下占端口的孤儿。
#[cfg(target_os = "linux")]
pub fn prepare_parent_death_signal(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
pub fn prepare_parent_death_signal(_cmd: &mut Command) {}

/// 杀进程组（无 Child 句柄版）：按 pid 对整组先 SIGTERM 再 SIGKILL。
/// 适用于只有 pid 的场景（如 CDP 浏览器主进程）。同样先 getpgid 确认
/// 该 pid 是自身进程组组长，绝不用 `kill(-pid)` 误杀调用方所在组；
/// 非组长则退回只杀该进程自身。
#[cfg(unix)]
pub fn kill_process_group_by_pid(pid: u32) {
    let pid = pid as libc::pid_t;
    let group_leader = unsafe { libc::getpgid(pid) };
    let target: libc::pid_t = if group_leader == pid { -pid } else { pid };

    let _ = unsafe { libc::kill(target, libc::SIGTERM) };
    let deadline = Instant::now() + crate::shared::child_reap_timeout();
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
pub fn kill_process_group_by_pid(pid: u32) {
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
pub fn wait_for_child_exit(child: &mut Child, timeout: Duration) {
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
/// 刷 WAL，也便于事后勘验「是谁停的」）；默认 3 秒内未退出再 SIGKILL（宿主
/// 退出路径见 `child_reap_timeout`，缩短以免卡住 `process::exit`）。子进程由
/// `prepare_new_process_group` 以独立进程组启动，pid == pgid，用
/// `kill(-pid, SIG)` 作用于整组。防御性地先用 getpgid 确认组确实归子进程
/// 所有（绝不误杀自身所在进程组），否则退回只对子进程本身发信号。
/// Windows：`taskkill /T /F` 递归杀进程树，失败时退回只杀子进程。
pub fn kill_process_tree(child: &mut Child) -> std::io::Result<()> {
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
        let deadline = Instant::now() + crate::shared::child_reap_timeout();
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn kill_process_tree_reaps_sleep_child() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        prepare_new_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sleep");
        let started = Instant::now();
        kill_process_tree(&mut child).expect("kill process tree");
        wait_for_child_exit(&mut child, Duration::from_millis(500));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "reaping sleep must not wait the full graceful timeout"
        );
        assert!(
            matches!(child.try_wait(), Ok(Some(_))),
            "sleep child must be reaped"
        );
    }
}
