//! Native project code statistics.
//!
//! Replaces the old frontend approach that read every file over IPC. Walks the
//! workspace once (gitignore-aware, parallel) and computes per-language line
//! counts classified into code / blank / comment, plus directory and file-size
//! breakdowns.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use serde::Serialize;

pub type StatsProgressCallback = Arc<dyn Fn(&str, u64) + Send + Sync + 'static>;

use crate::shared::{canonical_workspace, lock, relative_string, run_blocking_workspace_task};

use super::read::decode_text_bytes;
use super::{should_ignore_dir, should_ignore_file};

/// Safety cap so a pathological repo cannot produce an unbounded result.
const MAX_FILES: usize = 500_000;
const DIR_BREAKDOWN_LIMIT: usize = 16;
const MAX_STATS_READ_BYTES: u64 = 100 * 1024 * 1024;
const PROGRESS_EVERY_FILES: u64 = 250;

/// Dependency / vendored trees that inflate stats when not gitignored.
const STATS_VENDOR_DIRS: &[&str] = &[
    "vendor",
    "Pods",
    ".cargo-vendor",
    "third_party",
    "bower_components",
    "Carthage",
    "site-packages",
];

fn should_ignore_stats_dir(name: &str) -> bool {
    should_ignore_dir(name) || STATS_VENDOR_DIRS.iter().any(|dir| name.eq_ignore_ascii_case(dir))
}

fn filename_of(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn is_lockfile_name(filename: &str) -> bool {
    matches!(
        filename,
        "package-lock.json"
            | "npm-shrinkwrap.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "pnpm-lock.yml"
            | "bun.lock"
            | "bun.lockb"
            | "cargo.lock"
            | "gemfile.lock"
            | "poetry.lock"
            | "composer.lock"
            | "go.sum"
            | "go.work.sum"
            | "pipfile.lock"
            | "pdm.lock"
            | "uv.lock"
            | "flake.lock"
            | "package.resolved"
            | "podfile.lock"
            | "mix.lock"
            | "pubspec.lock"
    )
}

fn is_generated_name(filename: &str) -> bool {
    filename.contains(".min.")
        || filename.contains(".generated.")
        || filename.ends_with(".g.dart")
        || filename.ends_with(".pb.go")
        || filename.ends_with(".pb.ts")
        || filename.ends_with(".pb.js")
        || filename.ends_with(".gen.go")
        || filename.ends_with(".gen.ts")
}

fn is_ignore_dotfile(filename: &str) -> bool {
    matches!(
        filename,
        ".gitignore" | ".dockerignore" | ".npmignore" | ".eslintignore" | ".prettierignore"
    )
}

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
        "clj" | "cljs" | "cljc" | "edn" => "clojure",
        "erl" | "hrl" => "erlang",
        "ex" | "exs" | "heex" => "elixir",
        "gradle" | "groovy" => "groovy",
        "hs" | "lhs" => "haskell",
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
        "svelte" => "svelte",
        "swift" => "swift",
        "ts" | "tsx" => "typescript",
        "vb" => "vb",
        "vue" => "vue",
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
static SEMI: CommentSyntax = CommentSyntax { line: &[";"], block: &[] };
static PERCENT: CommentSyntax = CommentSyntax { line: &["%"], block: &[] };
static VB_STYLE: CommentSyntax = CommentSyntax { line: &["'"], block: &[] };
static BAT_STYLE: CommentSyntax = CommentSyntax { line: &["::"], block: &[] };
static HASKELL_STYLE: CommentSyntax = CommentSyntax { line: &["--"], block: &[("{-", "-}")] };
static WEB_SFC_STYLE: CommentSyntax =
    CommentSyntax { line: &["//"], block: &[("<!--", "-->"), ("/*", "*/")] };

fn comment_syntax(language: &str) -> Option<&'static CommentSyntax> {
    match language {
        "cpp" | "csharp" | "dart" | "go" | "groovy" | "java" | "javascript" | "json" | "kotlin"
        | "objective-c" | "protobuf" | "rust" | "scala" | "swift" | "typescript" | "graphql"
        | "less" | "scss" | "bicep" => Some(&C_STYLE),
        "php" => Some(&C_STYLE_HASH),
        "css" => Some(&CSS_STYLE),
        "fsharp" => Some(&FSHARP_STYLE),
        "python" => Some(&PYTHON_STYLE),
        "sql" | "mysql" | "pgsql" => Some(&SQL_STYLE),
        "lua" => Some(&LUA_STYLE),
        "html" | "xml" | "markdown" => Some(&HTML_STYLE),
        "vue" | "svelte" => Some(&WEB_SFC_STYLE),
        "haskell" => Some(&HASKELL_STYLE),
        "elixir" => Some(&HASH),
        "clojure" => Some(&SEMI),
        "erlang" => Some(&PERCENT),
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
/// syntax with a cross-line block-comment state machine. Line comments and
/// block openers at the trimmed line start are comments; a line that mixes
/// code with a trailing comment counts as code (cloc convention). A block
/// opener later on a code line still opens the block for subsequent lines.
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

        // Block openers first so a longer opener that starts with a line-comment
        // prefix (Lua `--[[` vs `--`) is not eaten as a single-line comment.
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

        if syntax.line.iter().any(|prefix| trimmed.starts_with(prefix)) {
            counts.comment += 1;
            continue;
        }

        counts.code += 1;
        if let Some(end) = trailing_unclosed_block(line, syntax) {
            block_end = Some(end);
        }
    }

    counts
}

/// First unclosed block opener on a code line, ignoring text after a line-comment.
fn trailing_unclosed_block<'a>(line: &'a str, syntax: &'a CommentSyntax) -> Option<&'a str> {
    let search_end = syntax
        .line
        .iter()
        .filter_map(|prefix| line.find(prefix))
        .min()
        .unwrap_or(line.len());
    let search = &line[..search_end];
    let mut unclosed: Option<&str> = None;
    for (start, end) in syntax.block {
        let mut from = 0;
        while let Some(rel) = search[from..].find(start) {
            let abs = from + rel;
            let after = &search[abs + start.len()..];
            unclosed = if after.contains(end) { None } else { Some(end) };
            from = abs + start.len();
        }
    }
    unclosed
}

// ── file category (for the code/config/doc/lockfile ratio) ─────────────

fn file_category(relative: &str, language: &str) -> FileCategory {
    let filename = filename_of(relative).to_ascii_lowercase();
    if is_lockfile_name(&filename) {
        return FileCategory::Lockfile;
    }
    if is_ignore_dotfile(&filename) {
        return FileCategory::Config;
    }
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
    Lockfile,
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
    lockfile_cat_lines: u64,
    languages: HashMap<String, LangAgg>,
    dirs: HashMap<String, DirAgg>,
    file_line_counts: Vec<u64>,
    largest_file: Option<(String, u64)>,
    truncated: bool,
}

#[derive(Clone, Copy)]
struct CachedFileStat {
    mtime_secs: u64,
    size: u64,
    counts: LineCounts,
}

static FILE_CACHE: OnceLock<Mutex<HashMap<String, HashMap<String, CachedFileStat>>>> = OnceLock::new();
static SCAN_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn file_cache() -> &'static Mutex<HashMap<String, HashMap<String, CachedFileStat>>> {
    FILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scan_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    SCAN_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn begin_scan(workspace_key: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut map = lock(scan_cancels());
    if let Some(previous) = map.get(workspace_key) {
        previous.store(true, Ordering::Relaxed);
    }
    map.insert(workspace_key.to_string(), Arc::clone(&flag));
    flag
}

fn finish_scan(workspace_key: &str, flag: &Arc<AtomicBool>) {
    let mut map = lock(scan_cancels());
    if map.get(workspace_key).is_some_and(|current| Arc::ptr_eq(current, flag)) {
        map.remove(workspace_key);
    }
}

impl Aggregator {
    fn merge(&mut self, mut other: Self) {
        self.total_files += other.total_files;
        self.total_directories += other.total_directories;
        self.text_files += other.text_files;
        self.code_files += other.code_files;
        self.skipped_files += other.skipped_files;
        self.total_lines += other.total_lines;
        self.code_lines += other.code_lines;
        self.blank_lines += other.blank_lines;
        self.comment_lines += other.comment_lines;
        self.code_cat_lines += other.code_cat_lines;
        self.config_cat_lines += other.config_cat_lines;
        self.doc_cat_lines += other.doc_cat_lines;
        self.lockfile_cat_lines += other.lockfile_cat_lines;
        self.truncated |= other.truncated;
        for (id, add) in other.languages.drain() {
            let entry = self.languages.entry(id).or_default();
            entry.files += add.files;
            entry.lines += add.lines;
            entry.code += add.code;
            entry.blank += add.blank;
            entry.comment += add.comment;
        }
        for (name, add) in other.dirs.drain() {
            let entry = self.dirs.entry(name).or_default();
            entry.files += add.files;
            entry.lines += add.lines;
        }
        self.file_line_counts.append(&mut other.file_line_counts);
        if let Some((path, lines)) = other.largest_file.take() {
            if self.largest_file.as_ref().map(|(_, current)| lines > *current).unwrap_or(true) {
                self.largest_file = Some((path, lines));
            }
        }
    }

    fn record_text_file(
        &mut self,
        relative: String,
        language: &str,
        counts: LineCounts,
        category: FileCategory,
        generated: bool,
    ) {
        let lines = counts.code + counts.blank + counts.comment;
        self.text_files += 1;
        self.total_lines += lines;
        self.code_lines += counts.code;
        self.blank_lines += counts.blank;
        self.comment_lines += counts.comment;
        match category {
            FileCategory::Code => {
                self.code_files += 1;
                self.code_cat_lines += lines;
            }
            FileCategory::Config => self.config_cat_lines += lines,
            FileCategory::Doc => self.doc_cat_lines += lines,
            FileCategory::Lockfile => self.lockfile_cat_lines += lines,
        }

        let lockfile = matches!(category, FileCategory::Lockfile);
        if !lockfile {
            self.file_line_counts.push(lines);
            let lang = self.languages.entry(language.to_string()).or_default();
            lang.files += 1;
            lang.lines += lines;
            lang.code += counts.code;
            lang.blank += counts.blank;
            lang.comment += counts.comment;
            let dir = self.dirs.entry(top_level_dir(&relative)).or_default();
            dir.files += 1;
            dir.lines += lines;
        }
        if !lockfile
            && !generated
            && self.largest_file.as_ref().map(|(_, current)| lines > *current).unwrap_or(true)
        {
            self.largest_file = Some((relative, lines));
        }
    }
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
    lockfile: u64,
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
pub struct ProjectStatsResult {
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

fn file_mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn classify_file_bytes(path: &std::path::Path, language: &str) -> Option<LineCounts> {
    let buffer = fs::read(path).ok()?;
    let content = decode_text_bytes(buffer).ok()?;
    Some(classify_lines(&content, comment_syntax(language)))
}

struct ThreadScan {
    workspace: PathBuf,
    progress_key: String,
    local: Aggregator,
    local_cache: HashMap<String, CachedFileStat>,
    cache: Arc<HashMap<String, CachedFileStat>>,
    cancel: Arc<AtomicBool>,
    file_counter: Arc<AtomicU64>,
    progress: Arc<AtomicU64>,
    progress_callback: Option<StatsProgressCallback>,
    sink: Arc<Mutex<Vec<(Aggregator, HashMap<String, CachedFileStat>)>>>,
}

impl Drop for ThreadScan {
    fn drop(&mut self) {
        let local = std::mem::take(&mut self.local);
        let cache = std::mem::take(&mut self.local_cache);
        lock(&self.sink).push((local, cache));
    }
}

impl ThreadScan {
    fn maybe_emit_progress(&self) {
        let Some(cb) = &self.progress_callback else {
            return;
        };
        let seen = self.progress.fetch_add(1, Ordering::Relaxed) + 1;
        if seen == 1 || seen % PROGRESS_EVERY_FILES == 0 {
            cb(&self.progress_key, seen);
        }
    }

    fn visit(&mut self, entry_result: Result<ignore::DirEntry, ignore::Error>) -> ignore::WalkState {
        if self.cancel.load(Ordering::Relaxed) {
            return ignore::WalkState::Quit;
        }
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
            self.local.total_directories += 1;
            return ignore::WalkState::Continue;
        }
        if !file_type.is_file() {
            return ignore::WalkState::Continue;
        }

        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta.as_ref().map(file_mtime_secs).unwrap_or(0);
        let too_large = size > MAX_STATS_READ_BYTES;
        let path = entry.into_path();
        let relative = relative_string(self.workspace.as_path(), &path);

        let seen = self.file_counter.fetch_add(1, Ordering::Relaxed) + 1;
        self.local.total_files += 1;
        if seen > MAX_FILES as u64 {
            self.local.truncated = true;
            return ignore::WalkState::Quit;
        }
        if too_large {
            self.local.skipped_files += 1;
            self.maybe_emit_progress();
            return ignore::WalkState::Continue;
        }

        let language = language_from_path(&relative);
        let counts = if let Some(hit) = self.cache.get(&relative) {
            if hit.mtime_secs == mtime && hit.size == size {
                self.local_cache.insert(relative.clone(), *hit);
                Some(hit.counts)
            } else {
                None
            }
        } else {
            None
        };
        let counts = match counts.or_else(|| classify_file_bytes(&path, language)) {
            Some(counts) => counts,
            None => {
                self.local.skipped_files += 1;
                self.maybe_emit_progress();
                return ignore::WalkState::Continue;
            }
        };
        self.local_cache.entry(relative.clone()).or_insert(CachedFileStat {
            mtime_secs: mtime,
            size,
            counts,
        });

        let filename = filename_of(&relative).to_ascii_lowercase();
        let category = file_category(&relative, language);
        let generated = is_generated_name(&filename);
        self.local.record_text_file(relative, language, counts, category, generated);
        self.maybe_emit_progress();
        ignore::WalkState::Continue
    }
}

pub async fn compute_project_stats(
    workspace_path: String,
    progress_callback: Option<StatsProgressCallback>,
) -> Result<ProjectStatsResult, String> {
    let cancel = begin_scan(&workspace_path);
    let key = workspace_path.clone();
    let flag = Arc::clone(&cancel);
    let result = run_blocking_workspace_task(move || {
        scan_project_stats(&workspace_path, cancel, progress_callback)
    })
    .await;
    finish_scan(&key, &flag);
    result
}

pub fn cancel_project_stats(workspace_path: String) {
    let map = lock(scan_cancels());
    if let Some(flag) = map.get(&workspace_path) {
        flag.store(true, Ordering::Relaxed);
    }
}

pub fn compute_project_stats_impl(workspace_path: &str) -> Result<ProjectStatsResult, String> {
    scan_project_stats(workspace_path, Arc::new(AtomicBool::new(false)), None)
}

fn scan_project_stats(
    workspace_path: &str,
    cancel: Arc<AtomicBool>,
    progress_callback: Option<StatsProgressCallback>,
) -> Result<ProjectStatsResult, String> {
    let workspace = canonical_workspace(workspace_path)?;
    let cache_key = workspace.to_string_lossy().into_owned();
    let cache_snapshot = {
        let map = lock(file_cache());
        Arc::new(map.get(&cache_key).cloned().unwrap_or_default())
    };

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
            let Some(name) = entry.file_name().to_str() else {
                return true;
            };
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                return !should_ignore_stats_dir(name);
            }
            !should_ignore_file(name)
        });

    let walker = builder.build_parallel();
    let workspace_ref = workspace.clone();
    let progress_key = workspace_path.to_string();
    let file_counter = Arc::new(AtomicU64::new(0));
    let progress = Arc::new(AtomicU64::new(0));
    let sink = Arc::new(Mutex::new(Vec::new()));

    walker.run(|| {
        let mut thread = ThreadScan {
            workspace: workspace_ref.clone(),
            progress_key: progress_key.clone(),
            local: Aggregator::default(),
            local_cache: HashMap::new(),
            cache: Arc::clone(&cache_snapshot),
            cancel: Arc::clone(&cancel),
            file_counter: Arc::clone(&file_counter),
            progress: Arc::clone(&progress),
            progress_callback: progress_callback.clone(),
            sink: Arc::clone(&sink),
        };
        Box::new(move |entry_result| thread.visit(entry_result))
    });

    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }

    let mut combined = Aggregator::default();
    let mut next_cache = HashMap::new();
    {
        let mut pieces = lock(&sink);
        for (agg, cache) in pieces.drain(..) {
            combined.merge(agg);
            next_cache.extend(cache);
        }
    }

    if !combined.truncated {
        lock(file_cache()).insert(cache_key, next_cache);
    }

    Ok(finalize(combined))
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
    directory_breakdown.truncate(DIR_BREAKDOWN_LIMIT);

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

    let counted_files = agg.file_line_counts.len() as u64;
    let counted_lines: u64 = agg.file_line_counts.iter().sum();
    let avg_lines_per_file = if counted_files > 0 { counted_lines / counted_files } else { 0 };
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
            lockfile: agg.lockfile_cat_lines,
        },
        avg_metrics: AverageMetrics {
            avg_lines_per_file,
            median_lines_per_file,
            max_lines_per_file,
            total_text_files: counted_files,
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
        assert_eq!(language_from_path("src/App.vue"), "vue");
        assert_eq!(language_from_path("src/Widget.svelte"), "svelte");
        assert_eq!(language_from_path("lib/Math.hs"), "haskell");
        assert_eq!(language_from_path("lib/mix.exs"), "elixir");
        assert_eq!(language_from_path("src/core.clj"), "clojure");
        assert_eq!(language_from_path("src/server.erl"), "erlang");
        assert_eq!(language_from_path("build.gradle"), "groovy");
        assert_eq!(language_from_path("tsconfig.jsonc"), "json");
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

    #[test]
    fn classifies_lua_block_comment_not_just_first_line() {
        let content = "-- line\n--[[\nblock\n]]\nprint(1)\n";
        let counts = classify_lines(content, comment_syntax("lua"));
        assert_eq!(counts.comment, 4);
        assert_eq!(counts.code, 1);
        assert_eq!(counts.blank, 0);
    }

    #[test]
    fn classifies_jsonc_line_and_block_comments() {
        let content = "// note\n{\n  \"a\": 1\n}\n/* trailing */\n";
        let counts = classify_lines(content, comment_syntax("json"));
        assert_eq!(counts.comment, 2);
        assert_eq!(counts.code, 3);
    }

    #[test]
    fn classifies_vue_html_and_script_comments() {
        let content = "<!-- tpl -->\n<template>\n</template>\n// script note\nconst x = 1;\n";
        let counts = classify_lines(content, comment_syntax("vue"));
        assert_eq!(counts.comment, 2);
        assert_eq!(counts.code, 3);
    }

    #[test]
    fn mid_line_block_opener_continues_on_following_lines() {
        let content = "const x = 1; /* start\nstill comment\n*/\ncode();\n";
        let counts = classify_lines(content, comment_syntax("typescript"));
        assert_eq!(counts.code, 2);
        assert_eq!(counts.comment, 2);
    }

    #[test]
    fn line_comment_hides_later_block_opener() {
        let content = "const x = 1; // /* not a block\ncode();\n";
        let counts = classify_lines(content, comment_syntax("typescript"));
        assert_eq!(counts.code, 2);
        assert_eq!(counts.comment, 0);
    }

    #[test]
    fn categorizes_lockfile_ignore_and_source() {
        assert!(matches!(
            file_category("package-lock.json", "json"),
            FileCategory::Lockfile
        ));
        assert!(matches!(
            file_category("frontend/yarn.lock", "plaintext"),
            FileCategory::Lockfile
        ));
        assert!(matches!(
            file_category(".gitignore", "plaintext"),
            FileCategory::Config
        ));
        assert!(matches!(
            file_category("src/app.ts", "typescript"),
            FileCategory::Code
        ));
        assert!(matches!(
            file_category("README.md", "markdown"),
            FileCategory::Doc
        ));
        assert!(is_generated_name("bundle.min.js"));
        assert!(is_generated_name("api.generated.ts"));
        assert!(!is_generated_name("minion.ts"));
    }

    #[test]
    fn compute_skips_vendor_lockfile_noise_and_generated_largest() {
        let workspace = std::env::temp_dir().join(format!(
            "codepapr-stats-p2-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::create_dir_all(workspace.join("vendor")).unwrap();
        std::fs::write(workspace.join("src/app.ts"), "export const n = 1;\nexport const m = 2;\n").unwrap();
        std::fs::write(
            workspace.join("src/bundle.min.js"),
            &(0..40).map(|i| format!("var a{i}=1;\n")).collect::<String>(),
        )
        .unwrap();
        std::fs::write(
            workspace.join("package-lock.json"),
            &(0..80).map(|i| format!("  \"p{i}\": \"1\",\n")).collect::<String>(),
        )
        .unwrap();
        std::fs::write(workspace.join("vendor/dep.js"), "module.exports = 1;\n").unwrap();
        std::fs::write(workspace.join(".DS_Store"), b"\0\0\0binary").unwrap();
        std::fs::write(workspace.join(".gitignore"), "dist\n").unwrap();

        let result = compute_project_stats_impl(workspace.to_str().unwrap()).expect("stats");
        let _ = std::fs::remove_dir_all(&workspace);

        assert!(result.code_ratio.lockfile > 0, "package-lock.json should be the lockfile bucket");
        assert!(
            result.languages.iter().all(|lang| lang.id != "json"),
            "lockfile json must not appear as a language"
        );
        assert_eq!(
            result.largest_file.as_ref().map(|f| f.path.as_str()),
            Some("src/app.ts"),
            "generated min.js must not win largest-file"
        );
        assert!(
            result.languages.iter().any(|lang| lang.id == "javascript" && lang.files == 1),
            "vendor js ignored; generated min.js still counted as javascript"
        );
        assert!(result.total_files <= 5, "OS noise and vendor should not inflate file count");
        assert!(result.code_ratio.config > 0);
        assert!(result.code_files >= 1);
    }

    fn record_code(agg: &mut Aggregator, relative: &str, language: &str, code: u64) {
        agg.total_files += 1;
        agg.record_text_file(
            relative.to_string(),
            language,
            LineCounts { code, blank: 0, comment: 0 },
            FileCategory::Code,
            false,
        );
    }

    #[test]
    fn aggregator_merge_sums_languages_and_largest_file() {
        let mut left = Aggregator::default();
        record_code(&mut left, "src/a.ts", "typescript", 2);
        let mut right = Aggregator::default();
        record_code(&mut right, "src/b.ts", "typescript", 5);
        record_code(&mut right, "lib/c.py", "python", 3);
        left.merge(right);
        assert_eq!(left.total_files, 3);
        assert_eq!(left.code_lines, 10);
        assert_eq!(left.languages.get("typescript").map(|lang| lang.files), Some(2));
        assert_eq!(left.languages.get("python").map(|lang| lang.lines), Some(3));
        assert_eq!(left.largest_file.as_ref().map(|(path, lines)| (path.as_str(), *lines)), Some(("src/b.ts", 5)));
    }

    #[test]
    fn scan_returns_cancelled_when_flag_is_set() {
        let workspace = std::env::temp_dir().join(format!(
            "codepapr-stats-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        for i in 0..80 {
            std::fs::write(workspace.join(format!("src/f{i}.ts")), "export const n = 1;\n").unwrap();
        }
        let result = scan_project_stats(
            workspace.to_str().unwrap(),
            Arc::new(AtomicBool::new(true)),
            None,
        );
        let _ = std::fs::remove_dir_all(&workspace);
        match result {
            Err(err) => assert!(err.contains("cancel")),
            Ok(_) => panic!("pre-cancelled scan must not succeed"),
        }
    }

    #[test]
    fn second_scan_of_unchanged_workspace_matches_first() {
        let workspace = std::env::temp_dir().join(format!(
            "codepapr-stats-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(workspace.join("src/app.ts"), "export const n = 1;\n").unwrap();
        std::fs::write(workspace.join("README.md"), "# hi\n\ntext\n").unwrap();
        let path = workspace.to_str().unwrap();
        let first = compute_project_stats_impl(path).expect("first");
        let second = compute_project_stats_impl(path).expect("second");
        let _ = std::fs::remove_dir_all(&workspace);
        assert_eq!(first.total_files, second.total_files);
        assert_eq!(first.total_lines, second.total_lines);
        assert_eq!(first.code_lines, second.code_lines);
        assert_eq!(first.languages.len(), second.languages.len());
        assert_eq!(
            first.largest_file.as_ref().map(|f| f.path.as_str()),
            second.largest_file.as_ref().map(|f| f.path.as_str())
        );
    }
}
