use std::fs;
use std::io::Read;

use base64::Engine;
use serde::Serialize;

use crate::shared::{
    parse_workspace_path_input, relative_string, resolve_existing_path,
    run_blocking_workspace_task, PathLocationInput,
};

use super::types::{ReadFileResult, ReadImageFileResult, ReadWindow};
use super::{
    DEFAULT_ANCHORED_CONTEXT_LINES, DEFAULT_MAX_READ_BYTES, MAX_RANGE_SOURCE_BYTES, MAX_READ_BYTES,
    MAX_READ_CONTEXT_LINES,
};

#[tauri::command]
pub(crate) async fn read_text_file(
    workspace_path: String,
    relative_path: String,
    max_bytes: Option<usize>,
    start_line: Option<usize>,
    end_line: Option<usize>,
    around_line: Option<usize>,
    context_lines: Option<usize>,
) -> Result<ReadFileResult, String> {
    run_blocking_workspace_task(move || {
        read_text_file_impl(
            workspace_path,
            relative_path,
            max_bytes,
            start_line,
            end_line,
            around_line,
            context_lines,
        )
    })
    .await
}

pub(crate) fn read_text_file_impl(
    workspace_path: String,
    relative_path: String,
    max_bytes: Option<usize>,
    start_line: Option<usize>,
    end_line: Option<usize>,
    around_line: Option<usize>,
    context_lines: Option<usize>,
) -> Result<ReadFileResult, String> {
    let max_bytes = clamp_read_bytes(max_bytes);
    let path_input = parse_workspace_path_input(Some(&relative_path));
    let (workspace, target) = resolve_existing_path(&workspace_path, Some(&path_input.path))?;
    if !target.is_file() {
        return Err("读取文本需要传入文件路径".to_string());
    }

    let has_requested_window = start_line.is_some()
        || end_line.is_some()
        || around_line.is_some()
        || path_input.line.is_some();
    let source_byte_limit = if has_requested_window {
        MAX_RANGE_SOURCE_BYTES
    } else {
        max_bytes
    };

    let mut file = fs::File::open(&target)
        .map_err(|err| format!("无法打开文件 {}: {err}", target.display()))?;
    let mut buffer = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take((source_byte_limit + 1) as u64)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("读取文件失败: {err}"))?;

    let mut truncated_by_bytes = buffer.len() > source_byte_limit;

    // Read the full buffer; take exactly source_byte_limit bytes for decoding
    if truncated_by_bytes {
        buffer.truncate(source_byte_limit);
    }

    let mut content = decode_text_bytes(buffer)?;
    if !has_requested_window {
        let (truncated_content, was_truncated) = truncate_to_bytes(&content, max_bytes);
        if was_truncated {
            content = truncated_content.to_string();
            truncated_by_bytes = true;
        }
    }

    let (lines, _) = split_text_lines_for_read(&content);
    let window = compute_read_window(
        lines.len(),
        start_line,
        end_line,
        around_line,
        context_lines,
        &path_input,
    )?;
    let (selected, selected_bytes) = slice_content_by_window(&content, &window);
    if has_requested_window {
        let (truncated_selected, was_truncated) = truncate_to_bytes(&selected, max_bytes);
        if was_truncated {
            truncated_by_bytes = true;
        }
        let final_content = truncated_selected.to_string();
        let final_bytes = final_content.len();
        return Ok(ReadFileResult {
            path: relative_string(&workspace, &target),
            content: final_content,
            bytes: final_bytes,
            start_line: window.start_line,
            end_line: window.end_line,
            total_lines: window.total_lines,
            truncated_by_range: window.truncated_by_range,
            truncated_by_bytes,
            location_line: window.location_line,
            location_column: window.location_column,
        });
    }

    Ok(ReadFileResult {
        path: relative_string(&workspace, &target),
        content,
        bytes: selected_bytes,
        start_line: window.start_line,
        end_line: window.end_line,
        total_lines: window.total_lines,
        truncated_by_range: window.truncated_by_range,
        truncated_by_bytes,
        location_line: window.location_line,
        location_column: window.location_column,
    })
}

fn truncate_to_bytes(content: &str, max_bytes: usize) -> (&str, bool) {
    if content.len() <= max_bytes {
        return (content, false);
    }
    let mut end = max_bytes;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    (&content[..end], true)
}

fn clamp_read_bytes(max_bytes: Option<usize>) -> usize {
    max_bytes
        .unwrap_or(DEFAULT_MAX_READ_BYTES)
        .clamp(1_000, MAX_READ_BYTES)
}

pub(super) fn split_text_lines_for_read(content: &str) -> (Vec<String>, bool) {
    if content.is_empty() {
        return (Vec::new(), false);
    }

    let normalized = content.replace("\r\n", "\n");
    let has_trailing_newline = normalized.ends_with('\n');
    let mut lines = normalized
        .split('\n')
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    if has_trailing_newline {
        lines.pop();
    }

    (lines, has_trailing_newline)
}

fn clamp_line_number(value: Option<usize>, fallback: usize) -> usize {
    value.filter(|line| *line > 0).unwrap_or(fallback)
}

fn compute_read_window(
    total_lines: usize,
    start_line: Option<usize>,
    end_line: Option<usize>,
    around_line: Option<usize>,
    context_lines: Option<usize>,
    hint: &PathLocationInput,
) -> Result<ReadWindow, String> {
    if total_lines == 0 {
        return Ok(ReadWindow {
            start_line: 0,
            end_line: 0,
            total_lines: 0,
            truncated_by_range: false,
            location_line: hint.line,
            location_column: hint.column,
        });
    }

    let effective_around_line = around_line.or(hint.line);
    let context_lines = context_lines
        .unwrap_or(DEFAULT_ANCHORED_CONTEXT_LINES)
        .min(MAX_READ_CONTEXT_LINES);

    let (start_line, end_line) =
        if let Some(center) = effective_around_line.filter(|line| *line > 0) {
            let center = center.min(total_lines);
            (
                center.saturating_sub(context_lines).max(1),
                (center + context_lines).min(total_lines),
            )
        } else if start_line.is_some() || end_line.is_some() {
            let start_line = clamp_line_number(start_line, 1).min(total_lines);
            let end_line = clamp_line_number(end_line, total_lines).min(total_lines);
            if end_line < start_line {
                return Err("endLine 不能小于 startLine".to_string());
            }
            (start_line, end_line)
        } else {
            (1, total_lines)
        };

    Ok(ReadWindow {
        start_line,
        end_line,
        total_lines,
        truncated_by_range: start_line != 1 || end_line != total_lines,
        location_line: effective_around_line
            .map(|line| line.min(total_lines))
            .or(hint.line),
        location_column: hint.column,
    })
}

fn slice_content_by_window(content: &str, window: &ReadWindow) -> (String, usize) {
    if content.is_empty()
        || window.total_lines == 0
        || window.start_line == 0
        || window.end_line == 0
    {
        return (String::new(), 0);
    }

    let (lines, has_trailing_newline) = split_text_lines_for_read(content);
    let mut selected = lines[window.start_line - 1..window.end_line].join("\n");
    if !selected.is_empty() && (window.end_line < window.total_lines || has_trailing_newline) {
        selected.push('\n');
    }
    let bytes = selected.len();
    (selected, bytes)
}

fn is_probably_binary_content(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return true;
    }

    let suspicious = bytes
        .iter()
        .filter(|&&byte| matches!(byte, 0x01..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F))
        .count();

    suspicious > 0 && suspicious * 100 > bytes.len().max(1)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchFileRead {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) bytes: usize,
}

#[tauri::command]
pub(crate) async fn read_text_files_batch(
    workspace_path: String,
    relative_paths: Vec<String>,
    max_bytes: Option<usize>,
) -> Result<Vec<BatchFileRead>, String> {
    run_blocking_workspace_task(move || {
        let max_bytes = std::cmp::min(
            max_bytes.unwrap_or(DEFAULT_MAX_READ_BYTES),
            MAX_READ_BYTES,
        )
        .max(1_000);
        let mut results = Vec::with_capacity(relative_paths.len());
        for rp in &relative_paths {
            let path_input = parse_workspace_path_input(Some(rp));
            let (workspace, target) = match resolve_existing_path(&workspace_path, Some(&path_input.path)) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if !target.is_file() {
                continue;
            }
            let mut file = match fs::File::open(&target) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let mut buffer = Vec::new();
            if std::io::Read::by_ref(&mut file)
                .take((max_bytes + 1) as u64)
                .read_to_end(&mut buffer)
                .is_err()
            {
                continue;
            }
            if buffer.len() > max_bytes {
                buffer.truncate(max_bytes);
            }
            let content = match decode_text_bytes(buffer) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let bytes = content.len();
            results.push(BatchFileRead {
                path: relative_string(&workspace, &target),
                content,
                bytes,
            });
        }
        Ok(results)
    })
    .await
}

const DEFAULT_MAX_READ_IMAGE_BYTES: usize = 5_000_000;
const MAX_READ_IMAGE_BYTES: usize = 25_000_000;

const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
    ("svg", "image/svg+xml"),
];

fn detect_media_type(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, mt)| *mt)
}

#[tauri::command]
pub(crate) async fn read_image_file(
    workspace_path: String,
    relative_path: String,
    max_bytes: Option<usize>,
) -> Result<ReadImageFileResult, String> {
    run_blocking_workspace_task(move || {
        read_image_file_impl(workspace_path, relative_path, max_bytes)
    })
    .await
}

pub(crate) fn read_image_file_impl(
    workspace_path: String,
    relative_path: String,
    max_bytes: Option<usize>,
) -> Result<ReadImageFileResult, String> {
    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_MAX_READ_IMAGE_BYTES)
        .clamp(1_000, MAX_READ_IMAGE_BYTES);

    let path_input = parse_workspace_path_input(Some(&relative_path));
    let (workspace, target) = resolve_existing_path(&workspace_path, Some(&path_input.path))?;
    if !target.is_file() {
        return Err("read_image 需要传入文件路径".to_string());
    }

    let media_type = detect_media_type(&target)
        .ok_or_else(|| "不支持的文件格式，仅支持 PNG、JPEG、WebP、GIF、BMP、SVG".to_string())?
        .to_string();

    let metadata = fs::metadata(&target)
        .map_err(|err| format!("无法读取文件信息: {err}"))?;
    let file_size = metadata.len() as usize;

    if file_size > max_bytes {
        return Err(format!(
            "图片文件过大（{} bytes），超过限制（{} bytes）",
            file_size, max_bytes
        ));
    }

    let mut file = fs::File::open(&target)
        .map_err(|err| format!("无法打开文件 {}: {err}", target.display()))?;
    let mut buffer = Vec::with_capacity(file_size);
    file.read_to_end(&mut buffer)
        .map_err(|err| format!("读取文件失败: {err}"))?;

    let data = base64::engine::general_purpose::STANDARD.encode(&buffer);

    Ok(ReadImageFileResult {
        path: relative_string(&workspace, &target),
        media_type,
        data,
        bytes: file_size,
    })
}

pub(crate) fn decode_text_bytes(bytes: Vec<u8>) -> Result<String, String> {
    if is_probably_binary_content(&bytes) {
        return Err("文件包含二进制内容，拒绝作为文本读取".to_string());
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(content),
        Err(error) => {
            let bytes = error.into_bytes();
            if is_probably_binary_content(&bytes) {
                return Err("文件包含二进制内容，拒绝作为文本读取".to_string());
            }

            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}
