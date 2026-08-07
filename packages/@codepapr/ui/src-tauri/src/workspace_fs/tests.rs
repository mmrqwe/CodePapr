use super::*;
use crate::test_helpers::TestWorkspace;
use std::fs;

#[test]
fn read_text_file_clamps_tiny_max_bytes_instead_of_failing() {
    let workspace = TestWorkspace::new("max-bytes");
    fs::write(workspace.file_path("note.txt"), b"hello world\n").expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "note.txt".to_string(),
        Some(0),
        None,
        None,
        None,
        None,
    )
    .expect("small maxBytes should be clamped, not fail");

    assert_eq!(result.content, "hello world\n");
    assert_eq!(result.path, "note.txt");
}

#[test]
fn read_text_file_allows_lossy_decode_for_text_like_non_utf8_bytes() {
    let workspace = TestWorkspace::new("lossy");
    fs::write(workspace.file_path("latin1.txt"), b"hello \xE9 world\n")
        .expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "latin1.txt".to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .expect("text-like bytes should still be readable");

    assert_eq!(result.content, "hello \u{fffd} world\n");
    assert_eq!(result.path, "latin1.txt");
}

#[test]
fn read_text_file_accepts_workspace_absolute_path_with_line_anchor() {
    let workspace = TestWorkspace::new("absolute-anchor");
    fs::create_dir_all(workspace.file_path("src")).expect("should create src dir");
    fs::write(
        workspace.file_path("src/app.ts"),
        b"export const value = 1;\n",
    )
    .expect("should write fixture");

    let anchored = format!(
        "{}:1:1",
        workspace.file_path("src/app.ts").to_string_lossy()
    );
    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        anchored,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("workspace absolute paths with line anchors should be readable");

    assert_eq!(result.content, "export const value = 1;\n");
    assert_eq!(result.path, "src/app.ts");
}

#[test]
fn read_text_file_can_return_requested_line_window() {
    let workspace = TestWorkspace::new("line-window");
    fs::write(
        workspace.file_path("note.txt"),
        b"alpha\nbeta\ngamma\ndelta\n",
    )
    .expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "note.txt".to_string(),
        None,
        Some(2),
        Some(3),
        None,
        None,
    )
    .expect("range read should succeed");

    assert_eq!(result.content, "beta\ngamma\n");
    assert_eq!(result.start_line, 2);
    assert_eq!(result.end_line, 3);
    assert_eq!(result.total_lines, 4);
    assert!(result.truncated_by_range);
}

#[test]
fn read_text_file_uses_anchor_as_default_window() {
    let workspace = TestWorkspace::new("anchor-window");
    fs::write(
        workspace.file_path("note.txt"),
        b"line1\nline2\nline3\nline4\n",
    )
    .expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "note.txt:3:2".to_string(),
        None,
        None,
        None,
        None,
        Some(0),
    )
    .expect("anchor window should succeed");

    assert_eq!(result.content, "line3\n");
    assert_eq!(result.location_line, Some(3));
    assert_eq!(result.location_column, Some(2));
    assert_eq!(result.start_line, 3);
    assert_eq!(result.end_line, 3);
    assert!(result.truncated_by_range);
}

#[test]
fn read_text_file_still_rejects_binary_content() {
    let workspace = TestWorkspace::new("binary");
    fs::write(
        workspace.file_path("image.bin"),
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00],
    )
    .expect("should write fixture");

    let error = match read::read_text_file_impl(
        workspace.workspace_arg(),
        "image.bin".to_string(),
        None,
        None,
        None,
        None,
        None,
    ) {
        Ok(_) => panic!("binary files should still be rejected"),
        Err(error) => error,
    };

    assert!(error.contains("二进制内容"));
}

#[test]
fn search_workspace_text_returns_context_and_respects_gitignore() {
    let workspace = TestWorkspace::new("search-text");
    fs::create_dir_all(workspace.file_path("src")).expect("should create src dir");
    fs::create_dir_all(workspace.file_path("generated")).expect("should create ignored dir");
    fs::write(workspace.file_path(".gitignore"), b"generated/\n")
        .expect("should write ignore file");
    fs::write(
        workspace.file_path("src/main.ts"),
        b"export const value = 1;\nexport function greet() {\n  return value;\n}\n",
    )
    .expect("should write source fixture");
    fs::write(
        workspace.file_path("generated/secret.txt"),
        b"ignored-hit\n",
    )
    .expect("should write ignored fixture");

    let result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "value".to_string(),
        None,
        None,
        Some(1),
        Some(10),
        Some(2),
        Some(200_000),
        None,
    )
    .expect("text search should succeed");

    assert_eq!(result.matches.len(), 2);
    assert_eq!(result.matches[0].path, "src/main.ts");
    assert_eq!(result.matches[0].line, 1);
    assert_eq!(result.matches[0].column, Some(14));
    assert_eq!(
        result.matches[1].context_before.as_ref().unwrap(),
        &["export function greet() {"]
    );
    assert_eq!(result.matches[1].context_after.as_ref().unwrap(), &["}"]);

    let ignored = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "ignored-hit".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("ignored search should still succeed");

    assert!(ignored.matches.is_empty());
}

#[test]
fn search_workspace_paths_supports_regex_and_respects_gitignore() {
    let workspace = TestWorkspace::new("search-paths");
    fs::create_dir_all(workspace.file_path("src")).expect("should create src dir");
    fs::create_dir_all(workspace.file_path("generated")).expect("should create ignored dir");
    fs::write(workspace.file_path(".gitignore"), b"generated/\n")
        .expect("should write ignore file");
    fs::write(
        workspace.file_path("src/main.ts"),
        b"export const value = 1;\n",
    )
    .expect("should write main fixture");
    fs::write(
        workspace.file_path("src/Feature.ts"),
        b"export const feature = true;\n",
    )
    .expect("should write feature fixture");
    fs::write(
        workspace.file_path("generated/FeatureHidden.ts"),
        b"hidden\n",
    )
    .expect("should write ignored path fixture");

    let result = search::search_workspace_paths_impl(
        workspace.workspace_arg(),
        "main|feature".to_string(),
        Some(false),
        Some(true),
        Some(10),
        None,
    )
    .expect("path search should succeed");

    let paths = result
        .matches
        .iter()
        .map(|entry| entry.path.clone())
        .collect::<Vec<_>>();

    assert!(paths.contains(&"src/main.ts".to_string()));
    assert!(paths.contains(&"src/Feature.ts".to_string()));
    assert!(!paths.contains(&"generated/FeatureHidden.ts".to_string()));
}

#[tokio::test]
async fn delete_workspace_file_removes_existing_file() {
    let workspace = TestWorkspace::new("delete-existing");
    fs::write(workspace.file_path("scratch.txt"), b"temp\n").expect("should write fixture");

    let removed =
        write::delete_workspace_file(workspace.workspace_arg(), "scratch.txt".to_string())
            .await
            .expect("delete should succeed");

    assert!(removed);
    assert!(!workspace.file_path("scratch.txt").exists());
}

#[tokio::test]
async fn delete_workspace_file_returns_false_when_missing() {
    let workspace = TestWorkspace::new("delete-missing");

    let removed = write::delete_workspace_file(workspace.workspace_arg(), "nope.txt".to_string())
        .await
        .expect("missing file should not error");

    assert!(!removed);
}

#[tokio::test]
async fn delete_workspace_file_rejects_escaping_paths() {
    let workspace = TestWorkspace::new("delete-escape");

    let error = match write::delete_workspace_file(
        workspace.workspace_arg(),
        "../escape.txt".to_string(),
    )
    .await
    {
        Ok(_) => panic!("path traversal should be rejected"),
        Err(error) => error,
    };

    assert!(!error.is_empty());
}

#[tokio::test]
async fn delete_workspace_dir_removes_existing_directory() {
    let workspace = TestWorkspace::new("delete-dir-existing");
    fs::create_dir_all(workspace.file_path("skill/scripts"))
        .expect("should create nested dir fixture");
    fs::write(workspace.file_path("skill/SKILL.md"), b"body\n").expect("should write skill file");
    fs::write(workspace.file_path("skill/scripts/run.sh"), b"echo ok\n")
        .expect("should write nested file");

    let removed = write::delete_workspace_dir(workspace.workspace_arg(), "skill".to_string())
        .await
        .expect("delete dir should succeed");

    assert!(removed);
    assert!(!workspace.file_path("skill").exists());
}

#[tokio::test]
async fn delete_workspace_dir_returns_false_when_missing() {
    let workspace = TestWorkspace::new("delete-dir-missing");

    let removed = write::delete_workspace_dir(workspace.workspace_arg(), "missing".to_string())
        .await
        .expect("missing dir should not error");

    assert!(!removed);
}

#[tokio::test]
async fn delete_workspace_dir_rejects_escaping_paths() {
    let workspace = TestWorkspace::new("delete-dir-escape");

    let error =
        match write::delete_workspace_dir(workspace.workspace_arg(), "../escape".to_string())
            .await
        {
            Ok(_) => panic!("path traversal should be rejected"),
            Err(error) => error,
        };

    assert!(!error.is_empty());
}

#[test]
fn should_ignore_file_filters_os_noise_case_insensitively() {
    assert!(should_ignore_file(".DS_Store"));
    assert!(should_ignore_file(".ds_store"));
    assert!(should_ignore_file("Thumbs.db"));
    assert!(should_ignore_file("thumbs.db"));
    assert!(should_ignore_file("desktop.ini"));
    assert!(!should_ignore_file("main.ts"));
    assert!(!should_ignore_file(".gitignore"));
}

#[test]
fn read_text_file_strips_utf8_bom() {
    let workspace = TestWorkspace::new("utf8-bom");
    fs::write(workspace.file_path("bom.txt"), b"\xef\xbb\xbfhello\n")
        .expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "bom.txt".to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .expect("utf-8 BOM file should be readable");

    assert_eq!(result.content, "hello\n");
}

#[test]
fn read_text_file_decodes_utf16le_with_bom() {
    let workspace = TestWorkspace::new("utf16-read");
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "hello\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(workspace.file_path("utf16.txt"), &bytes).expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "utf16.txt".to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .expect("utf-16 LE file should be readable");

    assert_eq!(result.content, "hello\n");
}

#[test]
fn read_text_file_splits_lone_cr_line_endings() {
    let workspace = TestWorkspace::new("cr-lines");
    fs::write(workspace.file_path("cr.txt"), b"alpha\rbeta\rgamma\n")
        .expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "cr.txt".to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .expect("lone-cr file should be readable");

    // 孤立 \r 也按换行计；全文读取保留原始字节（与 CRLF 行为一致）
    assert_eq!(result.total_lines, 3);
}

#[test]
fn search_workspace_text_decodes_utf16le_with_bom() {
    let workspace = TestWorkspace::new("search-utf16");
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "export const value = 1;\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(workspace.file_path("utf16.txt"), &bytes).expect("should write fixture");

    let result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "value".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("utf-16 file should be searchable");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, "utf16.txt");
    assert_eq!(result.skipped_files, 0);
}

#[test]
fn search_workspace_text_decodes_gbk_chinese_content() {
    let workspace = TestWorkspace::new("search-gbk");
    // 「你好世界」的 GBK 编码
    fs::write(
        workspace.file_path("gbk.txt"),
        b"\xC4\xE3\xBA\xC3\xCA\xC0\xBD\xE7\n",
    )
    .expect("should write fixture");

    let result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "世界".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("gbk file should be searchable");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, "gbk.txt");
    assert!(result.matches[0].preview.contains("世界"));
}

#[test]
fn search_workspace_text_degrades_invalid_regex_to_literal() {
    let workspace = TestWorkspace::new("search-regex-degrade");
    fs::create_dir_all(workspace.file_path("src")).expect("should create src dir");
    fs::write(workspace.file_path("src/main.ts"), b"call foo(bar) here\n")
        .expect("should write fixture");

    // 「foo(bar」是非法正则（未闭合括号），应降级为字面量搜索并命中
    let result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "foo(bar".to_string(),
        None,
        Some(true),
        None,
        None,
        None,
        None,
        None,
    )
    .expect("invalid regex should degrade instead of failing");

    assert!(result.regex_degraded);
    assert!(result.note.unwrap_or_default().contains("降级"));
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].line, 1);
}

#[test]
fn search_workspace_text_counts_skipped_binary_files() {
    let workspace = TestWorkspace::new("search-skipped");
    fs::create_dir_all(workspace.file_path("src")).expect("should create src dir");
    fs::write(workspace.file_path("src/main.ts"), b"needle token\n")
        .expect("should write text fixture");
    fs::write(
        workspace.file_path("blob.bin"),
        [0x00u8, 0x01, 0x02, 0x03, 0x04, 0x05],
    )
    .expect("should write binary fixture");

    let result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("search should succeed");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.skipped_files, 1);
}

#[test]
fn write_text_file_preserves_utf16le_bom_encoding() {
    let workspace = TestWorkspace::new("write-utf16");
    let mut original = vec![0xFF, 0xFE];
    for unit in "hello\n".encode_utf16() {
        original.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(workspace.file_path("utf16.txt"), &original).expect("should write fixture");

    let result = write::write_text_file_impl(
        workspace.workspace_arg(),
        "utf16.txt".to_string(),
        "world\n".to_string(),
    )
    .expect("write should succeed");

    assert_eq!(result.encoding.as_deref(), Some("utf-16le"));
    let bytes = fs::read(workspace.file_path("utf16.txt")).expect("should read back");
    assert_eq!(bytes, [0xFF, 0xFE, b'w', 0, b'o', 0, b'r', 0, b'l', 0, b'd', 0, 0x0A, 0]);
}

#[test]
fn write_text_file_preserves_gbk_encoding() {
    let workspace = TestWorkspace::new("write-gbk");
    // 「你好」的 GBK 编码
    fs::write(workspace.file_path("gbk.txt"), b"\xC4\xE3\xBA\xC3")
        .expect("should write fixture");

    let result = write::write_text_file_impl(
        workspace.workspace_arg(),
        "gbk.txt".to_string(),
        "世界abc".to_string(),
    )
    .expect("write should succeed");

    assert_eq!(result.encoding.as_deref(), Some("gb18030"));
    let bytes = fs::read(workspace.file_path("gbk.txt")).expect("should read back");
    assert_eq!(bytes, b"\xCA\xC0\xBD\xE7abc");
}

#[test]
fn write_text_file_preserves_utf8_bom() {
    let workspace = TestWorkspace::new("write-bom");
    fs::write(workspace.file_path("bom.txt"), b"\xef\xbb\xbfhello\n")
        .expect("should write fixture");

    let result = write::write_text_file_impl(
        workspace.workspace_arg(),
        "bom.txt".to_string(),
        "world\n".to_string(),
    )
    .expect("write should succeed");

    assert_eq!(result.encoding.as_deref(), Some("utf-8-bom"));
    let bytes = fs::read(workspace.file_path("bom.txt")).expect("should read back");
    assert_eq!(bytes, b"\xef\xbb\xbfworld\n");
}

#[test]
fn write_text_file_new_file_is_plain_utf8() {
    let workspace = TestWorkspace::new("write-new");

    let result = write::write_text_file_impl(
        workspace.workspace_arg(),
        "new.txt".to_string(),
        "plain\n".to_string(),
    )
    .expect("write should succeed");

    assert_eq!(result.encoding, None);
    let bytes = fs::read(workspace.file_path("new.txt")).expect("should read back");
    assert_eq!(bytes, b"plain\n");
}

#[test]
fn write_text_file_change_summary_works_for_gbk_files() {
    let workspace = TestWorkspace::new("write-gbk-summary");
    // 「第一行\n第二行\n」的 GBK 编码
    fs::write(
        workspace.file_path("gbk.txt"),
        b"\xB5\xDA\xD2\xBB\xD0\xD0\n\xB5\xDA\xB6\xFE\xD0\xD0\n",
    )
    .expect("should write fixture");

    let result = write::write_text_file_impl(
        workspace.workspace_arg(),
        "gbk.txt".to_string(),
        "第一行\n第三行\n".to_string(),
    )
    .expect("write should succeed");

    // 旧内容能正确解码时，摘要应是增量 diff 而不是整文件当新增
    assert_eq!(result.change.kind, "updated");
    assert_eq!(result.change.added, 1);
    assert_eq!(result.change.deleted, 1);
}

#[test]
fn read_text_file_handles_utf16_truncated_at_odd_byte() {
    let workspace = TestWorkspace::new("read-utf16-trunc");
    let mut bytes = vec![0xFF, 0xFE];
    let text = "x".repeat(600);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(workspace.file_path("utf16.txt"), &bytes).expect("should write fixture");

    // 1202 字节 = BOM(2) + 600 码元(1200)；上限 1000 会落在奇数字节
    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "utf16.txt".to_string(),
        Some(1000),
        None,
        None,
        None,
        None,
    )
    .expect("truncated utf-16 read should not fail");

    assert!(result.truncated_by_bytes);
    assert!(result.content.starts_with('x'));
}

#[test]
fn read_text_file_trims_incomplete_utf8_tail_at_truncation() {
    let workspace = TestWorkspace::new("read-utf8-trunc");
    // 999 个 a + 「汉」(3 字节) = 1002 字节；上限 1000 落在多字节序列中间
    let mut text = "a".repeat(999);
    text.push('汉');
    fs::write(workspace.file_path("note.txt"), text.as_bytes()).expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "note.txt".to_string(),
        Some(1000),
        None,
        None,
        None,
        None,
    )
    .expect("truncated utf-8 read should not fail");

    assert!(result.truncated_by_bytes);
    // 不完整尾部序列被修剪：不应出现替换字符或 GB18030 乱码
    assert_eq!(result.content, "a".repeat(999));
}

#[cfg(unix)]
#[test]
fn list_workspace_files_survives_broken_symlink() {
    let workspace = TestWorkspace::new("list-broken-symlink");
    fs::write(workspace.file_path("real.txt"), b"content\n").expect("should write fixture");
    std::os::unix::fs::symlink(
        workspace.file_path("missing-target.txt"),
        workspace.file_path("broken-link"),
    )
    .expect("should create symlink");

    let result = list::list_workspace_files_impl(workspace.workspace_arg(), None, Some(2), None)
        .expect("broken symlink should not break listing");

    let paths: Vec<String> = result.entries.iter().map(|e| e.path.clone()).collect();
    assert!(paths.contains(&"real.txt".to_string()));
}

#[test]
fn search_workspace_text_includes_dot_dirs_but_excludes_git() {
    let workspace = TestWorkspace::new("search-dot-dirs");
    fs::create_dir_all(workspace.file_path(".github/workflows"))
        .expect("should create .github dir");
    fs::create_dir_all(workspace.file_path(".git")).expect("should create .git dir");
    fs::write(
        workspace.file_path(".github/workflows/ci.yml"),
        b"needle-dotdir\n",
    )
    .expect("should write fixture");
    fs::write(workspace.file_path(".git/config"), b"needle-git\n")
        .expect("should write fixture");

    let result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle-dotdir".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("search should succeed");
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, ".github/workflows/ci.yml");

    let git_result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle-git".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .expect("search should succeed");
    assert!(git_result.matches.is_empty());
}

#[test]
fn search_workspace_text_counts_oversized_files_as_skipped() {
    let workspace = TestWorkspace::new("search-oversized");
    fs::write(workspace.file_path("small.txt"), b"needle small\n")
        .expect("should write fixture");
    fs::write(workspace.file_path("big.txt"), vec![b'x'; 4096])
        .expect("should write fixture");

    let result = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle".to_string(),
        None,
        None,
        None,
        None,
        None,
        Some(2000),
        None,
    )
    .expect("search should succeed");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.skipped_files, 1);
}

#[test]
fn read_text_file_window_preserves_crlf_line_endings() {
    let workspace = TestWorkspace::new("window-crlf");
    fs::write(
        workspace.file_path("crlf.txt"),
        b"alpha\r\nbeta\r\ngamma\r\n",
    )
    .expect("should write fixture");

    let result = read::read_text_file_impl(
        workspace.workspace_arg(),
        "crlf.txt".to_string(),
        None,
        Some(2),
        Some(2),
        None,
        None,
    )
    .expect("window read should succeed");

    // 窗口读取与整读一致：CRLF 文件不降级为 LF
    assert_eq!(result.content, "beta\r\n");
    assert_eq!(result.total_lines, 3);
}

#[test]
fn list_workspace_files_excludes_ds_store_and_ignored_dirs() {
    let workspace = TestWorkspace::new("list-ignore-noise");
    fs::create_dir_all(workspace.file_path("src")).expect("should create src dir");
    fs::write(workspace.file_path("src/main.ts"), b"export const value = 1;\n")
        .expect("should write source fixture");
    fs::write(workspace.file_path(".DS_Store"), b"binary-noise\n")
        .expect("should write macos noise file");
    fs::write(workspace.file_path("Thumbs.db"), b"windows-noise\n")
        .expect("should write windows noise file");

    let result = list::list_workspace_files_impl(
        workspace.workspace_arg(),
        None,
        Some(2),
        None,
    )
    .expect("list should succeed");

    let paths: Vec<String> = result.entries.iter().map(|e| e.path.clone()).collect();
    assert!(paths.contains(&"src/main.ts".to_string()));
    assert!(
        !paths.iter().any(|p| p.eq_ignore_ascii_case(".DS_Store")),
        ".DS_Store should be filtered: {paths:?}"
    );
    assert!(
        !paths.iter().any(|p| p.eq_ignore_ascii_case("Thumbs.db")),
        "Thumbs.db should be filtered: {paths:?}"
    );
}

#[test]
fn search_workspace_text_codepapr_apps_gated_by_app_mode() {
    let workspace = TestWorkspace::new("search-codepapr-apps");
    fs::create_dir_all(workspace.file_path(".CodePapr/apps/my-app"))
        .expect("should create app dir");
    fs::create_dir_all(workspace.file_path(".CodePapr/git"))
        .expect("should create shadow git dir");
    fs::write(
        workspace.file_path(".CodePapr/apps/my-app/index.html"),
        b"<html>needle-app</html>\n",
    )
    .expect("should write app fixture");
    fs::write(workspace.file_path(".CodePapr/memory.md"), b"needle-memory\n")
        .expect("should write memory fixture");
    fs::write(workspace.file_path(".CodePapr/git/config"), b"needle-shadow-git\n")
        .expect("should write shadow git fixture");
    // 项目 .gitignore 通常忽略 .CodePapr/：app 模式白名单需要穿透它
    fs::write(workspace.file_path(".gitignore"), b".CodePapr/\n")
        .expect("should write gitignore");
    fs::write(workspace.file_path("src-note.txt"), b"needle-app outside\n")
        .expect("should write outside fixture");

    // app 模式：能搜到 .CodePapr/apps 下的应用源码（穿透 gitignore），
    // 但 memory.md / git/ 等内部状态仍被屏蔽
    let app_mode = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle-app".to_string(),
        None,
        None,
        None,
        Some(20),
        None,
        None,
        Some(true),
    )
    .expect("app-mode search should succeed");
    let app_paths: Vec<String> = app_mode.matches.iter().map(|m| m.path.clone()).collect();
    assert!(
        app_paths.contains(&".CodePapr/apps/my-app/index.html".to_string()),
        "app mode should search .CodePapr/apps: {app_paths:?}"
    );
    assert!(app_paths.contains(&"src-note.txt".to_string()));

    let memory_hit = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle-memory".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        Some(true),
    )
    .expect("app-mode memory search should succeed");
    assert!(memory_hit.matches.is_empty(), "memory.md must stay hidden");

    let git_hit = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle-shadow-git".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        Some(true),
    )
    .expect("app-mode git search should succeed");
    assert!(git_hit.matches.is_empty(), ".CodePapr/git must stay hidden");

    // 非 app 模式：.CodePapr 全量屏蔽（含 apps）
    let non_app = search::search_workspace_text_impl(
        workspace.workspace_arg(),
        "needle-app".to_string(),
        None,
        None,
        None,
        Some(20),
        None,
        None,
        None,
    )
    .expect("non-app search should succeed");
    let non_app_paths: Vec<String> = non_app.matches.iter().map(|m| m.path.clone()).collect();
    assert_eq!(non_app_paths, vec!["src-note.txt".to_string()]);
}

#[test]
fn search_workspace_paths_codepapr_apps_gated_by_app_mode() {
    let workspace = TestWorkspace::new("search-paths-codepapr-apps");
    fs::create_dir_all(workspace.file_path(".CodePapr/apps/my-app"))
        .expect("should create app dir");
    fs::write(
        workspace.file_path(".CodePapr/apps/my-app/index.html"),
        b"<html></html>\n",
    )
    .expect("should write app fixture");
    fs::write(workspace.file_path(".gitignore"), b".CodePapr/\n")
        .expect("should write gitignore");

    let app_mode = search::search_workspace_paths_impl(
        workspace.workspace_arg(),
        "index\\.html".to_string(),
        Some(true),
        Some(true),
        Some(20),
        Some(true),
    )
    .expect("app-mode path search should succeed");
    let paths: Vec<String> = app_mode.matches.iter().map(|m| m.path.clone()).collect();
    assert!(
        paths.contains(&".CodePapr/apps/my-app/index.html".to_string()),
        "app mode should find app files by path: {paths:?}"
    );

    let non_app = search::search_workspace_paths_impl(
        workspace.workspace_arg(),
        "index\\.html".to_string(),
        Some(true),
        Some(true),
        Some(20),
        None,
    )
    .expect("non-app path search should succeed");
    assert!(non_app.matches.is_empty());
}

#[test]
fn list_workspace_files_codepapr_apps_gated_by_app_mode() {
    let workspace = TestWorkspace::new("list-codepapr-apps");
    fs::create_dir_all(workspace.file_path(".CodePapr/apps/my-app"))
        .expect("should create app dir");
    fs::create_dir_all(workspace.file_path(".CodePapr/skills"))
        .expect("should create skills dir");
    fs::write(
        workspace.file_path(".CodePapr/apps/my-app/index.html"),
        b"<html></html>\n",
    )
    .expect("should write app fixture");
    fs::write(workspace.file_path(".CodePapr/skills/search.md"), b"skill\n")
        .expect("should write skill fixture");
    fs::write(workspace.file_path(".CodePapr/project.sqlite"), b"db\n")
        .expect("should write db fixture");
    fs::write(workspace.file_path("src-note.txt"), b"note\n")
        .expect("should write outside fixture");

    // 非 app 模式：根目录遍历不出现 .CodePapr 任何内容
    let non_app = list::list_workspace_files_impl(
        workspace.workspace_arg(),
        None,
        Some(6),
        None,
    )
    .expect("non-app list should succeed");
    let paths: Vec<String> = non_app.entries.iter().map(|e| e.path.clone()).collect();
    assert!(paths.contains(&"src-note.txt".to_string()));
    assert!(
        !paths.iter().any(|p| p.starts_with(".CodePapr")),
        "non-app mode must hide .CodePapr: {paths:?}"
    );

    // app 模式：仅放行 apps 子树，skills/project.sqlite 仍隐藏
    let app_mode = list::list_workspace_files_impl(
        workspace.workspace_arg(),
        None,
        Some(6),
        Some(true),
    )
    .expect("app-mode list should succeed");
    let paths: Vec<String> = app_mode.entries.iter().map(|e| e.path.clone()).collect();
    assert!(
        paths.contains(&".CodePapr/apps/my-app/index.html".to_string()),
        "app mode should list app files: {paths:?}"
    );
    assert!(
        !paths.iter().any(|p| p.starts_with(".CodePapr/skills")),
        "skills must stay hidden in broad listing: {paths:?}"
    );
    assert!(
        !paths.contains(&".CodePapr/project.sqlite".to_string()),
        "project.sqlite must stay hidden: {paths:?}"
    );

    // 定向访问不受模式管控：skills 加载链路（显式 relativePath）保持可用
    let targeted = list::list_workspace_files_impl(
        workspace.workspace_arg(),
        Some(".CodePapr/skills".to_string()),
        Some(2),
        None,
    )
    .expect("targeted skills list should succeed");
    let paths: Vec<String> = targeted.entries.iter().map(|e| e.path.clone()).collect();
    assert!(
        paths.contains(&".CodePapr/skills/search.md".to_string()),
        "explicit skills listing must keep working: {paths:?}"
    );
}
