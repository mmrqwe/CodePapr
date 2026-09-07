//! L1 工具错误文案契约（Rust 宿主侧）。
//!
//! 与 vitest `packages/@codepapr/core/tests/tool-error-contracts.test.ts`
//! 及 UI 侧 `workspaceToolErrorContracts.test.ts` 配对：CodePapr 是双执行宿主
//! （TS handler / Rust sidecar），同一工具的报错必须双侧都满足
//! 「可定位、可理解、可行动」，且关键文案保持 parity——模型不应因为工具跑在
//! 哪个宿主上而读到不同质量的反馈。
//! 文案改动若丢失任一要素（或引用了 LLM 不可见的内部工具名），本模块红灯。

use crate::agent_runtime_tools::{apply_search_replace, require_path};
use crate::shell::background::run_workspace_shell_command_impl;
use crate::shell::dangerous::{
    classify_dangerous_command, detect_repo_content_search, DangerVerdict,
};
use crate::workspace_fs::search::SearchSkipStats;
use serde_json::json;

fn must_err<T>(result: Result<T, String>) -> String {
    match result {
        Err(message) => message,
        Ok(_) => panic!("预期 Err 但返回了 Ok"),
    }
}

// ──── search/replace 内核：TS searchReplaceDiff.ts 的 parity ────

#[test]
fn no_match_error_names_cause_and_recovery_path() {
    let message = must_err(apply_search_replace(
        "hello world\n",
        "nope",
        "x",
        None,
        None,
    ));
    assert!(message.contains("未找到要替换的文本块"), "got: {message}");
    assert!(message.contains("read"), "错误须给出可行动恢复路径: {message}");
    assert!(
        message.contains("核对") || message.contains("缩进"),
        "错误须解释失败原因: {message}"
    );
}

#[test]
fn newline_mismatch_is_diagnosed_on_both_sides() {
    let crlf_file = must_err(apply_search_replace("a\r\nb\r\n", "x\ny", "z", None, None));
    assert!(
        crlf_file.contains("CRLF 换行，但 search 使用了 LF"),
        "got: {crlf_file}"
    );
    let lf_file = must_err(apply_search_replace("a\nb\n", "x\r\ny", "z", None, None));
    assert!(
        lf_file.contains("LF 换行，但 search 使用了 CRLF"),
        "got: {lf_file}"
    );
}

#[test]
fn ambiguous_match_lists_count_and_two_disambiguation_paths() {
    let message = must_err(apply_search_replace(
        "dup\ndup\ndup\n",
        "dup",
        "x",
        None,
        None,
    ));
    assert!(message.contains("匹配到 3 处"), "got: {message}");
    assert!(message.contains("更精确的 search"), "got: {message}");
    assert!(message.contains("replaceAll=true"), "got: {message}");

    // expectedOccurrences 只能校验数量不能消歧——文案必须预先澄清，
    // 否则模型会按提示设置它并陷入同样的失败循环。
    let with_expected = must_err(apply_search_replace(
        "dup\ndup\ndup\n",
        "dup",
        "x",
        None,
        Some(3),
    ));
    assert!(with_expected.contains("不能消歧"), "got: {with_expected}");
}

#[test]
fn expected_occurrences_mismatch_reports_both_numbers() {
    let message = must_err(apply_search_replace(
        "dup\ndup\n",
        "dup",
        "x",
        Some(true),
        Some(5),
    ));
    assert!(
        message.contains("预期匹配 5 处，实际匹配 2 处"),
        "got: {message}"
    );
}

// ──── bash：高危拦截与仓库向搜索拦截的文案 ────

#[test]
fn blocked_dangerous_command_explains_and_points_to_user_channel() {
    // 拦截发生在 spawn 之前，测试机上不会真实执行 rm。
    let message = must_err(run_workspace_shell_command_impl(
        "/tmp/codepapr-contract-test-nonexistent".to_string(),
        "rm -rf /".to_string(),
        None,
        None,
        None,
        None,
    ));
    assert!(message.contains("高危命令被拦截"), "got: {message}");
    assert!(message.contains("终端手动运行"), "须给出用户侧兜底通道: {message}");
    assert!(
        !message.contains("workspace_"),
        "文案不得引用 LLM 不可见的内部工具名: {message}"
    );
}

#[test]
fn git_reset_hard_is_confirm_verdict_pointing_to_checkpoint() {
    let verdict = classify_dangerous_command("git reset --hard HEAD~1");
    assert!(
        matches!(verdict, DangerVerdict::Confirm(_)),
        "reset --hard 应走确认而非死锁: {verdict:?}"
    );
    let reason = verdict.reason().unwrap_or_default();
    assert!(reason.contains("检查点"), "须说明检查点兜底: {reason}");
}

#[test]
fn impl_layer_defers_confirm_verdict_to_entry_gates() {
    // 兜底层只杀 Block 级：Confirm 级由宿主入口（sidecar dispatch/UI handler）确认。
    // 用一个不存在的工作区路径，保证绝不会真的 spawn 命令。
    let err = must_err(run_workspace_shell_command_impl(
        "/tmp/codepapr-contract-test-nonexistent-ws".to_string(),
        "git reset --hard".to_string(),
        None,
        None,
        None,
        None,
    ));
    assert!(
        !err.contains("高危命令被拦截"),
        "Confirm 级不应在 impl 层被杀: {err}"
    );
}

#[test]
fn repo_search_interception_routes_to_grep_tool_with_feature_names() {
    let message = detect_repo_content_search("grep -rn TODO .")
        .unwrap_or_else(|| panic!("递归 grep 应被拦截并引导到 grep 工具"));
    assert!(message.contains("grep 工具"), "got: {message}");
    assert!(message.contains("isRegexp"), "须说明替代工具的关键参数: {message}");
    assert!(message.contains("includeGlobs"), "got: {message}");
    assert!(
        !message.contains("workspace_search_text"),
        "不得引导模型调用隐藏内部工具: {message}"
    );
    // 单文件过滤不是仓库向搜索，不应误伤。
    assert!(detect_repo_content_search("grep TODO src/a.ts").is_none());
}

#[test]
fn dangerous_detector_stays_conservative_on_ordinary_build_commands() {
    // 契约的另一半：误报会把 agent 死锁在无关命令上（论文结论③：
    // 工具反馈质量决定收敛）。这些必须 Allow（Block/Confirm 都不行）。
    for command in [
        "rm -rf node_modules",
        "npm run build",
        "git push origin main",
        "echo rm -rf /",
        "npm run reboot",
    ] {
        assert!(
            matches!(classify_dangerous_command(command), DangerVerdict::Allow),
            "常规命令被误拦/误确认: {command}"
        );
    }
}

// ──── 缺参数：点名参数并给示例 ────

#[test]
fn missing_path_argument_error_carries_example() {
    let message = must_err(require_path(&json!({})));
    assert!(message.contains("缺少路径参数"), "got: {message}");
    assert!(message.contains("relativePath"), "got: {message}");
    assert!(message.contains("src/main.ts"), "须附示例值: {message}");

    // 空白字符串按「缺失」处理：两种形态都必须给出示例值。
    let empty = must_err(require_path(&json!({ "relativePath": "  " })));
    assert!(empty.contains("relativePath"), "got: {empty}");
    assert!(empty.contains("src/main.ts"), "got: {empty}");

    let wrong_type = must_err(require_path(&json!({ "relativePath": 5 })));
    assert!(wrong_type.contains("实际类型: number"), "got: {wrong_type}");
    assert!(wrong_type.contains("src/main.ts"), "got: {wrong_type}");
}

// ──── 搜索可解释性：0 结果 ≠ 全库无匹配 ────

#[test]
fn skip_stats_explain_what_was_not_searched() {
    let stats = SearchSkipStats {
        oversize: 2,
        undecodable: 0,
        unreadable: 1,
    };
    let note = stats
        .explain()
        .unwrap_or_else(|| panic!("有跳过时必须有解释"));
    assert!(note.contains("3 个文件被跳过"), "got: {note}");
    assert!(note.contains("2 个超过大小上限"), "got: {note}");
    assert!(note.contains("1 个读取失败"), "got: {note}");
    assert!(
        SearchSkipStats::default().explain().is_none(),
        "无跳过时不应制造噪声 note"
    );
}
