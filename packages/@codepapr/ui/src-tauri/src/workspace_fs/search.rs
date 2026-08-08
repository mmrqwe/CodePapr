use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};

use crate::shared::{canonical_workspace, lock, relative_string, run_blocking_workspace_task};

use super::read::{decode_text_bytes, split_text_lines_for_read};
use super::types::{
    PathSearchMatch, PathSearchResult, PreparedPathSearch, PreparedTextSearch, SearchMatch,
    SearchResult,
};
use super::{
    should_ignore_dir, DEFAULT_SEARCH_CONTEXT_LINES, DEFAULT_SEARCH_MAX_FILE_BYTES,
    DEFAULT_SEARCH_MAX_MATCHES_PER_FILE, MAX_PATH_SEARCH_RESULTS, MAX_SEARCH_CONTEXT_LINES,
    MAX_SEARCH_MAX_FILE_BYTES, MAX_SEARCH_MAX_MATCHES_PER_FILE, MAX_SEARCH_RESULTS,
};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_workspace_text(
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
    run_blocking_workspace_task(move || {
        search_workspace_text_impl(
            workspace_path,
            query,
            case_sensitive,
            is_regexp,
            context_lines,
            max_results,
            max_matches_per_file,
            max_bytes_per_file,
            include_codepapr_apps,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn search_workspace_paths(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
    include_codepapr_apps: Option<bool>,
) -> Result<PathSearchResult, String> {
    run_blocking_workspace_task(move || {
        search_workspace_paths_impl(
            workspace_path,
            query,
            case_sensitive,
            is_regexp,
            max_results,
            include_codepapr_apps,
        )
    })
    .await
}

#[allow(clippy::too_many_arguments)]
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
    let workspace = canonical_workspace(&workspace_path)?;
    let prepared = prepare_text_search(
        query,
        case_sensitive,
        is_regexp,
        context_lines,
        max_results,
        max_matches_per_file,
        max_bytes_per_file,
    )?;
    let include_apps = include_codepapr_apps.unwrap_or(false);
    let (matches, truncated, skipped_files) =
        collect_search_matches(&workspace, &prepared, include_apps)?;

    Ok(SearchResult {
        query: prepared.raw_query.clone(),
        matches,
        truncated,
        regex_degraded: prepared.regex_degraded,
        skipped_files,
        note: if prepared.regex_degraded {
            degraded_note(&prepared.raw_query)
        } else {
            None
        },
    })
}

pub(crate) fn search_workspace_paths_impl(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
    include_codepapr_apps: Option<bool>,
) -> Result<PathSearchResult, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let prepared = prepare_path_search(query, case_sensitive, is_regexp, max_results)?;
    let include_apps = include_codepapr_apps.unwrap_or(false);
    let (matches, truncated) = collect_path_matches(&workspace, &prepared, include_apps)?;

    Ok(PathSearchResult {
        query: prepared.raw_query.clone(),
        matches,
        truncated,
        regex_degraded: prepared.regex_degraded,
        note: if prepared.regex_degraded {
            degraded_note(&prepared.raw_query)
        } else {
            None
        },
    })
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

fn degraded_note(raw_query: &str) -> Option<String> {
    Some(format!(
        "正则表达式无效，已降级为字面量搜索: {raw_query}"
    ))
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
    })
}

fn prepare_path_search(
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
) -> Result<PreparedPathSearch, String> {
    let raw_query = query.trim().to_string();
    if raw_query.is_empty() {
        return Err("文件搜索关键词不能为空".to_string());
    }

    let case_sensitive = resolve_case_sensitivity(&raw_query, case_sensitive);
    let (matcher, regex_degraded) = build_search_regex(&raw_query, is_regexp, case_sensitive)?;
    Ok(PreparedPathSearch {
        raw_query: raw_query.clone(),
        matcher,
        regex_degraded,
        max_results: max_results
            .unwrap_or(MAX_PATH_SEARCH_RESULTS)
            .clamp(1, MAX_PATH_SEARCH_RESULTS),
    })
}

/// 构建主搜索遍历器。`.CodePapr` 子树在这里始终被排除（名称过滤 + 项目
/// .gitignore 双重屏蔽）；app 模式对 `.CodePapr/apps` 的放行由
/// build_apps_walker 的二次遍历实现（override 语义是"只搜匹配项"，
/// 会误杀全库其余文件，不能用于此场景）。
fn build_search_walker_builder(workspace: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(workspace);
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

fn build_search_walker(workspace: &Path, max_filesize: Option<usize>) -> ignore::Walk {
    let mut builder = build_search_walker_builder(workspace);

    if let Some(limit) = max_filesize {
        builder.max_filesize(Some(limit as u64));
    }

    builder.build()
}

/// 处理单个遍历条目：读取、解码、按行匹配并写入共享结果。
/// 主遍历与 .CodePapr/apps 二次遍历共用。
#[allow(clippy::too_many_arguments)]
fn handle_search_entry(
    entry_result: Result<ignore::DirEntry, ignore::Error>,
    workspace: &Path,
    options: &PreparedTextSearch,
    max_filesize: usize,
    max_results: usize,
    max_per_file: usize,
    context_lines: usize,
    results: &Mutex<Vec<SearchMatch>>,
    truncated: &AtomicBool,
    skipped: &AtomicUsize,
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
    if max_filesize > 0 {
        if let Ok(metadata) = entry.metadata() {
            if metadata.len() > max_filesize as u64 {
                // 超过单文件大小上限：计入 skipped，不读取内容
                skipped.fetch_add(1, Ordering::Relaxed);
                return ignore::WalkState::Continue;
            }
        }
    }

    let path = entry.into_path();
    let Ok(buffer) = fs::read(&path) else {
        skipped.fetch_add(1, Ordering::Relaxed);
        return ignore::WalkState::Continue;
    };
    let Ok(content) = decode_text_bytes(buffer) else {
        // 二进制或无法解码的文件：计入 skipped，让调用方知道 0 结果不等于全库无匹配
        skipped.fetch_add(1, Ordering::Relaxed);
        return ignore::WalkState::Continue;
    };
    let (lines, _) = split_text_lines_for_read(&content);

    let mut local_matches: Vec<SearchMatch> = Vec::new();
    let mut matched_in_file = 0usize;

    for (index, line) in lines.iter().enumerate() {
        if matched_in_file >= max_per_file {
            break;
        }
        if let Some(found) = options.matcher.find(line) {
            matched_in_file += 1;
            local_matches.push(SearchMatch {
                path: relative_string(workspace, &path),
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
        let mut global = lock(&results);
        for m in local_matches {
            if global.len() >= max_results {
                truncated.store(true, Ordering::Relaxed);
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
) -> Result<(Vec<SearchMatch>, bool, usize), String> {
    let workspace_owned = workspace.to_path_buf();
    let max_filesize = options.max_bytes_per_file;

    let builder = build_search_walker_builder(&workspace_owned);

    // 不使用 builder.max_filesize 预过滤：超限文件需要计入 skipped_files，
    // 让调用方知道 0 结果不等于全库无匹配（改在访问条目时检查大小）

    let walker = builder.build_parallel();
    let workspace_ref = &workspace_owned;
    let results = Arc::new(Mutex::new(Vec::<SearchMatch>::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let skipped = Arc::new(AtomicUsize::new(0));
    let max_results = options.max_results;
    let max_per_file = options.max_matches_per_file;
    let context_lines = options.context_lines;

    walker.run(|| {
        let workspace = workspace_ref.clone();
        let results = Arc::clone(&results);
        let truncated = Arc::clone(&truncated);
        let skipped = Arc::clone(&skipped);
        Box::new(move |entry_result| {
            if truncated.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            handle_search_entry(
                entry_result,
                workspace.as_path(),
                options,
                max_filesize,
                max_results,
                max_per_file,
                context_lines,
                &results,
                &truncated,
                &skipped,
            )
        })
    });

    // app 模式：二次遍历 .CodePapr/apps（主遍历受项目 .gitignore 与名称
    // 过滤屏蔽无法到达）。结果并入同一共享状态，max_results 上限仍然生效。
    if include_codepapr_apps {
        if let Some(apps_walker) = build_apps_walker(&workspace_owned) {
            for entry_result in apps_walker {
                if truncated.load(Ordering::Relaxed) {
                    break;
                }
                handle_search_entry(
                    entry_result,
                    workspace_ref,
                    options,
                    max_filesize,
                    max_results,
                    max_per_file,
                    context_lines,
                    &results,
                    &truncated,
                    &skipped,
                );
            }
        }
    }

    let matches = Arc::try_unwrap(results)
        .unwrap_or_else(|_| unreachable!())
        .into_inner()
        .unwrap_or_else(|e| e.into_inner());
    Ok((
        matches,
        truncated.load(Ordering::Relaxed),
        skipped.load(Ordering::Relaxed),
    ))
}

pub(crate) fn collect_path_matches(
    workspace: &Path,
    options: &PreparedPathSearch,
    include_codepapr_apps: bool,
) -> Result<(Vec<PathSearchMatch>, bool), String> {
    let mut matches = Vec::new();
    let mut truncated = false;

    for entry in build_search_walker(workspace, None) {
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
