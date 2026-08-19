use regex::Regex;
use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) is_dir: bool,
    pub(crate) bytes: u64,
    pub(crate) has_children: bool,
    pub(crate) mtime_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListFilesResult {
    pub(crate) root: String,
    pub(crate) entries: Vec<FileEntry>,
    pub(crate) truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadFileResult {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) bytes: usize,
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) total_lines: usize,
    pub(crate) truncated_by_range: bool,
    pub(crate) truncated_by_bytes: bool,
    pub(crate) location_line: Option<usize>,
    pub(crate) location_column: Option<usize>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadImageFileResult {
    pub(crate) path: String,
    pub(crate) media_type: String,
    pub(crate) data: String,
    pub(crate) bytes: usize,
}

pub(crate) struct ReadWindow {
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) total_lines: usize,
    pub(crate) truncated_by_range: bool,
    pub(crate) location_line: Option<usize>,
    pub(crate) location_column: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteFileResult {
    pub(crate) path: String,
    pub(crate) bytes: usize,
    /// 非 UTF-8（或带 BOM）文件按原编码回写时的编码标识
    pub(crate) encoding: Option<String>,
    pub(crate) change: WriteFileChangeSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteFileChangeSummary {
    pub(crate) kind: String,
    pub(crate) added: usize,
    pub(crate) deleted: usize,
    pub(crate) before_lines: usize,
    pub(crate) after_lines: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMatch {
    pub(crate) path: String,
    pub(crate) line: usize,
    pub(crate) preview: String,
    pub(crate) column: Option<usize>,
    pub(crate) context_before: Option<Vec<String>>,
    pub(crate) context_after: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathSearchMatch {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) is_dir: bool,
    pub(crate) bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub(crate) query: String,
    pub(crate) matches: Vec<SearchMatch>,
    pub(crate) truncated: bool,
    /// 正则编译失败后已降级为字面量搜索
    pub(crate) regex_degraded: bool,
    /// 因读取失败/解码失败（二进制）/超出大小限制而被跳过的文件数
    pub(crate) skipped_files: usize,
    pub(crate) note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathSearchResult {
    pub(crate) query: String,
    pub(crate) matches: Vec<PathSearchMatch>,
    pub(crate) truncated: bool,
    /// 正则编译失败后已降级为字面量搜索
    pub(crate) regex_degraded: bool,
    pub(crate) note: Option<String>,
}

pub(crate) struct PreparedTextSearch {
    pub(crate) raw_query: String,
    pub(crate) matcher: Regex,
    pub(crate) regex_degraded: bool,
    pub(crate) context_lines: usize,
    pub(crate) max_results: usize,
    pub(crate) max_matches_per_file: usize,
    pub(crate) max_bytes_per_file: usize,
}

pub(crate) struct PreparedPathSearch {
    pub(crate) raw_query: String,
    pub(crate) matcher: Regex,
    pub(crate) regex_degraded: bool,
    pub(crate) max_results: usize,
}
