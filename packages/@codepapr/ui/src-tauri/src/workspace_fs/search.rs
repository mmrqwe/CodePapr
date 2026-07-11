use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};

use crate::shared::{canonical_workspace, relative_string, run_blocking_workspace_task};

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
) -> Result<PathSearchResult, String> {
    run_blocking_workspace_task(move || {
        search_workspace_paths_impl(
            workspace_path,
            query,
            case_sensitive,
            is_regexp,
            max_results,
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
    let (matches, truncated) = collect_search_matches(&workspace, &prepared)?;

    Ok(SearchResult {
        query: prepared.raw_query,
        matches,
        truncated,
    })
}

pub(crate) fn search_workspace_paths_impl(
    workspace_path: String,
    query: String,
    case_sensitive: Option<bool>,
    is_regexp: Option<bool>,
    max_results: Option<usize>,
) -> Result<PathSearchResult, String> {
    let workspace = canonical_workspace(&workspace_path)?;
    let prepared = prepare_path_search(query, case_sensitive, is_regexp, max_results)?;
    let (matches, truncated) = collect_path_matches(&workspace, &prepared)?;

    Ok(PathSearchResult {
        query: prepared.raw_query,
        matches,
        truncated,
    })
}

fn resolve_case_sensitivity(query: &str, requested: Option<bool>) -> bool {
    requested.unwrap_or_else(|| query.chars().any(|ch| ch.is_ascii_uppercase()))
}

fn build_search_regex(
    query: &str,
    is_regexp: Option<bool>,
    case_sensitive: bool,
) -> Result<Regex, String> {
    let pattern = if is_regexp.unwrap_or(false) {
        query.to_string()
    } else {
        regex::escape(query)
    };

    RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|err| format!("搜索正则无效: {err}"))
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
    Ok(PreparedTextSearch {
        raw_query: raw_query.clone(),
        matcher: build_search_regex(&raw_query, is_regexp, case_sensitive)?,
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
    Ok(PreparedPathSearch {
        raw_query: raw_query.clone(),
        matcher: build_search_regex(&raw_query, is_regexp, case_sensitive)?,
        max_results: max_results
            .unwrap_or(MAX_PATH_SEARCH_RESULTS)
            .clamp(1, MAX_PATH_SEARCH_RESULTS),
    })
}

fn build_search_walker(workspace: &Path, max_filesize: Option<usize>) -> ignore::Walk {
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

    if let Some(limit) = max_filesize {
        builder.max_filesize(Some(limit as u64));
    }

    builder.build()
}

pub(crate) fn collect_search_matches(
    workspace: &Path,
    options: &PreparedTextSearch,
) -> Result<(Vec<SearchMatch>, bool), String> {
    let workspace_owned = workspace.to_path_buf();
    let max_filesize = options.max_bytes_per_file;

    let mut builder = WalkBuilder::new(&workspace_owned);
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

    if max_filesize > 0 {
        builder.max_filesize(Some(max_filesize as u64));
    }

    let walker = builder.build_parallel();
    let workspace_ref = &workspace_owned;
    let results = Arc::new(Mutex::new(Vec::<SearchMatch>::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let max_results = options.max_results;
    let max_per_file = options.max_matches_per_file;
    let context_lines = options.context_lines;

    walker.run(|| {
        let workspace = workspace_ref.clone();
        let results = Arc::clone(&results);
        let truncated = Arc::clone(&truncated);
        Box::new(move |entry_result| {
            if truncated.load(Ordering::Relaxed) {
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
            if !file_type.is_file() {
                return ignore::WalkState::Continue;
            }

            let path = entry.into_path();
            let Ok(buffer) = fs::read(&path) else {
                return ignore::WalkState::Continue;
            };
            let Ok(content) = decode_text_bytes(buffer) else {
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
                        path: relative_string(workspace.as_path(), &path),
                        line: index + 1,
                        preview: line.trim().chars().take(240).collect(),
                        column: Some(found.start() + 1),
                        context_before: if context_lines > 0 {
                            Some(lines[index.saturating_sub(context_lines)..index].to_vec())
                        } else {
                            None
                        },
                        context_after: if context_lines > 0 {
                            Some(
                                lines[index + 1..(index + 1 + context_lines).min(lines.len())]
                                    .to_vec(),
                            )
                        } else {
                            None
                        },
                    });
                }
            }

            if !local_matches.is_empty() {
                let mut global = results.lock().unwrap();
                for m in local_matches {
                    if global.len() >= max_results {
                        truncated.store(true, Ordering::Relaxed);
                        break;
                    }
                    global.push(m);
                }
            }

            ignore::WalkState::Continue
        })
    });

    let matches = Arc::try_unwrap(results)
        .unwrap_or_else(|_| unreachable!())
        .into_inner()
        .unwrap();
    Ok((matches, truncated.load(Ordering::Relaxed)))
}

pub(crate) fn collect_path_matches(
    workspace: &Path,
    options: &PreparedPathSearch,
) -> Result<(Vec<PathSearchMatch>, bool), String> {
    let mut matches = Vec::new();
    let mut truncated = false;

    for entry in build_search_walker(workspace, None) {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.depth() == 0 {
            continue;
        }

        let path = entry.into_path();
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
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
            if matches.len() >= options.max_results {
                truncated = true;
                break;
            }
        }
    }

    Ok((matches, truncated))
}
