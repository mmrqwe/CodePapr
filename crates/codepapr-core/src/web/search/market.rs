use std::collections::HashMap;

use serde::Deserialize;

use super::{push_unique_search_result, WebSearchEntry};

#[derive(Deserialize)]
pub(crate) struct YahooFinanceSearchResponse {
    pub(crate) quotes: Option<Vec<YahooFinanceSearchQuote>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YahooFinanceSearchQuote {
    pub(crate) symbol: Option<String>,
    pub(crate) shortname: Option<String>,
    pub(crate) longname: Option<String>,
    pub(crate) exch_disp: Option<String>,
    pub(crate) type_disp: Option<String>,
    pub(crate) quote_type: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct YahooFinanceQuoteResponse {
    #[serde(rename = "quoteResponse")]
    pub(crate) quote_response: YahooFinanceQuoteContainer,
}

#[derive(Deserialize)]
pub(crate) struct YahooFinanceQuoteContainer {
    pub(crate) result: Vec<YahooFinanceQuoteItem>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YahooFinanceQuoteItem {
    pub(crate) symbol: Option<String>,
    pub(crate) regular_market_price: Option<f64>,
    pub(crate) regular_market_change_percent: Option<f64>,
    pub(crate) currency: Option<String>,
    pub(crate) market_state: Option<String>,
    pub(crate) full_exchange_name: Option<String>,
    pub(crate) exchange: Option<String>,
}

fn yahoo_quote_page_url(symbol: &str) -> String {
    let mut url = reqwest::Url::parse("https://finance.yahoo.com/quote/")
        .expect("static Yahoo Finance quote URL must be valid");
    url.path_segments_mut()
        .expect("static Yahoo Finance quote URL must have mutable segments")
        .pop_if_empty()
        .push(symbol);
    url.to_string()
}

fn fetch_yahoo_finance_quote_map(
    client: &reqwest::blocking::Client,
    symbols: &[String],
) -> Result<HashMap<String, YahooFinanceQuoteItem>, String> {
    if symbols.is_empty() {
        return Ok(HashMap::new());
    }

    let mut search_url = reqwest::Url::parse("https://query1.finance.yahoo.com/v7/finance/quote")
        .map_err(|err| format!("Yahoo Finance quote URL 构造失败: {err}"))?;
    search_url
        .query_pairs_mut()
        .append_pair("symbols", &symbols.join(","));

    let response = client
        .get(search_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|err| format!("Yahoo Finance quote 查询失败: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Yahoo Finance quote 查询失败: HTTP {status}"));
    }

    let text = response
        .text()
        .map_err(|err| format!("读取 Yahoo Finance quote 结果失败: {err}"))?;
    let payload = serde_json::from_str::<YahooFinanceQuoteResponse>(&text)
        .map_err(|err| format!("解析 Yahoo Finance quote 结果失败: {err}"))?;

    Ok(payload
        .quote_response
        .result
        .into_iter()
        .filter_map(|item| item.symbol.clone().map(|symbol| (symbol, item)))
        .collect())
}

fn format_market_price(price: f64) -> String {
    let decimals = if price.abs() >= 1.0 { 2 } else { 4 };
    format!("{:.*}", decimals, price)
}

pub(crate) fn collect_yahoo_finance_results(
    client: &reqwest::blocking::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchEntry>, String> {
    let yahoo_limit = max_results.clamp(1, 8);
    let mut search_url = reqwest::Url::parse("https://query1.finance.yahoo.com/v1/finance/search")
        .map_err(|err| format!("Yahoo Finance 搜索 URL 构造失败: {err}"))?;
    {
        let mut pairs = search_url.query_pairs_mut();
        pairs.append_pair("q", query);
        pairs.append_pair("lang", "en-US");
        pairs.append_pair("region", "US");
        pairs.append_pair("quotesCount", &yahoo_limit.to_string());
        pairs.append_pair("newsCount", "0");
    }

    let response = client
        .get(search_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|err| format!("Yahoo Finance 搜索失败: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Yahoo Finance 搜索失败: HTTP {status}"));
    }

    let text = response
        .text()
        .map_err(|err| format!("读取 Yahoo Finance 搜索结果失败: {err}"))?;
    let payload = serde_json::from_str::<YahooFinanceSearchResponse>(&text)
        .map_err(|err| format!("解析 Yahoo Finance 搜索结果失败: {err}"))?;
    let quotes = payload.quotes.unwrap_or_default();
    let symbols: Vec<String> = quotes
        .iter()
        .filter_map(|quote| quote.symbol.clone())
        .take(yahoo_limit)
        .collect();
    let quote_map = fetch_yahoo_finance_quote_map(client, &symbols).unwrap_or_default();

    let mut results = Vec::new();
    for quote in quotes.into_iter() {
        if results.len() >= max_results {
            break;
        }

        let Some(symbol) = quote.symbol.filter(|value| !value.trim().is_empty()) else {
            continue;
        };

        let display_name = quote
            .longname
            .or(quote.shortname)
            .unwrap_or_else(|| symbol.clone());
        let mut snippet_parts = Vec::new();

        if let Some(exchange) = quote
            .exch_disp
            .clone()
            .or(quote.type_disp.clone())
            .filter(|value| !value.trim().is_empty())
        {
            snippet_parts.push(exchange);
        }

        if let Some(market) = quote_map.get(&symbol) {
            if let Some(price) = market.regular_market_price {
                let currency = market
                    .currency
                    .as_deref()
                    .map(|value| format!(" {value}"))
                    .unwrap_or_default();
                snippet_parts.push(format!("现价 {}{currency}", format_market_price(price)));
            }
            if let Some(change) = market.regular_market_change_percent {
                snippet_parts.push(format!("{change:+.2}%"));
            }
            if let Some(state) = market
                .market_state
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                snippet_parts.push(state.to_string());
            }
            if snippet_parts.is_empty() {
                if let Some(exchange_name) = market
                    .full_exchange_name
                    .as_deref()
                    .or(market.exchange.as_deref())
                    .filter(|value| !value.trim().is_empty())
                {
                    snippet_parts.push(exchange_name.to_string());
                }
            }
        }

        if snippet_parts.is_empty() {
            if let Some(kind) = quote.quote_type.filter(|value| !value.trim().is_empty()) {
                snippet_parts.push(kind);
            }
        }

        push_unique_search_result(
            &mut results,
            WebSearchEntry {
                title: format!("{display_name} ({symbol})"),
                url: yahoo_quote_page_url(&symbol),
                snippet: snippet_parts.join(" | "),
            },
        );
    }

    Ok(results)
}
