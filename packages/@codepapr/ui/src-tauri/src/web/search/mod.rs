use serde::Serialize;

use crate::web::client::{
    build_web_client, cache_search_response, get_cached_search, is_source_cooling_down,
    mark_source_failed, mark_source_ok,
};
use crate::web::text::normalize_search_text;

pub(crate) mod academic;
pub(crate) mod bing;
pub(crate) mod brave;
pub(crate) mod duckduckgo;
pub(crate) mod market;
pub(crate) mod mojeek;
pub(crate) mod qwant;
pub(crate) mod searxng;

pub(crate) const BING_SEARCH_ENDPOINT: &str = "https://api.bing.microsoft.com/v7.0/search";
pub(crate) const WIKIPEDIA_API_ENDPOINT: &str = "https://en.wikipedia.org/w/api.php";
pub(crate) const ARXIV_API_ENDPOINT: &str = "http://export.arxiv.org/api/query";
pub(crate) const OPENALEX_API_ENDPOINT: &str = "https://api.openalex.org/works";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSearchEntry {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) snippet: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSearchResponse {
    pub(crate) query: String,
    #[serde(rename = "abstract")]
    pub(crate) abstract_text: String,
    pub(crate) abstract_url: String,
    pub(crate) results: Vec<WebSearchEntry>,
    /// SearXNG 不可用/返回空，已降级到内置多源聚合
    pub(crate) degraded: bool,
    /// 降级或源失败说明（供 LLM 判断结果可信度）
    pub(crate) note: Option<String>,
    /// 实际贡献了结果的搜索源
    pub(crate) sources: Vec<String>,
}

pub(crate) fn push_unique_search_result(
    results: &mut Vec<WebSearchEntry>,
    candidate: WebSearchEntry,
) {
    if candidate.title.trim().is_empty() || candidate.url.trim().is_empty() {
        return;
    }

    let normalized_url = candidate.url.trim_end_matches('/');
    if results.iter().any(|existing| {
        existing
            .url
            .trim_end_matches('/')
            .eq_ignore_ascii_case(normalized_url)
            || existing.title.eq_ignore_ascii_case(&candidate.title)
    }) {
        return;
    }

    results.push(candidate);
}

/// 将某源的命中合并进总结果（去重、受 max_results 约束），并记录贡献源。
fn merge_source(
    results: &mut Vec<WebSearchEntry>,
    sources: &mut Vec<String>,
    name: &str,
    entries: Vec<WebSearchEntry>,
    max_results: usize,
) {
    let mut contributed = false;
    for entry in entries {
        if results.len() >= max_results {
            break;
        }
        let before = results.len();
        push_unique_search_result(results, entry);
        contributed |= results.len() > before;
    }
    if contributed {
        sources.push(name.to_string());
    }
}

fn contains_explicit_market_symbol(query: &str) -> bool {
    query.split_whitespace().any(|token| {
        let trimmed = token.trim_matches(|ch: char| {
            !ch.is_ascii_alphanumeric() && ch != '.' && ch != '-' && ch != '$'
        });
        let normalized = trimmed.strip_prefix('$').unwrap_or(trimmed);

        !normalized.is_empty()
            && normalized.len() <= 10
            && normalized.chars().any(|ch| ch.is_ascii_alphabetic())
            && normalized
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '.' || ch == '-')
            && (trimmed.starts_with('$') || normalized.contains('.') || normalized.contains('-'))
    })
}

fn is_direct_market_quote_query(query: &str) -> bool {
    let lower = query.to_lowercase();
    const QUOTE_KEYWORDS: &[&str] = &[
        "stock price",
        "share price",
        "current price",
        "live price",
        "market price",
        "ticker",
        "premarket",
        "after hours",
        "exchange rate",
        "forex",
        "股价",
        "现价",
        "行情",
        "最新价",
        "市价",
        "汇率",
        "盘前",
        "盘后",
        "币价",
    ];

    contains_explicit_market_symbol(query)
        || QUOTE_KEYWORDS.iter().any(|keyword| lower.contains(keyword))
}

fn is_finance_like_query(query: &str) -> bool {
    if is_direct_market_quote_query(query) {
        return true;
    }

    let lower = query.to_lowercase();
    const FINANCE_KEYWORDS: &[&str] = &[
        "stock",
        "stocks",
        "market cap",
        "earnings",
        "dividend",
        "etf",
        "index fund",
        "mutual fund",
        "nasdaq",
        "nyse",
        "dow jones",
        "s&p 500",
        "exchange rate",
        "currency pair",
        "crypto",
        "bitcoin",
        "ethereum",
        "bond",
        "treasury",
        "commodity",
        "futures",
        "gold price",
        "silver price",
        "oil price",
        "股票",
        "证券",
        "基金",
        "指数",
        "美股",
        "港股",
        "a股",
        "财报",
        "市值",
        "汇率",
        "加密货币",
        "比特币",
        "以太坊",
        "债券",
        "黄金",
        "白银",
        "原油",
    ];

    FINANCE_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

fn is_academic_query(query: &str) -> bool {
    let lower = query.to_lowercase();
    const ACADEMIC_KEYWORDS: &[&str] = &[
        "paper",
        "research",
        "study",
        "journal",
        "conference",
        "algorithm",
        "deep learning",
        "machine learning",
        "neural network",
        "survey",
        "review",
        "arxiv",
        "doi",
        "citation",
        "dataset",
        "benchmark",
        "state of the art",
        "sota",
        "transformer",
        "attention mechanism",
        "reinforcement learning",
        "natural language processing",
        "nlp",
        "computer vision",
        "diffusion model",
        "large language model",
        "llm",
        "fine tuning",
        "pretraining",
        "论文",
        "研究",
        "学术",
        "文献",
        "期刊",
        "会议",
        "算法",
        "深度学习",
        "机器学习",
        "神经网络",
        "综述",
        "模型",
        "实验",
        "训练",
        "推理",
        "预训练",
        "微调",
        "数据集",
        "基准",
        "transformer",
        "注意力机制",
        "强化学习",
        "自然语言处理",
        "计算机视觉",
        "大语言模型",
        "扩散模型",
    ];

    ACADEMIC_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_web(
    query: String,
    max_results: Option<usize>,
    searxng_enabled: Option<bool>,
    searxng_base_url: Option<String>,
    searxng_categories: Option<String>,
    searxng_time_range: Option<String>,
    searxng_language: Option<String>,
    searxng_safe_search: Option<u8>,
    searxng_engines: Option<String>,
) -> Result<WebSearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let query = query.trim();
        if query.is_empty() {
            return Err("搜索关键词不能为空".to_string());
        }

        let searxng_active = searxng_enabled.unwrap_or(false)
            && searxng_base_url
                .as_deref()
                .map(|url| !url.trim().is_empty())
                .unwrap_or(false);
        let cache_scope = if searxng_active {
            format!(
                "searxng:{}",
                searxng_base_url.as_deref().unwrap_or("").trim()
            )
        } else {
            "builtin".to_string()
        };

        if let Some(cached) = get_cached_search(query, &cache_scope) {
            return Ok(cached);
        }

        let max_results = max_results.unwrap_or(5).clamp(1, 10);
        let client = build_web_client()?;

        let mut degraded = false;
        let mut note: Option<String> = None;

        if searxng_active {
            let base_url = searxng_base_url.as_deref().unwrap_or("").trim().to_string();
            match searxng::collect_searxng_results(
                &client,
                &base_url,
                query,
                max_results,
                searxng_categories.as_deref().unwrap_or(""),
                searxng_time_range.as_deref().unwrap_or(""),
                searxng_language.as_deref().unwrap_or(""),
                searxng_safe_search.unwrap_or(1),
                searxng_engines.as_deref().unwrap_or(""),
            ) {
                Ok((results, abstract_text, abstract_url)) if !results.is_empty() => {
                    let response = WebSearchResponse {
                        query: query.to_string(),
                        abstract_text,
                        abstract_url,
                        results,
                        degraded: false,
                        note: None,
                        sources: vec!["searxng".to_string()],
                    };
                    cache_search_response(query, &cache_scope, &response);
                    return Ok(response);
                }
                Ok(_) => {
                    degraded = true;
                    let msg = "SearXNG 返回空结果，已降级到内置多源聚合".to_string();
                    eprintln!("{msg}");
                    note = Some(msg);
                }
                Err(err) => {
                    degraded = true;
                    let msg = format!("SearXNG 搜索失败，已降级到内置多源聚合: {err}");
                    eprintln!("{msg}");
                    note = Some(msg);
                }
            }
        }

        let mut results = Vec::new();
        let mut sources: Vec<String> = Vec::new();

        let finance_like_query = is_finance_like_query(query);
        let prioritize_market_quote = is_direct_market_quote_query(query);
        let yahoo_results = if finance_like_query {
            market::collect_yahoo_finance_results(&client, query, max_results).unwrap_or_default()
        } else {
            Vec::new()
        };

        if prioritize_market_quote {
            if let Some(entry) = yahoo_results.first() {
                let before = results.len();
                push_unique_search_result(
                    &mut results,
                    WebSearchEntry {
                        title: entry.title.clone(),
                        url: entry.url.clone(),
                        snippet: entry.snippet.clone(),
                    },
                );
                if results.len() > before {
                    sources.push("yahoo".to_string());
                }
            }
        }

        // 主抓取源并行执行：Bing(免key RSS/API) / DuckDuckGo(html→lite) / Brave / Mojeek / Qwant。
        // 冷却中的源（近期失败）直接跳过，避免反复撞限流。
        type SourceOutcome = (&'static str, Result<Vec<WebSearchEntry>, String>);
        let outcomes: Vec<SourceOutcome> = std::thread::scope(|scope| {
            let mut handles: Vec<(
                &'static str,
                std::thread::ScopedJoinHandle<'_, Result<Vec<WebSearchEntry>, String>>,
            )> = Vec::new();

            if !is_source_cooling_down("bing") {
                handles.push((
                    "bing",
                    scope.spawn(|| bing::collect_bing_results(&client, query, max_results)),
                ));
            }
            if !is_source_cooling_down("duckduckgo") {
                handles.push((
                    "duckduckgo",
                    scope.spawn(|| {
                        duckduckgo::collect_duckduckgo_html_results(&client, query, max_results)
                            .or_else(|_| {
                                duckduckgo::collect_duckduckgo_lite_results(
                                    &client,
                                    query,
                                    max_results,
                                )
                            })
                    }),
                ));
            }
            if !is_source_cooling_down("brave") {
                handles.push((
                    "brave",
                    scope.spawn(|| brave::collect_brave_results(&client, query, max_results)),
                ));
            }
            if !is_source_cooling_down("mojeek") {
                handles.push((
                    "mojeek",
                    scope.spawn(|| mojeek::collect_mojeek_results(&client, query, max_results)),
                ));
            }
            if !is_source_cooling_down("qwant") {
                handles.push((
                    "qwant",
                    scope.spawn(|| qwant::collect_qwant_lite_results(&client, query, max_results)),
                ));
            }

            handles
                .into_iter()
                .map(|(name, handle)| {
                    let joined = handle
                        .join()
                        .unwrap_or_else(|_| Err(format!("{name} 搜索线程异常退出")));
                    (name, joined)
                })
                .collect()
        });

        // 按优先级合并：Bing → DuckDuckGo → Brave → Mojeek → Qwant
        for (name, outcome) in outcomes {
            match outcome {
                Ok(entries) if !entries.is_empty() => {
                    mark_source_ok(name);
                    merge_source(&mut results, &mut sources, name, entries, max_results);
                }
                Ok(_) => {
                    mark_source_failed(name);
                    eprintln!("内置搜索源 {name} 返回空结果");
                }
                Err(err) => {
                    mark_source_failed(name);
                    eprintln!("内置搜索源 {name} 失败: {err}");
                }
            }
        }

        if let Ok(wiki_results) = academic::collect_wikipedia_results(&client, query, max_results) {
            merge_source(&mut results, &mut sources, "wikipedia", wiki_results, max_results);
        }

        let academic_query = is_academic_query(query);
        if academic_query && results.len() < max_results {
            if let Ok(arxiv_results) = academic::collect_arxiv_results(&client, query, max_results)
            {
                merge_source(&mut results, &mut sources, "arxiv", arxiv_results, max_results);
            }
        }

        if academic_query && results.len() < max_results {
            if let Ok(openalex_results) =
                academic::collect_openalex_results(&client, query, max_results)
            {
                merge_source(
                    &mut results,
                    &mut sources,
                    "openalex",
                    openalex_results,
                    max_results,
                );
            }
        }

        let mut abstract_text = String::new();
        let mut abstract_url = String::new();
        if let Ok(instant) = duckduckgo::fetch_duckduckgo_instant(&client, query) {
            abstract_text = instant
                .abstract_text
                .as_deref()
                .map(normalize_search_text)
                .unwrap_or_default();
            abstract_url = instant.abstract_url.unwrap_or_default();

            if results.len() < max_results {
                if let Some(topics) = instant.related_topics.as_ref() {
                    let before = results.len();
                    duckduckgo::collect_duckduckgo_related_results(
                        topics,
                        &mut results,
                        max_results,
                    );
                    if results.len() > before {
                        sources.push("duckduckgo-instant".to_string());
                    }
                }
            }
        }

        if finance_like_query {
            let tail: Vec<WebSearchEntry> = yahoo_results
                .into_iter()
                .skip(usize::from(prioritize_market_quote))
                .collect();
            merge_source(&mut results, &mut sources, "yahoo", tail, max_results);
        }

        results.truncate(max_results);
        if results.is_empty() && note.is_none() {
            note = Some("所有搜索源均未返回结果（可能被限流或查询无匹配）".to_string());
        }
        let response = WebSearchResponse {
            query: query.to_string(),
            abstract_text,
            abstract_url,
            results,
            degraded,
            note,
            sources,
        };
        cache_search_response(query, &cache_scope, &response);
        Ok(response)
    })
    .await
    .map_err(|e| format!("搜索失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(title: &str, url: &str) -> WebSearchEntry {
        WebSearchEntry {
            title: title.to_string(),
            url: url.to_string(),
            snippet: String::new(),
        }
    }

    #[test]
    fn push_unique_dedupes_by_normalized_url_and_title() {
        let mut results = Vec::new();
        push_unique_search_result(&mut results, entry("A", "https://example.com/page"));
        push_unique_search_result(&mut results, entry("Different title", "https://example.com/page/"));
        push_unique_search_result(&mut results, entry("a", "https://other.com/x"));
        push_unique_search_result(&mut results, entry("", "https://empty-title.com"));
        push_unique_search_result(&mut results, entry("No url", ""));
        // URL 归一化去重 + 标题大小写不敏感去重；空标题/空 URL 丢弃
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://example.com/page");
    }

    #[test]
    fn merge_source_tracks_contributors_and_cap() {
        let mut results = Vec::new();
        let mut sources = Vec::new();
        merge_source(
            &mut results,
            &mut sources,
            "bing",
            vec![entry("A", "https://a.com"), entry("B", "https://b.com")],
            10,
        );
        merge_source(&mut results, &mut sources, "brave", vec![entry("A", "https://a.com")], 10);
        merge_source(
            &mut results,
            &mut sources,
            "mojeek",
            vec![entry("C", "https://c.com")],
            2,
        );
        assert_eq!(results.len(), 2);
        assert_eq!(sources, vec!["bing".to_string()]);
    }
}
