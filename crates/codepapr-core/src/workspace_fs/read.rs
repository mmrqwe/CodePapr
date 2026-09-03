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

pub async fn read_text_file(
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

    // \r\n → \n；残留的孤立 \r（老 Mac 换行）也按换行处理
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
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

    // 与整文件读取保持一致的换行风格：CRLF 文件窗口读取不降级为 LF
    let line_ending = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let (lines, has_trailing_newline) = split_text_lines_for_read(content);
    let mut selected = lines[window.start_line - 1..window.end_line].join(line_ending);
    if !selected.is_empty() && (window.end_line < window.total_lines || has_trailing_newline) {
        selected.push_str(line_ending);
    }
    let bytes = selected.len();
    (selected, bytes)
}

// ── Artifact 回读（PR2：history_read_artifact 的 Rust 实现）────────────────
//
// 只读接口，供模型/UI 按需取回已外置的大工具输出。安全约束：
// - artifactId 必须是 `.CodePapr/tool-output/` 内的相对路径（禁止 `..`/绝对路径）；
// - 只读，不写入任何内容；
// - 字节/字符上限钳制，绝不把完整大文件整体注入未来上下文。

const ARTIFACT_DIR: &str = ".CodePapr/tool-output";
/// 单次回读的字符上限（offset/limit 语义，`truncated` 标记是否还有更多内容）。
const MAX_ARTIFACT_READ_CHARS: usize = 200_000;
/// 整文件读取的字节硬上限（超出部分不读；artifact 是工具输出，正常远小于此）。
const MAX_ARTIFACT_SOURCE_BYTES: usize = 5_000_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactReadResult {
    pub(crate) artifact_id: String,
    pub(crate) content: String,
    pub(crate) total_chars: usize,
    pub(crate) truncated: bool,
}

pub async fn read_artifact(
    workspace_path: String,
    artifact_id: String,
    offset_chars: Option<usize>,
    limit_chars: Option<usize>,
) -> Result<ArtifactReadResult, String> {
    run_blocking_workspace_task(move || {
        read_artifact_impl(workspace_path, artifact_id, offset_chars, limit_chars)
    })
    .await
}

pub(crate) fn read_artifact_impl(
    workspace_path: String,
    artifact_id: String,
    offset_chars: Option<usize>,
    limit_chars: Option<usize>,
) -> Result<ArtifactReadResult, String> {
    // 路径约束：相对路径、无 `..` 段、必须位于 ARTIFACT_DIR 内
    let normalized = artifact_id.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.split('/').any(|segment| segment == ".." || segment.is_empty())
    {
        return Err("artifact 路径非法".to_string());
    }
    let dir_prefix = format!("{ARTIFACT_DIR}/");
    if !normalized.starts_with(&dir_prefix) || normalized.len() <= dir_prefix.len() {
        return Err(format!("artifact 必须位于 {ARTIFACT_DIR}/ 目录内"));
    }

    let path_input = parse_workspace_path_input(Some(&normalized));
    let (workspace, target) = resolve_existing_path(&workspace_path, Some(&path_input.path))?;
    if !target.is_file() {
        return Err("artifact 不存在".to_string());
    }

    let mut file = fs::File::open(&target)
        .map_err(|err| format!("无法打开 artifact {}: {err}", target.display()))?;
    let mut buffer = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take((MAX_ARTIFACT_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("读取 artifact 失败: {err}"))?;
    if buffer.len() > MAX_ARTIFACT_SOURCE_BYTES {
        buffer.truncate(MAX_ARTIFACT_SOURCE_BYTES);
    }
    let content = decode_text_bytes(buffer)?;
    let total_chars = content.chars().count();

    let offset = offset_chars.unwrap_or(0).min(total_chars);
    let limit = limit_chars
        .unwrap_or(MAX_ARTIFACT_READ_CHARS)
        .clamp(1, MAX_ARTIFACT_READ_CHARS);
    let selected: String = content.chars().skip(offset).take(limit).collect();
    let truncated = offset + limit < total_chars;

    Ok(ArtifactReadResult {
        artifact_id: relative_string(&workspace, &target),
        content: selected,
        total_chars,
        truncated,
    })
}

fn is_probably_binary_content(bytes: &[u8]) -> bool {    if bytes.contains(&0) {
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

pub async fn read_text_files_batch(
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
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
    ("jfif", "image/jpeg"),
    ("tiff", "image/tiff"),
    ("tif", "image/tiff"),
];

fn detect_media_type(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, mt)| *mt)
}

pub async fn read_image_file(
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
        .ok_or_else(|| "不支持的文件格式，仅支持 PNG、JPEG、WebP、GIF、BMP、SVG、ICO、AVIF、TIFF".to_string())?
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

/// 文本编码探测结果。写入时按原编码回写，避免编辑导致静默转码/BOM 丢失。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16LeBom,
    Utf16BeBom,
    /// 无 BOM，启发式识别
    Utf16Le,
    Utf16Be,
    /// GBK/GB2312 超集
    Gb18030,
}

impl TextEncoding {
    pub(crate) fn label(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "utf-8",
            TextEncoding::Utf8Bom => "utf-8-bom",
            TextEncoding::Utf16LeBom | TextEncoding::Utf16Le => "utf-16le",
            TextEncoding::Utf16BeBom | TextEncoding::Utf16Be => "utf-16be",
            TextEncoding::Gb18030 => "gb18030",
        }
    }
}

/// 探测字节序列的文本编码；二进制内容返回 None。
pub(crate) fn detect_text_encoding(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.starts_with(b"\xef\xbb\xbf") {
        return Some(TextEncoding::Utf8Bom);
    }
    // UTF-16 BOM 必须在二进制检测之前（UTF-16 内容含 NUL 字节）
    if bytes.starts_with(b"\xff\xfe") {
        return Some(TextEncoding::Utf16LeBom);
    }
    if bytes.starts_with(b"\xfe\xff") {
        return Some(TextEncoding::Utf16BeBom);
    }
    if let Some(encoding) = detect_utf16_without_bom(bytes) {
        return Some(encoding);
    }
    if is_probably_binary_content(bytes) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => Some(TextEncoding::Utf8),
        Err(err) => {
            // 仅尾部不完整序列（按字节上限截断导致）仍视为 UTF-8，
            // 避免落入 GB18030 兜底在截断点产生乱码
            if err.error_len().is_none() && err.valid_up_to() >= bytes.len().saturating_sub(3) {
                return Some(TextEncoding::Utf8);
            }
            Some(TextEncoding::Gb18030)
        }
    }
}

pub(crate) fn decode_text_bytes(bytes: Vec<u8>) -> Result<String, String> {
    let Some(encoding) = detect_text_encoding(&bytes) else {
        return Err("文件包含二进制内容，拒绝作为文本读取".to_string());
    };

    match encoding {
        TextEncoding::Utf8Bom => decode_utf8_body(&bytes[3..]),
        TextEncoding::Utf16LeBom => decode_utf16(&bytes[2..], encoding_rs::UTF_16LE),
        TextEncoding::Utf16BeBom => decode_utf16(&bytes[2..], encoding_rs::UTF_16BE),
        TextEncoding::Utf16Le => decode_utf16(&bytes, encoding_rs::UTF_16LE),
        TextEncoding::Utf16Be => decode_utf16(&bytes, encoding_rs::UTF_16BE),
        TextEncoding::Utf8 => decode_utf8_body(&bytes),
        TextEncoding::Gb18030 => {
            let (decoded, _, had_errors) = encoding_rs::GB18030.decode(&bytes);
            if !had_errors {
                return Ok(decoded.into_owned());
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
    }
}

fn decode_utf8_body(bytes: &[u8]) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(content) => Ok(content.to_string()),
        Err(err) if err.error_len().is_none() => {
            // 尾部不完整多字节序列（截断导致）：修剪后解码
            let trimmed = &bytes[..err.valid_up_to()];
            std::str::from_utf8(trimmed)
                .map(|content| content.to_string())
                .map_err(|err| format!("UTF-8 解码失败: {err}"))
        }
        Err(err) => Err(format!("UTF-8 解码失败: {err}")),
    }
}

fn decode_utf16(bytes: &[u8], encoding: &'static encoding_rs::Encoding) -> Result<String, String> {
    // 按字节上限截断可能落在奇数字节：丢弃尾部半个码元而不是报错
    let usable = bytes.len() / 2 * 2;
    let (decoded, _, had_errors) = encoding.decode(&bytes[..usable]);
    if had_errors {
        return Err("文件包含二进制内容，拒绝作为文本读取".to_string());
    }
    Ok(decoded.into_owned())
}

/// 无 BOM UTF-16 启发式：NUL 字节集中出现在奇数位（LE）或偶数位（BE），
/// 且另一侧几乎没有 NUL。典型场景：Windows 工具生成的 ASCII 为主的 UTF-16 文件。
fn detect_utf16_without_bom(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.len() < 4 {
        return None;
    }

    let mut even_nuls = 0usize;
    let mut odd_nuls = 0usize;
    for (index, &byte) in bytes.iter().enumerate() {
        if byte == 0 {
            if index % 2 == 0 {
                even_nuls += 1;
            } else {
                odd_nuls += 1;
            }
        }
    }

    let (dominant, other, encoding) = if odd_nuls >= even_nuls {
        (odd_nuls, even_nuls, TextEncoding::Utf16Le)
    } else {
        (even_nuls, odd_nuls, TextEncoding::Utf16Be)
    };

    // 主导侧 NUL 占比需 >= 25%，且另一侧 NUL 极少，避免误判真正的二进制
    if dominant * 4 < bytes.len() || other * 3 > dominant {
        return None;
    }

    // 校验可解码性（截断的尾部奇数字节在解码阶段丢弃）
    let usable = bytes.len() / 2 * 2;
    let rs_encoding = match encoding {
        TextEncoding::Utf16Le => encoding_rs::UTF_16LE,
        _ => encoding_rs::UTF_16BE,
    };
    let (_, _, had_errors) = rs_encoding.decode(&bytes[..usable]);
    if had_errors {
        return None;
    }
    Some(encoding)
}

/// 按指定编码回写文本内容（BOM 随编码变体保留/省略）。
pub(crate) fn encode_text_with_encoding(content: &str, encoding: TextEncoding) -> Vec<u8> {
    match encoding {
        TextEncoding::Utf8 => content.as_bytes().to_vec(),
        TextEncoding::Utf8Bom => {
            let mut out = Vec::with_capacity(3 + content.len());
            out.extend_from_slice(b"\xef\xbb\xbf");
            out.extend_from_slice(content.as_bytes());
            out
        }
        TextEncoding::Utf16LeBom | TextEncoding::Utf16Le => {
            let mut out = Vec::with_capacity(content.len() * 2 + 2);
            if encoding == TextEncoding::Utf16LeBom {
                out.extend_from_slice(b"\xff\xfe");
            }
            for unit in content.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        TextEncoding::Utf16BeBom | TextEncoding::Utf16Be => {
            let mut out = Vec::with_capacity(content.len() * 2 + 2);
            if encoding == TextEncoding::Utf16BeBom {
                out.extend_from_slice(b"\xfe\xff");
            }
            for unit in content.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            out
        }
        // encoding_rs 的 UTF-16 编码器被规范禁用（会输出 UTF-8），故手工编码；
        // GB18030 编码器可用且覆盖全部 Unicode
        TextEncoding::Gb18030 => encode_with(encoding_rs::GB18030, content),
    }
}

fn encode_with(encoding: &'static encoding_rs::Encoding, content: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() * 4);
    let mut encoder = encoding.new_encoder();
    let mut input = content;
    loop {
        let (result, read, _) = encoder.encode_from_utf8_to_vec(input, &mut out, true);
        input = &input[read..];
        match result {
            encoding_rs::CoderResult::InputEmpty => break,
            encoding_rs::CoderResult::OutputFull => continue,
        }
    }
    out
}
