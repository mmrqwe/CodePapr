use bitflags::bitflags;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock, RwLock},
};

// ── Unified symbol model ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSymbolDefinition {
    pub name: String,
    pub kind: u64,
    pub signature: String,
    pub detail: String,
    pub line: usize,
    pub column: usize,
    pub end_column: usize,
    pub container_name: Option<String>,
    pub exported: bool,
    pub symbol_source: SymbolSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum SymbolSource {
    Lsp,
    Ast,
    Regex,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolLocation {
    pub uri: String,
    pub line: usize,
    pub character: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverResult {
    pub contents: String,
    pub line: usize,
    pub start_column: usize,
    pub end_column: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ReferenceResult {
    pub locations: Vec<SymbolLocation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxErrorInfo {
    pub line: usize,
    pub column: usize,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCheckResult {
    pub supported: bool,
    pub error_count: usize,
    pub errors: Vec<SyntaxErrorInfo>,
}

/// 文件符号信息（含行范围），用于 read 工具的符号切片与文件大纲。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSymbolInfo {
    pub name: String,
    pub kind: String,
    pub line: usize,
    pub end_line: usize,
    pub signature: String,
    pub container_name: Option<String>,
}

// ── Provider capability ──────────────────────────────────────────────

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ProviderCapability: u8 {
        const SYMBOLS       = 1 << 0;
        const DEFINITION    = 1 << 1;
        const HOVER         = 1 << 2;
        const REFERENCES     = 1 << 3;
        const DIAGNOSTICS   = 1 << 4;
        const EDGE_ENRICH   = 1 << 5;
    }
}

impl Serialize for ProviderCapability {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut flags = Vec::new();
        if self.contains(ProviderCapability::SYMBOLS) {
            flags.push("symbols");
        }
        if self.contains(ProviderCapability::DEFINITION) {
            flags.push("definition");
        }
        if self.contains(ProviderCapability::HOVER) {
            flags.push("hover");
        }
        if self.contains(ProviderCapability::REFERENCES) {
            flags.push("references");
        }
        if self.contains(ProviderCapability::DIAGNOSTICS) {
            flags.push("diagnostics");
        }
        if self.contains(ProviderCapability::EDGE_ENRICH) {
            flags.push("edge-enrich");
        }
        flags.serialize(serializer)
    }
}

// ── Provider trait ────────────────────────────────────────────────────

pub trait SymbolProvider: Send + Sync {
    // 返回借用 self 的 &str 而非 &'static str：旧签名逼着 String 字段的实现
    // 用 Box::leak 每次调用都永久泄漏一份字符串（随使用无界增长）。
    fn language_id(&self) -> &str;
    fn provider_name(&self) -> &str;
    fn source(&self) -> SymbolSource;
    fn capability(&self) -> ProviderCapability;

    fn extract_symbols(
        &self,
        path: &str,
        content: &str,
    ) -> Result<Vec<UnifiedSymbolDefinition>, String>;

    fn hover(
        &self,
        _path: &str,
        _content: &str,
        _line: usize,
        _character: usize,
    ) -> Result<Option<HoverResult>, String> {
        Ok(None)
    }

    fn definition(
        &self,
        _path: &str,
        _content: &str,
        _line: usize,
        _character: usize,
    ) -> Result<Vec<SymbolLocation>, String> {
        Ok(Vec::new())
    }

    fn references(
        &self,
        _path: &str,
        _content: &str,
        _line: usize,
        _character: usize,
    ) -> Result<Vec<SymbolLocation>, String> {
        Ok(Vec::new())
    }

    /// 语法检查（tree-sitter）。返回 None 表示该 provider 不支持语法检查。
    fn check_syntax(&self, _content: &str) -> Option<SyntaxCheckResult> {
        None
    }

    /// 提取文件符号（含行范围），用于符号切片与文件大纲。返回空表示该 provider 不支持。
    fn file_symbols(&self, _content: &str) -> Vec<FileSymbolInfo> {
        Vec::new()
    }
}

// ── Provider registry ─────────────────────────────────────────────────

type SharedProvider = Arc<dyn SymbolProvider>;

struct ProviderRegistry {
    providers: Vec<SharedProvider>,
    language_index: HashMap<String, Vec<usize>>,
}

impl ProviderRegistry {
    fn new() -> Self {
        ProviderRegistry {
            providers: Vec::new(),
            language_index: HashMap::new(),
        }
    }

    fn register(&mut self, provider: SharedProvider) {
        let index = self.providers.len();
        let language_id = provider.language_id().to_string();
        self.providers.push(provider);
        self.language_index
            .entry(language_id)
            .or_default()
            .push(index);
    }

    fn providers_for_language(&self, language_id: &str) -> Vec<&SharedProvider> {
        let Some(indices) = self.language_index.get(language_id) else {
            return Vec::new();
        };
        indices
            .iter()
            .filter_map(|index| self.providers.get(*index))
            .collect()
    }

    pub fn all_languages(&self) -> Vec<String> {
        self.language_index.keys().cloned().collect()
    }
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn resolve_symbol_provider(language_id: String) -> Result<ResolvedProviderInfo, String> {
    ProviderSelector::resolve(&language_id)
        .ok_or_else(|| format!("{language_id} 无可用 SymbolProvider"))
}

#[tauri::command]
pub fn list_available_symbol_providers() -> Result<Vec<ResolvedProviderInfo>, String> {
    let reg = registry()
        .read()
        .map_err(|_| "ProviderRegistry 锁中毒".to_string())?;
    let languages = reg.all_languages();
    let mut infos = Vec::new();
    for lang in languages {
        if let Some(info) = ProviderSelector::resolve(&lang) {
            infos.push(info);
        }
    }
    infos.sort_by(|a, b| a.language_id.cmp(&b.language_id));
    Ok(infos)
}

static PROVIDER_REGISTRY: OnceLock<RwLock<ProviderRegistry>> = OnceLock::new();

fn registry() -> &'static RwLock<ProviderRegistry> {
    PROVIDER_REGISTRY.get_or_init(|| RwLock::new(ProviderRegistry::new()))
}

pub fn register_provider(provider: SharedProvider) -> Result<(), String> {
    let mut reg = registry()
        .write()
        .map_err(|_| "ProviderRegistry 锁中毒".to_string())?;
    reg.register(provider);
    Ok(())
}

/// 对指定语言做 tree-sitter 语法检查。无 AST provider（或解析失败）时返回 `supported: false`，
/// 调用方据此降级（跳过语法预检），而非报错。
pub fn check_syntax_for_language(language_id: &str, content: &str) -> SyntaxCheckResult {
    let Ok(reg) = registry().read() else {
        return SyntaxCheckResult {
            supported: false,
            error_count: 0,
            errors: vec![],
        };
    };
    for provider in reg.providers_for_language(language_id) {
        if let Some(result) = provider.check_syntax(content) {
            return result;
        }
    }
    SyntaxCheckResult {
        supported: false,
        error_count: 0,
        errors: vec![],
    }
}

#[tauri::command]
pub fn check_syntax(language_id: String, content: String) -> Result<SyntaxCheckResult, String> {
    Ok(check_syntax_for_language(&language_id, &content))
}

/// 提取文件符号（含行范围），用于 read 工具的符号切片与文件大纲。
/// 无 AST provider（或解析失败）时返回空 Vec，调用方据此降级，绝不报错。
pub fn extract_file_symbols_for_language(language_id: &str, content: &str) -> Vec<FileSymbolInfo> {
    let Ok(reg) = registry().read() else {
        return Vec::new();
    };
    for provider in reg.providers_for_language(language_id) {
        let symbols = provider.file_symbols(content);
        if !symbols.is_empty() {
            return symbols;
        }
    }
    Vec::new()
}

#[tauri::command]
pub fn extract_file_symbols(
    language_id: String,
    content: String,
) -> Result<Vec<FileSymbolInfo>, String> {
    Ok(extract_file_symbols_for_language(&language_id, &content))
}

// ── Provider selector: LSP → AST → Regex 降级链 ─────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProviderInfo {
    pub language_id: String,
    pub provider_name: String,
    pub source: SymbolSource,
    pub capability: ProviderCapability,
    pub fallback_chain: Vec<String>,
}

pub struct ProviderSelector;

impl ProviderSelector {
    pub fn select(language_id: &str) -> Option<(SharedProvider, ResolvedProviderInfo)> {
        let reg = registry().read().ok()?;
        let providers = reg.providers_for_language(language_id);
        if providers.is_empty() {
            return None;
        }

        let mut chain = Vec::new();
        for provider in &providers {
            chain.push(provider.provider_name().to_string());
        }

        let best = providers.first()?;
        let info = ResolvedProviderInfo {
            language_id: language_id.to_string(),
            provider_name: best.provider_name().to_string(),
            source: best.source(),
            capability: best.capability(),
            fallback_chain: chain,
        };

        Some((Arc::clone(best), info))
    }

    pub fn resolve(language_id: &str) -> Option<ResolvedProviderInfo> {
        Self::select(language_id).map(|(_, info)| info)
    }

    #[allow(dead_code)]
    pub fn best_source(language_id: &str) -> SymbolSource {
        Self::select(language_id)
            .map(|(_, info)| info.source)
            .unwrap_or(SymbolSource::None)
    }
}

// ── Regex-based provider (declarative patterns) ────────────────────────

use regex::Regex;
use std::collections::HashSet;

struct LanguagePatterns {
    language_id: &'static str,
    type_regex: Option<&'static str>,
    callable_regex: Option<&'static str>,
    variable_regex: Option<&'static str>,
    import_regex: Option<&'static str>,
    kind_map: HashMap<&'static str, u64>,
}

struct RegexSymbolProvider {
    language_id: &'static str,
    provider_name: String,
    patterns: LanguagePatterns,
}

impl RegexSymbolProvider {
    fn new(patterns: LanguagePatterns) -> Self {
        let provider_name = format!("regex-{}", patterns.language_id);
        RegexSymbolProvider {
            language_id: patterns.language_id,
            provider_name,
            patterns,
        }
    }

    fn parse_symbols(&self, text: &str) -> Vec<UnifiedSymbolDefinition> {
        let lines = line_start_offsets(text);
        let mut symbols = Vec::new();
        let mut seen = HashSet::new();

        for (line_index, line) in iter_lines(text, &lines) {
            if let Some(type_regex_str) = self.patterns.type_regex {
                if let Some(regex) = compile_regex(type_regex_str) {
                    if let Some(symbol) = self.extract_type_like(line_index, line, &regex) {
                        push_unique(&mut symbols, &mut seen, symbol);
                        continue;
                    }
                }
            }

            if let Some(callable_str) = self.patterns.callable_regex {
                if let Some(regex) = compile_regex(callable_str) {
                    if let Some(symbol) = self.extract_callable(line_index, line, &regex) {
                        push_unique(&mut symbols, &mut seen, symbol);
                    }
                }
            }

            if let Some(variable_str) = self.patterns.variable_regex {
                if let Some(regex) = compile_regex(variable_str) {
                    if let Some(symbol) = self.extract_variable(line_index, line, &regex) {
                        push_unique(&mut symbols, &mut seen, symbol);
                    }
                }
            }
        }

        symbols.sort_by_key(|s| (s.line, s.column));
        symbols
    }

    fn extract_type_like(
        &self,
        line_index: usize,
        line: &str,
        regex: &Regex,
    ) -> Option<UnifiedSymbolDefinition> {
        let captures = regex.captures(line)?;
        let kind_text = captures.get(1)?.as_str();
        let name_match = pick_name_capture(&captures, &[2, 3])?;
        let kind = *self.patterns.kind_map.get(kind_text).unwrap_or(&5);
        Some(UnifiedSymbolDefinition {
            name: name_match.as_str().to_string(),
            kind,
            signature: line.trim().to_string(),
            detail: kind_text.to_string(),
            line: line_index,
            column: byte_to_column(line, name_match.start()),
            end_column: byte_to_column(line, name_match.end()),
            container_name: None,
            exported: false,
            symbol_source: SymbolSource::Regex,
        })
    }

    fn extract_callable(
        &self,
        line_index: usize,
        line: &str,
        regex: &Regex,
    ) -> Option<UnifiedSymbolDefinition> {
        let captures = regex.captures(line)?;
        let name_match = captures.get(1)?;
        let name = name_match.as_str();
        if is_control_keyword(name) {
            return None;
        }
        let kind = if name.chars().next()?.is_uppercase() {
            9
        } else {
            12
        };
        Some(UnifiedSymbolDefinition {
            name: name.to_string(),
            kind,
            signature: line.trim().trim_end_matches('{').trim().to_string(),
            detail: "function".to_string(),
            line: line_index,
            column: byte_to_column(line, name_match.start()),
            end_column: byte_to_column(line, name_match.start() + name.len()),
            container_name: None,
            exported: false,
            symbol_source: SymbolSource::Regex,
        })
    }

    fn extract_variable(
        &self,
        line_index: usize,
        line: &str,
        regex: &Regex,
    ) -> Option<UnifiedSymbolDefinition> {
        let captures = regex.captures(line)?;
        let name_match = captures.get(1)?;
        let name = name_match.as_str();
        if is_control_keyword(name) {
            return None;
        }
        Some(UnifiedSymbolDefinition {
            name: name.to_string(),
            kind: 13,
            signature: line.trim().trim_end_matches(';').trim().to_string(),
            detail: "variable".to_string(),
            line: line_index,
            column: byte_to_column(line, name_match.start()),
            end_column: byte_to_column(line, name_match.start() + name.len()),
            container_name: None,
            exported: false,
            symbol_source: SymbolSource::Regex,
        })
    }
}

impl SymbolProvider for RegexSymbolProvider {
    fn language_id(&self) -> &str {
        self.language_id
    }

    fn provider_name(&self) -> &str {
        &self.provider_name
    }

    fn source(&self) -> SymbolSource {
        SymbolSource::Regex
    }

    fn capability(&self) -> ProviderCapability {
        let mut cap = ProviderCapability::SYMBOLS;
        if self.patterns.type_regex.is_some() || self.patterns.callable_regex.is_some() {
            cap |= ProviderCapability::DEFINITION | ProviderCapability::HOVER;
        }
        if self.patterns.import_regex.is_some() {
            cap |= ProviderCapability::EDGE_ENRICH;
        }
        cap
    }

    fn extract_symbols(
        &self,
        _path: &str,
        content: &str,
    ) -> Result<Vec<UnifiedSymbolDefinition>, String> {
        Ok(self.parse_symbols(content))
    }

    fn hover(
        &self,
        _path: &str,
        content: &str,
        line: usize,
        character: usize,
    ) -> Result<Option<HoverResult>, String> {
        let symbols = self.parse_symbols(content);
        let line_starts = line_start_offsets(content);
        let Some((identifier, start_col, end_col)) =
            identifier_at_position(content, &line_starts, line, character)
        else {
            return Ok(None);
        };
        let Some(symbol) = nearest_symbol(&symbols, &identifier, line) else {
            return Ok(None);
        };
        Ok(Some(HoverResult {
            contents: format!("{}\n{}", symbol.signature, symbol.detail),
            line,
            start_column: start_col,
            end_column: end_col,
        }))
    }

    fn definition(
        &self,
        _path: &str,
        content: &str,
        line: usize,
        character: usize,
    ) -> Result<Vec<SymbolLocation>, String> {
        let symbols = self.parse_symbols(content);
        let line_starts = line_start_offsets(content);
        let Some((identifier, _, _)) =
            identifier_at_position(content, &line_starts, line, character)
        else {
            return Ok(Vec::new());
        };
        let Some(symbol) = nearest_symbol(&symbols, &identifier, line) else {
            return Ok(Vec::new());
        };
        Ok(vec![SymbolLocation {
            uri: String::new(),
            line: symbol.line,
            character: symbol.column,
        }])
    }
}

// ── Regex utilities (shared with lsp_fallback) ─────────────────────────

/// 从同名符号中挑"最可能的目标"：优先声明行距引用位置最近者（同作用域/
/// 就近定义优先），平局取更靠前（更早声明）者。旧实现 `.find()` 只取解析
/// 顺序首个——重载/多作用域同名时会把引用定位到错误定义（#14）。
fn nearest_symbol<'a>(
    symbols: &'a [UnifiedSymbolDefinition],
    name: &str,
    near_line: usize,
) -> Option<&'a UnifiedSymbolDefinition> {
    symbols
        .iter()
        .filter(|s| s.name == name)
        .min_by_key(|s| (s.line.abs_diff(near_line), s.line))
}

fn compile_regex(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

fn pick_name_capture<'a>(
    captures: &'a regex::Captures<'a>,
    indices: &[usize],
) -> Option<regex::Match<'a>> {
    for index in indices {
        if let Some(m) = captures.get(*index) {
            if !m.as_str().is_empty() {
                return Some(m);
            }
        }
    }
    None
}

fn push_unique(
    symbols: &mut Vec<UnifiedSymbolDefinition>,
    seen: &mut HashSet<String>,
    symbol: UnifiedSymbolDefinition,
) {
    let key = format!("{}:{}:{}", symbol.name, symbol.line, symbol.column);
    if seen.insert(key) {
        symbols.push(symbol);
    }
}

fn line_start_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            offsets.push(index + 1);
        }
    }
    offsets
}

fn iter_lines<'a>(
    text: &'a str,
    offsets: &'a [usize],
) -> impl Iterator<Item = (usize, &'a str)> + 'a {
    offsets
        .iter()
        .enumerate()
        .map(move |(index, _)| (index, line_text(text, offsets, index).unwrap_or("")))
}

fn line_text<'a>(text: &'a str, offsets: &[usize], line: usize) -> Option<&'a str> {
    let start = *offsets.get(line)?;
    let end = if line + 1 < offsets.len() {
        offsets[line + 1].saturating_sub(1)
    } else {
        text.len()
    };
    text.get(start..end)
}

fn identifier_at_position(
    text: &str,
    offsets: &[usize],
    line: usize,
    column: usize,
) -> Option<(String, usize, usize)> {
    let line_text_val = line_text(text, offsets, line)?;
    let bytes = line_text_val.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let mut index = column.min(bytes.len().saturating_sub(1));
    if !is_identifier_byte(bytes[index]) {
        if index > 0 && is_identifier_byte(bytes[index - 1]) {
            index -= 1;
        } else {
            return None;
        }
    }
    let mut start = index;
    while start > 0 && is_identifier_byte(bytes[start - 1]) {
        start -= 1;
    }
    let mut end = index + 1;
    while end < bytes.len() && is_identifier_byte(bytes[end]) {
        end += 1;
    }
    Some((line_text_val.get(start..end)?.to_string(), start, end))
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn byte_to_column(line: &str, byte_index: usize) -> usize {
    line.get(..byte_index)
        .map(|prefix| prefix.chars().count())
        .unwrap_or(0)
}

fn is_control_keyword(value: &str) -> bool {
    matches!(
        value,
        "if" | "for"
            | "foreach"
            | "while"
            | "switch"
            | "catch"
            | "using"
            | "lock"
            | "return"
            | "sizeof"
            | "nameof"
            | "new"
            | "delete"
            | "else"
            | "case"
            | "default"
            | "break"
            | "continue"
            | "throw"
            | "try"
            | "finally"
            | "do"
            | "goto"
    )
}

// ── LSP-based provider ────────────────────────────────────────────────

struct LspSymbolProvider {
    language_id: String,
    provider_name: String,
    workspace_path: Mutex<Option<String>>,
}

impl LspSymbolProvider {
    fn new(language_id: &str) -> Self {
        LspSymbolProvider {
            language_id: language_id.to_string(),
            provider_name: format!("lsp-{language_id}"),
            workspace_path: Mutex::new(None),
        }
    }

    fn ensure_workspace(&self, path: &str) -> Result<(String, String), String> {
        let file_path = Path::new(path);

        if let Ok(ref ws) = self.workspace_path.lock() {
            if let Some(ws) = ws.as_ref() {
                let ws_path = Path::new(ws);
                if file_path.starts_with(ws_path) {
                    let relative = file_path
                        .strip_prefix(ws_path)
                        .map_err(|_| format!("无法计算相对路径: {path}"))?;
                    return Ok((ws.to_string(), relative.to_string_lossy().to_string()));
                }
            }
        }

        if file_path.is_absolute() {
            let mut current = file_path.parent();
            while let Some(dir) = current {
                if dir.join(".git").exists()
                    || dir.join("package.json").exists()
                    || dir.join("Cargo.toml").exists()
                {
                    let ws = dir.to_string_lossy().to_string();
                    let relative = file_path
                        .strip_prefix(dir)
                        .map_err(|_| format!("无法计算相对路径: {path}"))?
                        .to_string_lossy()
                        .to_string();
                    if let Ok(mut guard) = self.workspace_path.lock() {
                        *guard = Some(ws.clone());
                    }
                    return Ok((ws, relative));
                }
                current = dir.parent();
            }
        }

        Err(format!("无法确定 {path} 的工作区"))
    }
}

impl SymbolProvider for LspSymbolProvider {
    fn language_id(&self) -> &str {
        &self.language_id
    }

    fn provider_name(&self) -> &str {
        &self.provider_name
    }

    fn source(&self) -> SymbolSource {
        SymbolSource::Lsp
    }

    fn capability(&self) -> ProviderCapability {
        ProviderCapability::SYMBOLS
            | ProviderCapability::DEFINITION
            | ProviderCapability::HOVER
            | ProviderCapability::REFERENCES
            | ProviderCapability::DIAGNOSTICS
            | ProviderCapability::EDGE_ENRICH
    }

    fn extract_symbols(
        &self,
        path: &str,
        content: &str,
    ) -> Result<Vec<UnifiedSymbolDefinition>, String> {
        let (workspace_path, relative_path) = self.ensure_workspace(path)?;

        let uri = crate::lsp::file_uri_for(Path::new(&workspace_path), &relative_path)?;

        let _ = crate::lsp::lsp_open_document_with_app(
            None,
            workspace_path.clone(),
            self.language_id.clone(),
            relative_path.clone(),
            content.to_string(),
            1,
            Some(0),
        );

        let response = crate::lsp::lsp_request_impl(
            &workspace_path,
            &self.language_id,
            "textDocument/documentSymbol",
            &json!({ "textDocument": { "uri": uri } }),
        )?;

        let _ =
            crate::lsp::lsp_close_document_impl(&workspace_path, &self.language_id, &relative_path);

        let symbols = flatten_lsp_symbols(&response.message, SymbolSource::Lsp);
        Ok(symbols)
    }

    fn hover(
        &self,
        path: &str,
        content: &str,
        line: usize,
        character: usize,
    ) -> Result<Option<HoverResult>, String> {
        let (workspace_path, relative_path) = self.ensure_workspace(path)?;

        let uri = crate::lsp::file_uri_for(Path::new(&workspace_path), &relative_path)?;

        let _ = crate::lsp::lsp_open_document_with_app(
            None,
            workspace_path.clone(),
            self.language_id.clone(),
            relative_path.clone(),
            content.to_string(),
            1,
            Some(0),
        );

        let response = crate::lsp::lsp_request_impl(
            &workspace_path,
            &self.language_id,
            "textDocument/hover",
            &json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character },
            }),
        );

        let _ =
            crate::lsp::lsp_close_document_impl(&workspace_path, &self.language_id, &relative_path);

        let result = response?;
        let contents = result
            .message
            .get("result")
            .and_then(|r| r.get("contents"))
            .map(lsp_markdown_to_plain)
            .unwrap_or_default();

        if contents.is_empty() {
            return Ok(None);
        }

        Ok(Some(HoverResult {
            contents,
            line,
            start_column: character,
            end_column: character + 1,
        }))
    }

    fn definition(
        &self,
        path: &str,
        content: &str,
        line: usize,
        character: usize,
    ) -> Result<Vec<SymbolLocation>, String> {
        let (workspace_path, relative_path) = self.ensure_workspace(path)?;

        let uri = crate::lsp::file_uri_for(Path::new(&workspace_path), &relative_path)?;

        let _ = crate::lsp::lsp_open_document_with_app(
            None,
            workspace_path.clone(),
            self.language_id.clone(),
            relative_path.clone(),
            content.to_string(),
            1,
            Some(0),
        );

        let response = crate::lsp::lsp_request_impl(
            &workspace_path,
            &self.language_id,
            "textDocument/definition",
            &json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character },
            }),
        );

        let _ =
            crate::lsp::lsp_close_document_impl(&workspace_path, &self.language_id, &relative_path);

        let result = response?;
        let locations = parse_lsp_locations(&result.message);
        Ok(locations)
    }

    fn references(
        &self,
        path: &str,
        content: &str,
        line: usize,
        character: usize,
    ) -> Result<Vec<SymbolLocation>, String> {
        let (workspace_path, relative_path) = self.ensure_workspace(path)?;

        let uri = crate::lsp::file_uri_for(Path::new(&workspace_path), &relative_path)?;

        let _ = crate::lsp::lsp_open_document_with_app(
            None,
            workspace_path.clone(),
            self.language_id.clone(),
            relative_path.clone(),
            content.to_string(),
            1,
            Some(0),
        );

        let response = crate::lsp::lsp_request_impl(
            &workspace_path,
            &self.language_id,
            "textDocument/references",
            &json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character },
                "context": { "includeDeclaration": false },
            }),
        );

        let _ =
            crate::lsp::lsp_close_document_impl(&workspace_path, &self.language_id, &relative_path);

        let result = response?;
        let locations = parse_lsp_locations(&result.message);
        Ok(locations)
    }
}

fn flatten_lsp_symbols(
    value: &serde_json::Value,
    source: SymbolSource,
) -> Vec<UnifiedSymbolDefinition> {
    let mut symbols = Vec::new();
    flatten_lsp_symbols_rec(value, source, &mut symbols, None);
    symbols
}

fn flatten_lsp_symbols_rec(
    value: &serde_json::Value,
    source: SymbolSource,
    symbols: &mut Vec<UnifiedSymbolDefinition>,
    container_name: Option<String>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                flatten_lsp_symbols_rec(item, source, symbols, container_name.clone());
            }
        }
        serde_json::Value::Object(map) => {
            let name = map
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                return;
            }
            let kind = map.get("kind").and_then(|v| v.as_u64()).unwrap_or(0);
            let detail = map
                .get("detail")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let (line, column, end_column) = if let Some(range) = map.get("range") {
                (
                    range
                        .get("start")
                        .and_then(|s| s.get("line"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                    range
                        .get("start")
                        .and_then(|s| s.get("character"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                    range
                        .get("end")
                        .and_then(|e| e.get("character"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                )
            } else if let Some(sel_range) = map.get("selectionRange") {
                (
                    sel_range
                        .get("start")
                        .and_then(|s| s.get("line"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                    sel_range
                        .get("start")
                        .and_then(|s| s.get("character"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                    sel_range
                        .get("end")
                        .and_then(|e| e.get("character"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                )
            } else {
                (0, 0, 0)
            };

            let exported = map
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|tags| {
                    tags.iter()
                        .any(|t| t.as_u64().map(|v| v == 1).unwrap_or(false))
                })
                .unwrap_or(false);

            symbols.push(UnifiedSymbolDefinition {
                name,
                kind,
                signature: detail.clone(),
                detail,
                line,
                column,
                end_column,
                container_name,
                exported,
                symbol_source: source,
            });

            if let Some(children) = map.get("children").and_then(|v| v.as_array()) {
                let parent_name = map
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                for child in children {
                    flatten_lsp_symbols_rec(child, source, symbols, parent_name.clone());
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn lsp_markdown_to_plain(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(map) => {
            if let Some(kind) = map.get("kind").and_then(|v| v.as_str()) {
                if kind == "markdown" {
                    return map
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
            map.get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
        _ => String::new(),
    }
}

fn parse_lsp_location_item(item: &serde_json::Value) -> Option<SymbolLocation> {
    // Location: { uri, range }
    // LocationLink: { targetUri, targetRange, targetSelectionRange }
    // 初始化声明了 definition.linkSupport=true，tsserver / rust-analyzer
    // 会返回 LocationLink；只认 uri/range 会把合法定义结果丢掉。
    let uri = item
        .get("targetUri")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("uri").and_then(|v| v.as_str()))?
        .to_string();
    let range = item
        .get("targetSelectionRange")
        .or_else(|| item.get("targetRange"))
        .or_else(|| item.get("range"))?;
    let line = range.get("start")?.get("line")?.as_u64()? as usize;
    let character = range.get("start")?.get("character")?.as_u64()? as usize;
    Some(SymbolLocation {
        uri,
        line,
        character,
    })
}

pub(crate) fn parse_lsp_locations(value: &serde_json::Value) -> Vec<SymbolLocation> {
    let result = match value.get("result") {
        Some(r) => r,
        None => return Vec::new(),
    };

    let items = match result {
        serde_json::Value::Array(arr) => arr.clone(),
        serde_json::Value::Object(_) => vec![result.clone()],
        _ => return Vec::new(),
    };

    items.iter().filter_map(parse_lsp_location_item).collect()
}

// ── AST-based provider (tree-sitter) ──────────────────────────────────

use tree_sitter::{Language, Node, Parser};

/// 统计语法错误节点数（ERROR / MISSING），并收集前 `limit` 个错误位置（迭代遍历，避免大文件栈溢出）。
fn collect_syntax_errors(node: Node<'_>, errors: &mut Vec<SyntaxErrorInfo>, limit: usize) -> usize {
    let mut count = 0;
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if n.is_error() || n.is_missing() {
            count += 1;
            if errors.len() < limit {
                let pos = n.start_position();
                errors.push(SyntaxErrorInfo {
                    line: pos.row + 1,
                    column: pos.column + 1,
                    kind: if n.is_missing() { "missing" } else { "error" }.to_string(),
                });
            }
        }
        for i in 0..n.child_count() {
            if let Some(child) = n.child(i) {
                stack.push(child);
            }
        }
    }
    count
}

#[allow(dead_code)]
struct AstLanguageConfig {
    language_id: &'static str,
    language_fn: fn() -> Language,
    type_kinds: &'static [&'static str],
    callable_kinds: &'static [&'static str],
    variable_kinds: &'static [&'static str],
    import_kinds: &'static [&'static str],
    kind_map: &'static [(&'static str, u64)],
    name_field: &'static str,
    /// 在匹配节点上追加尝试的 field 名（name_field 未命中时按序尝试）。
    fallback_name_fields: &'static [&'static str],
    /// 仍找不到名字时，按序取第一个该 kind 的命名子节点：先在其上尝试
    /// name_field 与 fallback fields，仍未命中则直接使用该子节点文本。
    name_child_kinds: &'static [&'static str],
}

impl AstLanguageConfig {
    fn all_name_fields(&self) -> impl Iterator<Item = &'static str> + '_ {
        std::iter::once(self.name_field)
            .chain(self.fallback_name_fields.iter().copied())
    }

    /// 按 config 规则解析符号名节点：节点自身 field → fallback fields →
    /// 指定 kind 的子节点（先 field 后文本）。
    fn resolve_name_node<'tree>(&self, node: Node<'tree>) -> Option<Node<'tree>> {
        for field in self.all_name_fields() {
            if let Some(name_node) = node.child_by_field_name(field) {
                return Some(name_node);
            }
        }
        for kind in self.name_child_kinds {
            let Some(child) = (0..node.child_count())
                .filter_map(|i| node.child(i))
                .find(|c| c.is_named() && c.kind() == *kind)
            else {
                continue;
            };
            for field in self.all_name_fields() {
                if let Some(name_node) = child.child_by_field_name(field) {
                    return Some(name_node);
                }
            }
            return Some(child);
        }
        None
    }
}

struct AstSymbolProvider {
    config: AstLanguageConfig,
    provider_name: String,
}

impl AstSymbolProvider {
    fn new(config: AstLanguageConfig) -> Self {
        let provider_name = format!("ast-{}", config.language_id);
        AstSymbolProvider {
            config,
            provider_name,
        }
    }

    fn parse_and_extract(&self, content: &str) -> Vec<UnifiedSymbolDefinition> {
        let mut parser = Parser::new();
        let language = (self.config.language_fn)();
        if parser.set_language(&language).is_err() {
            return Vec::new();
        }
        let tree = match parser.parse(content, None) {
            Some(t) => t,
            None => return Vec::new(),
        };
        let mut symbols = Vec::new();
        let bytes = content.as_bytes();
        self.walk_node(tree.root_node(), bytes, &mut symbols);
        symbols.sort_by_key(|s| (s.line, s.column));
        symbols
    }

    fn walk_node(&self, node: Node<'_>, source: &[u8], symbols: &mut Vec<UnifiedSymbolDefinition>) {
        let kind = node.kind();

        if let Some(sym_kind) = self.match_kind(kind) {
            if let Some(name_node) = self.config.resolve_name_node(node) {
                let name = name_node.utf8_text(source).unwrap_or("");
                if !name.is_empty() && !is_control_keyword(name) {
                    let start = node.start_position();
                    let end = node.end_position();
                    let sig = node.utf8_text(source).unwrap_or("").to_string();
                    let signature = sig
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim_end_matches('{')
                        .trim()
                        .to_string();

                    symbols.push(UnifiedSymbolDefinition {
                        name: name.to_string(),
                        kind: sym_kind,
                        signature,
                        detail: kind.to_string(),
                        line: start.row,
                        column: start.column,
                        end_column: end.column,
                        container_name: None,
                        exported: false,
                        symbol_source: SymbolSource::Ast,
                    });
                }
            }
        }

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.is_named() {
                    self.walk_node(child, source, symbols);
                }
            }
        }
    }

    fn match_kind(&self, kind: &str) -> Option<u64> {
        for (k, v) in self.config.kind_map {
            if *k == kind {
                return Some(*v);
            }
        }
        None
    }

    fn extract_file_symbols_inner(&self, content: &str) -> Vec<FileSymbolInfo> {
        let mut parser = Parser::new();
        let language = (self.config.language_fn)();
        if parser.set_language(&language).is_err() {
            return Vec::new();
        }
        let tree = match parser.parse(content, None) {
            Some(t) => t,
            None => return Vec::new(),
        };
        let mut symbols = Vec::new();
        let bytes = content.as_bytes();
        self.walk_file_symbols(tree.root_node(), bytes, None, &mut symbols);
        symbols.sort_by_key(|s| s.line);
        symbols
    }

    fn walk_file_symbols(
        &self,
        node: Node<'_>,
        source: &[u8],
        container: Option<String>,
        symbols: &mut Vec<FileSymbolInfo>,
    ) {
        let kind = node.kind();
        let mut child_container = container.clone();
        if self.match_kind(kind).is_some() {
            if let Some(name_node) = self.config.resolve_name_node(node) {
                let name = name_node.utf8_text(source).unwrap_or("");
                if !name.is_empty() && !is_control_keyword(name) {
                    let start = node.start_position();
                    let end = node.end_position();
                    let sig = node.utf8_text(source).unwrap_or("").to_string();
                    let signature = sig
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim_end_matches('{')
                        .trim()
                        .to_string();
                    symbols.push(FileSymbolInfo {
                        name: name.to_string(),
                        kind: kind.to_string(),
                        line: start.row + 1,
                        end_line: end.row + 1,
                        signature,
                        container_name: container.clone(),
                    });
                    child_container = Some(name.to_string());
                }
            }
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.is_named() {
                    self.walk_file_symbols(child, source, child_container.clone(), symbols);
                }
            }
        }
    }
}

impl SymbolProvider for AstSymbolProvider {
    fn language_id(&self) -> &str {
        self.config.language_id
    }

    fn provider_name(&self) -> &str {
        &self.provider_name
    }

    fn source(&self) -> SymbolSource {
        SymbolSource::Ast
    }

    fn capability(&self) -> ProviderCapability {
        let mut cap = ProviderCapability::SYMBOLS
            | ProviderCapability::DEFINITION
            | ProviderCapability::HOVER;
        if !self.config.import_kinds.is_empty() {
            cap |= ProviderCapability::EDGE_ENRICH;
        }
        cap
    }

    fn extract_symbols(
        &self,
        _path: &str,
        content: &str,
    ) -> Result<Vec<UnifiedSymbolDefinition>, String> {
        Ok(self.parse_and_extract(content))
    }

    fn check_syntax(&self, content: &str) -> Option<SyntaxCheckResult> {
        let mut parser = Parser::new();
        let language = (self.config.language_fn)();
        if parser.set_language(&language).is_err() {
            return Some(SyntaxCheckResult {
                supported: false,
                error_count: 0,
                errors: vec![],
            });
        }
        let tree = parser.parse(content, None)?;
        let mut errors = Vec::new();
        let error_count = collect_syntax_errors(tree.root_node(), &mut errors, 10);
        Some(SyntaxCheckResult {
            supported: true,
            error_count,
            errors,
        })
    }

    fn file_symbols(&self, content: &str) -> Vec<FileSymbolInfo> {
        self.extract_file_symbols_inner(content)
    }

    fn hover(
        &self,
        _path: &str,
        content: &str,
        line: usize,
        character: usize,
    ) -> Result<Option<HoverResult>, String> {
        let symbols = self.parse_and_extract(content);
        let offsets: Vec<usize> = content
            .bytes()
            .enumerate()
            .filter(|(_, b)| *b == b'\n')
            .map(|(i, _)| i + 1)
            .collect();
        let line_starts: Vec<usize> = {
            let mut v = vec![0];
            v.extend(offsets);
            v
        };
        let Some((identifier, start_col, end_col)) =
            identifier_at_position(content, &line_starts, line, character)
        else {
            return Ok(None);
        };
        let Some(symbol) = nearest_symbol(&symbols, &identifier, line) else {
            return Ok(None);
        };
        Ok(Some(HoverResult {
            contents: symbol.signature.clone(),
            line,
            start_column: start_col,
            end_column: end_col,
        }))
    }

    fn definition(
        &self,
        _path: &str,
        content: &str,
        line: usize,
        character: usize,
    ) -> Result<Vec<SymbolLocation>, String> {
        let symbols = self.parse_and_extract(content);
        let offsets: Vec<usize> = content
            .bytes()
            .enumerate()
            .filter(|(_, b)| *b == b'\n')
            .map(|(i, _)| i + 1)
            .collect();
        let line_starts: Vec<usize> = {
            let mut v = vec![0];
            v.extend(offsets);
            v
        };
        let Some((identifier, _, _)) =
            identifier_at_position(content, &line_starts, line, character)
        else {
            return Ok(Vec::new());
        };
        let Some(symbol) = nearest_symbol(&symbols, &identifier, line) else {
            return Ok(Vec::new());
        };
        Ok(vec![SymbolLocation {
            uri: String::new(),
            line: symbol.line,
            character: symbol.column,
        }])
    }
}

// ── Unified symbol resolver (LSP → AST → Regex fallback) ────────────

#[tauri::command]
pub fn resolve_symbols(
    language_id: String,
    path: String,
    content: String,
) -> Result<Vec<UnifiedSymbolDefinition>, String> {
    let reg = registry()
        .read()
        .map_err(|_| "ProviderRegistry 锁中毒".to_string())?;
    let providers = reg.providers_for_language(&language_id);
    if providers.is_empty() {
        return Err(format!("{language_id} 无可用 SymbolProvider"));
    }

    let mut last_error = String::new();
    for provider in &providers {
        match provider.extract_symbols(&path, &content) {
            Ok(symbols) if !symbols.is_empty() => return Ok(symbols),
            Ok(_) => {
                last_error = format!("{} 返回空符号列表", provider.provider_name());
            }
            Err(err) => {
                last_error = err;
            }
        }
    }

    Err(format!(
        "{language_id} 所有 Provider 均无法提取符号: {last_error}"
    ))
}

#[tauri::command]
pub fn resolve_symbol_hover(
    language_id: String,
    path: String,
    content: String,
    line: usize,
    character: usize,
) -> Result<Option<HoverResult>, String> {
    let reg = registry()
        .read()
        .map_err(|_| "ProviderRegistry 锁中毒".to_string())?;
    let providers = reg.providers_for_language(&language_id);
    for provider in &providers {
        if let Ok(Some(result)) = provider.hover(&path, &content, line, character) {
            return Ok(Some(result));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn resolve_symbol_definition(
    language_id: String,
    path: String,
    content: String,
    line: usize,
    character: usize,
) -> Result<Vec<SymbolLocation>, String> {
    let reg = registry()
        .read()
        .map_err(|_| "ProviderRegistry 锁中毒".to_string())?;
    let providers = reg.providers_for_language(&language_id);
    for provider in &providers {
        match provider.definition(&path, &content, line, character) {
            Ok(locs) if !locs.is_empty() => return Ok(locs),
            Ok(_) => continue,
            Err(_) => continue,
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
pub fn resolve_symbol_references(
    language_id: String,
    path: String,
    content: String,
    line: usize,
    character: usize,
) -> Result<Vec<SymbolLocation>, String> {
    let reg = registry()
        .read()
        .map_err(|_| "ProviderRegistry 锁中毒".to_string())?;
    let providers = reg.providers_for_language(&language_id);
    for provider in &providers {
        match provider.references(&path, &content, line, character) {
            Ok(locs) if !locs.is_empty() => return Ok(locs),
            Ok(_) => continue,
            Err(_) => continue,
        }
    }
    Ok(Vec::new())
}

// ── Default provider registration ──────────────────────────────────────

pub fn register_default_providers() {
    register_lsp_providers();
    register_ast_providers();
    register_regex_providers();
}

fn register_lsp_providers() {
    let lsp_languages = [
        "typescript",
        "html",
        "css",
        "json",
        "yaml",
        "python",
        "csharp",
        "java",
        "cpp",
        "shellscript",
        "rust",
        "go",
        "swift",
        "sql",
        "markdown",
    ];

    for lang in &lsp_languages {
        let _ = register_provider(Arc::new(LspSymbolProvider::new(lang)));
    }
}

fn register_ast_providers() {
    register_ast_with_config(AstLanguageConfig {
        language_id: "typescript",
        language_fn: || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        type_kinds: &[
            "class_declaration",
            "interface_declaration",
            "enum_declaration",
            "type_alias_declaration",
        ],
        callable_kinds: &["function_declaration", "method_definition"],
        variable_kinds: &["variable_declarator", "lexical_declaration"],
        import_kinds: &["import_statement"],
        kind_map: &[
            ("class_declaration", 5),
            ("interface_declaration", 11),
            ("enum_declaration", 10),
            ("type_alias_declaration", 5),
            ("function_declaration", 12),
            ("method_definition", 6),
            ("variable_declarator", 13),
            ("lexical_declaration", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "typescriptreact",
        language_fn: || tree_sitter_typescript::LANGUAGE_TSX.into(),
        type_kinds: &[
            "class_declaration",
            "interface_declaration",
            "enum_declaration",
            "type_alias_declaration",
        ],
        callable_kinds: &["function_declaration", "method_definition"],
        variable_kinds: &["variable_declarator", "lexical_declaration"],
        import_kinds: &["import_statement"],
        kind_map: &[
            ("class_declaration", 5),
            ("interface_declaration", 11),
            ("enum_declaration", 10),
            ("type_alias_declaration", 5),
            ("function_declaration", 12),
            ("method_definition", 6),
            ("variable_declarator", 13),
            ("lexical_declaration", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "javascript",
        language_fn: || tree_sitter_javascript::LANGUAGE.into(),
        type_kinds: &["class_declaration"],
        callable_kinds: &[
            "function_declaration",
            "method_definition",
            "arrow_function",
        ],
        variable_kinds: &["variable_declarator", "lexical_declaration"],
        import_kinds: &["import_statement"],
        kind_map: &[
            ("class_declaration", 5),
            ("function_declaration", 12),
            ("method_definition", 6),
            ("arrow_function", 12),
            ("variable_declarator", 13),
            ("lexical_declaration", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "python",
        language_fn: || tree_sitter_python::LANGUAGE.into(),
        type_kinds: &["class_definition"],
        callable_kinds: &["function_definition"],
        variable_kinds: &["assignment"],
        import_kinds: &["import_statement", "import_from_statement"],
        kind_map: &[
            ("class_definition", 5),
            ("function_definition", 12),
            ("assignment", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "rust",
        language_fn: || tree_sitter_rust::LANGUAGE.into(),
        type_kinds: &["struct_item", "enum_item", "trait_item", "impl_item"],
        callable_kinds: &["function_item"],
        variable_kinds: &["let_declaration", "const_item", "static_item"],
        import_kinds: &["use_declaration"],
        kind_map: &[
            ("struct_item", 23),
            ("enum_item", 10),
            ("trait_item", 11),
            ("impl_item", 5),
            ("function_item", 12),
            ("let_declaration", 13),
            ("const_item", 14),
            ("static_item", 14),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "java",
        language_fn: || tree_sitter_java::LANGUAGE.into(),
        type_kinds: &[
            "class_declaration",
            "interface_declaration",
            "enum_declaration",
        ],
        callable_kinds: &["method_declaration", "constructor_declaration"],
        variable_kinds: &["field_declaration"],
        import_kinds: &["import_declaration"],
        kind_map: &[
            ("class_declaration", 5),
            ("interface_declaration", 11),
            ("enum_declaration", 10),
            ("method_declaration", 6),
            ("constructor_declaration", 9),
            ("field_declaration", 8),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "go",
        language_fn: || tree_sitter_go::LANGUAGE.into(),
        type_kinds: &["type_declaration"],
        callable_kinds: &["function_declaration", "method_declaration"],
        variable_kinds: &[
            "var_declaration",
            "const_declaration",
            "short_var_declaration",
        ],
        import_kinds: &["import_declaration"],
        kind_map: &[
            ("type_declaration", 5),
            ("function_declaration", 12),
            ("method_declaration", 6),
            ("var_declaration", 13),
            ("const_declaration", 14),
            ("short_var_declaration", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "cpp",
        language_fn: || tree_sitter_cpp::LANGUAGE.into(),
        type_kinds: &["class_specifier", "struct_specifier", "enum_specifier"],
        callable_kinds: &["function_definition"],
        variable_kinds: &["declaration"],
        import_kinds: &["preproc_include"],
        kind_map: &[
            ("class_specifier", 5),
            ("struct_specifier", 23),
            ("enum_specifier", 10),
            ("function_definition", 12),
            ("declaration", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "shellscript",
        language_fn: || tree_sitter_bash::LANGUAGE.into(),
        type_kinds: &[],
        callable_kinds: &["function_definition"],
        variable_kinds: &["variable_assignment"],
        import_kinds: &[],
        kind_map: &[("function_definition", 12), ("variable_assignment", 13)],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "php",
        language_fn: || tree_sitter_php::LANGUAGE_PHP_ONLY.into(),
        type_kinds: &[
            "class_declaration",
            "interface_declaration",
            "trait_declaration",
            "enum_declaration",
        ],
        callable_kinds: &["function_definition", "method_declaration"],
        variable_kinds: &["property_declaration"],
        import_kinds: &["use_declaration", "namespace_use_clause"],
        kind_map: &[
            ("class_declaration", 5),
            ("interface_declaration", 11),
            ("trait_declaration", 5),
            ("enum_declaration", 10),
            ("function_definition", 12),
            ("method_declaration", 6),
            ("property_declaration", 8),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "csharp",
        language_fn: || tree_sitter_c_sharp::LANGUAGE.into(),
        type_kinds: &[
            "class_declaration",
            "interface_declaration",
            "struct_declaration",
            "enum_declaration",
        ],
        callable_kinds: &[
            "method_declaration",
            "constructor_declaration",
            "local_function_statement",
        ],
        variable_kinds: &["field_declaration", "variable_declaration"],
        import_kinds: &["using_directive"],
        kind_map: &[
            ("class_declaration", 5),
            ("interface_declaration", 11),
            ("struct_declaration", 23),
            ("enum_declaration", 10),
            ("method_declaration", 6),
            ("constructor_declaration", 9),
            ("local_function_statement", 12),
            ("field_declaration", 8),
            ("variable_declaration", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "css",
        language_fn: || tree_sitter_css::LANGUAGE.into(),
        type_kinds: &[],
        callable_kinds: &[],
        variable_kinds: &[],
        import_kinds: &["import_statement"],
        kind_map: &[],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "html",
        language_fn: || tree_sitter_html::LANGUAGE.into(),
        type_kinds: &["element", "script_element", "style_element"],
        callable_kinds: &[],
        variable_kinds: &[],
        import_kinds: &[],
        kind_map: &[("element", 5), ("script_element", 5), ("style_element", 5)],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "json",
        language_fn: || tree_sitter_json::LANGUAGE.into(),
        type_kinds: &["object", "pair"],
        callable_kinds: &[],
        variable_kinds: &[],
        import_kinds: &[],
        kind_map: &[("object", 19), ("pair", 7)],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "ruby",
        language_fn: || tree_sitter_ruby::LANGUAGE.into(),
        type_kinds: &["class", "module"],
        callable_kinds: &["method", "singleton_method"],
        variable_kinds: &["assignment"],
        import_kinds: &["call"],
        kind_map: &[
            ("class", 5),
            ("module", 2),
            ("method", 6),
            ("singleton_method", 6),
            ("assignment", 13),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "kotlin",
        language_fn: || tree_sitter_kotlin::LANGUAGE.into(),
        type_kinds: &[
            "class_declaration",
            "object_declaration",
            "interface_declaration",
        ],
        callable_kinds: &["function_declaration"],
        variable_kinds: &["property_declaration"],
        import_kinds: &["import_header"],
        kind_map: &[
            ("class_declaration", 5),
            ("object_declaration", 5),
            ("interface_declaration", 11),
            ("function_declaration", 12),
            ("property_declaration", 7),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    register_ast_with_config(AstLanguageConfig {
        language_id: "swift",
        language_fn: || tree_sitter_swift::LANGUAGE.into(),
        type_kinds: &[
            "class_declaration",
            "struct_declaration",
            "enum_declaration",
            "protocol_declaration",
        ],
        callable_kinds: &["function_declaration", "init_declaration"],
        variable_kinds: &["property_declaration"],
        import_kinds: &["import_declaration"],
        kind_map: &[
            ("class_declaration", 5),
            ("struct_declaration", 23),
            ("enum_declaration", 10),
            ("protocol_declaration", 11),
            ("function_declaration", 12),
            ("init_declaration", 9),
            ("property_declaration", 7),
        ],
        name_field: "name",
        fallback_name_fields: &[],
        name_child_kinds: &[],
    });

    // SQL（tree-sitter-sequel / DerekStride/tree-sitter-sql）：
    // - table/view/function/trigger 等对象名在 object_reference 子节点的 name field 中
    // - create_index 的对象名是语句自身的 field("column")
    // - create_database/create_schema 的对象名是裸 identifier 子节点
    // kind 数值与 regex-sql provider 保持一致（TABLE/VIEW/INDEX=5，FUNCTION/PROCEDURE/TRIGGER=12）。
    register_ast_with_config(AstLanguageConfig {
        language_id: "sql",
        language_fn: || tree_sitter_sql::LANGUAGE.into(),
        type_kinds: &[
            "create_table",
            "create_view",
            "create_materialized_view",
            "create_index",
        ],
        callable_kinds: &["create_function", "create_trigger"],
        variable_kinds: &[],
        import_kinds: &[],
        kind_map: &[
            ("create_table", 5),
            ("create_view", 5),
            ("create_materialized_view", 5),
            ("create_index", 5),
            ("create_function", 12),
            ("create_trigger", 12),
        ],
        name_field: "name",
        fallback_name_fields: &["column"],
        name_child_kinds: &["object_reference", "identifier"],
    });
}

fn register_ast_with_config(config: AstLanguageConfig) {
    let _ = register_provider(Arc::new(AstSymbolProvider::new(config)));
}

fn register_regex_providers() {
    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "csharp",
        type_regex: Some(
            r"^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|new)\s+)*(class|interface|struct|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)",
        ),
        callable_regex: Some(
            r"^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|sealed|abstract|virtual|override|async|extern|unsafe|partial|new)\s+)*(?:<[A-Za-z0-9_,\s]+>\s*)?(?:[A-Za-z_][A-Za-z0-9_<>,\[\]?.\s]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(",
        ),
        variable_regex: None,
        import_regex: Some(r"using\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*;"),
        kind_map: HashMap::from([
            ("class", 5),
            ("interface", 11),
            ("struct", 23),
            ("enum", 10),
            ("record", 5),
        ]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "java",
        type_regex: Some(
            r"^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed)\s+)*(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)",
        ),
        callable_regex: Some(
            r"^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[A-Za-z0-9_,\s]+>\s*)?(?:[A-Za-z_][A-Za-z0-9_<>,\[\]?.\s]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(",
        ),
        variable_regex: None,
        import_regex: Some(r"import\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*;"),
        kind_map: HashMap::from([("class", 5), ("interface", 11), ("enum", 10), ("record", 5)]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "cpp",
        type_regex: Some(
            r"^\s*(?:template\s*<[^>]+>\s*)?(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)",
        ),
        callable_regex: Some(
            r"^\s*(?:template\s*<[^>]+>\s*)?(?:(?:inline|static|constexpr|virtual|explicit|friend|extern|auto|consteval|constinit)\s+)*(?:[A-Za-z_~][A-Za-z0-9_:<>*&\s,]*\s+)?([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|;)",
        ),
        variable_regex: None,
        import_regex: Some(r#"#include\s+[<"]([^>"]+)[>"]"#),
        kind_map: HashMap::from([("class", 5), ("struct", 23), ("enum", 10)]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "swift",
        type_regex: Some(
            r"^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+)*(class|struct|enum|protocol|extension|actor)\s+(\w+)",
        ),
        callable_regex: Some(
            r"^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|override\s+|mutating\s+|static\s+|class\s+)*func\s+(\w+)\s*\(",
        ),
        variable_regex: Some(
            r"^\s*(?:public\s+|private\s+|internal\s+|static\s+|lazy\s+)*(?:let|var)\s+(\w+)\s*[:=]",
        ),
        import_regex: Some(r"import\s+(\w+)"),
        kind_map: HashMap::from([
            ("class", 5),
            ("struct", 23),
            ("enum", 10),
            ("protocol", 11),
            ("extension", 5),
            ("actor", 5),
        ]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "sql",
        type_regex: Some(
            r"(?i)CREATE\s+(TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\[?(\w+)\]?|`?(\w+)`?)",
        ),
        callable_regex: None,
        variable_regex: None,
        import_regex: None,
        kind_map: HashMap::from([
            ("TABLE", 5),
            ("VIEW", 5),
            ("INDEX", 5),
            ("FUNCTION", 12),
            ("PROCEDURE", 12),
            ("TRIGGER", 12),
        ]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "markdown",
        type_regex: Some(r"^(#{1,6})\s+(.+)"),
        callable_regex: None,
        variable_regex: None,
        import_regex: Some(r"\[([^\]]+)\]\(([^)]+)\)"),
        kind_map: HashMap::from([
            ("#", 1),
            ("##", 1),
            ("###", 1),
            ("####", 1),
            ("#####", 1),
            ("######", 1),
        ]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "ruby",
        type_regex: Some(r"^\s*(class|module)\s+(\w+)"),
        callable_regex: Some(r"^\s*def\s+(self\.)?(\w+)"),
        variable_regex: None,
        import_regex: Some(r"require\s+\S+"),
        kind_map: HashMap::from([("class", 5), ("module", 2)]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "php",
        type_regex: Some(r"^\s*(abstract\s+|final\s+)*(class|interface|trait|enum)\s+(\w+)"),
        callable_regex: Some(
            r"^\s*(public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*function\s+(\w+)\s*\(",
        ),
        variable_regex: None,
        import_regex: Some(r"use\s+(\S+)\s*;"),
        kind_map: HashMap::from([("class", 5), ("interface", 11), ("trait", 5), ("enum", 10)]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "kotlin",
        type_regex: Some(
            r"^\s*(public\s+|private\s+|internal\s+|protected\s+|open\s+|abstract\s+|data\s+|sealed\s+|inner\s+)*(class|object|interface|enum)\s+(\w+)",
        ),
        callable_regex: Some(
            r"^\s*(public\s+|private\s+|internal\s+|protected\s+|override\s+|open\s+|suspend\s+|tailrec\s+|inline\s+)*fun\s+(\w+)\s*\(",
        ),
        variable_regex: Some(r"^\s*(val|var)\s+(\w+)\s*[:=]"),
        import_regex: Some(r"import\s+(\S+)"),
        kind_map: HashMap::from([("class", 5), ("object", 5), ("interface", 11), ("enum", 10)]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "dart",
        type_regex: Some(
            r"^\s*(abstract\s+|sealed\s+|base\s+|final\s+|mixin\s+)*(class|enum|mixin|extension)\s+(\w+)",
        ),
        callable_regex: Some(r"^\s*(static\s+|async\s+)?\w+\s+(\w+)\s*\("),
        variable_regex: Some(
            r"^\s*(final\s+|const\s+|late\s+|static\s+)*(var|int|String|bool|double|num|dynamic)\s+(\w+)\s*[;=]",
        ),
        import_regex: Some(r"import\s+\S+"),
        kind_map: HashMap::from([("class", 5), ("enum", 10), ("mixin", 5), ("extension", 5)]),
    })));

    let _ = register_provider(Arc::new(RegexSymbolProvider::new(LanguagePatterns {
        language_id: "typescript",
        type_regex: Some(r"^\s*(export\s+)?(abstract\s+)?(class|interface|enum|type)\s+(\w+)"),
        callable_regex: Some(r"^\s*(export\s+)?(async\s+)?function\s+(\w+)\s*\("),
        variable_regex: Some(r"^\s*(export\s+)?(const|let|var)\s+(\w+)\s*[:=]"),
        import_regex: Some(r"import\s+.+\s+from\s+\S+"),
        kind_map: HashMap::from([("class", 5), ("interface", 11), ("enum", 10), ("type", 5)]),
    })));
}

#[cfg(test)]
mod symbol_resolution_tests {
    use super::*;

    fn symbol(name: &str, line: usize) -> UnifiedSymbolDefinition {
        UnifiedSymbolDefinition {
            name: name.to_string(),
            kind: 1,
            signature: format!("fn {name}()"),
            detail: String::new(),
            line,
            column: 1,
            end_column: 4,
            container_name: None,
            exported: false,
            symbol_source: SymbolSource::Regex,
        }
    }

    // 回归 #14：同名符号（重载/多作用域）必须就近解析，而不是取解析顺序首个。
    #[test]
    fn nearest_symbol_prefers_declaration_closest_to_reference_line() {
        let symbols = vec![symbol("foo", 10), symbol("foo", 40), symbol("bar", 30)];

        let near_first = nearest_symbol(&symbols, "foo", 12).expect("foo should resolve");
        assert_eq!(near_first.line, 10, "引用靠近第一个声明时应解析到它");

        let near_second = nearest_symbol(&symbols, "foo", 38).expect("foo should resolve");
        assert_eq!(near_second.line, 40, "引用靠近第二个声明时应解析到它（旧实现取 10）");

        let tie = nearest_symbol(&symbols, "foo", 25).expect("foo should resolve");
        assert_eq!(tie.line, 10, "距离平局时取更靠前（更早声明）者");

        assert!(nearest_symbol(&symbols, "missing", 20).is_none());
    }

    // 回归 #14 集成：regex provider 的 definition 对同一文件内两个同名函数，
    // 按引用位置就近返回目标声明（行号 0 基，LSP 语义）。
    #[test]
    fn regex_provider_definition_resolves_nearest_same_named_symbol() {
        let provider = RegexSymbolProvider::new(LanguagePatterns {
            language_id: "python",
            type_regex: None,
            callable_regex: Some(r"^\s*def\s+(\w+)\s*\("),
            variable_regex: None,
            import_regex: None,
            kind_map: HashMap::new(),
        });
        let content = "def foo(): # first\n    pass\n\n\ndef foo(): # second\n    return 2\n";

        // 引用第二个 foo（第 4 行，0 基）→ 应定位到第 4 行声明
        let defs = provider
            .definition("test.py", content, 4, 5)
            .expect("definition should succeed");
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].line, 4, "应定位到第 4 行的 foo（旧实现返回第 0 行）");

        // 引用第一个 foo（第 0 行）→ 定位到第 0 行
        let defs = provider
            .definition("test.py", content, 0, 5)
            .expect("definition should succeed");
        assert_eq!(defs[0].line, 0);

        // hover 同样就近
        let hover = provider
            .hover("test.py", content, 4, 5)
            .expect("hover should succeed")
            .expect("hover should find symbol");
        assert!(
            hover.contents.contains("second"),
            "hover 应命中就近声明: {}",
            hover.contents
        );
    }
}

#[cfg(test)]
mod lsp_location_parse_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_lsp_locations_reads_plain_location() {
        let message = json!({
            "result": [{
                "uri": "file:///tmp/proj/src/a.ts",
                "range": {
                    "start": { "line": 3, "character": 8 },
                    "end": { "line": 3, "character": 11 }
                }
            }]
        });
        let locations = parse_lsp_locations(&message);
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].uri, "file:///tmp/proj/src/a.ts");
        assert_eq!(locations[0].line, 3);
        assert_eq!(locations[0].character, 8);
    }

    #[test]
    fn parse_lsp_locations_reads_location_link() {
        let message = json!({
            "result": [{
                "originSelectionRange": {
                    "start": { "line": 10, "character": 2 },
                    "end": { "line": 10, "character": 5 }
                },
                "targetUri": "file:///tmp/proj/src/def.ts",
                "targetRange": {
                    "start": { "line": 0, "character": 0 },
                    "end": { "line": 20, "character": 1 }
                },
                "targetSelectionRange": {
                    "start": { "line": 4, "character": 16 },
                    "end": { "line": 4, "character": 19 }
                }
            }]
        });
        let locations = parse_lsp_locations(&message);
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].uri, "file:///tmp/proj/src/def.ts");
        assert_eq!(locations[0].line, 4);
        assert_eq!(locations[0].character, 16);
    }
}

#[cfg(test)]
mod syntax_check_tests {
    use super::*;

    #[test]
    fn check_syntax_valid_typescript_has_no_errors() {
        register_ast_providers();
        let result =
            check_syntax_for_language("typescript", "const x = 1;\nfunction foo() { return x; }\n");
        assert!(result.supported);
        assert_eq!(result.error_count, 0);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn check_syntax_broken_typescript_reports_errors() {
        register_ast_providers();
        let result = check_syntax_for_language("typescript", "const x = ;\nfunction foo( { return x;\n");
        assert!(result.supported);
        assert!(result.error_count > 0);
    }

    #[test]
    fn check_syntax_unsupported_language_is_not_supported() {
        register_ast_providers();
        let result = check_syntax_for_language("nonexistent_language_xyz", "some code");
        assert!(!result.supported);
        assert_eq!(result.error_count, 0);
    }

    #[test]
    fn extract_file_symbols_typescript_returns_symbols_with_ranges() {
        register_ast_providers();
        let content = "const x = 1;\nfunction getUser() {\n  return x;\n}\n";
        let symbols = extract_file_symbols_for_language("typescript", content);
        assert!(!symbols.is_empty());
        let get_user = symbols.iter().find(|s| s.name == "getUser");
        assert!(get_user.is_some());
        let s = get_user.unwrap();
        assert_eq!(s.line, 2);
        assert!(s.end_line >= 2);
    }

    #[test]
    fn extract_file_symbols_unsupported_language_is_empty() {
        register_ast_providers();
        let symbols = extract_file_symbols_for_language("nonexistent_language_xyz", "some code");
        assert!(symbols.is_empty());
    }

    #[test]
    fn check_syntax_valid_sql_has_no_errors() {
        register_ast_providers();
        let result = check_syntax_for_language(
            "sql",
            "CREATE TABLE users (\n  id INT PRIMARY KEY,\n  email VARCHAR(255)\n);\n",
        );
        assert!(result.supported);
        assert_eq!(result.error_count, 0);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn check_syntax_broken_sql_reports_errors() {
        register_ast_providers();
        let result = check_syntax_for_language("sql", "CREATE TABLE users (id INT;\n");
        assert!(result.supported);
        assert!(result.error_count > 0);
    }

    #[test]
    fn extract_file_symbols_sql_returns_create_statements() {
        register_ast_providers();
        let content = "CREATE TABLE users (\n  id INT\n);\nCREATE INDEX idx_users_email ON users(email);\n";
        let symbols = extract_file_symbols_for_language("sql", content);
        let table = symbols.iter().find(|s| s.name == "users");
        assert!(table.is_some(), "expected users table symbol, got: {symbols:?}");
        let table = table.unwrap();
        assert_eq!(table.kind, "create_table");
        assert_eq!(table.line, 1);
        assert!(table.end_line >= 3);
        let index = symbols.iter().find(|s| s.name == "idx_users_email");
        assert!(
            index.is_some(),
            "expected idx_users_email index symbol, got: {symbols:?}"
        );
    }

    #[test]
    fn extract_file_symbols_sql_resolves_qualified_object_reference() {
        register_ast_providers();
        let content = "CREATE TABLE public.orders (\n  id INT\n);\n";
        let symbols = extract_file_symbols_for_language("sql", content);
        assert!(
            symbols.iter().any(|s| s.name == "orders"),
            "expected orders table symbol, got: {symbols:?}"
        );
        assert!(
            !symbols.iter().any(|s| s.name == "public.orders"),
            "name should be resolved from object_reference name field, got: {symbols:?}"
        );
    }

    #[test]
    fn extract_file_symbols_sql_resolves_function_and_view() {
        register_ast_providers();
        let content =
            "CREATE VIEW active_users AS SELECT * FROM users;\nCREATE FUNCTION inc(x INT) RETURNS INT AS $$ BEGIN RETURN x + 1; END; $$ LANGUAGE plpgsql;\n";
        let symbols = extract_file_symbols_for_language("sql", content);
        assert!(
            symbols.iter().any(|s| s.name == "active_users"),
            "expected active_users view symbol, got: {symbols:?}"
        );
        assert!(
            symbols.iter().any(|s| s.name == "inc"),
            "expected inc function symbol, got: {symbols:?}"
        );
    }
}
