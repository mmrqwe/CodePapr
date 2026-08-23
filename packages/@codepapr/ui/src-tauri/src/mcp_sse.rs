//! Legacy MCP HTTP+SSE client (2024-11-05). rmcp 1.7 removed SseClientTransport;
//! this reimplements the handshake so `transport=sse` still works.

use std::{future::Future, io, sync::Arc, time::Duration};

use futures_util::StreamExt;
use rmcp::{
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
    RoleClient, ServiceExt,
};
use tokio::sync::mpsc;

use super::{McpServerConfig, SharedMcpClient};

pub async fn connect_sse(
    server: &McpServerConfig,
    timeout: Duration,
) -> Result<SharedMcpClient, String> {
    if server.url.trim().is_empty() {
        return Err("MCP sse url is required".to_string());
    }

    let http = reqwest::Client::builder()
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;
    let sse_url = server.url.trim().to_string();
    let headers = server.headers.clone();

    let mut request = http
        .get(&sse_url)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::CACHE_CONTROL, "no-cache");
    for (key, value) in &headers {
        if !key.trim().is_empty() {
            request = request.header(key.as_str(), value.as_str());
        }
    }

    let response = tokio::time::timeout(timeout, request.send())
        .await
        .map_err(|_| format!("Timed out connecting to MCP sse server '{}'", server.name))?
        .map_err(|err| format!("Failed to connect MCP sse server '{}': {err}", server.name))?;

    if !response.status().is_success() {
        return Err(format!(
            "MCP sse server '{}' returned HTTP {}",
            server.name,
            response.status()
        ));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("text/event-stream") || content_type.is_empty() {
        // continue
    } else if content_type.contains("json") || content_type.contains("text/plain") {
        return Err(format!(
            "MCP sse server '{}' did not return text/event-stream (got {content_type}). Use streamable-http if this is a Streamable HTTP endpoint.",
            server.name
        ));
    }

    let mut byte_stream = response.bytes_stream();
    let (post_url, leftover) = tokio::time::timeout(
        timeout,
        wait_for_endpoint(&sse_url, &mut byte_stream),
    )
    .await
    .map_err(|_| format!("Timed out waiting for SSE endpoint on '{}'", server.name))?
    .map_err(|err| format!("Failed to initialize MCP sse server '{}': {err}", server.name))?;

    const MCP_CHANNEL_CAPACITY: usize = 256;
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<ClientJsonRpcMessage>(MCP_CHANNEL_CAPACITY);
    let (incoming_tx, incoming_rx) = mpsc::channel::<ServerJsonRpcMessage>(MCP_CHANNEL_CAPACITY);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

    let post_http = http.clone();
    let post_headers = headers.clone();
    let post_url_task = post_url.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                message = outgoing_rx.recv() => {
                    let Some(message) = message else { break };
                    let body = match serde_json::to_vec(&message) {
                        Ok(body) => body,
                        Err(_) => continue,
                    };
                    let mut request = post_http
                        .post(&post_url_task)
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(body);
                    for (key, value) in &post_headers {
                        if !key.trim().is_empty() {
                            request = request.header(key.as_str(), value.as_str());
                        }
                    }
                    let _ = request.send().await;
                }
            }
        }
    });

    let incoming_for_sse = incoming_tx;
    tokio::spawn(async move {
        let mut buffer = leftover;
        loop {
            while let Some(event) = pop_sse_event(&mut buffer) {
                if event.event == "message" || event.event.is_empty() {
                    if let Ok(message) = serde_json::from_str::<ServerJsonRpcMessage>(&event.data) {
                        if incoming_for_sse.send(message).await.is_err() {
                            return;
                        }
                    }
                }
            }
            match byte_stream.next().await {
                Some(Ok(bytes)) => buffer.push_str(&String::from_utf8_lossy(&bytes)),
                _ => break,
            }
        }
    });

    let transport = SseTransport {
        tx: outgoing_tx,
        rx: incoming_rx,
        shutdown: shutdown_tx,
    };
    let client = tokio::time::timeout(timeout, ().serve(transport))
        .await
        .map_err(|_| format!("Timed out initializing MCP sse server '{}'", server.name))?
        .map_err(|err| format!("Failed to initialize MCP sse server '{}': {err}", server.name))?;

    Ok(Arc::new(tokio::sync::Mutex::new(client)))
}

struct SseTransport {
    tx: mpsc::Sender<ClientJsonRpcMessage>,
    rx: mpsc::Receiver<ServerJsonRpcMessage>,
    shutdown: mpsc::Sender<()>,
}

impl Transport<RoleClient> for SseTransport {
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let tx = self.tx.clone();
        async move {
            tx.send(item).await.map_err(|_| {
                io::Error::new(io::ErrorKind::BrokenPipe, "MCP sse send channel closed")
            })
        }
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        async { self.rx.recv().await }
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        let shutdown = self.shutdown.clone();
        async move {
            let _ = shutdown.send(()).await;
            Ok(())
        }
    }
}

struct SseEvent {
    event: String,
    data: String,
}

async fn wait_for_endpoint<E, B>(
    sse_url: &str,
    stream: &mut (impl StreamExt<Item = Result<B, E>> + Unpin),
) -> Result<(String, String), String>
where
    E: std::fmt::Display,
    B: AsRef<[u8]>,
{
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|err| format!("SSE stream error: {err}"))?;
        buffer.push_str(&String::from_utf8_lossy(bytes.as_ref()));
        while let Some(event) = pop_sse_event(&mut buffer) {
            if event.event == "endpoint" {
                return Ok((join_endpoint_url(sse_url, event.data.trim()), buffer));
            }
        }
    }
    Err("SSE stream ended before sending an endpoint event".to_string())
}

fn join_endpoint_url(sse_url: &str, endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        return endpoint.to_string();
    }
    match reqwest::Url::parse(sse_url) {
        Ok(base) => base
            .join(endpoint)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| endpoint.to_string()),
        Err(_) => endpoint.to_string(),
    }
}

fn pop_sse_event(buffer: &mut String) -> Option<SseEvent> {
    let split_at = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n"))?;
    let raw = buffer[..split_at].to_string();
    let skip = if buffer[split_at..].starts_with("\r\n\r\n") {
        4
    } else {
        2
    };
    buffer.replace_range(..split_at + skip, "");

    let mut event = String::new();
    let mut data = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start().to_string());
        }
    }
    Some(SseEvent {
        event,
        data: data.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::{join_endpoint_url, pop_sse_event};

    #[test]
    fn pop_sse_event_parses_endpoint_block() {
        let mut buffer = "event: endpoint\ndata: /messages?session=1\n\nrest".to_string();
        let event = pop_sse_event(&mut buffer).expect("event");
        assert_eq!(event.event, "endpoint");
        assert_eq!(event.data, "/messages?session=1");
        assert_eq!(buffer, "rest");
    }

    #[test]
    fn join_endpoint_url_resolves_relative_paths() {
        let joined = join_endpoint_url("https://example.com/sse", "/messages?s=1");
        assert_eq!(joined, "https://example.com/messages?s=1");
        assert_eq!(
            join_endpoint_url("https://example.com/sse", "https://example.com/m"),
            "https://example.com/m"
        );
    }
}
