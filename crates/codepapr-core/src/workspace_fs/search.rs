use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};

use crate::shared::{canonical_workspace, lock, relative_string, run_blocking_workspace_task};

use super::read::{
    decode_text_bytes_with_encoding, detect_text_encoding, split_text_lines_for_read,
    TextEncoding,
};
use super::types::{
    PathSearchMatch, PathSearchResult, PreparedPathSearch, PreparedTextSearch, SearchMatch,
    SearchResult,
};
use super::{
    is_app_state_dir, should_ignore_dir, DEFAULT_SEARCH_CONTEXT_LINES,
    DEFAULT_SEARCH_MAX_FILE_BYTES, DEFAULT_SEARCH_MAX_MATCHES_PER_FILE, MAX_PATH_SEARCH_RESULTS,
    MAX_SEARCH_CONTEXT_LINES, MAX_SEARCH_MAX_FILE_BYTES, MAX_SEARCH_MAX_MATCHES_PER_FILE,
    MAX_SEARCH_RESULTS,
};

/// 搜索跳过的文件分类计数：让「0 结果 ≠ 全库无匹配」有可解释的原因构成。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SearchSkipStats {
    pub(crate) oversize: usize,
    pub(crate) undecodable: usize,
    pub(crate) unreadable: usize,
}

impl SearchSkipStats {
    pub(crate) fn total(&self) -> usize {
        self.oversize + self.undecodable + self.unreadable
    }

    /// 拼 note 用的中文摘要；total 为 0 时返回 None。
    fn explain(&self) -> Option<String> {
        if self.total() == 0 {
            return None;
        }
        let mut parts = Vec::new();
        if self.oversize > 0 {
            parts.push(format!("{} 个超过大小上限", self.oversize));
        }
        if self.undecodable > 0 {
            parts.push(format!("{} 个二进制/无法解码", self.undecodable));
        }
        if self.unreadable > 0 {
            parts.push(format!("{} 个读取失败", self.unreadable));
        }
        Some(format!(
            "{} 个文件被跳过（{}），未搜索其内容",
            self.total(),
            parts.join("、")
        ))
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn search_workspace_text(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    context_lines: Option<usize>,
    max_results: Option<usize>,
    max_matches_per_file: Option<usize>,
    max_bytes_per_file: Option<usize>,
    include_codepapr_apps: Option<bool>,
    include_ignored_dirs: Option<bool>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<SearchResult, String> {
    run_blocking_workspace_task(move || {
        search_workspace_text_impl_full(
            workspace_path,
            query,
            case_sensitive,
            is_regexp,
            context_lines,
            max_results,
            max_matches_per_file,
            max_bytes_per_file,
            include_codepapr_apps,
            include_ignored_dirs,
            include_globs,
            exclude_globs,
        )
    })
    .await
}

pub async fn search_workspace_paths(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
    include_codepapr_apps: Option<bool>,
    include_ignored_dirs: Option<bool>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<PathSearchResult, String> {
    run_blocking_workspace_task(move || {
        search_workspace_paths_impl_full(
            workspace_path,
            query,
            case_sensitive,
            is_regexp,
            max_results,
            include_codepapr_apps,
            include_ignored_dirs,
            include_globs,
            exclude_globs,
        )
    })
    .await
}

#[allow(clippy::too_many_arguments)]
#[allow(dead_code)] // 仅单元测试使用（workspace_fs/tests.rs）；命令走 _full 变体
pub(crate) fn search_workspace_text_impl(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    context_lines: Option<usize>,
    max_results: Option<usize>,
    max_matches_per_file: Option<usize>,
    max_bytes_per_file: Option<usize>,
    include_codepapr_apps: Option<bool>,
) -> Result<SearchResult, String> {
    search_workspace_text_impl_full(
        workspace_path,
        query,
        case_sensitive,
        is_regexp,
        context_lines,
        max_results,
        max_matches_per_file,
        max_bytes_per_file,
        include_codepapr_apps,
        None,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn search_workspace_text_impl_full(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    context_lines: Option<usize>,
    max_results: Option<usize>,
    max_matches_per_file: Option<usize>,
    max_bytes_per_file: Option<usize>,
    include_codepapr_apps: Option<bool>,
    include_ignored_dirs: Option<bool>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<SearchResult, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let prepared = prepare_text_search(
        query,
        case_sensitive,
        is_regexp,
        context_lines,
        max_results,
        max_matches_per_file,
        max_bytes_per_file,
        include_globs,
        exclude_globs,
    )?;
    let include_apps = include_codepapr_apps.unwrap_or(false);
    let include_ignored = include_ignored_dirs.unwrap_or(false);
    let (matches, truncated, skipped) =
        collect_search_matches(&workspace, &prepared, include_apps, include_ignored)?;

    // 顶栏摘要（R2）：把 truncated / skippedFiles 的原因直接写进 note，
    // 不再指望调用方自己从布尔值和计数里推断「0 结果意味着什么」。
    let mut note_parts: Vec<String> = Vec::new();
    if prepared.regex_degraded {
        note_parts.push(degraded_note(&prepared.raw_query));
    }
    if truncated {
        note_parts.push(format!(
            "匹配已达 maxResults 上限（{}），结果被截断",
            prepared.max_results
        ));
    }
    if let Some(explain) = skipped.explain() {
        note_parts.push(explain);
    }
    let note = if note_parts.is_empty() {
        None
    } else {
        Some(note_parts.join("；"))
    };

    Ok(SearchResult {
        query: prepared.raw_query.clone(),
        matches,
        truncated,
        regex_degraded: prepared.regex_degraded,
        skipped_files: skipped.total(),
        note,
    })
}

#[allow(clippy::too_many_arguments)]
#[allow(dead_code)] // 仅单元测试使用（workspace_fs/tests.rs）；命令走 _full 变体
pub(crate) fn search_workspace_paths_impl(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
    include_codepapr_apps: Option<bool>,
) -> Result<PathSearchResult, String> {
    search_workspace_paths_impl_full(
        workspace_path,
        query,
        case_sensitive,
        is_regexp,
        max_results,
        include_codepapr_apps,
        None,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn search_workspace_paths_impl_full(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
    include_codepapr_apps: Option<bool>,
    include_ignored_dirs: Option<bool>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<PathSearchResult, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let prepared = prepare_path_search(
        query,
        case_sensitive,
        is_regexp,
        max_results,
        include_globs,
        exclude_globs,
    )?;
    let include_apps = include_codepapr_apps.unwrap_or(false);
    let include_ignored = include_ignored_dirs.unwrap_or(false);
    let (matches, truncated) =
        collect_path_matches(&workspace, &prepared, include_apps, include_ignored)?;

    Ok(PathSearchResult {
        query: prepared.raw_query.clone(),
        matches,
        truncated,
        regex_degraded: prepared.regex_degraded,
        note: compose_path_note(&prepared, truncated),
    })
}

fn compose_path_note(prepared: &PreparedPathSearch, truncated: bool) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if prepared.regex_degraded {
        parts.push(degraded_note(&prepared.raw_query));
    }
    if truncated {
        parts.push(format!(
            "匹配已达 maxResults 上限（{}），结果被截断",
            prepared.max_results
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("；"))
    }
}

fn resolve_case_sensitivity(query: &str, requested: Option<bool>) -> bool {
    requested.unwrap_or_else(|| query.chars().any(|ch| ch.is_ascii_uppercase()))
}

/// 返回 (正则, 是否降级)。is_regexp 模式下编译失败时自动降级为字面量搜索，
/// 避免 LLM 写出 Rust regex 不支持的语法（lookaround、反向引用等）时直接报错。
fn build_search_regex(
    query: &str,
    is_regexp: Option<bool>,
    case_sensitive: bool,
) -> Result<(Regex, bool), String> {
    let is_regexp = is_regexp.unwrap_or(false);
    let pattern = if is_regexp {
        query.to_string()
    } else {
        regex::escape(query)
    };

    match RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
    {
        Ok(regex) => Ok((regex, false)),
        Err(err) => {
            if !is_regexp {
                return Err(format!("搜索正则无效: {err}"));
            }
            let regex = RegexBuilder::new(&regex::escape(query))
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|err| format!("搜索正则无效: {err}"))?;
            Ok((regex, true))
        }
    }
}

fn degraded_note(raw_query: &str) -> String {
    format!("正则表达式无效，已降级为字面量搜索: {raw_query}")
}

/// 把 glob 模式集合编译为 GlobSet（对相对路径匹配）。
/// 语义对齐 ripgrep：不含 `/` 的模式按文件名匹配任意层级（自动加 `**/` 前缀）；
/// 大小写不敏感；`*` 不跨路径分隔符。
fn build_glob_set(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    let mut builder = GlobSetBuilder::new();
    let mut count = 0usize;
    for raw in patterns {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.replace('\\', "/");
        let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
        if normalized == "**" || normalized == "**/*" {
            // 匹配一切的 include 等价于不加过滤
            continue;
        }
        let pattern = if normalized.contains('/') {
            normalized.to_string()
        } else {
            format!("**/{normalized}")
        };
        let glob = GlobBuilder::new(&pattern)
            .case_insensitive(true)
            .literal_separator(true)
            .build()
            .map_err(|err| format!("无效 glob 模式 {trimmed}: {err}"))?;
        builder.add(glob);
        count += 1;
    }
    if count == 0 {
        return Ok(None);
    }
    builder
        .build()
        .map(Some)
        .map_err(|err| format!("glob 规则构建失败: {err}"))
}

/// 对纯 ASCII 字面量 query 构建字节级预过滤正则（R3 快路径）。
///
/// 原理：UTF-8 与 GB18030 对 ASCII 子串字节透明（真命中必然在原始字节流中
/// 出现同字节序列；多字节尾字节只会造成假阳性，随后由完整解码路径复核）。
/// 因此预过滤「无命中」可以安全跳过整个文件的解码与逐行匹配，结果与慢路径
/// 完全一致；UTF-16/BOM/二进制字节流不适用（由调用侧按编码门控）。
fn build_literal_prefilter(
    raw_query: &str,
    is_regexp: bool,
    case_sensitive: bool,
) -> Option<regex::bytes::Regex> {
    if is_regexp || raw_query.is_empty() || !raw_query.is_ascii() {
        return None;
    }
    let pattern = regex::escape(raw_query);
    // 转义后的 ASCII 模式在 bytes 引擎下必然可编译；失败仅视为无快路径。
    regex::bytes::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .ok()
}

#[allow(clippy::too_many_arguments)]
fn prepare_text_search(
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    context_lines: Option<usize>,
    max_results: Option<usize>,
    max_matches_per_file: Option<usize>,
    max_bytes_per_file: Option<usize>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<PreparedTextSearch, String> {
    let raw_query = query.trim().to_string();
    if raw_query.is_empty() {
        return Err("搜索关键词不能为空".to_string());
    }
    if raw_query.chars().count() < 2 && !is_regexp.unwrap_or(false) {
        return Err("搜索关键词至少需要 2 个字符".to_string());
    }

    let case_sensitive = resolve_case_sensitivity(&raw_query, case_sensitive);
    let (matcher, regex_degraded) = build_search_regex(&raw_query, is_regexp, case_sensitive)?;
    let prefilter = build_literal_prefilter(&raw_query, is_regexp.unwrap_or(false), case_sensitive);
    let include_globs = include_globs
        .as_deref()
        .map(build_glob_set)
        .transpose()?
        .flatten();
    let exclude_globs = exclude_globs
        .as_deref()
        .map(build_glob_set)
        .transpose()?
        .flatten();
    Ok(PreparedTextSearch {
        raw_query: raw_query.clone(),
        matcher,
        regex_degraded,
        context_lines: context_lines
            .unwrap_or(DEFAULT_SEARCH_CONTEXT_LINES)
            .min(MAX_SEARCH_CONTEXT_LINES),
        max_results: max_results
            .unwrap_or(MAX_SEARCH_RESULTS)
            .clamp(1, MAX_SEARCH_RESULTS),
        max_matches_per_file: max_matches_per_file
            .unwrap_or(DEFAULT_SEARCH_MAX_MATCHES_PER_FILE)
            .clamp(1, MAX_SEARCH_MAX_MATCHES_PER_FILE),
        max_bytes_per_file: max_bytes_per_file
            .unwrap_or(DEFAULT_SEARCH_MAX_FILE_BYTES)
            .clamp(1_000, MAX_SEARCH_MAX_FILE_BYTES),
        prefilter,
        include_globs,
        exclude_globs,
    })
}

fn prepare_path_search(
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<PreparedPathSearch, String> {
    let raw_query = query.trim().to_string();
    if raw_query.is_empty() {
        return Err("文件搜索关键词不能为空".to_string());
    }

    let case_sensitive = resolve_case_sensitivity(&raw_query, case_sensitive);
    let (matcher, regex_degraded) = build_search_regex(&raw_query, is_regexp, case_sensitive)?;
    let include_globs = include_globs
        .as_deref()
        .map(build_glob_set)
        .transpose()?
        .flatten();
    let exclude_globs = exclude_globs
        .as_deref()
        .map(build_glob_set)
        .transpose()?
        .flatten();
    Ok(PreparedPathSearch {
        raw_query: raw_query.clone(),
        matcher,
        regex_degraded,
        max_results: max_results
            .unwrap_or(MAX_PATH_SEARCH_RESULTS)
            .clamp(1, MAX_PATH_SEARCH_RESULTS),
        include_globs,
        exclude_globs,
    })
}

/// 构建主搜索遍历器。`.CodePapr` 子树在这里始终被排除（名称过滤 + 项目
/// .gitignore 双重屏蔽）；app 模式对 `.CodePapr/apps` 的放行由
/// build_apps_walker 的二次遍历实现（override 语义是"只搜匹配项"，
/// 会误杀全库其余文件，不能用于此场景）。
fn build_search_walker_builder(workspace: &Path, include_ignored_dirs: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(workspace);
    if include_ignored_dirs {
        // 全量模式：穿透 .gitignore 与通用忽略目录（node_modules/build/dist/.venv 等），
        // 仅排除 `.git` 与应用自身状态目录（.CodePapr/.ProjectGraph/.scratch）。
        builder
            .hidden(false)
            .require_git(false)
            .parents(false)
            .git_ignore(false)
            .git_exclude(false)
            .ignore(false)
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                entry
                    .file_name()
                    .to_str()
                    .map(|name| !(name == ".git" || is_app_state_dir(name)))
                    .unwrap_or(true)
            });
    } else {
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
    }

    builder
}

/// app 模式专用遍历器：直接以 `.CodePapr/apps` 为根，关闭 gitignore
/// （项目 .gitignore 通常忽略 .CodePapr/），仅保留重型目录名称过滤。
fn build_apps_walker(workspace: &Path) -> Option<ignore::Walk> {
    let apps_root = workspace.join(".CodePapr/apps");
    if !apps_root.is_dir() {
        return None;
    }
    let mut builder = WalkBuilder::new(&apps_root);
    builder
        .hidden(false)
        .require_git(false)
        .parents(false)
        .git_ignore(false)
        .git_exclude(false)
        .ignore(false)
        .filter_entry(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| !should_ignore_dir(name))
                .unwrap_or(true)
        });
    Some(builder.build())
}

fn build_search_walker(
    workspace: &Path,
    max_filesize: Option<usize>,
    include_ignored_dirs: bool,
) -> ignore::Walk {
    let mut builder = build_search_walker_builder(workspace, include_ignored_dirs);

    if let Some(limit) = max_filesize {
        builder.max_filesize(Some(limit as u64));
    }

    builder.build()
}

/// 共享可变状态：主遍历与 apps 二次遍历共用。
struct TextSearchShared<'a> {
    workspace: &'a Path,
    options: &'a PreparedTextSearch,
    max_filesize: usize,
    max_results: usize,
    max_per_file: usize,
    results: Mutex<Vec<SearchMatch>>,
    truncated: AtomicBool,
    oversize: AtomicUsize,
    undecodable: AtomicUsize,
    unreadable: AtomicUsize,
}

/// glob 过滤：exclude 优先；include 提供时仅放行命中文件。
/// 被 glob 排除的文件不计入 skipped（那是显式过滤，不是「没搜到」）。
fn glob_allows(options: &PreparedTextSearch, relative: &str) -> bool {
    if options
        .exclude_globs
        .as_ref()
        .is_some_and(|set| set.is_match(relative))
    {
        return false;
    }
    if let Some(include) = &options.include_globs {
        return include.is_match(relative);
    }
    true
}

/// 处理单个遍历条目：读取、解码、按行匹配并写入共享结果。
/// 主遍历与 .CodePapr/apps 二次遍历共用。
fn handle_search_entry(
    entry_result: Result<ignore::DirEntry, ignore::Error>,
    shared: &TextSearchShared<'_>,
) -> ignore::WalkState {
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
    if !file_type.is_file() {
        return ignore::WalkState::Continue;
    }
    if shared.options.include_globs.is_some() || shared.options.exclude_globs.is_some() {
        let relative = relative_string(shared.workspace, entry.path());
        if !glob_allows(shared.options, &relative) {
            return ignore::WalkState::Continue;
        }
    }
    if shared.max_filesize > 0 {
        if let Ok(metadata) = entry.metadata() {
            if metadata.len() > shared.max_filesize as u64 {
                // 超过单文件大小上限：计入 skipped，不读取内容
                shared.oversize.fetch_add(1, Ordering::Relaxed);
                return ignore::WalkState::Continue;
            }
        }
    }

    let path = entry.into_path();
    let Ok(buffer) = fs::read(&path) else {
        shared.unreadable.fetch_add(1, Ordering::Relaxed);
        return ignore::WalkState::Continue;
    };
    let Some(encoding) = detect_text_encoding(&buffer) else {
        // 二进制：计入 skipped，让调用方知道 0 结果不等于全库无匹配
        shared.undecodable.fetch_add(1, Ordering::Relaxed);
        return ignore::WalkState::Continue;
    };
    // 字节级预过滤（R3）：只对 ASCII 兼容编码（UTF-8/GB18030）生效；
    // 无命中即跳过解码与逐行匹配，行为与慢路径逐字节等价。
    if matches!(
        encoding,
        TextEncoding::Utf8 | TextEncoding::Utf8Bom | TextEncoding::Gb18030
    ) {
        if let Some(prefilter) = &shared.options.prefilter {
            if prefilter.find(&buffer).is_none() {
                return ignore::WalkState::Continue;
            }
        }
    }
    let Ok(content) = decode_text_bytes_with_encoding(&buffer, encoding) else {
        shared.undecodable.fetch_add(1, Ordering::Relaxed);
        return ignore::WalkState::Continue;
    };
    let (lines, _) = split_text_lines_for_read(&content);

    let context_lines = shared.options.context_lines;
    let mut local_matches: Vec<SearchMatch> = Vec::new();
    let mut matched_in_file = 0usize;

    for (index, line) in lines.iter().enumerate() {
        if matched_in_file >= shared.max_per_file {
            break;
        }
        if let Some(found) = shared.options.matcher.find(line) {
            matched_in_file += 1;
            local_matches.push(SearchMatch {
                path: relative_string(shared.workspace, &path),
                line: index + 1,
                preview: line.trim().chars().take(240).collect(),
                // found.start() 是字节偏移：非 ASCII 行上直接当列号会
                // 让光标定位错位，换算成字符偏移。
                column: Some(line[..found.start()].chars().count() + 1),
                context_before: if context_lines > 0 {
                    Some(lines[index.saturating_sub(context_lines)..index].to_vec())
                } else {
                    None
                },
                context_after: if context_lines > 0 {
                    Some(
                        lines[index + 1..(index + 1 + context_lines).min(lines.len())].to_vec(),
                    )
                } else {
                    None
                },
            });
        }
    }

    if !local_matches.is_empty() {
        let mut global = lock(&shared.results);
        for m in local_matches {
            if global.len() >= shared.max_results {
                shared.truncated.store(true, Ordering::Relaxed);
                break;
            }
            global.push(m);
        }
    }

    ignore::WalkState::Continue
}

pub(crate) fn collect_search_matches(
    workspace: &Path,
    options: &PreparedTextSearch,
    include_codepapr_apps: bool,
    include_ignored_dirs: bool,
) -> Result<(Vec<SearchMatch>, bool, SearchSkipStats), String> {
    let workspace_owned = workspace.to_path_buf();
    let max_filesize = options.max_bytes_per_file;

    let builder = build_search_walker_builder(&workspace_owned, include_ignored_dirs);

    // 不使用 builder.max_filesize 预过滤：超限文件需要计入 skipped_files，
    // 让调用方知道 0 结果不等于全库无匹配（改在访问条目时检查大小）

    let walker = builder.build_parallel();
    let workspace_ref = &workspace_owned;
    let shared = Arc::new(TextSearchShared {
        workspace: workspace_ref,
        options,
        max_filesize,
        max_results: options.max_results,
        max_per_file: options.max_matches_per_file,
        results: Mutex::new(Vec::<SearchMatch>::new()),
        truncated: AtomicBool::new(false),
        oversize: AtomicUsize::new(0),
        undecodable: AtomicUsize::new(0),
        unreadable: AtomicUsize::new(0),
    });

    walker.run(|| {
        let shared = Arc::clone(&shared);
        Box::new(move |entry_result| {
            if shared.truncated.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            handle_search_entry(entry_result, &shared)
        })
    });

    // app 模式：二次遍历 .CodePapr/apps（主遍历受项目 .gitignore 与名称
    // 过滤屏蔽无法到达）。结果并入同一共享状态，max_results 上限仍然生效。
    if include_codepapr_apps {
        if let Some(apps_walker) = build_apps_walker(&workspace_owned) {
            for entry_result in apps_walker {
                if shared.truncated.load(Ordering::Relaxed) {
                    break;
                }
                handle_search_entry(entry_result, &shared);
            }
        }
    }

    let shared = Arc::try_unwrap(shared).unwrap_or_else(|_| unreachable!());
    let matches = shared.results.into_inner().unwrap_or_else(|e| e.into_inner());
    Ok((
        matches,
        shared.truncated.into_inner(),
        SearchSkipStats {
            oversize: shared.oversize.into_inner(),
            undecodable: shared.undecodable.into_inner(),
            unreadable: shared.unreadable.into_inner(),
        },
    ))
}

pub(crate) fn collect_path_matches(
    workspace: &Path,
    options: &PreparedPathSearch,
    include_codepapr_apps: bool,
    include_ignored_dirs: bool,
) -> Result<(Vec<PathSearchMatch>, bool), String> {
    let mut matches = Vec::new();
    let mut truncated = false;

    for entry in build_search_walker(workspace, None, include_ignored_dirs) {
        if match_path_entry(entry, workspace, options, &mut matches) {
            truncated = true;
            return Ok((matches, truncated));
        }
    }

    // app 模式：二次遍历 .CodePapr/apps（主遍历受 .gitignore 与名称过滤屏蔽）
    if include_codepapr_apps {
        if let Some(apps_walker) = build_apps_walker(workspace) {
            for entry in apps_walker {
                if match_path_entry(entry, workspace, options, &mut matches) {
                    truncated = true;
                    return Ok((matches, truncated));
                }
            }
        }
    }

    Ok((matches, truncated))
}

/// 处理单个路径条目；返回 true 表示已达 max_results 上限（截断）。
fn match_path_entry(
    entry_result: Result<ignore::DirEntry, ignore::Error>,
    workspace: &Path,
    options: &PreparedPathSearch,
    matches: &mut Vec<PathSearchMatch>,
) -> bool {
    let Ok(entry) = entry_result else {
        return false;
    };
    if entry.depth() == 0 {
        return false;
    }

    let path = entry.into_path();
    let Ok(metadata) = fs::metadata(&path) else {
        return false;
    };
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    let relative = relative_string(workspace, &path);

    if options
        .exclude_globs
        .as_ref()
        .is_some_and(|set| set.is_match(&relative))
    {
        return false;
    }
    if options
        .include_globs
        .as_ref()
        .is_some_and(|set| !set.is_match(&relative))
    {
        return false;
    }

    if options.matcher.is_match(&relative) || options.matcher.is_match(&name) {
        matches.push(PathSearchMatch {
            path: relative,
            name,
            is_dir: metadata.is_dir(),
            bytes: if metadata.is_dir() { 0 } else { metadata.len() },
        });
        return matches.len() >= options.max_results;
    }
    false
}
