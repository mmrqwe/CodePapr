use serde::Serialize;

use crate::web::client::{build_web_client, cache_search_response, get_cached_search};
use crate::web::text::normalize_search_text;

pub(crate) mod academic;
pub(crate) mod bing;
pub(crate) mod duckduckgo;
pub(crate) mod market;
pub(crate) mod mojeek;
pub(crate) mod qwant;
pub(crate) mod searxng;

pub(crate) const BING_SEARCH_ENDPOINT: &str = "https://api.bing.microsoft.com/v7.0/search";
pub(crate) const WIKIPEDIA_API_ENDPOINT: &str = "https://en.wikipedia.org/w/api.php";
pub(crate) const ARXIV_API_ENDPOINT: &str = "http://export.arxiv.org/api/query";
pub(crate) const OPENALEX_API_ENDPOINT: &str = "https://api.openalex.org/works";

#[derive(Clone, Serialize)]
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

        if let Some(cached) = get_cached_search(query) {
            return Ok(cached);
        }

        let max_results = max_results.unwrap_or(5).clamp(1, 10);
        let client = build_web_client()?;

        if searxng_enabled.unwrap_or(false) {
            if let Some(ref base_url) = searxng_base_url {
                if !base_url.trim().is_empty() {
                    match searxng::collect_searxng_results(
                        &client,
                        base_url.trim(),
                        query,
                        max_results,
                        searxng_categories.as_deref().unwrap_or(""),
                        searxng_time_range.as_deref().unwrap_or(""),
                        searxng_language.as_deref().unwrap_or(""),
                        searxng_safe_search.unwrap_or(1),
                        searxng_engines.as_deref().unwrap_or(""),
                    ) {
                        Ok((results, abstract_text, abstract_url)) => {
                            let response = WebSearchResponse {
                                query: query.to_string(),
                                abstract_text,
                                abstract_url,
                                results,
                            };
                            cache_search_response(query, &response);
                            return Ok(response);
                        }
                        Err(err) => {
                            eprintln!("SearXNG 搜索失败，降级到内置多源聚合: {err}");
                        }
                    }
                }
            }
        }

        let mut results = Vec::new();
        let finance_like_query = is_finance_like_query(query);
        let prioritize_market_quote = is_direct_market_quote_query(query);
        let yahoo_results = if finance_like_query {
            market::collect_yahoo_finance_results(&client, query, max_results).unwrap_or_default()
        } else {
            Vec::new()
        };

        if prioritize_market_quote {
            if let Some(entry) = yahoo_results.first() {
                push_unique_search_result(
                    &mut results,
                    WebSearchEntry {
                        title: entry.title.clone(),
                        url: entry.url.clone(),
                        snippet: entry.snippet.clone(),
                    },
                );
            }
        }

        if let Ok(bing_results) = bing::collect_bing_results(&client, query, max_results) {
            for entry in bing_results {
                if results.len() >= max_results {
                    break;
                }
                push_unique_search_result(&mut results, entry);
            }
        }

        let duck_html_outcome =
            duckduckgo::collect_duckduckgo_html_results(&client, query, max_results);
        let duck_html_failed = match &duck_html_outcome {
            Ok(list) => list.is_empty(),
            Err(_) => true,
        };
        if let Ok(duck_results) = duck_html_outcome {
            for entry in duck_results {
                if results.len() >= max_results {
                    break;
                }
                push_unique_search_result(&mut results, entry);
            }
        }

        if duck_html_failed && results.len() < max_results {
            if let Ok(lite_results) =
                duckduckgo::collect_duckduckgo_lite_results(&client, query, max_results)
            {
                for entry in lite_results {
                    if results.len() >= max_results {
                        break;
                    }
                    push_unique_search_result(&mut results, entry);
                }
            }
        }

        if results.len() < max_results {
            if let Ok(mojeek_results) = mojeek::collect_mojeek_results(&client, query, max_results)
            {
                for entry in mojeek_results {
                    if results.len() >= max_results {
                        break;
                    }
                    push_unique_search_result(&mut results, entry);
                }
            }
        }

        if results.len() < max_results {
            if let Ok(qwant_results) =
                qwant::collect_qwant_lite_results(&client, query, max_results)
            {
                for entry in qwant_results {
                    if results.len() >= max_results {
                        break;
                    }
                    push_unique_search_result(&mut results, entry);
                }
            }
        }

        if let Ok(wiki_results) = academic::collect_wikipedia_results(&client, query, max_results) {
            for entry in wiki_results {
                if results.len() >= max_results {
                    break;
                }
                push_unique_search_result(&mut results, entry);
            }
        }

        let academic_query = is_academic_query(query);
        if academic_query && results.len() < max_results {
            if let Ok(arxiv_results) = academic::collect_arxiv_results(&client, query, max_results)
            {
                for entry in arxiv_results {
                    if results.len() >= max_results {
                        break;
                    }
                    push_unique_search_result(&mut results, entry);
                }
            }
        }

        if academic_query && results.len() < max_results {
            if let Ok(openalex_results) =
                academic::collect_openalex_results(&client, query, max_results)
            {
                for entry in openalex_results {
                    if results.len() >= max_results {
                        break;
                    }
                    push_unique_search_result(&mut results, entry);
                }
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
                    duckduckgo::collect_duckduckgo_related_results(
                        topics,
                        &mut results,
                        max_results,
                    );
                }
            }
        }

        if finance_like_query {
            for entry in yahoo_results
                .into_iter()
                .skip(usize::from(prioritize_market_quote))
            {
                if results.len() >= max_results {
                    break;
                }
                push_unique_search_result(&mut results, entry);
            }
        }

        results.truncate(max_results);
        let response = WebSearchResponse {
            query: query.to_string(),
            abstract_text,
            abstract_url,
            results,
        };
        cache_search_response(query, &response);
        Ok(response)
    })
    .await
    .map_err(|e| format!("搜索失败: {e}"))?
}
