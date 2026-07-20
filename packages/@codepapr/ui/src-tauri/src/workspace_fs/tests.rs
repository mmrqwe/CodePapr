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
