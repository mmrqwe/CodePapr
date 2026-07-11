use rmcp::{
    transport::streamable_http_client::{
        StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
    },
    ServiceExt,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: test_mcp_connect <url> [token]");
        std::process::exit(1);
    }

    let url = args[1].trim().to_string();
    let token = args.get(2).map(|t| t.trim().to_string());
    let timeout = Duration::from_secs(30);

    eprintln!("Connecting to: {url}");
    if let Some(ref t) = token {
        if !t.is_empty() {
            eprintln!("With auth token: {}...", &t[..t.len().min(8)]);
        }
    }

    let url_arc: Arc<str> = Arc::from(url.as_str());
    let mut config = StreamableHttpClientTransportConfig::with_uri(url_arc);

    if let Some(ref t) = token {
        if !t.is_empty() {
            let mut headers = HashMap::new();
            let val = reqwest::header::HeaderValue::from_str(&format!("Bearer {t}"))
                .expect("valid header value");
            headers.insert(reqwest::header::AUTHORIZATION, val);
            config = config.custom_headers(headers);
        }
    }

    let transport = StreamableHttpClientTransport::from_config(config);

    eprintln!("Initializing...");
    match tokio::time::timeout(timeout, ().serve(transport)).await {
        Ok(Ok(running_service)) => {
            eprintln!("Connected successfully!");

            let mut client = running_service;

            eprintln!("Listing tools...");
            match tokio::time::timeout(Duration::from_secs(15), client.list_tools(None)).await {
                Ok(Ok(tools)) => {
                    let tools = tools.tools;
                    eprintln!("Found {} tools:", tools.len());
                    for tool in &tools {
                        let desc = tool
                            .description
                            .as_deref()
                            .unwrap_or("(no description)");
                        eprintln!("  - {}: {:.80}", tool.name, desc);
                    }
                    std::process::exit(0);
                }
                Ok(Err(e)) => {
                    eprintln!("list_tools error: {e}");
                    std::process::exit(2);
                }
                Err(_) => {
                    eprintln!("list_tools timed out");
                    std::process::exit(3);
                }
            }
        }
        Ok(Err(e)) => {
            eprintln!("Init error: {e}");
            std::process::exit(2);
        }
        Err(_) => {
            eprintln!("Init timed out");
            std::process::exit(3);
        }
    }
}
