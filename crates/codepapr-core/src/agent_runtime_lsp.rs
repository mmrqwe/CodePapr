//! P2: host LSP / lsp_edit / diagnostics in Rust so they do not wait on WebView JS.
//! Graph / project-wide diagnostics stay UI-bridged (AST + multi-stage TS).

use crate::workspace_fs;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};
use crate::events::EventSink;

static LSP_DOC_VERSION: AtomicI32 = AtomicI32::new(1);

const SYMBOL_KINDS: &[&str] = &[
    "",
    "File",
    "Module",
    "Namespace",
    "Package",
    "Class",
    "Method",
    "Property",
    "Field",
    "Constructor",
    "Enum",
    "Interface",
    "Function",
    "Variable",
    "Constant",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Key",
    "Null",
    "EnumMember",
    "Struct",
    "Event",
    "Operator",
    "TypeParameter",
];

pub fn lsp_language_from_path(path: &str) -> Option<&'static str> {
    let filename = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let extension = if filename.contains('.') {
        filename.rsplit('.').next().unwrap_or("")
    } else {
        filename.as_str()
    };
    Some(match extension {
        "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" => "cpp",
        "cs" | "csx" => "csharp",
        "java" => "java",
        "ts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "htm" | "html" | "shtml" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "json" => "json",
        "jsonc" => "jsonc",
        "yaml" | "yml" => "yaml",
        "py" | "pyi" | "pyw" => "python",
        "sh" | "bash" | "zsh" => "shellscript",
        "sql" => "sql",
        "md" | "mdx" => "markdown",
        "rs" => "rust",
        "go" => "go",
        "swift" => "swift",
        _ => return None,
    })
}

pub fn dispatch(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    name: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    match name {
        "lsp" => dispatch_lsp_action(sink, workspace_path, args),
        "workspace_symbol_definition" => {
            navigation(sink, workspace_path, args, "textDocument/definition")
        }
        "workspace_symbol_references" => references(sink, workspace_path, args),
        "workspace_symbol_hover" => hover(sink, workspace_path, args),
        "workspace_document_symbol" => document_symbol(sink, workspace_path, args),
        "workspace_workspace_symbol" => workspace_symbol(sink, workspace_path, args),
        "workspace_implementation" => {
            navigation(sink, workspace_path, args, "textDocument/implementation")
        }
        "workspace_prepare_call_hierarchy" => prepare_call_hierarchy(sink, workspace_path, args),
        "workspace_incoming_calls" => call_hierarchy_calls(sink, workspace_path, args, true),
        "workspace_outgoing_calls" => call_hierarchy_calls(sink, workspace_path, args, false),
        "diagnostics" | "workspace_lsp_diagnostics" => diagnostics(sink, workspace_path, args),
        "lsp_edit" => dispatch_lsp_edit(sink, workspace_path, args),
        "workspace_rename_symbol" => rename(sink, workspace_path, args),
        "workspace_apply_code_action" => apply_code_action(sink, workspace_path, args),
        "workspace_organize_imports" => apply_code_action(
            sink,
            workspace_path,
            &with_kind(args, "source.organizeImports"),
        ),
        "workspace_fix_diagnostics" => {
            apply_code_action(sink, workspace_path, &with_kind(args, "quickfix"))
        }
        "workspace_format_files" => format_files(sink, workspace_path, args),
        other => Err(format!("sidecar 宿主未实现语言工具: {other}")),
    }
}

fn with_kind(args: &Value, kind: &str) -> Value {
    let mut obj = args.as_object().cloned().unwrap_or_default();
    obj.entry("kind".to_string())
        .or_insert_with(|| json!(kind));
    Value::Object(obj)
}

fn dispatch_lsp_action(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let action = arg_string(args, "action").ok_or_else(|| "action 必须是字符串".to_string())?;
    match action.as_str() {
        "goToDefinition" => navigation(sink, workspace_path, args, "textDocument/definition"),
        "findReferences" => references(sink, workspace_path, args),
        "hover" => hover(sink, workspace_path, args),
        "documentSymbol" => document_symbol(sink, workspace_path, args),
        "workspaceSymbol" => workspace_symbol(sink, workspace_path, args),
        "goToImplementation" => {
            navigation(sink, workspace_path, args, "textDocument/implementation")
        }
        "prepareCallHierarchy" => prepare_call_hierarchy(sink, workspace_path, args),
        "incomingCalls" => call_hierarchy_calls(sink, workspace_path, args, true),
        "outgoingCalls" => call_hierarchy_calls(sink, workspace_path, args, false),
        other => Err(format!("未知的 lsp action: {other}")),
    }
}

fn dispatch_lsp_edit(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let action = arg_string(args, "action").ok_or_else(|| "action 必须是字符串".to_string())?;
    match action.as_str() {
        "rename" => rename(sink, workspace_path, args),
        "code_action" => apply_code_action(sink, workspace_path, args),
        "format" => format_files(sink, workspace_path, args),
        other => Err(format!("未知的 lsp_edit action: {other}")),
    }
}

fn navigation(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
    method: &str,
) -> Result<(Value, Vec<String>), String> {
    let result = lsp_position_request(sink, workspace_path, args, method, json!({}))?;
    let locations = normalize_locations(workspace_path, &result);
    Ok((
        json!({
            "available": true,
            "locations": locations,
            "source": "lsp",
            "confidence": "high",
        }),
        Vec::new(),
    ))
}

fn references(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let include = args
        .get("includeDeclaration")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let result = lsp_position_request(
        sink,
        workspace_path,
        args,
        "textDocument/references",
        json!({ "context": { "includeDeclaration": include } }),
    )?;
    let locations = normalize_locations(workspace_path, &result);
    Ok((
        json!({
            "available": true,
            "locations": locations,
            "source": "lsp",
            "confidence": "high",
        }),
        Vec::new(),
    ))
}

fn hover(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let result = lsp_position_request(sink, workspace_path, args, "textDocument/hover", json!({}))?;
    match hover_contents(&result) {
        Some(contents) => Ok((
            json!({
                "available": true,
                "contents": contents,
                "source": "lsp",
                "confidence": "high",
            }),
            Vec::new(),
        )),
        None => Ok((
            json!({
                "available": true,
                "message": "该位置没有 hover 信息。",
                "source": "lsp",
                "confidence": "high",
            }),
            Vec::new(),
        )),
    }
}

fn document_symbol(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let path = require_path(args)?;
    let result = lsp_position_request(
        sink,
        workspace_path,
        args,
        "textDocument/documentSymbol",
        json!({}),
    )?;
    let symbols = flatten_document_symbols(workspace_path, &path, &result);
    Ok((
        json!({
            "available": true,
            "symbols": symbols,
            "source": "lsp",
            "confidence": "high",
        }),
        Vec::new(),
    ))
}

fn workspace_symbol(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let query = arg_string(args, "query").unwrap_or_default();
    let result = lsp_request_opened(
        sink,
        workspace_path,
        args,
        "workspace/symbol",
        json!({ "query": query }),
    )?;
    let symbols = flatten_workspace_symbols(workspace_path, &result);
    Ok((
        json!({
            "available": true,
            "symbols": symbols,
            "source": "lsp",
            "confidence": "high",
        }),
        Vec::new(),
    ))
}

fn prepare_call_hierarchy(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let result = lsp_position_request(
        sink,
        workspace_path,
        args,
        "textDocument/prepareCallHierarchy",
        json!({}),
    )?;
    Ok((
        json!({
            "available": true,
            "items": flatten_call_items(workspace_path, &result),
            "source": "lsp",
            "confidence": "high",
        }),
        Vec::new(),
    ))
}

fn call_hierarchy_calls(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
    incoming: bool,
) -> Result<(Value, Vec<String>), String> {
    let prepared = lsp_position_request(
        sink,
        workspace_path,
        args,
        "textDocument/prepareCallHierarchy",
        json!({}),
    )?;
    let items = match prepared {
        Value::Array(items) => items,
        other if !other.is_null() => vec![other],
        _ => Vec::new(),
    };
    let Some(item) = items.into_iter().next() else {
        return Ok((
            json!({
                "available": true,
                "calls": [],
                "message": "该位置没有可用的调用层级项。",
                "source": "lsp",
                "confidence": "high",
            }),
            Vec::new(),
        ));
    };
    let method = if incoming {
        "callHierarchy/incomingCalls"
    } else {
        "callHierarchy/outgoingCalls"
    };
    let result = lsp_request_opened(sink, workspace_path, args, method, json!({ "item": item }))?;
    let key = if incoming { "from" } else { "to" };
    Ok((
        json!({
            "available": true,
            "calls": flatten_call_calls(workspace_path, &result, key),
            "source": "lsp",
            "confidence": "high",
        }),
        Vec::new(),
    ))
}

fn diagnostics(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let relative_path = arg_string(args, "relativePath");
    if let Some(path) = relative_path {
        let language_id = language_id_for(&path, args)?;
        let _ = open_document(sink, workspace_path, &language_id, &path);
        let response =
            crate::lsp::lsp_get_diagnostics_impl(workspace_path, &language_id, Some(&path))?;
        let uri = file_uri(workspace_path, &path);
        let file_diags = response
            .diagnostics
            .get(&uri)
            .and_then(|value| value.get("diagnostics"))
            .cloned()
            .or_else(|| response.diagnostics.get(&uri).cloned())
            .unwrap_or(json!([]));
        let count = file_diags.as_array().map(|a| a.len()).unwrap_or(0);
        let _ = crate::lsp::lsp_close_document_impl(workspace_path, &language_id, &path);
        return Ok((
            json!({
                "relativePath": path,
                "totalCount": count,
                "diagnostics": file_diags,
            }),
            Vec::new(),
        ));
    }

    let langs = crate::symbol_provider::list_available_symbol_providers().unwrap_or_default();
    let mut summary = serde_json::Map::new();
    let mut total = 0usize;
    for info in langs {
        if let Ok(response) =
            crate::lsp::lsp_get_diagnostics_impl(workspace_path, &info.language_id, None)
        {
            for (uri, payload) in response.diagnostics {
                let diags = payload
                    .get("diagnostics")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if diags.is_empty() {
                    continue;
                }
                let file = relative_from_uri(workspace_path, &uri).unwrap_or(uri);
                let top: Vec<String> = diags
                    .iter()
                    .take(3)
                    .filter_map(|d| d.get("message").and_then(Value::as_str).map(str::to_string))
                    .collect();
                total += diags.len();
                summary.insert(
                    file,
                    json!({ "count": diags.len(), "topIssues": top }),
                );
            }
        }
    }
    Ok((
        json!({
            "totalFiles": summary.len(),
            "totalIssues": total,
            "files": summary.iter().map(|(file, info)| {
                json!({ "file": file, "count": info.get("count"), "topIssues": info.get("topIssues") })
            }).collect::<Vec<_>>(),
        }),
        Vec::new(),
    ))
}

fn rename(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let new_name = arg_string(args, "newName").ok_or_else(|| "newName 必须是字符串".to_string())?;
    let edit = lsp_position_request(
        sink,
        workspace_path,
        args,
        "textDocument/rename",
        json!({ "newName": new_name }),
    )?;
    apply_workspace_edit(workspace_path, &edit)
}

fn apply_code_action(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let position = lsp_position(args);
    let mut context = json!({ "diagnostics": [] });
    if let Some(kind) = arg_string(args, "kind") {
        context["only"] = json!([kind]);
    }
    let actions = lsp_position_request(
        sink,
        workspace_path,
        args,
        "textDocument/codeAction",
        json!({
            "range": { "start": position, "end": position },
            "context": context,
        }),
    )?;
    let list = match actions {
        Value::Array(items) => items,
        other if !other.is_null() => vec![other],
        _ => Vec::new(),
    };
    let desired_title = arg_string(args, "title").map(|s| s.to_ascii_lowercase());
    let desired_kind = arg_string(args, "kind").map(|s| s.to_ascii_lowercase());
    let preferred_only = args.get("preferredOnly").and_then(Value::as_bool).unwrap_or(false);
    let chosen = list.into_iter().find(|action| {
        let edit = action.get("edit");
        if edit.is_none() || edit == Some(&Value::Null) {
            return false;
        }
        if preferred_only && action.get("isPreferred") != Some(&Value::Bool(true)) {
            return false;
        }
        if let Some(title) = &desired_title {
            let actual = action
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            if !actual.contains(title.as_str()) {
                return false;
            }
        }
        if let Some(kind) = &desired_kind {
            let actual = action
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            if !actual.starts_with(kind.as_str()) {
                return false;
            }
        }
        true
    });
    let Some(action) = chosen else {
        return Ok((
            json!({
                "available": true,
                "ok": false,
                "changedFiles": [],
                "appliedEdits": 0,
                "message": "没有可应用的 code action。",
            }),
            Vec::new(),
        ));
    };
    let edit = action.get("edit").cloned().unwrap_or(Value::Null);
    apply_workspace_edit(workspace_path, &edit)
}

fn format_files(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
) -> Result<(Value, Vec<String>), String> {
    let mut paths = arg_string_array(args, "relativePaths");
    paths.extend(arg_string_array(args, "filePaths"));
    if paths.is_empty() {
        if let Some(path) = arg_string(args, "relativePath") {
            paths.push(path);
        }
    }
    if paths.is_empty() {
        return Err("relativePaths 必须是非空字符串数组".to_string());
    }
    let tab_size = args.get("tabSize").and_then(Value::as_u64).unwrap_or(2);
    let insert_spaces = args
        .get("insertSpaces")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut changed = Vec::new();
    let mut applied = 0usize;
    for path in paths {
        let mut file_args = args.as_object().cloned().unwrap_or_default();
        file_args.insert("relativePath".to_string(), json!(path));
        let edits = lsp_position_request(
            sink,
            workspace_path,
            &Value::Object(file_args),
            "textDocument/formatting",
            json!({
                "options": { "tabSize": tab_size, "insertSpaces": insert_spaces }
            }),
        )?;
        if edits.is_null() {
            continue;
        }
        let uri = file_uri(workspace_path, &path);
        let (value, mutated) = apply_workspace_edit(
            workspace_path,
            &json!({ "changes": { uri: edits } }),
        )?;
        if value.get("ok") == Some(&Value::Bool(true)) {
            changed.extend(mutated);
            applied += value.get("appliedEdits").and_then(Value::as_u64).unwrap_or(0) as usize;
        }
    }
    Ok((
        json!({
            "available": true,
            "ok": !changed.is_empty(),
            "changedFiles": changed,
            "appliedEdits": applied,
            "message": if changed.is_empty() {
                "没有需要格式化的改动。".to_string()
            } else {
                format!("已格式化 {} 个文件。", changed.len())
            },
        }),
        changed,
    ))
}

fn apply_workspace_edit(
    workspace_path: &str,
    edit: &Value,
) -> Result<(Value, Vec<String>), String> {
    let grouped = collect_edits(workspace_path, edit);
    if grouped.is_empty() {
        return Ok((
            json!({
                "available": true,
                "ok": false,
                "changedFiles": [],
                "appliedEdits": 0,
                "message": "语言服务没有返回可应用的文本改动。",
            }),
            Vec::new(),
        ));
    }
    let mut changed = Vec::new();
    let mut failed = Vec::new();
    let mut applied = 0usize;
    for (path, edits) in grouped {
        let current = match workspace_fs::read::read_text_file_impl(
            workspace_path.to_string(),
            path.clone(),
            Some(1_000_000),
            None,
            None,
            None,
            None,
        ) {
            Ok(file) if !file.truncated_by_bytes => file,
            _ => {
                failed.push(path);
                continue;
            }
        };
        match apply_text_edits(&current.content, &edits) {
            Ok((next, count)) => {
                if next == current.content {
                    continue;
                }
                if workspace_fs::write::write_text_file_impl(
                    workspace_path.to_string(),
                    path.clone(),
                    next,
                )
                .is_err()
                {
                    failed.push(path);
                    continue;
                }
                applied += count;
                changed.push(path);
            }
            Err(_) => failed.push(path),
        }
    }
    let failed_note = if failed.is_empty() {
        String::new()
    } else {
        format!("（{} 个文件未能应用：{}）", failed.len(), failed.join("、"))
    };
    Ok((
        json!({
            "available": true,
            "ok": !changed.is_empty(),
            "changedFiles": changed,
            "appliedEdits": applied,
            "failedFiles": failed,
            "message": if changed.is_empty() {
                format!("没有可应用的改动。{failed_note}")
            } else {
                format!("已应用 {applied} 处语言服务改动。{failed_note}")
            },
        }),
        changed,
    ))
}

fn collect_edits(workspace_path: &str, edit: &Value) -> Vec<(String, Vec<Value>)> {
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
    let push = |grouped: &mut Vec<(String, Vec<Value>)>, path: String, edits: Vec<Value>| {
        if let Some((_, existing)) = grouped.iter_mut().find(|(p, _)| *p == path) {
            existing.extend(edits);
        } else {
            grouped.push((path, edits));
        }
    };
    if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            if let Some(path) = relative_from_uri(workspace_path, uri) {
                if let Some(list) = edits.as_array() {
                    push(&mut grouped, path, list.clone());
                }
            }
        }
    }
    if let Some(document_changes) = edit.get("documentChanges").and_then(Value::as_array) {
        for change in document_changes {
            let uri = change
                .pointer("/textDocument/uri")
                .and_then(Value::as_str)
                .or_else(|| change.get("uri").and_then(Value::as_str));
            let Some(uri) = uri else { continue };
            let Some(path) = relative_from_uri(workspace_path, uri) else {
                continue;
            };
            if let Some(list) = change.get("edits").and_then(Value::as_array) {
                push(&mut grouped, path, list.clone());
            }
        }
    }
    grouped
}

fn apply_text_edits(content: &str, edits: &[Value]) -> Result<(String, usize), String> {
    let mut indexed: Vec<(usize, usize, usize, String)> = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        let start = edit.pointer("/range/start").cloned().unwrap_or(json!({}));
        let end = edit.pointer("/range/end").cloned().unwrap_or(json!({}));
        let start_off = utf16_to_byte(
            content,
            start.get("line").and_then(Value::as_u64).unwrap_or(0) as usize,
            start.get("character").and_then(Value::as_u64).unwrap_or(0) as usize,
        );
        let end_off = utf16_to_byte(
            content,
            end.get("line").and_then(Value::as_u64).unwrap_or(0) as usize,
            end.get("character").and_then(Value::as_u64).unwrap_or(0) as usize,
        );
        let new_text = edit
            .get("newText")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        indexed.push((start_off.min(end_off), start_off.max(end_off), index, new_text));
    }
    indexed.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(b.2.cmp(&a.2)));
    let mut next = content.to_string();
    for (start, end, _, text) in &indexed {
        let start = (*start).min(next.len());
        let end = (*end).min(next.len()).max(start);
        next.replace_range(start..end, text);
    }
    Ok((next, indexed.len()))
}

fn utf16_to_byte(content: &str, line: usize, character: usize) -> usize {
    let mut remaining_lines = line;
    let mut byte = 0usize;
    for (idx, ch) in content.char_indices() {
        if remaining_lines == 0 {
            byte = idx;
            break;
        }
        if ch == '\n' {
            remaining_lines -= 1;
            byte = idx + ch.len_utf8();
        }
    }
    if remaining_lines > 0 {
        return content.len();
    }
    let slice = &content[byte..];
    let mut units = 0usize;
    for (idx, ch) in slice.char_indices() {
        if units >= character {
            return byte + idx;
        }
        units += ch.len_utf16();
    }
    content.len()
}

fn lsp_position_request(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
    method: &str,
    extra: Value,
) -> Result<Value, String> {
    let mut params = extra;
    if let Some(obj) = params.as_object_mut() {
        obj.insert(
            "textDocument".to_string(),
            json!({ "uri": file_uri(workspace_path, &require_path(args)?) }),
        );
        obj.entry("position".to_string())
            .or_insert_with(|| lsp_position(args));
    }
    lsp_request_opened(sink, workspace_path, args, method, params)
}

fn lsp_request_opened(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    args: &Value,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let path = require_path(args)?;
    let language_id = language_id_for(&path, args)?;
    let content = workspace_fs::read::read_text_file_impl(
        workspace_path.to_string(),
        path.clone(),
        Some(1_000_000),
        None,
        None,
        None,
        None,
    )?
    .content;
    crate::lsp::lsp_open_document_with_sink(
        sink,
        workspace_path.to_string(),
        language_id.clone(),
        path.clone(),
        content,
        LSP_DOC_VERSION.fetch_add(1, Ordering::Relaxed),
        Some(0),
    )?;
    let response = crate::lsp::lsp_request_impl(workspace_path, &language_id, method, &params);
    let _ = crate::lsp::lsp_close_document_impl(workspace_path, &language_id, &path);
    let response = response?;
    if let Some(error) = response.message.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("LSP 请求失败");
        return Err(message.to_string());
    }
    Ok(response
        .message
        .get("result")
        .cloned()
        .unwrap_or(Value::Null))
}

fn open_document(
    sink: Option<&dyn EventSink>,
    workspace_path: &str,
    language_id: &str,
    path: &str,
) -> Result<(), String> {
    let content = workspace_fs::read::read_text_file_impl(
        workspace_path.to_string(),
        path.to_string(),
        Some(1_000_000),
        None,
        None,
        None,
        None,
    )?
    .content;
    crate::lsp::lsp_open_document_with_sink(
        sink,
        workspace_path.to_string(),
        language_id.to_string(),
        path.to_string(),
        content,
        LSP_DOC_VERSION.fetch_add(1, Ordering::Relaxed),
        Some(0),
    )
    .map(|_| ())
}

fn lsp_position(args: &Value) -> Value {
    let line = args
        .get("line")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .saturating_sub(1);
    let column = args
        .get("column")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .saturating_sub(1);
    json!({ "line": line, "character": column })
}

fn language_id_for(path: &str, args: &Value) -> Result<String, String> {
    if let Some(id) = arg_string(args, "languageId") {
        return Ok(id);
    }
    lsp_language_from_path(path)
        .map(str::to_string)
        .ok_or_else(|| format!("无法从路径推断 languageId: {path}"))
}

fn require_path(args: &Value) -> Result<String, String> {
    arg_string(args, "relativePath")
        .or_else(|| arg_string(args, "path"))
        .ok_or_else(|| "relativePath 必须是字符串".to_string())
}

fn arg_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn arg_string_array(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn file_uri(workspace_path: &str, relative: &str) -> String {
    crate::lsp::file_uri_for(Path::new(workspace_path), relative)
        .unwrap_or_else(|_| crate::lsp::path_to_file_uri(&format!("{workspace_path}/{relative}")))
}

fn relative_from_uri(workspace_path: &str, uri: &str) -> Option<String> {
    let ws = crate::lsp::path_to_file_uri(&workspace_path.replace('\\', "/"));
    let rest = uri.strip_prefix(&ws).or_else(|| {
        let with_slash = if ws.ends_with('/') {
            ws.clone()
        } else {
            format!("{ws}/")
        };
        uri.strip_prefix(&with_slash).map(|s| s)
    })?;
    let decoded = percent_decode(rest.trim_start_matches('/'));
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &input[i + 1..i + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).replace('\\', "/")
}

fn symbol_kind_name(kind: Option<&Value>) -> &'static str {
    let n = kind.and_then(Value::as_u64).unwrap_or(0) as usize;
    SYMBOL_KINDS.get(n).copied().unwrap_or("Unknown")
}

fn loc_from_range(workspace_path: &str, uri: Option<&str>, range: Option<&Value>) -> Option<Value> {
    let relative = relative_from_uri(workspace_path, uri?)?;
    let start = range?.get("start")?;
    let end = range.and_then(|r| r.get("end")).unwrap_or(start);
    Some(json!({
        "relativePath": relative,
        "line": start.get("line").and_then(Value::as_u64).unwrap_or(0) + 1,
        "column": start.get("character").and_then(Value::as_u64).unwrap_or(0) + 1,
        "endLine": end.get("line").and_then(Value::as_u64).unwrap_or(0) + 1,
        "endColumn": end.get("character").and_then(Value::as_u64).unwrap_or(0) + 1,
    }))
}

fn normalize_locations(workspace_path: &str, result: &Value) -> Vec<Value> {
    let entries = match result {
        Value::Array(items) => items.clone(),
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    };
    let mut locations = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries.iter().take(100) {
        let uri = entry
            .get("targetUri")
            .and_then(Value::as_str)
            .or_else(|| entry.get("uri").and_then(Value::as_str));
        let range = entry
            .get("targetSelectionRange")
            .or_else(|| entry.get("targetRange"))
            .or_else(|| entry.get("range"));
        if let Some(loc) = loc_from_range(workspace_path, uri, range) {
            let key = loc.to_string();
            if seen.insert(key) {
                locations.push(loc);
            }
        }
    }
    locations
}

fn hover_contents(result: &Value) -> Option<String> {
    let contents = result.get("contents")?;
    if let Some(text) = contents.as_str() {
        return Some(text.to_string());
    }
    if let Some(items) = contents.as_array() {
        let joined = items
            .iter()
            .filter_map(marked_string)
            .collect::<Vec<_>>()
            .join("\n\n");
        return if joined.is_empty() { None } else { Some(joined) };
    }
    marked_string(contents)
}

fn marked_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.get("value").and_then(Value::as_str).map(str::to_string))
}

fn flatten_document_symbols(workspace_path: &str, relative_path: &str, result: &Value) -> Vec<Value> {
    let mut symbols = Vec::new();
    fn walk(
        items: &[Value],
        relative_path: &str,
        container: Option<&str>,
        symbols: &mut Vec<Value>,
    ) {
        for entry in items {
            if symbols.len() >= 500 {
                return;
            }
            let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
            let range = entry
                .get("selectionRange")
                .or_else(|| entry.get("range"))
                .or_else(|| entry.pointer("/location/range"));
            let start = range.and_then(|r| r.get("start"));
            symbols.push(json!({
                "name": name,
                "kind": symbol_kind_name(entry.get("kind")),
                "relativePath": relative_path,
                "line": start.and_then(|s| s.get("line")).and_then(Value::as_u64).unwrap_or(0) + 1,
                "column": start.and_then(|s| s.get("character")).and_then(Value::as_u64).unwrap_or(0) + 1,
                "containerName": container,
            }));
            if let Some(children) = entry.get("children").and_then(Value::as_array) {
                walk(children, relative_path, Some(name), symbols);
            }
        }
    }
    match result {
        Value::Array(items) => walk(items, relative_path, None, &mut symbols),
        _ => {}
    }
    let _ = workspace_path;
    symbols
}

fn flatten_workspace_symbols(workspace_path: &str, result: &Value) -> Vec<Value> {
    let mut symbols = Vec::new();
    let items = match result {
        Value::Array(items) => items,
        _ => return symbols,
    };
    for entry in items.iter().take(200) {
        let uri = entry
            .pointer("/location/uri")
            .and_then(Value::as_str)
            .or_else(|| entry.get("uri").and_then(Value::as_str));
        let range = entry
            .pointer("/location/range")
            .or_else(|| entry.get("selectionRange"))
            .or_else(|| entry.get("range"));
        let Some(loc) = loc_from_range(workspace_path, uri, range) else {
            continue;
        };
        symbols.push(json!({
            "name": entry.get("name").and_then(Value::as_str).unwrap_or(""),
            "kind": symbol_kind_name(entry.get("kind")),
            "relativePath": loc.get("relativePath"),
            "line": loc.get("line"),
            "column": loc.get("column"),
            "containerName": entry.get("containerName"),
        }));
    }
    symbols
}

fn flatten_call_items(workspace_path: &str, result: &Value) -> Vec<Value> {
    let items = match result {
        Value::Array(items) => items,
        _ => return Vec::new(),
    };
    items
        .iter()
        .filter_map(|entry| {
            let uri = entry.get("uri").and_then(Value::as_str);
            let range = entry
                .get("selectionRange")
                .or_else(|| entry.get("range"));
            let loc = loc_from_range(workspace_path, uri, range)?;
            Some(json!({
                "name": entry.get("name").and_then(Value::as_str).unwrap_or(""),
                "kind": symbol_kind_name(entry.get("kind")),
                "relativePath": loc.get("relativePath"),
                "line": loc.get("line"),
                "column": loc.get("column"),
            }))
        })
        .collect()
}

fn flatten_call_calls(workspace_path: &str, result: &Value, key: &str) -> Vec<Value> {
    let items = match result {
        Value::Array(items) => items,
        _ => return Vec::new(),
    };
    items
        .iter()
        .take(100)
        .filter_map(|entry| {
            let item = entry.get(key)?;
            let uri = item.get("uri").and_then(Value::as_str);
            let range = item.get("selectionRange").or_else(|| item.get("range"));
            let loc = loc_from_range(workspace_path, uri, range)?;
            Some(json!({
                "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
                "relativePath": loc.get("relativePath"),
                "line": loc.get("line"),
                "column": loc.get("column"),
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsp_language_maps_ts_and_tsx() {
        assert_eq!(lsp_language_from_path("src/a.ts"), Some("typescript"));
        assert_eq!(lsp_language_from_path("src/a.tsx"), Some("typescriptreact"));
        assert_eq!(lsp_language_from_path("src/a.py"), Some("python"));
        assert_eq!(lsp_language_from_path("README.md"), Some("markdown"));
        assert_eq!(lsp_language_from_path("notes.txt"), None);
    }

    #[test]
    fn utf16_offset_handles_ascii() {
        assert_eq!(utf16_to_byte("ab\ncd", 1, 1), 4);
        assert_eq!(utf16_to_byte("hello", 0, 2), 2);
    }
}
