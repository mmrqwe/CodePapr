//! Native project code statistics.
//!
//! Replaces the old frontend approach that read every file over IPC. Walks the
//! workspace once (gitignore-aware, parallel) and computes per-language line
//! counts classified into code / blank / comment, plus directory and file-size
//! breakdowns.

use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};

use ignore::WalkBuilder;
use serde::Serialize;

use crate::shared::{canonical_workspace, lock, relative_string, run_blocking_workspace_task};

use super::read::decode_text_bytes;
use super::should_ignore_dir;

/// Safety cap so a pathological repo cannot produce an unbounded result.
const MAX_FILES: usize = 500_000;

// ── Language detection (ported from ui/src/utils/editorLanguage.ts) ────

pub(crate) fn language_from_path(path: &str) -> &'static str {
    let filename_owned = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let filename = filename_owned.as_str();

    if filename == "dockerfile" || filename.ends_with(".dockerfile") {
        return "dockerfile";
    }
    if filename == "makefile" {
        return "shell";
    }
    if filename == ".env" || filename.starts_with(".env.") {
        return "ini";
    }
    if matches!(
        filename,
        ".babelrc" | ".eslintrc" | ".prettierrc" | ".stylelintrc" | ".swcrc"
    ) {
        return "json";
    }
    if filename == ".editorconfig" {
        return "ini";
    }
    if matches!(filename, ".dockerignore" | ".gitignore" | ".npmignore") {
        return "plaintext";
    }

    let extension = if filename.contains('.') {
        filename.rsplit('.').next().unwrap_or("")
    } else {
        filename
    };

    match extension {
        "bat" | "cmd" => "bat",
        "bicep" => "bicep",
        "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" => "cpp",
        "cs" | "csx" => "csharp",
        "css" => "css",
        "dart" => "dart",
        "fs" | "fsi" | "fsx" => "fsharp",
        "go" => "go",
        "graphql" | "gql" => "graphql",
        "htm" | "html" | "shtml" => "html",
        "ini" | "conf" | "cfg" | "properties" | "toml" => "ini",
        "java" => "java",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "json" | "jsonc" => "json",
        "kt" | "kts" => "kotlin",
        "less" => "less",
        "lua" => "lua",
        "m" | "mm" => "objective-c",
        "md" | "mdx" => "markdown",
        "mysql" => "mysql",
        "p6" | "pl" | "pm" => "perl",
        "pgsql" => "pgsql",
        "php" => "php",
        "proto" => "protobuf",
        "ps1" | "psd1" | "psm1" => "powershell",
        "py" | "pyi" | "pyw" => "python",
        "r" => "r",
        "rb" => "ruby",
        "rs" => "rust",
        "scala" | "sc" => "scala",
        "scss" => "scss",
        "sh" | "bash" | "zsh" => "shell",
        "sql" => "sql",
        "swift" => "swift",
        "ts" | "tsx" => "typescript",
        "vb" => "vb",
        "xml" | "xaml" | "csproj" | "fsproj" | "props" | "svg" => "xml",
        "yaml" | "yml" => "yaml",
        _ => "plaintext",
    }
}

// ── code / blank / comment classification ──────────────────────────────

struct CommentSyntax {
    /// Line-comment prefixes (matched against the trimmed line start).
    line: &'static [&'static str],
    /// Block-comment (start, end) pairs (opener matched at trimmed line start).
    block: &'static [(&'static str, &'static str)],
}

static C_STYLE: CommentSyntax = CommentSyntax { line: &["//"], block: &[("/*", "*/")] };
static C_STYLE_HASH: CommentSyntax = CommentSyntax { line: &["//", "#"], block: &[("/*", "*/")] };
static CSS_STYLE: CommentSyntax = CommentSyntax { line: &[], block: &[("/*", "*/")] };
static HASH: CommentSyntax = CommentSyntax { line: &["#"], block: &[] };
static SQL_STYLE: CommentSyntax = CommentSyntax { line: &["--"], block: &[("/*", "*/")] };
static HTML_STYLE: CommentSyntax = CommentSyntax { line: &[], block: &[("<!--", "-->")] };
static PYTHON_STYLE: CommentSyntax =
    CommentSyntax { line: &["#"], block: &[("\"\"\"", "\"\"\""), ("'''", "'''")] };
static LUA_STYLE: CommentSyntax = CommentSyntax { line: &["--"], block: &[("--[[", "]]")] };
static RUBY_STYLE: CommentSyntax = CommentSyntax { line: &["#"], block: &[("=begin", "=end")] };
static POWERSHELL_STYLE: CommentSyntax = CommentSyntax { line: &["#"], block: &[("<#", "#>")] };
static FSHARP_STYLE: CommentSyntax = CommentSyntax { line: &["//"], block: &[("(*", "*)")] };
static SEMI_HASH: CommentSyntax = CommentSyntax { line: &[";", "#"], block: &[] };
static VB_STYLE: CommentSyntax = CommentSyntax { line: &["'"], block: &[] };
static BAT_STYLE: CommentSyntax = CommentSyntax { line: &["::"], block: &[] };

fn comment_syntax(language: &str) -> Option<&'static CommentSyntax> {
    match language {
        "cpp" | "csharp" | "dart" | "go" | "java" | "javascript" | "kotlin" | "objective-c"
        | "protobuf" | "rust" | "scala" | "swift" | "typescript" | "graphql" | "less" | "scss"
        | "bicep" => Some(&C_STYLE),
        "php" => Some(&C_STYLE_HASH),
        "css" => Some(&CSS_STYLE),
        "fsharp" => Some(&FSHARP_STYLE),
        "python" => Some(&PYTHON_STYLE),
        "sql" | "mysql" | "pgsql" => Some(&SQL_STYLE),
        "lua" => Some(&LUA_STYLE),
        "html" | "xml" | "markdown" => Some(&HTML_STYLE),
        "ruby" => Some(&RUBY_STYLE),
        "powershell" => Some(&POWERSHELL_STYLE),
        "ini" => Some(&SEMI_HASH),
        "vb" => Some(&VB_STYLE),
        "bat" => Some(&BAT_STYLE),
        "shell" | "dockerfile" | "yaml" | "r" | "perl" => Some(&HASH),
        _ => None,
    }
}

#[derive(Default, Clone, Copy)]
struct LineCounts {
    code: u64,
    blank: u64,
    comment: u64,
}

/// Classify each line as code / blank / comment using a per-language comment
/// syntax with a cross-line block-comment state machine. This is a heuristic
/// (line comments and block openers are recognised at the trimmed line start;
/// a line mixing code with a trailing comment counts as code, matching cloc).
fn classify_lines(content: &str, syntax: Option<&CommentSyntax>) -> LineCounts {
    let mut counts = LineCounts::default();
    let mut block_end: Option<&str> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            counts.blank += 1;
            continue;
        }

        if let Some(end) = block_end {
            counts.comment += 1;
            if line.contains(end) {
                block_end = None;
            }
            continue;
        }

        let Some(syntax) = syntax else {
            counts.code += 1;
            continue;
        };

        if syntax.line.iter().any(|prefix| trimmed.starts_with(prefix)) {
            counts.comment += 1;
            continue;
        }

        let mut handled = false;
        for (start, end) in syntax.block {
            if trimmed.starts_with(start) {
                counts.comment += 1;
                if let Some(opener_pos) = line.find(start) {
                    let after_opener = &line[opener_pos + start.len()..];
                    if !after_opener.contains(end) {
                        block_end = Some(end);
                    }
                }
                handled = true;
                break;
            }
        }
        if handled {
            continue;
        }

        counts.code += 1;
    }

    counts
}

// ── file category (for the code/config/doc ratio) ──────────────────────

fn file_category(language: &str) -> FileCategory {
    match language {
        "markdown" | "plaintext" => FileCategory::Doc,
        "json" | "ini" | "yaml" | "xml" | "bicep" => FileCategory::Config,
        _ => FileCategory::Code,
    }
}

enum FileCategory {
    Code,
    Config,
    Doc,
}

fn is_code_language(language: &str) -> bool {
    !matches!(language, "plaintext" | "markdown")
}

// ── aggregation ────────────────────────────────────────────────────────

#[derive(Default)]
struct LangAgg {
    files: u64,
    lines: u64,
    code: u64,
    blank: u64,
    comment: u64,
}

#[derive(Default)]
struct DirAgg {
    files: u64,
    lines: u64,
}

#[derive(Default)]
struct Aggregator {
    total_files: u64,
    total_directories: u64,
    text_files: u64,
    code_files: u64,
    skipped_files: u64,
    total_lines: u64,
    code_lines: u64,
    blank_lines: u64,
    comment_lines: u64,
    code_cat_lines: u64,
    config_cat_lines: u64,
    doc_cat_lines: u64,
    languages: HashMap<String, LangAgg>,
    dirs: HashMap<String, DirAgg>,
    file_line_counts: Vec<u64>,
    largest_file: Option<(String, u64)>,
    truncated: bool,
}

fn top_level_dir(relative: &str) -> String {
    let normalized = relative.strip_prefix("./").unwrap_or(relative);
    match normalized.find('/') {
        Some(idx) => normalized[..idx].to_string(),
        None => "(root)".to_string(),
    }
}

// ── result types (mirror the frontend ProjectStatsResult) ──────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageStat {
    id: String,
    files: u64,
    lines: u64,
    code: u64,
    blank: u64,
    comment: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryStat {
    name: String,
    files: u64,
    lines: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSizeBucket {
    label: String,
    files: u64,
    lines: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeRatio {
    code: u64,
    config: u64,
    doc: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AverageMetrics {
    avg_lines_per_file: u64,
    median_lines_per_file: u64,
    max_lines_per_file: u64,
    total_text_files: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LargestFile {
    path: String,
    lines: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectStatsResult {
    total_files: u64,
    total_directories: u64,
    text_files: u64,
    code_files: u64,
    skipped_files: u64,
    total_lines: u64,
    code_lines: u64,
    blank_lines: u64,
    comment_lines: u64,
    languages: Vec<LanguageStat>,
    largest_file: Option<LargestFile>,
    truncated: bool,
    directory_breakdown: Vec<DirectoryStat>,
    file_size_distribution: Vec<FileSizeBucket>,
    code_ratio: CodeRatio,
    avg_metrics: AverageMetrics,
}

// ── command ────────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn compute_project_stats(
    workspace_path: String,
) -> Result<ProjectStatsResult, String> {
    run_blocking_workspace_task(move || compute_project_stats_impl(&workspace_path)).await
}

pub(crate) fn compute_project_stats_impl(workspace_path: &str) -> Result<ProjectStatsResult, String> {
    let workspace = canonical_workspace(workspace_path)?;

    let mut builder = WalkBuilder::new(&workspace);
    builder
        .hidden(false)
        .require_git(false)
        .parents(true)
        .git_ignore(true)
        .git_exclude(true)
        .ignore(true)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            entry
                .file_name()
                .to_str()
                .map(|name| !should_ignore_dir(name))
                .unwrap_or(true)
        });

    let walker = builder.build_parallel();
    let workspace_ref = workspace.clone();
    let aggregator = Arc::new(Mutex::new(Aggregator::default()));

    walker.run(|| {
        let workspace = workspace_ref.clone();
        let aggregator = Arc::clone(&aggregator);
        Box::new(move |entry_result| {
            let entry = match entry_result {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };
            if entry.depth() == 0 {
                return ignore::WalkState::Continue;
            }
            let Some(file_type) = entry.file_type() else {
                return ignore::WalkState::Continue;
            };

            if file_type.is_dir() {
                let mut agg = lock(&aggregator);
                agg.total_directories += 1;
                return ignore::WalkState::Continue;
            }
            if !file_type.is_file() {
                return ignore::WalkState::Continue;
            }

            // 超大文件（数据集等）只计数不读内容：旧实现对每个文件整体
            // fs::read 进内存，workspace 里放一个多 GB 文件就能 OOM。
            const MAX_STATS_READ_BYTES: u64 = 100 * 1024 * 1024;
            let too_large = entry
                .metadata()
                .map(|m| m.len() > MAX_STATS_READ_BYTES)
                .unwrap_or(false);
            let path = entry.into_path();
            let relative = relative_string(workspace.as_path(), &path);

            let mut agg = lock(&aggregator);
            if agg.truncated {
                return ignore::WalkState::Quit;
            }
            agg.total_files += 1;
            if agg.total_files > MAX_FILES as u64 {
                agg.truncated = true;
                return ignore::WalkState::Quit;
            }

            let language = language_from_path(&relative);

            if too_large {
                agg.skipped_files += 1;
                return ignore::WalkState::Continue;
            }

            let buffer = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => {
                    agg.skipped_files += 1;
                    return ignore::WalkState::Continue;
                }
            };
            let content = match decode_text_bytes(buffer) {
                Ok(c) => c,
                Err(_) => {
                    agg.skipped_files += 1;
                    return ignore::WalkState::Continue;
                }
            };

            let counts = classify_lines(&content, comment_syntax(language));
            let lines = counts.code + counts.blank + counts.comment;

            agg.text_files += 1;
            agg.total_lines += lines;
            agg.code_lines += counts.code;
            agg.blank_lines += counts.blank;
            agg.comment_lines += counts.comment;
            agg.file_line_counts.push(lines);

            if is_code_language(language) {
                agg.code_files += 1;
            }
            match file_category(language) {
                FileCategory::Code => agg.code_cat_lines += lines,
                FileCategory::Config => agg.config_cat_lines += lines,
                FileCategory::Doc => agg.doc_cat_lines += lines,
            }

            let lang = agg.languages.entry(language.to_string()).or_default();
            lang.files += 1;
            lang.lines += lines;
            lang.code += counts.code;
            lang.blank += counts.blank;
            lang.comment += counts.comment;

            let dir = agg.dirs.entry(top_level_dir(&relative)).or_default();
            dir.files += 1;
            dir.lines += lines;

            if agg.largest_file.as_ref().map(|(_, l)| lines > *l).unwrap_or(true) {
                agg.largest_file = Some((relative, lines));
            }

            ignore::WalkState::Continue
        })
    });

    let agg = Arc::try_unwrap(aggregator)
        .unwrap_or_else(|_| unreachable!())
        .into_inner()
        .unwrap_or_else(|e| e.into_inner());

    Ok(finalize(agg))
}

fn median(values: &[u64]) -> u64 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) / 2
    } else {
        sorted[mid]
    }
}

fn finalize(agg: Aggregator) -> ProjectStatsResult {
    let mut languages: Vec<LanguageStat> = agg
        .languages
        .into_iter()
        .map(|(id, l)| LanguageStat {
            id,
            files: l.files,
            lines: l.lines,
            code: l.code,
            blank: l.blank,
            comment: l.comment,
        })
        .collect();
    languages.sort_by(|a, b| b.lines.cmp(&a.lines));

    let mut directory_breakdown: Vec<DirectoryStat> = agg
        .dirs
        .into_iter()
        .map(|(name, d)| DirectoryStat { name, files: d.files, lines: d.lines })
        .collect();
    directory_breakdown.sort_by(|a, b| b.lines.cmp(&a.lines));
    directory_breakdown.truncate(8);

    let mut small = FileSizeBucket { label: "small".to_string(), files: 0, lines: 0 };
    let mut medium = FileSizeBucket { label: "medium".to_string(), files: 0, lines: 0 };
    let mut large = FileSizeBucket { label: "large".to_string(), files: 0, lines: 0 };
    for lines in &agg.file_line_counts {
        if *lines < 200 {
            small.files += 1;
            small.lines += lines;
        } else if *lines < 1000 {
            medium.files += 1;
            medium.lines += lines;
        } else {
            large.files += 1;
            large.lines += lines;
        }
    }
    let file_size_distribution: Vec<FileSizeBucket> = [small, medium, large]
        .into_iter()
        .filter(|b| b.files > 0)
        .collect();

    let text_files = agg.text_files;
    let total_lines = agg.total_lines;
    let avg_lines_per_file = if text_files > 0 { total_lines / text_files } else { 0 };
    let median_lines_per_file = median(&agg.file_line_counts);
    let max_lines_per_file = agg.file_line_counts.iter().copied().max().unwrap_or(0);

    ProjectStatsResult {
        total_files: agg.total_files,
        total_directories: agg.total_directories,
        text_files: agg.text_files,
        code_files: agg.code_files,
        skipped_files: agg.skipped_files,
        total_lines: agg.total_lines,
        code_lines: agg.code_lines,
        blank_lines: agg.blank_lines,
        comment_lines: agg.comment_lines,
        languages,
        largest_file: agg.largest_file.map(|(path, lines)| LargestFile { path, lines }),
        truncated: agg.truncated,
        directory_breakdown,
        file_size_distribution,
        code_ratio: CodeRatio {
            code: agg.code_cat_lines,
            config: agg.config_cat_lines,
            doc: agg.doc_cat_lines,
        },
        avg_metrics: AverageMetrics {
            avg_lines_per_file,
            median_lines_per_file,
            max_lines_per_file,
            total_text_files: text_files,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_detection_matches_extension_and_special_names() {
        assert_eq!(language_from_path("src/index.ts"), "typescript");
        assert_eq!(language_from_path("src/App.tsx"), "typescript");
        assert_eq!(language_from_path("lib/foo.py"), "python");
        assert_eq!(language_from_path("Dockerfile"), "dockerfile");
        assert_eq!(language_from_path("build.dockerfile"), "dockerfile");
        assert_eq!(language_from_path("Makefile"), "shell");
        assert_eq!(language_from_path(".env"), "ini");
        assert_eq!(language_from_path(".env.local"), "ini");
        assert_eq!(language_from_path(".gitignore"), "plaintext");
        assert_eq!(language_from_path(".eslintrc"), "json");
        assert_eq!(language_from_path("README.md"), "markdown");
        assert_eq!(language_from_path("LICENSE"), "plaintext");
        assert_eq!(language_from_path("win\\script.ps1"), "powershell");
    }

    #[test]
    fn classifies_c_style_code_blank_comment() {
        let content = "// a comment\n\nconst x = 1; // trailing\n/* block\n   still block */\ncode();\n";
        let counts = classify_lines(content, comment_syntax("typescript"));
        // line1 comment, line2 blank, line3 code (trailing comment), line4-5 block comment, line6 code
        assert_eq!(counts.comment, 3);
        assert_eq!(counts.blank, 1);
        assert_eq!(counts.code, 2);
    }

    #[test]
    fn classifies_python_hash_and_docstring() {
        let content = "# comment\nx = 1\n\"\"\"\ndocstring\n\"\"\"\ny = 2\n";
        let counts = classify_lines(content, comment_syntax("python"));
        // # comment(1), x=1 code, """ + docstring + """ = 3 comment, y=2 code
        assert_eq!(counts.comment, 4);
        assert_eq!(counts.code, 2);
        assert_eq!(counts.blank, 0);
    }

    #[test]
    fn classifies_sql_dash_dash_and_block() {
        let content = "-- note\nSELECT 1;\n/* multi\nline */\nSELECT 2;\n";
        let counts = classify_lines(content, comment_syntax("sql"));
        assert_eq!(counts.comment, 3);
        assert_eq!(counts.code, 2);
    }

    #[test]
    fn plaintext_has_no_comments() {
        let content = "hello\n\nworld\n";
        let counts = classify_lines(content, comment_syntax("plaintext"));
        assert_eq!(counts.code, 2);
        assert_eq!(counts.blank, 1);
        assert_eq!(counts.comment, 0);
    }
}
