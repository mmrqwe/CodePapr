use rmcp::{
    model::CallToolRequestParams,
    transport::streamable_http_client::{
        StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
    },
    ServiceExt,
};
use serde_json::Map;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: test_mcp_full <url> [tool_name] [tool_args_json]");
        eprintln!("Example: test_mcp_full http://127.0.0.1:18999/mcp add '{{\"a\":3,\"b\":4}}'");
        std::process::exit(1);
    }

    let url = args[1].trim().to_string();
    let timeout = Duration::from_secs(30);

    println!(">>> Connecting to: {url}");
    let url_arc: Arc<str> = Arc::from(url.as_str());
    let config = StreamableHttpClientTransportConfig::with_uri(url_arc);
    let transport = StreamableHttpClientTransport::from_config(config);

    let running_service = match tokio::time::timeout(timeout, ().serve(transport)).await {
        Ok(Ok(svc)) => svc,
        Ok(Err(e)) => {
            println!("FAIL: Init error: {e}");
            std::process::exit(2);
        }
        Err(_) => {
            println!("FAIL: Init timed out");
            std::process::exit(3);
        }
    };

    let client = running_service;
    println!(">>> Initialized.");

    // List tools
    match tokio::time::timeout(Duration::from_secs(15), client.list_tools(None)).await {
        Ok(Ok(result)) => {
            println!(">>> Found {} tools:", result.tools.len());
            for t in &result.tools {
                let desc = t.description.as_deref().unwrap_or("(no desc)");
                println!("      - {}: {}", t.name, desc);
            }
        }
        Ok(Err(e)) => {
            println!("FAIL: list_tools: {e}");
            std::process::exit(2);
        }
        Err(_) => {
            println!("FAIL: list_tools timeout");
            std::process::exit(3);
        }
    }

    // Call tool if specified
    if args.len() >= 3 {
        let tool_name = &args[2];
        let tool_args: Map<String, serde_json::Value> = if args.len() >= 4 {
            serde_json::from_str(&args[3]).unwrap_or_default()
        } else {
            Map::new()
        };

        println!(">>> Calling tool '{}' with args: {:?}", tool_name, tool_args);

        let params = CallToolRequestParams::new(tool_name.clone())
            .with_arguments(tool_args);

        match tokio::time::timeout(Duration::from_secs(30), client.call_tool(params)).await {
            Ok(Ok(result)) => {
                if result.is_error.unwrap_or(false) {
                    println!("FAIL: tool returned error");
                    for c in &result.content {
                        println!("      {c:?}");
                    }
                    std::process::exit(2);
                } else {
                    println!(">>> Tool result:");
                    for c in &result.content {
                        println!("      {c:?}");
                    }
                    println!(">>> SUCCESS");
                }
            }
            Ok(Err(e)) => {
                println!("FAIL: call_tool error: {e}");
                std::process::exit(2);
            }
            Err(_) => {
                println!("FAIL: call_tool timeout");
                std::process::exit(3);
            }
        }
    } else {
        println!(">>> SUCCESS (no tool call requested)");
    }
}
