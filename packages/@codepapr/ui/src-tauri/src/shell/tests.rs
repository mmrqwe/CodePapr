#[cfg(test)]
mod tests {
    use crate::shell::background::{
        drain_capped_output, run_workspace_command_impl, scan_script_for_version_constraint,
        MAX_OUTPUT_BYTES,
    };
    use crate::shell::guard::find_unquoted_shell_version_constraint;
    use crate::shell::session::{
        close_shell_session, open_shell_session, read_shell_output, send_shell_command,
        send_shell_input,
    };
    use crate::test_helpers::TestWorkspace;
    use std::{fs, path::PathBuf, thread, time::Duration};

    #[test]
    fn find_unquoted_shell_version_constraint_detects_unquoted_package_specs() {
        assert_eq!(
            find_unquoted_shell_version_constraint("pip install openai>=0.27.0"),
            Some("openai>=0.27.0".to_string())
        );
        assert_eq!(
            find_unquoted_shell_version_constraint("pip install openai >=0.27.0"),
            Some(">=0.27.0".to_string())
        );
        assert_eq!(
            find_unquoted_shell_version_constraint("pip install openai > =0.27.0"),
            Some("=0.27.0".to_string())
        );
        assert_eq!(
            find_unquoted_shell_version_constraint("python<3.13 && echo ok"),
            Some("python<3.13".to_string())
        );
        assert_eq!(
            find_unquoted_shell_version_constraint("pip install openai \\\n>=0.27.0"),
            Some(">=0.27.0".to_string())
        );
    }

    #[test]
    fn find_unquoted_shell_version_constraint_ignores_quoted_specs_and_redirects() {
        assert_eq!(
            find_unquoted_shell_version_constraint("pip install 'openai>=0.27.0'"),
            None
        );
        assert_eq!(
            find_unquoted_shell_version_constraint("echo hello > output.txt"),
            None
        );
    }

    #[test]
    fn send_shell_input_rejects_unquoted_version_constraint_before_shell_write() {
        let workspace = TestWorkspace::new("shell-guard");
        let session = open_shell_session(workspace.workspace_arg(), Some("/bin/sh".to_string()))
            .expect("should open shell session");

        let error = match send_shell_input(
            session.session_id.clone(),
            "pip install openai>=0.27.0".to_string(),
        ) {
            Ok(_) => panic!("unsafe shell input should be rejected"),
            Err(error) => error,
        };

        assert!(error.contains("未加引号的版本约束"));
        assert!(!workspace.file_path("=0.27.0").exists());

        let error2 = match send_shell_input(
            session.session_id.clone(),
            "pip install openai >=0.27.0".to_string(),
        ) {
            Ok(_) => panic!("unsafe shell input should be rejected"),
            Err(error) => error,
        };
        assert!(error2.contains("未加引号的版本约束"));
        assert!(!workspace.file_path("=0.27.0").exists());

        let error3 = match send_shell_input(
            session.session_id.clone(),
            "pip install openai \\\n>=0.27.0".to_string(),
        ) {
            Ok(_) => panic!("unsafe shell input should be rejected"),
            Err(error) => error,
        };
        assert!(error3.contains("未加引号的版本约束"));
        assert!(!workspace.file_path("=0.27.0").exists());

        let closed = close_shell_session(session.session_id).expect("should close shell session");
        assert!(closed.closed);
    }

    #[test]
    fn send_shell_command_quotes_args_before_shell_write() {
        let workspace = TestWorkspace::new("shell-command-guard");
        let session = open_shell_session(workspace.workspace_arg(), Some("/bin/sh".to_string()))
            .expect("should open shell session");

        send_shell_command(
            session.session_id.clone(),
            "printf".to_string(),
            Some(vec!["%s\\n".to_string(), "openai>=0.27.0".to_string()]),
        )
        .expect("structured shell command should be accepted");

        std::thread::sleep(Duration::from_millis(120));

        let output =
            read_shell_output(session.session_id.clone()).expect("should read shell output");
        assert!(output.output_tail.contains("openai>=0.27.0"));
        assert!(!workspace.file_path("=0.27.0").exists());

        let closed = close_shell_session(session.session_id).expect("should close shell session");
        assert!(closed.closed);
    }

    #[test]
    fn scan_script_for_version_constraint_detects_unquoted_constraints() {
        let workspace = TestWorkspace::new("script-scan");
        let ws_path = PathBuf::from(workspace.workspace_arg());

        let script_path = workspace.file_path("install.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\npip install openai>=0.27.0 requests>=2.28.0\n",
        )
        .expect("should write script");
        let result = scan_script_for_version_constraint(&ws_path, "./install.sh");
        assert!(
            result.is_some(),
            "should detect unquoted version constraint"
        );
        let found = result.unwrap();
        assert!(
            found.contains(">="),
            "found token should contain constraint operator: {found}"
        );

        let cmd_path = workspace.file_path("setup.command");
        fs::write(&cmd_path, "#!/bin/sh\npip install textual>=0.52.0\n")
            .expect("should write .command script");
        let result2 = scan_script_for_version_constraint(&ws_path, "./setup.command");
        assert!(
            result2.is_some(),
            ".command file with unquoted constraint should be detected"
        );

        let safe_path = workspace.file_path("safe.sh");
        fs::write(&safe_path, "#!/bin/sh\npip install \"openai>=0.27.0\"\n")
            .expect("should write safe script");
        let result3 = scan_script_for_version_constraint(&ws_path, "./safe.sh");
        assert!(
            result3.is_none(),
            "quoted version constraint should not be flagged"
        );

        let comment_path = workspace.file_path("commented.sh");
        fs::write(
            &comment_path,
            "#!/bin/sh\n# pip install openai>=0.27.0\necho done\n",
        )
        .expect("should write commented script");
        let result4 = scan_script_for_version_constraint(&ws_path, "./commented.sh");
        assert!(
            result4.is_none(),
            "comment lines should not trigger the guard"
        );

        let txt_path = workspace.file_path("notes.txt");
        fs::write(&txt_path, "pip install openai>=0.27.0\n").expect("should write text file");
        let result5 = scan_script_for_version_constraint(&ws_path, "./notes.txt");
        assert!(
            result5.is_none(),
            "non-script file extension should not be scanned"
        );
    }

    #[test]
    fn run_workspace_command_rejects_shell_script_with_unquoted_version_constraint() {
        if std::env::consts::OS == "windows" {
            return;
        }

        let workspace = TestWorkspace::new("ws-cmd-script-guard");

        let script_path = workspace.file_path("install.sh");
        fs::write(&script_path, "#!/bin/sh\npip install openai>=0.27.0\n")
            .expect("should write script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&script_path)
                .expect("should get metadata")
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&script_path, perms).expect("should set permissions");
        }

        let result = run_workspace_command_impl(
            workspace.workspace_arg(),
            "./install.sh".to_string(),
            None,
            Some(5),
            None,
        );

        assert!(result.is_err());
        let err = match result {
            Ok(_) => panic!("should have rejected the script with version constraint"),
            Err(e) => e,
        };
        assert!(
            err.contains("未加引号的版本约束"),
            "error should mention version constraint: {err}"
        );

        assert!(
            !workspace.file_path("=0.27.0").exists(),
            "empty redirect file should not have been created"
        );
    }

    // P3：输出缓冲必须有上限（旧实现 read_to_end 无上限会撑爆内存），
    // 但超限后仍要持续读完（否则子进程阻塞在满管道上直到超时）。
    #[test]
    fn drain_capped_output_caps_buffer_but_keeps_draining() {
        use std::cell::Cell;
        use std::io::Read;
        use std::rc::Rc;

        struct CountingReader {
            remaining: usize,
            consumed: Rc<Cell<usize>>,
        }
        impl Read for CountingReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = buf.len().min(self.remaining);
                self.remaining -= n;
                self.consumed.set(self.consumed.get() + n);
                Ok(n)
            }
        }

        let total = MAX_OUTPUT_BYTES * 3;
        let consumed = Rc::new(Cell::new(0));
        let reader = CountingReader {
            remaining: total,
            consumed: Rc::clone(&consumed),
        };
        let buffer = drain_capped_output(reader);
        assert_eq!(buffer.len(), MAX_OUTPUT_BYTES, "保留内容不得超过上限");
        assert_eq!(consumed.get(), total, "超限后仍必须读到 EOF");
    }
}
