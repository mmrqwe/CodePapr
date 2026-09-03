use crate::rpc_client::RpcClient;
use serde_json::json;
use std::time::Instant;

pub async fn run(client: &RpcClient, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let start = Instant::now();
    let res = client.call("ping", json!({})).await?;
    let elapsed = start.elapsed();
    let latency_ms = elapsed.as_secs_f64() * 1000.0;

    if json_mode {
        println!("{}", serde_json::to_string_pretty(&json!({
            "status": res,
            "latencyMs": (latency_ms * 100.0).round() / 100.0,
        }))?);
    } else {
        println!("Server response: {} (latency: {:.2}ms)", res, latency_ms);
    }

    Ok(())
}
