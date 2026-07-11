use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};

const BUILTIN_COMMAND: &str = "codepapr-builtin-symbols";

#[derive(Clone)]
pub struct FallbackServerSnapshot {
    pub server_family: String,
    pub command: String,
    pub open_documents: usize,
    pub stderr_tail: Vec<String>,
}

#[derive(Clone)]
struct FallbackDocument {
    text: String,
}

struct FallbackServerState {
    server_family: String,
    open_documents: HashMap<String, FallbackDocument>,
}

#[derive(Clone)]
struct ParsedSymbol {
    name: String,
    detail: String,
    signature: String,
    kind: u64,
    line: usize,
    column: usize,
    end_column: usize,
}

static FALLBACK_SERVERS: OnceLock<Mutex<HashMap<String, FallbackServerState>>> = OnceLock::new();

fn fallback_servers() -> &'static Mutex<HashMap<String, FallbackServerState>> {
    FALLBACK_SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn supports_language(language_id: &str) -> bool {
    fallback_family(language_id).is_some()
}

pub fn ensure_server(workspace_path: &str, language_id: &str) -> Option<FallbackServerSnapshot> {
    let key = fallback_key(workspace_path, language_id)?;
    let server_family = fallback_family(language_id)?.to_string();
    let mut servers = fallback_servers().lock().ok()?;
    let server = servers.entry(key).or_insert_with(|| FallbackServerState {
        server_family,
        open_documents: HashMap::new(),
    });
    Some(snapshot(server))
}

pub fn open_document(
    workspace_path: &str,
    language_id: &str,
    uri: &str,
    content: &str,
    _version: i32,
) -> Option<FallbackServerSnapshot> {
    let key = fallback_key(workspace_path, language_id)?;
    let server_family = fallback_family(language_id)?.to_string();
    let mut servers = fallback_servers().lock().ok()?;
    let server = servers.entry(key).or_insert_with(|| FallbackServerState {
        server_family,
        open_documents: HashMap::new(),
    });
    server.open_documents.insert(
        uri.to_string(),
        FallbackDocument {
            text: content.to_string(),
        },
    );
    Some(snapshot(server))
}

pub fn close_document(workspace_path: &str, language_id: &str, uri: &str) -> Option<bool> {
    let key = fallback_key(workspace_path, language_id)?;
    let mut servers = fallback_servers().lock().ok()?;
    let Some(server) = servers.get_mut(&key) else {
        return Some(false);
    };
    let removed = server.open_documents.remove(uri).is_some();
    Some(removed)
}

pub fn stop_server(workspace_path: &str, language_id: &str) -> Option<bool> {
    let key = fallback_key(workspace_path, language_id)?;
    let mut servers = fallback_servers().lock().ok()?;
    Some(servers.remove(&key).is_some())
}

pub fn request(
    workspace_path: &str,
    language_id: &str,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let key = fallback_key(workspace_path, language_id)?;
    let uri = params
        .get("textDocument")
        .and_then(|value| value.get("uri"))
        .and_then(Value::as_str)?
        .to_string();

    let document = {
        let servers = fallback_servers().lock().ok()?;
        let server = servers.get(&key)?;
        server.open_documents.get(&uri)?.clone()
    };

    let symbols = parse_symbols(language_id, &document.text);
    let result = match method {
        "textDocument/documentSymbol" => Ok(document_symbol_result(&document.text, &symbols)),
        "textDocument/definition" => definition_result(params, &uri, &document.text, &symbols),
        "textDocument/hover" => hover_result(params, &document.text, &symbols),
        _ => Ok(Value::Null),
    };

    Some(result)
}

fn fallback_family(language_id: &str) -> Option<&'static str> {
    match language_id {
        "csharp" => Some("csharp"),
        "java" => Some("java"),
        "c" | "cpp" => Some("cpp"),
        "swift" => Some("swift"),
        "rust" => Some("rust"),
        "go" => Some("go"),
        _ => None,
    }
}

fn fallback_key(workspace_path: &str, language_id: &str) -> Option<String> {
    Some(format!(
        "{}::{}",
        workspace_path,
        fallback_family(language_id)?
    ))
}

fn snapshot(server: &FallbackServerState) -> FallbackServerSnapshot {
    FallbackServerSnapshot {
        server_family: server.server_family.clone(),
        command: BUILTIN_COMMAND.to_string(),
        open_documents: server.open_documents.len(),
        stderr_tail: vec![
            "using built-in same-file fallback for outline, definition, and basic hover".to_string(),
            "external diagnostics and richer project-wide language features still require a real LSP server"
                .to_string(),
        ],
    }
}

fn document_symbol_result(text: &str, symbols: &[ParsedSymbol]) -> Value {
    let line_starts = line_start_offsets(text);
    Value::Array(
        symbols
            .iter()
            .map(|symbol| {
                let line_text = line_text(text, &line_starts, symbol.line).unwrap_or("");
                let line_len = line_text.len();
                json!({
                    "name": symbol.name,
                    "detail": symbol.detail,
                    "kind": symbol.kind,
                    "range": range_value(symbol.line, 0, line_len),
                    "selectionRange": range_value(symbol.line, symbol.column, symbol.end_column),
                })
            })
            .collect(),
    )
}

fn definition_result(
    params: &Value,
    uri: &str,
    text: &str,
    symbols: &[ParsedSymbol],
) -> Result<Value, String> {
    let position =
        request_position(params).ok_or_else(|| "fallback definition 缺少 position".to_string())?;
    let line_starts = line_start_offsets(text);
    let Some((identifier, _, _)) =
        identifier_at_position(text, &line_starts, position.0, position.1)
    else {
        return Ok(Value::Array(Vec::new()));
    };

    let Some(symbol) = symbols.iter().find(|symbol| symbol.name == identifier) else {
        return Ok(Value::Array(Vec::new()));
    };

    Ok(Value::Array(vec![json!({
        "uri": uri,
        "range": range_value(symbol.line, symbol.column, symbol.end_column),
    })]))
}

fn hover_result(params: &Value, text: &str, symbols: &[ParsedSymbol]) -> Result<Value, String> {
    let position =
        request_position(params).ok_or_else(|| "fallback hover 缺少 position".to_string())?;
    let line_starts = line_start_offsets(text);
    let Some((identifier, start_column, end_column)) =
        identifier_at_position(text, &line_starts, position.0, position.1)
    else {
        return Ok(Value::Null);
    };

    let Some(symbol) = symbols.iter().find(|symbol| symbol.name == identifier) else {
        return Ok(Value::Null);
    };

    Ok(json!({
        "contents": {
            "kind": "plaintext",
            "value": format!("{}\n{}", symbol.signature, symbol.detail),
        },
        "range": range_value(position.0, start_column, end_column),
    }))
}

fn request_position(params: &Value) -> Option<(usize, usize)> {
    let line = params.get("position")?.get("line")?.as_u64()? as usize;
    let character = params.get("position")?.get("character")?.as_u64()? as usize;
    Some((line, character))
}

fn range_value(line: usize, start_column: usize, end_column: usize) -> Value {
    json!({
        "start": { "line": line, "character": start_column },
        "end": { "line": line, "character": end_column.max(start_column + 1) },
    })
}

fn parse_symbols(language_id: &str, text: &str) -> Vec<ParsedSymbol> {
    let lines = line_start_offsets(text);
    let mut symbols = match language_id {
        "csharp" => parse_csharp_symbols(text, &lines),
        "java" => parse_java_symbols(text, &lines),
        "c" | "cpp" => parse_cpp_symbols(text, &lines),
        "swift" => parse_swift_symbols(text, &lines),
        "rust" => parse_rust_symbols(text, &lines),
        "go" => parse_go_symbols(text, &lines),
        _ => Vec::new(),
    };
    symbols.sort_by_key(|symbol| (symbol.line, symbol.column));
    symbols
}

fn parse_csharp_symbols(text: &str, lines: &[usize]) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    for (line_index, line) in iter_lines(text, lines) {
        if let Some(symbol) = class_like_symbol(line_index, line, csharp_type_regex(), "csharp") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
        if let Some(symbol) = callable_symbol(line_index, line, csharp_callable_regex(), "csharp") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
    }
    symbols
}

fn parse_java_symbols(text: &str, lines: &[usize]) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    for (line_index, line) in iter_lines(text, lines) {
        if let Some(symbol) = class_like_symbol(line_index, line, java_type_regex(), "java") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
        if let Some(symbol) = callable_symbol(line_index, line, java_callable_regex(), "java") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
    }
    symbols
}

fn parse_cpp_symbols(text: &str, lines: &[usize]) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    for (line_index, line) in iter_lines(text, lines) {
        if let Some(symbol) = class_like_symbol(line_index, line, cpp_type_regex(), "cpp") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
        if let Some(symbol) = callable_symbol(line_index, line, cpp_callable_regex(), "cpp") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
    }
    symbols
}

fn parse_swift_symbols(text: &str, lines: &[usize]) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    for (line_index, line) in iter_lines(text, lines) {
        if let Some(symbol) = class_like_symbol(line_index, line, swift_type_regex(), "swift") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
        if let Some(symbol) = callable_symbol(line_index, line, swift_callable_regex(), "swift") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
    }
    symbols
}

fn parse_rust_symbols(text: &str, lines: &[usize]) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    for (line_index, line) in iter_lines(text, lines) {
        if let Some(symbol) = class_like_symbol(line_index, line, rust_type_regex(), "rust") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
        if let Some(symbol) = callable_symbol(line_index, line, rust_callable_regex(), "rust") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
    }
    symbols
}

fn parse_go_symbols(text: &str, lines: &[usize]) -> Vec<ParsedSymbol> {
    let mut symbols = Vec::new();
    let mut seen = HashSet::new();
    for (line_index, line) in iter_lines(text, lines) {
        if let Some(symbol) = go_type_like_symbol(line_index, line) {
            push_unique(&mut symbols, &mut seen, symbol);
        }
        if let Some(symbol) = callable_symbol(line_index, line, go_callable_regex(), "go") {
            push_unique(&mut symbols, &mut seen, symbol);
        }
    }
    symbols
}

// Go 的 `type Name struct`/`type Name interface` 把名字写在种类前面，与
// class_like_symbol 预期的“种类在前、名字在后”捕获顺序相反，所以单独写一个小函数，
// 而不去改共用的 class_like_symbol（避免影响其他语言）。
fn go_type_like_symbol(line_index: usize, line: &str) -> Option<ParsedSymbol> {
    let captures = go_type_regex().captures(line)?;
    let name_match = captures.get(1)?;
    let kind_text = captures.get(2)?.as_str();
    let kind = if kind_text == "interface" { 11 } else { 23 };
    Some(ParsedSymbol {
        name: name_match.as_str().to_string(),
        detail: kind_text.to_string(),
        signature: line.trim().to_string(),
        kind,
        line: line_index,
        column: byte_to_column(line, name_match.start()),
        end_column: byte_to_column(line, name_match.end()),
    })
}

fn push_unique(symbols: &mut Vec<ParsedSymbol>, seen: &mut HashSet<String>, symbol: ParsedSymbol) {
    let key = format!("{}:{}:{}", symbol.name, symbol.line, symbol.column);
    if seen.insert(key) {
        symbols.push(symbol);
    }
}

fn class_like_symbol(
    line_index: usize,
    line: &str,
    regex: &Regex,
    _language: &str,
) -> Option<ParsedSymbol> {
    let captures = regex.captures(line)?;
    let kind_text = captures.get(1)?.as_str();
    let name_match = captures.get(2)?;
    let detail = kind_text.to_string();
    let kind = match kind_text {
        "class" | "record" => 5,
        "interface" | "trait" => 11,
        "struct" => 23,
        "enum" => 10,
        _ => 5,
    };
    Some(ParsedSymbol {
        name: name_match.as_str().to_string(),
        detail,
        signature: line.trim().to_string(),
        kind,
        line: line_index,
        column: byte_to_column(line, name_match.start()),
        end_column: byte_to_column(line, name_match.end()),
    })
}

fn callable_symbol(
    line_index: usize,
    line: &str,
    regex: &Regex,
    language: &str,
) -> Option<ParsedSymbol> {
    let captures = regex.captures(line)?;
    let name_match = captures.get(1)?;
    let raw_name = name_match.as_str();
    let normalized_name = raw_name.rsplit("::").next().unwrap_or(raw_name);
    if is_control_keyword(normalized_name) {
        return None;
    }
    let detail = if language == "cpp" {
        "function"
    } else {
        "method"
    };
    let kind = if normalized_name == raw_name
        && normalized_name.chars().next()?.is_uppercase()
        && language != "cpp"
    {
        9
    } else if language == "cpp" {
        12
    } else {
        6
    };
    Some(ParsedSymbol {
        name: normalized_name.to_string(),
        detail: detail.to_string(),
        signature: line.trim().trim_end_matches('{').trim().to_string(),
        kind,
        line: line_index,
        column: byte_to_column(line, name_match.start()),
        end_column: byte_to_column(line, name_match.start() + normalized_name.len()),
    })
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
    )
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
    let line_text = line_text(text, offsets, line)?;
    let bytes = line_text.as_bytes();
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
    Some((line_text.get(start..end)?.to_string(), start, end))
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn byte_to_column(line: &str, byte_index: usize) -> usize {
    line.get(..byte_index)
        .map(|prefix| prefix.chars().count())
        .unwrap_or(0)
}

fn csharp_type_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|new)\s+)*(class|interface|struct|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid csharp type regex")
    })
}

fn csharp_callable_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|sealed|abstract|virtual|override|async|extern|unsafe|partial|new)\s+)*(?:<[A-Za-z0-9_,\s]+>\s*)?(?:[A-Za-z_][A-Za-z0-9_<>,\[\]?.\s]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(")
            .expect("valid csharp callable regex")
    })
}

fn java_type_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed)\s+)*(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid java type regex")
    })
}

fn java_callable_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[A-Za-z0-9_,\s]+>\s*)?(?:[A-Za-z_][A-Za-z0-9_<>,\[\]?.\s]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(")
            .expect("valid java callable regex")
    })
}

fn cpp_type_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:template\s*<[^>]+>\s*)?(class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid cpp type regex")
    })
}

fn cpp_callable_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:template\s*<[^>]+>\s*)?(?:(?:inline|static|constexpr|virtual|explicit|friend|extern|auto|consteval|constinit)\s+)*(?:[A-Za-z_~][A-Za-z0-9_:<>*&\s,]*\s+)?([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|;)" )
            .expect("valid cpp callable regex")
    })
}

fn swift_type_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+)*(?:final\s+)?(?:open\s+|public\s+)?\s*(class|struct|enum|protocol|actor|extension)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid swift type regex")
    })
}

fn swift_callable_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:@[A-Za-z]+\s*)?(?:(?:public|private|internal|fileprivate|open)\s+)?(?:override\s+|mutating\s+|nonmutating\s+|static\s+|class\s+)?(?:async\s+)?(?:throws\s+|rethrows\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid swift callable regex")
    })
}

fn rust_type_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid rust type regex")
    })
}

fn rust_callable_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]"#)
            .expect("valid rust callable regex")
    })
}

fn go_type_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b")
            .expect("valid go type regex")
    })
}

fn go_callable_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(")
            .expect("valid go callable regex")
    })
}

#[cfg(test)]
mod tests {
    use super::parse_symbols;

    #[test]
    fn parses_csharp_symbols() {
        let text = "internal static class Program\n{\n    private static int Add(int left, int right) => left + right;\n\n    private static void Main()\n    {\n        Add(1, 2);\n    }\n}\n";
        let symbols = parse_symbols("csharp", text);
        assert!(symbols.iter().any(|symbol| symbol.name == "Program"));
        assert!(symbols.iter().any(|symbol| symbol.name == "Add"));
        assert!(symbols.iter().any(|symbol| symbol.name == "Main"));
    }

    #[test]
    fn parses_java_symbols() {
        let text = "public class Main {\n    private static int add(int left, int right) {\n        return left + right;\n    }\n}\n";
        let symbols = parse_symbols("java", text);
        assert!(symbols.iter().any(|symbol| symbol.name == "Main"));
        assert!(symbols.iter().any(|symbol| symbol.name == "add"));
    }

    #[test]
    fn parses_cpp_symbols() {
        let text = "class Math {\n};\n\nint add(int left, int right) { return left + right; }\n";
        let symbols = parse_symbols("cpp", text);
        assert!(symbols.iter().any(|symbol| symbol.name == "Math"));
        assert!(symbols.iter().any(|symbol| symbol.name == "add"));
    }

    #[test]
    fn parses_swift_symbols() {
        let text = "class ViewController: UIViewController {\n    func viewDidLoad() {\n        super.viewDidLoad()\n    }\n\n    @IBAction func buttonTapped() {}\n}\n";
        let symbols = parse_symbols("swift", text);
        assert!(symbols.iter().any(|symbol| symbol.name == "ViewController"));
        assert!(symbols.iter().any(|symbol| symbol.name == "viewDidLoad"));
        assert!(symbols.iter().any(|symbol| symbol.name == "buttonTapped"));
    }

    #[test]
    fn parses_rust_symbols() {
        let text = "pub struct Point {\n    x: i32,\n}\n\nimpl Point {\n    pub fn add(&self, other: &Point) -> i32 {\n        self.x + other.x\n    }\n}\n";
        let symbols = parse_symbols("rust", text);
        assert!(symbols.iter().any(|symbol| symbol.name == "Point"));
        assert!(symbols.iter().any(|symbol| symbol.name == "add"));
    }

    #[test]
    fn parses_go_symbols() {
        let text = "package main\n\ntype Point struct {\n\tX int\n}\n\nfunc (p Point) Add(other Point) int {\n\treturn p.X + other.X\n}\n\nfunc NewPoint(x int) Point {\n\treturn Point{X: x}\n}\n";
        let symbols = parse_symbols("go", text);
        assert!(symbols.iter().any(|symbol| symbol.name == "Point"));
        assert!(symbols.iter().any(|symbol| symbol.name == "Add"));
        assert!(symbols.iter().any(|symbol| symbol.name == "NewPoint"));
    }
}
