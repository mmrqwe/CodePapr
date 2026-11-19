use rmcp::{
    model::{CallToolRequestParams, CallToolResult, Content},
    object,
};
use serde_json::{Map, Value};
use std::time::Duration;
use tokio::time::{timeout_at, Instant};

use crate::web::client::{rate_limit_domain, DDG_MIN_REQUEST_INTERVAL_MS};
use crate::web::search::{duckduckgo::search_duckduckgo_html, search_web, WebSearchEntry};

use super::{connect_stdio, uses_npx_package, McpServerConfig};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SafeSearch {
    Strict,
    Moderate,
    Off,
}

impl SafeSearch {
    fn html_value(self) -> &'static str {
        match self {
            Self::Strict => "1",
            Self::Moderate => "-1",
            Self::Off => "-2",
        }
    }

    fn python_value(self) -> &'static str {
        match self {
            Self::Strict => "STRICT",
            Self::Moderate => "MODERATE",
            Self::Off => "OFF",
        }
    }
}

pub(super) fn fallback_query<'a>(
    server: &McpServerConfig,
    tool_name: &str,
    args: &'a Map<String, Value>,
) -> Option<(&'a str, usize, SafeSearch)> {
    if tool_name != "duckduckgo_web_search"
        || !uses_npx_package(server, "search", "duckduckgo-mcp-server")
        || !server.env.is_empty()
    {
        return None;
    }
    let safe_search = match args.get("safeSearch") {
        None => SafeSearch::Moderate,
        Some(value) => match value.as_str()? {
            "strict" => SafeSearch::Strict,
            "moderate" => SafeSearch::Moderate,
            "off" => SafeSearch::Off,
            _ => return None,
        },
    };
    let query = args.get("query")?.as_str()?.trim();
    if query.is_empty() || query.encode_utf16().count() > 400 {
        return None;
    }
    let count = match args.get("count") {
        Some(value) => value
            .as_f64()
            .filter(|count| (1.0..=20.0).contains(count))? as usize,
        None => 10,
    };
    Some((query, count, safe_search))
}

pub(super) async fn fallback(
    server: &McpServerConfig,
    tool_name: &str,
    args: &Map<String, Value>,
    deadline: Instant,
) -> Option<CallToolResult> {
    let (query, count, safe_search) = fallback_query(server, tool_name, args)?;
    let direct = search_duckduckgo_html(query.into(), count, safe_search.html_value());
    if let Ok(entries) = timeout_at(deadline, direct).await.ok()? {
        if let Some(result) = web_result(query, "DuckDuckGo HTML", &entries) {
            return Some(result);
        }
    }

    let python_deadline = deadline.min(Instant::now() + Duration::from_secs(30));
    let python = search_with_python(server, query, count, safe_search, python_deadline);
    if let Ok(Some(result)) = timeout_at(python_deadline, python).await {
        return Some(result);
    }

    // Other providers cannot preserve a custom DuckDuckGo SafeSearch level.
    if safe_search != SafeSearch::Moderate || Instant::now() >= deadline {
        return None;
    }
    let search = search_web(
        query.into(),
        Some(count),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    let response = timeout_at(deadline, search).await.ok()?.ok()?;
    web_result(query, &response.sources.join(", "), &response.results)
}

async fn search_with_python(
    server: &McpServerConfig,
    query: &str,
    count: usize,
    safe_search: SafeSearch,
    deadline: Instant,
) -> Option<CallToolResult> {
    // Keep the existing MCP tool name and input schema. uvx is optional.
    let mut provider = server.clone();
    provider.command = "uvx".into();
    provider.args = [
        "--with",
        "duckduckgo-mcp-server[browser]==0.7.0",
        "duckduckgo-mcp-server",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    provider
        .env
        .insert("DDG_SAFE_SEARCH".into(), safe_search.python_value().into());
    // Return usable URLs after this temporary server has been closed.
    provider
        .env
        .insert("DDG_REF_URL_THRESHOLD".into(), "0".into());
    let client = connect_stdio(
        &provider,
        deadline.saturating_duration_since(Instant::now()),
    )
    .await
    .ok()?;
    tokio::task::spawn_blocking(|| {
        rate_limit_domain(
            "html.duckduckgo.com",
            Duration::from_millis(DDG_MIN_REQUEST_INTERVAL_MS),
        );
    })
    .await
    .ok()?;
    let params = CallToolRequestParams::new("search")
        .with_arguments(object!({ "query": query, "max_results": count }));
    let mut client = client.lock().await;
    let result = client.call_tool(params).await;
    let _ = client.close_with_timeout(Duration::from_secs(2)).await;
    let result = result.ok()?;
    if result.is_error == Some(true) {
        return None;
    }
    let text = result.content.iter().find_map(|entry| {
        let text = entry.as_text()?.text.as_str();
        let (found, _) = text
            .strip_prefix("Found ")?
            .split_once(" search results:")?;
        (found.parse::<usize>().ok()? > 0).then_some(text)
    })?;
    Some(CallToolResult::success(vec![Content::text(format!(
        "Results from DuckDuckGo.\n\n{text}"
    ))]))
}

fn web_result(query: &str, sources: &str, entries: &[WebSearchEntry]) -> Option<CallToolResult> {
    if entries.is_empty() {
        return None;
    }
    let entries = entries
        .iter()
        .map(|entry| format!("### {}\n{}\n\n{}", entry.title, entry.url, entry.snippet))
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(CallToolResult::success(vec![Content::text(format!(
        "# Web search results for {query}\n\nResults from {sources}.\n\n{entries}"
    ))]))
}
