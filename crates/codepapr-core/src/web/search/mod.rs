use serde::Serialize;

use crate::web::client::{
    build_web_client, cache_search_response, get_cached_search, is_source_cooling_down,
    mark_source_empty, mark_source_failed, mark_source_ok,
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

pub use searxng::{probe_searxng, SearxngProbeResult};

pub(crate) const BING_SEARCH_ENDPOINT: &str = "https://api.bing.microsoft.com/v7.0/search";
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
pub struct WebSearchResponse {
    pub(crate) query: String,
    #[serde(rename = "abstract")]
    pub(crate) abstract_text: String,
    pub(crate) abstract_url: String,
    pub(crate) results: Vec<WebSearchEntry>,
    /// 结果质量降级：SearXNG 不可用/返回空而改用内置聚合，或全部搜索源空手而归。
    /// 恒与 note 同现（degraded=true ⇒ note=Some），note 附带核验建议。
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

// ── 相关性闸门（内置聚合专用） ──────────────────────────────────────────

/// 把 query 切成打分 token：拉丁词（≥2 字符）+ CJK 连续段的二元组。
/// 中文没有空格分词，二元组是对 CJK 查询最稳健的轻量近似。
fn tokenize_query(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut tokens: Vec<String> = Vec::new();
    let mut latin = String::new();
    let mut cjk_run: Vec<char> = Vec::new();

    let flush_latin = |latin: &mut String, tokens: &mut Vec<String>| {
        if latin.chars().count() >= 2 {
            tokens.push(std::mem::take(latin));
        } else {
            latin.clear();
        }
    };
    let flush_cjk = |cjk_run: &mut Vec<char>, tokens: &mut Vec<String>| {
        if cjk_run.len() == 1 {
            tokens.push(cjk_run[0].to_string());
        } else {
            for pair in cjk_run.windows(2) {
                tokens.push(pair.iter().collect());
            }
        }
        cjk_run.clear();
    };

    for ch in lower.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            flush_latin(&mut latin, &mut tokens);
            cjk_run.push(ch);
        } else if ch.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk_run, &mut tokens);
            latin.push(ch);
        } else {
            flush_latin(&mut latin, &mut tokens);
            flush_cjk(&mut cjk_run, &mut tokens);
        }
    }
    flush_latin(&mut latin, &mut tokens);
    flush_cjk(&mut cjk_run, &mut tokens);

    tokens.sort();
    tokens.dedup();
    tokens
}

/// 轻量相关性分：标题命中 token 计 2 分，摘要命中计 1 分。
fn entry_relevance(tokens: &[String], entry: &WebSearchEntry) -> usize {
    if tokens.is_empty() {
        return 1;
    }
    let title = entry.title.to_lowercase();
    let snippet = entry.snippet.to_lowercase();
    let mut score = 0usize;
    for token in tokens {
        if title.contains(token.as_str()) {
            score += 2;
        } else if snippet.contains(token.as_str()) {
            score += 1;
        }
    }
    score
}

/// URL 的粗略域名键（host 去 www 前缀）。取末两段近似主域，
/// 不引 pubsuffix；对「同域刷屏」的抑制足够。
fn domain_key(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest)?;
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()?
        .rsplit('@')
        .next()?
        .trim()
        .to_lowercase();
    if host.is_empty() {
        return None;
    }
    let segments: Vec<&str> = host.split('.').filter(|s| !s.is_empty()).collect();
    Some(if segments.len() <= 2 {
        host
    } else {
        segments[segments.len() - 2..].join(".")
    })
}

/// 内置聚合的通用网页源打分排序：分数降序、同分保持源优先级稳定序。
/// 存在正分结果时，0 分（标题+摘要与 query 无任何 token 重叠）结果被丢弃，
/// 让位给更可信的百科/学术源；正分不足时 0 分结果仍参与填充，避免空结果。
fn rank_generic_entries(
    tokens: &[String],
    outcomes: Vec<(&'static str, Vec<WebSearchEntry>)>,
) -> (Vec<(&'static str, WebSearchEntry)>, Vec<(&'static str, WebSearchEntry)>) {
    let mut pool: Vec<(usize, usize, &'static str, WebSearchEntry)> = Vec::new();
    let mut order = 0usize;
    for (name, entries) in outcomes {
        for entry in entries {
            let score = entry_relevance(tokens, &entry);
            pool.push((score, order, name, entry));
            order += 1;
        }
    }
    pool.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let has_strong = pool.first().is_some_and(|(score, ..)| *score > 0);
    let mut strong: Vec<(&'static str, WebSearchEntry)> = Vec::new();
    let mut weak: Vec<(&'static str, WebSearchEntry)> = Vec::new();
    for (score, _, name, entry) in pool {
        if has_strong && score == 0 {
            continue;
        }
        if score == 0 {
            weak.push((name, entry));
        } else {
            strong.push((name, entry));
        }
    }
    (strong, weak)
}

/// 按排序后的候选池合并结果：去重 + 同域名上限 + max_results 截断。
fn merge_ranked_pool(
    results: &mut Vec<WebSearchEntry>,
    sources: &mut Vec<String>,
    pool: &[(&'static str, WebSearchEntry)],
    domain_counts: &mut std::collections::HashMap<String, usize>,
    max_results: usize,
) {
    const DOMAIN_CAP: usize = 2;
    for (name, entry) in pool {
        if results.len() >= max_results {
            return;
        }
        let key = domain_key(&entry.url);
        if let Some(key) = &key {
            if domain_counts.get(key).copied().unwrap_or(0) >= DOMAIN_CAP {
                continue;
            }
        }
        let before = results.len();
        push_unique_search_result(results, (*entry).clone());
        if results.len() > before {
            if let Some(key) = key {
                *domain_counts.entry(key).or_insert(0) += 1;
            }
            if !sources.iter().any(|s| s == name) {
                sources.push((*name).to_string());
            }
        }
    }
}

fn query_has_cjk(query: &str) -> bool {
    query
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

/// 内置路径的 Wikipedia 语言选择：显式语言偏好（zh*）优先，其次按查询脚本。
fn pick_wikipedia_language(query: &str, preferred: Option<&str>) -> &'static str {
    if preferred.is_some_and(|lang| lang.trim().to_lowercase().starts_with("zh")) {
        return "zh";
    }
    if query_has_cjk(query) {
        return "zh";
    }
    "en"
}

fn push_note(note: &mut Option<String>, msg: impl Into<String>) {
    match note {
        Some(existing) => {
            let msg = msg.into();
            if !existing.contains(&msg) {
                existing.push('；');
                existing.push_str(&msg);
            }
        }
        None => *note = Some(msg.into()),
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

#[allow(clippy::too_many_arguments)]
pub async fn search_web(
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
    tokio::task::spawn_blocking(move || {
        search_web_impl(
            query,
            max_results,
            searxng_enabled,
            searxng_base_url,
            searxng_categories,
            searxng_time_range,
            searxng_language,
            searxng_safe_search,
            searxng_engines,
        )
    })
    .await
    .map_err(|e| format!("搜索失败: {e}"))?
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn search_web_impl(
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
        let query = query.trim();
        if query.is_empty() {
            return Err("搜索关键词不能为空".to_string());
        }

        let searxng_active = searxng_enabled.unwrap_or(false)
            && searxng_base_url
                .as_deref()
                .map(|url| !url.trim().is_empty())
                .unwrap_or(false);
        let max_results = max_results.unwrap_or(5).clamp(1, 10);

        // W1：SearXNG 未启用时分类/时间/语言/安全搜索参数无效，必须显式告知，
        // 否则 Agent 会误以为过滤生效。
        let searxng_params_ignored = !searxng_active
            && (searxng_categories.as_deref().is_some_and(|v| !v.trim().is_empty())
                || searxng_time_range.as_deref().is_some_and(|v| !v.trim().is_empty())
                || searxng_language.as_deref().is_some_and(|v| !v.trim().is_empty())
                || searxng_safe_search.is_some_and(|v| v != 1));

        // 缓存 key 必须纳入所有影响结果的参数，且全部先归一化（clamp/trim/lowercase），
        // 否则用户改参数后 TTL 内仍会命中旧结果
        let mut cache_key = format!(
            "{}\u{1f}{max_results}\u{1f}{}",
            if searxng_active {
                format!(
                    "searxng:{}",
                    searxng_base_url.as_deref().unwrap_or("").trim()
                )
            } else if searxng_params_ignored {
                // 带「参数被忽略」note 的结果与纯净结果分开缓存，避免互相污染
                "builtin+ignored".to_string()
            } else {
                "builtin".to_string()
            },
            query.to_lowercase()
        );
        if searxng_active {
            cache_key.push_str(&format!(
                "\u{1f}{categories}\u{1f}{time_range}\u{1f}{language}\u{1f}{safe_search}\u{1f}{engines}",
                categories = searxng_categories.as_deref().unwrap_or("").trim().to_lowercase(),
                time_range = searxng_time_range.as_deref().unwrap_or("").trim().to_lowercase(),
                language = searxng_language.as_deref().unwrap_or("").trim().to_lowercase(),
                safe_search = searxng_safe_search.unwrap_or(1),
                engines = searxng_engines.as_deref().unwrap_or("").trim().to_lowercase(),
            ));
        }

        if let Some(cached) = get_cached_search(&cache_key) {
            return Ok(cached);
        }

        let client = build_web_client()?;

        let mut degraded = false;
        let mut note: Option<String> = None;
        if searxng_params_ignored {
            push_note(
                &mut note,
                "SearXNG 未启用，本次已忽略分类/时间范围/语言/安全搜索等 SearXNG 专属参数，仅执行通用网页聚合搜索",
            );
        }

        if searxng_active {
            let base_url = searxng_base_url.as_deref().unwrap_or("").trim().to_string();
            match searxng::collect_searxng_results(
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
                    cache_search_response(&cache_key, &response);
                    return Ok(response);
                }
                Ok(_) => {
                    degraded = true;
                    let msg = "SearXNG 返回空结果，已降级到内置多源聚合";
                    eprintln!("{msg}");
                    push_note(&mut note, msg);
                }
                Err(err) => {
                    degraded = true;
                    let msg = format!("SearXNG 搜索失败，已降级到内置多源聚合: {err}");
                    eprintln!("{msg}");
                    push_note(&mut note, msg);
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

        // 相关性闸门（W2）：通用网页源不再按源优先级 FIFO 占坑，
        // 而是按 title+snippet 与 query 的 token 重叠打分排序，
        // 并在同一域名上设上限，避免单站刷屏把弱相关结果顶进 maxResults。
        let mut generic_outcomes: Vec<(&'static str, Vec<WebSearchEntry>)> = Vec::new();
        for (name, outcome) in outcomes {
            match outcome {
                Ok(entries) if !entries.is_empty() => {
                    mark_source_ok(name);
                    generic_outcomes.push((name, entries));
                }
                Ok(_) => {
                    // 合法 0 命中不是源故障：只进极短冷却，避免冷门查询拖死后续热门查询
                    mark_source_empty(name);
                    eprintln!("内置搜索源 {name} 返回空结果");
                }
                Err(err) => {
                    mark_source_failed(name);
                    eprintln!("内置搜索源 {name} 失败: {err}");
                }
            }
        }

        let query_tokens = tokenize_query(query);
        let (strong_entries, weak_entries) = rank_generic_entries(&query_tokens, generic_outcomes);
        let mut domain_counts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        merge_ranked_pool(&mut results, &mut sources, &strong_entries, &mut domain_counts, max_results);
        if results.len() < max_results {
            merge_ranked_pool(&mut results, &mut sources, &weak_entries, &mut domain_counts, max_results);
        }

        let wiki_lang = pick_wikipedia_language(query, searxng_language.as_deref());
        if let Ok(wiki_results) =
            academic::collect_wikipedia_results(&client, query, max_results, wiki_lang)
        {
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
        // degraded 不变式：结果为空（内置全挂）也视为降级；degraded 必须带 note，
        // 并提示 Agent 用 web_fetch_url 核验，避免静默采信弱相关结果。
        if results.is_empty() {
            degraded = true;
            push_note(&mut note, "所有搜索源均未返回结果（可能被限流或查询无匹配）");
        }
        if degraded {
            push_note(&mut note, "搜索结果可能不完整或不准确，关键事实请用 web_fetch_url 抓取原文核验");
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
        // 降级结果不缓存：否则 TTL 内即使 SearXNG 恢复也会一直命中降级旧结果
        if !degraded {
            cache_search_response(&cache_key, &response);
        }
        Ok(response)
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

    fn entry_snippet(title: &str, url: &str, snippet: &str) -> WebSearchEntry {
        WebSearchEntry {
            title: title.to_string(),
            url: url.to_string(),
            snippet: snippet.to_string(),
        }
    }

    #[test]
    fn tokenize_splits_latin_words_and_cjk_bigrams() {
        let latin = tokenize_query("Rust async runtime");
        assert!(latin.contains(&"rust".to_string()));
        assert!(latin.contains(&"async".to_string()));
        assert!(latin.contains(&"runtime".to_string()));
        // 单字符 token 被丢弃
        assert!(!latin.contains(&"a".to_string()));

        let cjk = tokenize_query("深度学习");
        assert!(cjk.contains(&"深度".to_string()));
        assert!(cjk.contains(&"度学".to_string()));
        assert!(cjk.contains(&"学习".to_string()));
    }

    #[test]
    fn entry_relevance_scores_title_and_snippet_overlap() {
        let tokens = tokenize_query("rust borrow checker");
        let strong = entry_snippet(
            "The Rust Borrow Checker",
            "https://x.com",
            "borrow checking explained",
        );
        let weak = entry_snippet("Totally unrelated page", "https://y.com", "no match here");
        assert!(entry_relevance(&tokens, &strong) > entry_relevance(&tokens, &weak));
        assert_eq!(entry_relevance(&tokens, &weak), 0);
    }

    #[test]
    fn domain_key_extracts_registrable_host() {
        assert_eq!(domain_key("https://www.example.com/a/b").as_deref(), Some("example.com"));
        assert_eq!(domain_key("https://sub.blog.co.uk/x").as_deref(), Some("co.uk"));
        assert_eq!(domain_key("https://a.com").as_deref(), Some("a.com"));
        assert_eq!(domain_key("not a url").as_deref(), None);
    }

    #[test]
    fn rank_generic_entries_orders_by_score_and_keeps_source_priority() {
        let tokens = tokenize_query("rust ownership");
        // bing 先返回一个弱相关；brave 后返回一个强相关 → 强相关必须排前
        let outcomes = vec![
            (
                "bing",
                vec![entry_snippet("Random news", "https://news.com", "nothing relevant")],
            ),
            (
                "brave",
                vec![entry_snippet("Rust Ownership System", "https://rust-lang.org", "ownership and borrowing")],
            ),
        ];
        let (strong, weak) = rank_generic_entries(&tokens, outcomes);
        assert!(weak.is_empty(), "存在正分结果时 0 分结果应被丢弃");
        assert_eq!(strong.len(), 1);
        assert_eq!(strong[0].1.url, "https://rust-lang.org");
    }

    #[test]
    fn rank_generic_entries_keeps_all_zero_scores_when_no_strong_match() {
        let tokens = tokenize_query("quantum flutation");
        let outcomes = vec![(
            "bing",
            vec![
                entry_snippet("A", "https://a.com", "x"),
                entry_snippet("B", "https://b.com", "y"),
            ],
        )];
        let (strong, weak) = rank_generic_entries(&tokens, outcomes);
        assert!(strong.is_empty());
        assert_eq!(weak.len(), 2, "无正分结果时 0 分结果需保留用于填充");
    }

    #[test]
    fn merge_ranked_pool_caps_same_domain() {
        let tokens = tokenize_query("query");
        let outcomes = vec![(
            "bing",
            (0..5)
                .map(|i| entry_snippet(&format!("query page {i}"), &format!("https://same.com/p{i}"), "query"))
                .collect::<Vec<_>>(),
        )];
        let (ranked, _) = rank_generic_entries(&tokens, outcomes);
        let mut results = Vec::new();
        let mut sources = Vec::new();
        let mut counts = std::collections::HashMap::new();
        merge_ranked_pool(&mut results, &mut sources, &ranked, &mut counts, 10);
        assert_eq!(results.len(), 2, "同域名最多保留 2 条");
        assert_eq!(sources, vec!["bing".to_string()]);
    }

    #[test]
    fn pick_wikipedia_language_prefers_zh_for_cjk_and_explicit_zh() {
        assert_eq!(pick_wikipedia_language("深度学习", None), "zh");
        assert_eq!(pick_wikipedia_language("machine learning", Some("zh-CN")), "zh");
        assert_eq!(pick_wikipedia_language("machine learning", None), "en");
        assert_eq!(pick_wikipedia_language("machine learning", Some("en")), "en");
    }
}
