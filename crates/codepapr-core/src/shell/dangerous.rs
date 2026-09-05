//! 高危命令检测。
//!
//! 这里只拦截「明确具有灾难性后果、且对编码 Agent 没有正当用途」的命令：
//! 删除根目录/用户主目录、格式化磁盘、向块设备裸写、fork 炸弹、git 强制推送/
//! 硬重置、关机等。检测刻意保持保守——像 `rm -rf node_modules`、`rm -rf dist`
//! 这类常规清理操作不会被拦截。
//!
//! 判定基于「段首命令」（会先剥离 `sudo`/`doas` 等提权前缀），而不是在整行里
//! 随意搜索关键字，以避免把 `npm run reboot`、`echo rm -rf /` 这类把危险词当作
//! 参数的命令误判为高危。
//!
//! 返回 `Some(reason)` 表示命令应被拦截，`reason` 用于向调用方（最终是 LLM 与
//! 用户）解释拦截原因。

/// 把一个命令行按 shell 元字符切成多个简单片段。
/// 这不是完整的 shell 解析，仅用于让每个 `cmd args...` 段能被独立检查，
/// 避免 `a && rm -rf /` 这类串联命令漏检。
pub(crate) fn split_segments(line: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '|' | ';' | '\n' => {
                if !current.trim().is_empty() {
                    segments.push(current.trim().to_string());
                }
                current.clear();
            }
            '&' => {
                // `&&` 与单个 `&` 都作为分隔；`cmd &` 后台运行同样切分。
                if chars.peek() == Some(&'&') {
                    chars.next();
                }
                if !current.trim().is_empty() {
                    segments.push(current.trim().to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        segments.push(current.trim().to_string());
    }
    segments
}

/// 按空白切分 token，并去掉成对的首尾引号，便于路径比较。
fn tokenize(segment: &str) -> Vec<String> {
    segment
        .split_whitespace()
        .map(|raw| {
            let trimmed = raw.trim();
            let bytes = trimmed.as_bytes();
            if bytes.len() >= 2 {
                let first = bytes[0];
                let last = bytes[bytes.len() - 1];
                if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
                    return trimmed[1..trimmed.len() - 1].to_string();
                }
            }
            trimmed.to_string()
        })
        .collect()
}

/// 取路径的最后一节作为命令名（`/bin/rm` -> `rm`）。
fn basename(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}

/// 剥离 Windows 可执行扩展名（`diskpart.exe` -> `diskpart`），便于统一匹配。
fn strip_exe_ext(name: &str) -> &str {
    name.strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".com"))
        .or_else(|| name.strip_suffix(".bat"))
        .or_else(|| name.strip_suffix(".cmd"))
        .unwrap_or(name)
}

/// 归一化命令名：取 basename 并去掉可执行扩展名，再转小写。
fn command_name(token: &str) -> String {
    strip_exe_ext(basename(token)).to_lowercase()
}

const PRIVILEGE_WRAPPERS: &[&str] = &["sudo", "doas", "pkexec", "su", "please"];

/// 找到段首真正要执行的命令下标：跳过提权包装命令。
/// 若剥到 flag（如 `sudo -u root ...` 的 `-u`）则返回 None，表示无法可靠判定，
/// 此时不做拦截（宁可漏报也不误报）。
fn find_head_index(tokens: &[String]) -> Option<usize> {
    let mut i = 0;
    while i < tokens.len() {
        let base = command_name(&tokens[i]);
        if PRIVILEGE_WRAPPERS.contains(&base.as_str()) {
            i += 1;
            continue;
        }
        break;
    }
    if i < tokens.len() && !tokens[i].starts_with('-') {
        Some(i)
    } else {
        None
    }
}

/// 判断 rm 的目标路径是否属于「根目录/主目录」级别的危险目标。
fn is_root_like_target(target: &str) -> bool {
    let cleaned = target.trim_end_matches('/');
    let cleaned = if cleaned.is_empty() { "/" } else { cleaned };
    matches!(
        cleaned,
        "/" | "/*" | "~" | "~/" | "$HOME" | "${HOME}" | "%USERPROFILE%"
    )
}

/// 检查以 `rm` 开头的 token 序列：仅当「递归 + 强制」且目标是根/主目录时拦截。
fn rm_is_dangerous(tokens: &[String]) -> bool {
    let mut recursive = false;
    let mut force = false;
    let mut targets: Vec<&str> = Vec::new();
    let mut past_flags = false;
    for token in tokens.iter().skip(1) {
        if token == "--" {
            past_flags = true;
            continue;
        }
        if !past_flags && token.starts_with('-') && token.len() > 1 {
            let body = token.trim_start_matches('-');
            if body == "no-preserve-root" {
                return true;
            }
            if body == "recursive" {
                recursive = true;
                continue;
            }
            if body == "force" {
                force = true;
                continue;
            }
            if body.contains('r') || body.contains('R') {
                recursive = true;
            }
            if body.contains('f') {
                force = true;
            }
            continue;
        }
        targets.push(token);
    }
    if !(recursive && force) {
        return false;
    }
    targets.iter().any(|t| is_root_like_target(t))
}

/// 检查以 `git` 开头的 token 序列是否为强制推送/删除远端/硬重置。
fn git_is_dangerous(tokens: &[String]) -> bool {
    if tokens.len() < 2 {
        return false;
    }
    match tokens[1].to_lowercase().as_str() {
        "push" => {
            let mut force = false;
            let mut delete = false;
            let mut colon_delete = false;
            for token in tokens.iter().skip(2) {
                match token.as_str() {
                    "--force" | "-f" | "--force-with-lease" => force = true,
                    "--delete" | "-d" => delete = true,
                    _ => {
                        if !token.starts_with('-') && token.starts_with(':') {
                            colon_delete = true;
                        }
                    }
                }
            }
            force || delete || colon_delete
        }
        "reset" => tokens.iter().skip(2).any(|t| t.to_lowercase() == "--hard"),
        _ => false,
    }
}

/// 检查单个片段是否命中高危模式，命中则返回原因。
fn segment_reason(segment: &str) -> Option<String> {
    let lower = segment.to_lowercase();

    // 向块设备裸写 / 重定向覆盖块设备（不依赖段首命令，直接全段匹配）。
    if lower.contains("of=/dev/") {
        return Some("检测到向块设备裸写（of=/dev/...），会摧毁磁盘数据".to_string());
    }
    for dev in [
        "/dev/sd",
        "/dev/hd",
        "/dev/nvme",
        "/dev/disk",
        "/dev/mmcblk",
        "/dev/xvd",
    ] {
        for redirect in [">", ">>"] {
            let with_space = format!("{redirect} {dev}");
            let no_space = format!("{redirect}{dev}");
            if lower.contains(&with_space) || lower.contains(&no_space) {
                return Some(format!(
                    "检测到重定向写入块设备（{dev}...），会摧毁磁盘数据"
                ));
            }
        }
    }

    let tokens = tokenize(segment);
    let head_idx = find_head_index(&tokens)?;
    let rest = &tokens[head_idx..];
    let head = command_name(&rest[0]);

    // 磁盘格式化/擦除类：命令名本身即足够特征。
    if head.starts_with("mkfs") || matches!(head.as_str(), "wipefs" | "shred" | "diskpart") {
        return Some(format!("检测到磁盘格式化/擦除命令 `{head}`，已拦截"));
    }

    match head.as_str() {
        "rm" => {
            if rm_is_dangerous(rest) {
                return Some(
                    "检测到递归强制删除根目录或用户主目录（rm -rf / 或 ~），已拦截".to_string(),
                );
            }
        }
        "git" => {
            if git_is_dangerous(rest) {
                return if rest.len() >= 2 && rest[1].to_lowercase() == "reset" {
                    Some(
                        "检测到 git reset --hard，会丢弃未提交改动；如需回退请使用内置的对话重置/检查点回滚"
                            .to_string(),
                    )
                } else {
                    Some(
                        "检测到 git 强制推送/删除远端分支，可能不可逆地覆盖远端历史，已拦截"
                            .to_string(),
                    )
                };
            }
        }
        "dd" => {
            if rest
                .iter()
                .skip(1)
                .any(|t| t.to_lowercase().starts_with("of=/dev/"))
            {
                return Some("检测到 dd 向块设备写入，会摧毁磁盘数据".to_string());
            }
        }
        "diskutil" => {
            if rest.iter().skip(1).any(|t| {
                matches!(
                    t.to_lowercase().as_str(),
                    "erasedisk" | "erasevolume" | "zerodisk" | "secureerase" | "partitiondisk"
                )
            }) {
                return Some("检测到 diskutil 磁盘擦除/分区操作，已拦截".to_string());
            }
        }
        "shutdown" | "reboot" | "halt" | "poweroff" => {
            return Some(format!("检测到关机/重启命令 `{head}`，已拦截"));
        }
        "init" => {
            if rest.iter().skip(1).any(|t| matches!(t.as_str(), "0" | "6")) {
                return Some("检测到 init 0/6 关机/重启，已拦截".to_string());
            }
        }
        "systemctl" => {
            if rest.iter().skip(1).any(|t| {
                matches!(
                    t.to_lowercase().as_str(),
                    "poweroff" | "reboot" | "halt" | "shutdown"
                )
            }) {
                return Some("检测到 systemctl 关机/重启，已拦截".to_string());
            }
        }
        "format" => {
            // Windows `format C:`；仅当后跟盘符时才判定，避免误伤名为 format 的脚本。
            if rest.iter().skip(1).any(|t| {
                t.len() == 2
                    && t.ends_with(':')
                    && t.chars().next().map_or(false, |c| c.is_ascii_alphabetic())
            }) {
                return Some("检测到 Windows format 格式化磁盘命令，已拦截".to_string());
            }
        }
        _ => {}
    }

    None
}

/// 对完整命令行做高危检测；命中返回拦截原因。
pub(crate) fn detect_dangerous_command(command_line: &str) -> Option<String> {
    let line = command_line.trim();
    if line.is_empty() {
        return None;
    }
    // fork 炸弹（`:(){ :|:& };:` 及其变体）在分段前先做整体匹配，
    // 因为它依赖 `|`、`&`、`;` 这些会被分段切断的字符。
    if line.contains(":|:&") {
        return Some("检测到 fork 炸弹模式，会耗尽系统进程资源".to_string());
    }
    for segment in split_segments(line) {
        if let Some(reason) = segment_reason(&segment) {
            return Some(reason);
        }
    }
    None
}

/// 供「command + args」型执行路径复用：先拼成一行再检测。
pub(crate) fn detect_dangerous_invocation(command: &str, args: &[String]) -> Option<String> {
    let mut line = command.to_string();
    for arg in args {
        line.push(' ');
        line.push_str(arg);
    }
    detect_dangerous_command(&line)
}

/// grep 族（grep/egrep/fgrep）的递归仓库搜标志：`-r`、`-R`、`-rn`、`--recursive`。
fn has_recursive_flag(args: &[String]) -> bool {
    args.iter().any(|arg| {
        if arg == "--recursive" || arg.starts_with("--recursive=") {
            return true;
        }
        match arg.strip_prefix('-') {
            // 组合短选项（-rn/-nr/-e 等）：只要含 r/R 即递归；`--` 前缀已在上面处理。
            Some(short) if !short.is_empty() && !arg.starts_with("--") => {
                short.contains('r') || short.contains('R')
            }
            _ => false,
        }
    })
}

/// rg/ag/ack 的位置参数：约定「第一个非 flag 是 pattern，其余是路径」。
/// 无法完美解析带值 flag（如 `-g ts`），因此只用于目录形态判断，宁可漏报不误报。
fn positional_after_pattern(args: &[String]) -> Vec<String> {
    let mut non_flags = args
        .iter()
        .filter(|a| !a.starts_with('-') && a.as_str() != "--")
        .cloned()
        .collect::<Vec<_>>();
    if !non_flags.is_empty() {
        non_flags.remove(0);
    }
    non_flags
}

fn is_dir_like(path: &str) -> bool {
    path == "." || path == ".." || path.ends_with('/') || path.ends_with(std::path::MAIN_SEPARATOR)
}

const REPO_SEARCH_COMMANDS: &[&str] = &["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack"];

/// 仓库向内容搜索命令检测：`grep` 工具带忽略规则/截断/跳过保护，bash 直跑
/// 递归搜索会绕开这些策略并在大仓库卡顿。只拦「高置信仓库向」：
/// - grep 族：递归 flag（-r/-R/-rn/--recursive）；无递归 flag 视为 stdin/单文件过滤，放行。
/// - rg/ag/ack（天然递归）：段首且无显式文件路径参数（默认扫当前树），或路径参数是目录形态。
///   `rg -`（stdin）与 `rg --files`（文件列表）豁免；管道后无路径参数的段放行（意图不明不误伤）。
pub(crate) fn detect_repo_content_search(command_line: &str) -> Option<String> {
    let line = command_line.trim();
    if line.is_empty() {
        return None;
    }
    for (index, segment) in split_segments(line).iter().enumerate() {
        let tokens = tokenize(segment);
        let Some(head) = find_head_index(&tokens) else {
            continue;
        };
        let name = command_name(&tokens[head]);
        if !REPO_SEARCH_COMMANDS.contains(&name.as_str()) {
            continue;
        }
        let args = &tokens[head + 1..];
        let searches_repo = match name.as_str() {
            "grep" | "egrep" | "fgrep" => has_recursive_flag(args),
            _ => {
                if args.iter().any(|a| a.as_str() == "-")
                    || args.iter().any(|a| a.starts_with("--files"))
                {
                    false
                } else {
                    let paths = positional_after_pattern(args);
                    if paths.is_empty() {
                        index == 0
                    } else {
                        paths.iter().any(|p| is_dir_like(p))
                    }
                }
            }
        };
        if searches_repo {
            return Some(format!(
                "仓库向内容搜索命令 `{segment}` 被拦截。请改用 grep 工具：默认字面量匹配，\
                 isRegexp:true 才按正则，支持 includeGlobs/excludeGlobs 文件过滤，\
                 自动跳过构建产物并截断输出。管道/stdin 文本过滤（不加 -r、无目录参数）不受此限制。"
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_rm_rf_root() {
        assert!(detect_dangerous_command("rm -rf /").is_some());
        assert!(detect_dangerous_command("rm -rf /*").is_some());
        assert!(detect_dangerous_command("rm -fr /").is_some());
        assert!(detect_dangerous_command("rm -rf ~").is_some());
        assert!(detect_dangerous_command("rm -rf $HOME").is_some());
        assert!(detect_dangerous_command("sudo rm -rf /").is_some());
        assert!(detect_dangerous_command("echo hi && rm -rf /").is_some());
        assert!(detect_dangerous_command("rm --recursive --force /").is_some());
        assert!(detect_dangerous_command("rm -rf --no-preserve-root /").is_some());
    }

    #[test]
    fn allows_common_rm_usage() {
        assert!(detect_dangerous_command("rm -rf node_modules").is_none());
        assert!(detect_dangerous_command("rm -rf dist build").is_none());
        assert!(detect_dangerous_command("rm file.txt").is_none());
        assert!(detect_dangerous_command("rm -rf ./target").is_none());
        assert!(detect_dangerous_command("rm -rf /tmp/codepapr-cache").is_none());
    }

    #[test]
    fn blocks_disk_and_format() {
        assert!(detect_dangerous_command("mkfs.ext4 /dev/sda1").is_some());
        assert!(detect_dangerous_command("dd if=/dev/zero of=/dev/sda").is_some());
        assert!(detect_dangerous_command("diskutil eraseDisk JHFS+ X /dev/disk0").is_some());
        assert!(detect_dangerous_command("wipefs -a /dev/sda").is_some());
        assert!(detect_dangerous_command("cat x > /dev/sda").is_some());
        assert!(detect_dangerous_command("format C:").is_some());
        assert!(detect_dangerous_command("diskpart").is_some());
        // Windows 可执行扩展名应被剥离后正常命中。
        assert!(detect_dangerous_command("diskpart.exe").is_some());
        assert!(detect_dangerous_command("format.com D:").is_some());
    }

    #[test]
    fn blocks_git_destructive() {
        assert!(detect_dangerous_command("git push --force").is_some());
        assert!(detect_dangerous_command("git push -f origin main").is_some());
        assert!(detect_dangerous_command("git push --force-with-lease").is_some());
        assert!(detect_dangerous_command("git push origin :main").is_some());
        assert!(detect_dangerous_command("git push --delete origin feature").is_some());
        assert!(detect_dangerous_command("git reset --hard").is_some());
        assert!(detect_dangerous_command("git reset --hard HEAD~1").is_some());
    }

    #[test]
    fn allows_normal_git() {
        assert!(detect_dangerous_command("git push origin main").is_none());
        assert!(detect_dangerous_command("git reset --soft HEAD~1").is_none());
        assert!(detect_dangerous_command("git reset --mixed").is_none());
        assert!(detect_dangerous_command("git status").is_none());
    }

    #[test]
    fn blocks_fork_bomb_and_power() {
        assert!(detect_dangerous_command(":(){ :|:& };:").is_some());
        assert!(detect_dangerous_command("shutdown -h now").is_some());
        assert!(detect_dangerous_command("reboot").is_some());
        assert!(detect_dangerous_command("systemctl poweroff").is_some());
        assert!(detect_dangerous_command("init 0").is_some());
    }

    #[test]
    fn allows_benign_commands() {
        assert!(detect_dangerous_command("npm run build").is_none());
        assert!(detect_dangerous_command("npm test").is_none());
        assert!(detect_dangerous_command("ls -la").is_none());
        assert!(detect_dangerous_command("cargo build --release").is_none());
        assert!(detect_dangerous_command("python -m pip install -r requirements.txt").is_none());
        assert!(detect_dangerous_command("git log --oneline").is_none());
        // 危险词作为参数而非段首命令时不应误报。
        assert!(detect_dangerous_command("npm run reboot").is_none());
        assert!(detect_dangerous_command("echo rm -rf /").is_none());
    }

    #[test]
    fn invocation_helper_checks_command_plus_args() {
        assert!(
            detect_dangerous_invocation("rm", &["-rf".to_string(), "/".to_string()]).is_some()
        );
        assert!(
            detect_dangerous_invocation("git", &["push".to_string(), "--force".to_string()])
                .is_some()
        );
        assert!(
            detect_dangerous_invocation("rm", &["-rf".to_string(), "node_modules".to_string()])
                .is_none()
        );
    }

    #[test]
    fn repo_content_search_blocks_recursive_grep() {
        assert!(detect_repo_content_search("grep -rn TODO .").is_some());
        assert!(detect_repo_content_search("grep -R foo src").is_some());
        assert!(detect_repo_content_search("grep --recursive foo src").is_some());
    }

    #[test]
    fn repo_content_search_blocks_bare_repo_searchers() {
        assert!(detect_repo_content_search("rg -n foo").is_some());
        assert!(detect_repo_content_search("rg foo .").is_some());
        assert!(detect_repo_content_search("rg foo src/").is_some());
        assert!(detect_repo_content_search("ag TODO").is_some());
        assert!(detect_repo_content_search("ack foo").is_some());
    }

    #[test]
    fn repo_content_search_blocks_in_pipeline_head() {
        // `rg` 作为管道首段（无 stdin）默认扫当前树，即使后面接了 wc。
        assert!(detect_repo_content_search("rg foo | wc -l").is_some());
    }

    #[test]
    fn repo_content_search_allows_file_and_stdin_usage() {
        // 单文件 grep、显式文件路径 rg、管道内 stdin 过滤都不拦。
        assert!(detect_repo_content_search("grep TODO src/main.rs").is_none());
        assert!(detect_repo_content_search("rg foo Cargo.toml").is_none());
        assert!(detect_repo_content_search("cat log.txt | grep -i warn").is_none());
        assert!(detect_repo_content_search("make 2>&1 | rg error").is_none());
        assert!(detect_repo_content_search("git ls-files | rg \"\\.rs$\"").is_none());
    }

    #[test]
    fn repo_content_search_allows_non_search_commands() {
        assert!(detect_repo_content_search("npm install").is_none());
        assert!(detect_repo_content_search("ls -la").is_none());
        // 搜索词作为参数而非段首命令时不误报。
        assert!(detect_repo_content_search("echo rg -n foo").is_none());
    }
}
