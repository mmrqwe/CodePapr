use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::tts_player_lock;
use crate::shared::lock;
use crate::tts::server::GPT_SOVITS_API_PORT;

static WS_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

static WS_RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();

fn ws_runtime() -> &'static tokio::runtime::Runtime {
    WS_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to build shared WS runtime")
    })
}

pub(crate) fn set_ws_app_handle(handle: tauri::AppHandle) {
    let _ = WS_APP_HANDLE.set(handle);
}

pub(crate) const WS_PATH: &str = "/ws/synthesize";

pub(crate) fn ws_base_url() -> String {
    format!("ws://127.0.0.1:{GPT_SOVITS_API_PORT}{WS_PATH}")
}

struct ReorderBuffer {
    expected_seq: u64,
    generation: u64,
    pending: HashMap<u64, Vec<Vec<u8>>>,
}

static REORDER_BUFFER: std::sync::OnceLock<Mutex<ReorderBuffer>> = std::sync::OnceLock::new();

fn reorder_buffer() -> &'static Mutex<ReorderBuffer> {
    REORDER_BUFFER.get_or_init(|| {
        Mutex::new(ReorderBuffer {
            expected_seq: 0,
            generation: 0,
            pending: HashMap::new(),
        })
    })
}

pub(crate) fn clear_reorder_buffer() {
    let mut buf = lock(reorder_buffer());
    buf.pending.clear();
    buf.expected_seq = 0;
    buf.generation += 1;
}

fn insert_and_drain(seq: u64, wav_chunks: Vec<Vec<u8>>, generation: u64) {
    let mut buf = lock(reorder_buffer());
    if generation != buf.generation {
        return;
    }
    buf.pending.insert(seq, wav_chunks);
    let mut to_enqueue: Vec<Vec<u8>> = Vec::new();
    let mut next = buf.expected_seq;
    while let Some(chunks) = buf.pending.remove(&next) {
        to_enqueue.extend(chunks);
        next += 1;
    }
    buf.expected_seq = next;
    if to_enqueue.is_empty() {
        return;
    }
    drop(buf);
    let lock = tts_player_lock();
    let mut player = crate::shared::lock(lock);
    for wav in &to_enqueue {
        let _ = player.enqueue_wav(wav);
    }
}

struct WsRequest {
    sentences: Vec<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    sample_steps: u32,
    speed: f32,
    top_k: u32,
    top_p: f32,
    temperature: f32,
    model_name: Option<String>,
    seq: u64,
    done_tx: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
}

/// Number of persistent WebSocket connections in the pool.
/// Each connection processes requests independently, so N connections
/// can handle N concurrent batch requests in true parallel.
///
/// Currently 1 by design: the blocking path serialises batches on this
/// single pooled connection, which keeps audio enqueue order deterministic
/// (concurrent connections enqueueing into the shared rodio sink could play
/// sentences out of order). True parallelism comes from the non-blocking
/// path, which opens its own independent connections per chunk.
const WS_POOL_SIZE: usize = 1;

/// Round-robin counter for assigning requests to pool connections.
static WS_POOL_RR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Global pool: N persistent WebSocket connections to the Python
/// server, shared across all synthesis calls. Each connection runs in a
/// dedicated background thread with its own mpsc channel.
///
/// Lazy-initialised on first use.
static WS_POOL: std::sync::OnceLock<Mutex<Vec<mpsc::UnboundedSender<WsRequest>>>> =
    std::sync::OnceLock::new();

fn get_or_init_pool() -> Result<(), String> {
    let lock = WS_POOL.get_or_init(|| Mutex::new(Vec::new()));
    let mut guard = lock.lock().map_err(|e| format!("WS pool lock error: {e}"))?;
    if !guard.is_empty() {
        return Ok(());
    }

    let mut senders: Vec<mpsc::UnboundedSender<WsRequest>> = Vec::with_capacity(WS_POOL_SIZE);

    for i in 0..WS_POOL_SIZE {
        let (tx, mut rx) = mpsc::unbounded_channel::<WsRequest>();

        std::thread::spawn(move || {
            let _ = ws_runtime().block_on(async move {
                let url = ws_base_url();
                let (ws, _) = match connect_async(&url).await {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[tts-ws] pool conn #{i} connect error: {e}");
                        while let Ok(req) = rx.try_recv() {
                            if let Some(tx) = req.done_tx {
                                let _ = tx.send(Err(format!("WS connect failed: {e}")));
                            }
                        }
                        return;
                    }
                };
                run_pool_loop(ws, &mut rx).await;
                while let Ok(req) = rx.try_recv() {
                    if let Some(tx) = req.done_tx {
                        let _ = tx.send(Err("WebSocket pool closed".to_string()));
                    }
                }
            });
        });

        senders.push(tx);
    }

    *guard = senders;
    Ok(())
}

async fn run_pool_loop(
    mut ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    rx: &mut mpsc::UnboundedReceiver<WsRequest>,
) {
    while let Some(req) = rx.recv().await {
        let gen = lock(reorder_buffer()).generation;
        let result = process_one_request(&mut ws, &req).await;
        match &result {
            Ok(wavs) => insert_and_drain(req.seq, wavs.clone(), gen),
            Err(_) => insert_and_drain(req.seq, vec![], gen),
        }
        if let Some(done_tx) = req.done_tx {
            let _ = done_tx.send(result.map(|_| ()));
        }
    }
}

async fn process_one_request(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    req: &WsRequest,
) -> Result<Vec<Vec<u8>>, String> {
    let mut ref_obj = serde_json::Map::new();
    if let Some(ref path) = req.ref_audio_path {
        if !path.is_empty() {
            ref_obj.insert(
                "refer_wav_path".to_string(),
                serde_json::Value::String(path.clone()),
            );
            ref_obj.insert(
                "prompt_text".to_string(),
                serde_json::Value::String(req.prompt_text.clone().unwrap_or_default()),
            );
            let lang = req.prompt_language
                .clone()
                .unwrap_or_else(|| "zh".to_string());
            ref_obj.insert(
                "prompt_language".to_string(),
                serde_json::Value::String(lang.clone()),
            );
            let text_lang = req.text_language
                .clone()
                .unwrap_or_else(|| lang.clone());
            ref_obj.insert(
                "text_language".to_string(),
                serde_json::Value::String(text_lang),
            );
        }
    }

    let mut payload = serde_json::Map::new();
    payload.insert(
        "texts".to_string(),
        serde_json::Value::Array(
            req.sentences
                .iter()
                .map(|s| serde_json::Value::String(s.clone()))
                .collect(),
        ),
    );
    payload.insert(
        "sample_steps".to_string(),
        serde_json::Value::Number(serde_json::Number::from(req.sample_steps)),
    );
    payload.insert(
        "speed_factor".to_string(),
        serde_json::Value::Number(
            serde_json::Number::from_f64(req.speed as f64)
                .unwrap_or(serde_json::Number::from(1)),
        ),
    );
    payload.insert(
        "top_k".to_string(),
        serde_json::Value::Number(serde_json::Number::from(req.top_k)),
    );
    payload.insert(
        "top_p".to_string(),
        serde_json::Value::Number(
            serde_json::Number::from_f64(req.top_p as f64)
                .unwrap_or(serde_json::Number::from(1)),
        ),
    );
    payload.insert(
        "temperature".to_string(),
        serde_json::Value::Number(
            serde_json::Number::from_f64(req.temperature as f64)
                .unwrap_or(serde_json::Number::from(1)),
        ),
    );
    if let Some(ref model) = req.model_name {
        if !model.is_empty() {
            payload.insert(
                "model_name".to_string(),
                serde_json::Value::String(model.clone()),
            );
        }
    }
    if !ref_obj.is_empty() {
        payload.insert("ref".to_string(), serde_json::Value::Object(ref_obj));
    }

    let json = serde_json::Value::Object(payload).to_string();
    ws.send(Message::Text(json))
        .await
        .map_err(|e| {
            invalidate_pool();
            format!("WebSocket send failed: {e}")
        })?;

    let mut received_count: usize = 0;
    let mut seen_indices: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut collected_wavs: Vec<Vec<u8>> = Vec::new();
    let ws_result = loop {
        match ws.next().await {
            Some(Ok(Message::Binary(data))) => {
                if data.len() < 4 {
                    continue;
                }
                let idx = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;

                if idx < req.sentences.len() {
                    if !seen_indices.insert(idx) {
                        continue;
                    }
                    if data.len() > 4 {
                        collected_wavs.push(data[4..].to_vec());
                    }
                    received_count += 1;
                }
            }
            Some(Ok(Message::Text(txt))) => {
                let v: serde_json::Value =
                    serde_json::from_str(&txt).unwrap_or_default();
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    if let Some(idx) = v.get("index").and_then(|i| i.as_u64()) {
                        if let Some(app) = WS_APP_HANDLE.get() {
                            let _ = app.emit("tts-sentence-failed", serde_json::json!({
                                "index": idx,
                                "error": err,
                            }));
                        }
                        received_count += 1;
                        continue;
                    }
                    invalidate_pool();
                    break Err(format!("TTS server error: {err}"));
                }
                if v.get("done").is_some() {
                    break Ok(received_count);
                }
                eprintln!("[tts-ws] unrecognised text frame: {txt}");
            }
            Some(Ok(Message::Close(_))) => {
                invalidate_pool();
                if received_count > 0 {
                    break Ok(received_count);
                }
                break Err("WebSocket closed by server before any data received".to_string());
            }
            Some(Err(e)) => {
                invalidate_pool();
                if received_count > 0 {
                    break Ok(received_count);
                }
                break Err(format!("WebSocket error: {e}"));
            }
            None => break Ok(received_count),
            _ => {}
        }
    };

    let received_count = match ws_result {
        Ok(n) => n,
        Err(e) => return Err(e),
    };

    if received_count == 0 && !req.sentences.is_empty() {
        return Err(format!(
            "WebSocket closed before any sentences were received (got 0/{})",
            req.sentences.len()
        ));
    }

    if received_count < req.sentences.len() {
        return Err(format!(
            "Partial synthesis: got {}/{} sentences",
            received_count,
            req.sentences.len()
        ));
    }

    Ok(collected_wavs)
}

fn invalidate_pool() {
    if let Some(lock) = WS_POOL.get() {
        if let Ok(mut guard) = lock.lock() {
            guard.clear();
        }
    }
}

fn send_to_pool(
    sentences: Vec<String>,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    sample_steps: u32,
    speed: f32,
    top_k: u32,
    top_p: f32,
    temperature: f32,
    seq: u64,
    done_tx: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    get_or_init_pool()?;
    let lock = WS_POOL.get().ok_or("WS pool not initialised")?;
    let guard = lock.lock().map_err(|e| format!("WS pool lock error: {e}"))?;
    if guard.is_empty() {
        return Err("WS pool is empty".to_string());
    }
    let idx = WS_POOL_RR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % guard.len();
    let tx = &guard[idx];
    let req = WsRequest {
        sentences,
        model_name,
        ref_audio_path,
        prompt_text,
        prompt_language,
        text_language,
        sample_steps,
        speed,
        top_k,
        top_p,
        temperature,
        seq,
        done_tx,
    };
    tx.send(req).map_err(|_| {
        invalidate_pool();
        "WebSocket pool channel closed".to_string()
    })
}

/// Blocking variant: sends a batch through the persistent WebSocket
/// pool and waits for all sentences to be received and enqueued.
///
/// If the pool connection was closed by the server (e.g. idle timeout
/// between conversations), invalidates the pool and retries once on a
/// fresh connection.
pub(crate) fn synthesize_batch_ws(
    sentences: Vec<String>,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    sample_steps: u32,
    speed: f32,
    top_k: u32,
    top_p: f32,
    temperature: f32,
    seq: u64,
) -> Result<(), String> {
    fn do_send(
        sentences: &Vec<String>,
        model_name: &Option<String>,
        ref_audio_path: &Option<String>,
        prompt_text: &Option<String>,
        prompt_language: &Option<String>,
        text_language: &Option<String>,
        sample_steps: u32,
        speed: f32,
        top_k: u32,
        top_p: f32,
        temperature: f32,
        seq: u64,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<(), String>>, String> {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        send_to_pool(
            sentences.clone(),
            model_name.clone(),
            ref_audio_path.clone(),
            prompt_text.clone(),
            prompt_language.clone(),
            text_language.clone(),
            sample_steps,
            speed,
            top_k,
            top_p,
            temperature,
            seq,
            Some(done_tx),
        )?;
        Ok(done_rx)
    }

    let rx = do_send(
        &sentences, &model_name, &ref_audio_path,
        &prompt_text, &prompt_language, &text_language, sample_steps, speed,
        top_k, top_p, temperature, seq,
    )?;
    match rx.blocking_recv() {
        Ok(result) => {
            if result.is_err() {
                let err = result.as_ref().unwrap_err();
                if err.contains("closed") || err.contains("failed") || err.contains("pipe") || err.contains("Broken") {
                    invalidate_pool();
                    let rx2 = do_send(
                        &sentences, &model_name, &ref_audio_path,
                        &prompt_text, &prompt_language, &text_language, sample_steps, speed,
                        top_k, top_p, temperature, seq,
                    )?;
                    return match rx2.blocking_recv() {
                        Ok(r) => r,
                        Err(_) => Err("Batch synthesis channel cancelled on retry".to_string()),
                    };
                }
            }
            result
        }
        Err(_) => Err("Batch synthesis channel cancelled".to_string()),
    }
}

/// Non-blocking variant: creates an independent WebSocket connection
/// in a background thread. Multiple chunks can run in parallel — each
/// with its own tokio runtime and TCP connection.
///
/// The Python server (uvicorn) handles concurrent WS connections
/// natively, so chunk 1 can synthesize while chunk 0's audio is still
/// playing from the rodio sink.
pub(crate) fn synthesize_batch_ws_nonblocking(
    sentences: Vec<String>,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    sample_steps: u32,
    speed: f32,
    top_k: u32,
    top_p: f32,
    temperature: f32,
    seq: u64,
) {
    let gen = lock(reorder_buffer()).generation;
    std::thread::spawn(move || {
        let result = ws_runtime().block_on(synthesize_batch_ws_async(
            sentences,
            model_name,
            ref_audio_path,
            prompt_text,
            prompt_language,
            text_language,
            sample_steps,
            speed,
            top_k,
            top_p,
            temperature,
        ));
        match result {
            Ok(wavs) => insert_and_drain(seq, wavs, gen),
            Err(_) => insert_and_drain(seq, vec![], gen),
        }
    });
}

/// Connect independently, send JSON, receive all WAVs, enqueue each.
/// Used by nonblocking calls for parallel chunk synthesis.
async fn synthesize_batch_ws_async(
    sentences: Vec<String>,
    model_name: Option<String>,
    ref_audio_path: Option<String>,
    prompt_text: Option<String>,
    prompt_language: Option<String>,
    text_language: Option<String>,
    sample_steps: u32,
    speed: f32,
    top_k: u32,
    top_p: f32,
    temperature: f32,
) -> Result<Vec<Vec<u8>>, String> {
    let url = ws_base_url();
    let (mut ws, _resp) = connect_async(&url)
        .await
        .map_err(|e| format!("WebSocket connection failed: {e}"))?;

    let mut ref_obj = serde_json::Map::new();
    if let Some(ref path) = ref_audio_path {
        if !path.is_empty() {
            ref_obj.insert("refer_wav_path".to_string(), serde_json::Value::String(path.clone()));
            ref_obj.insert("prompt_text".to_string(), serde_json::Value::String(prompt_text.unwrap_or_default()));
            let lang = prompt_language.clone().unwrap_or_else(|| "zh".to_string());
            ref_obj.insert("prompt_language".to_string(), serde_json::Value::String(lang.clone()));
            let text_lang = text_language.clone().unwrap_or_else(|| lang.clone());
            ref_obj.insert("text_language".to_string(), serde_json::Value::String(text_lang));
        }
    }

    let mut payload = serde_json::Map::new();
    payload.insert("texts".to_string(), serde_json::Value::Array(sentences.iter().map(|s| serde_json::Value::String(s.clone())).collect()));
    payload.insert("sample_steps".to_string(), serde_json::Value::Number(serde_json::Number::from(sample_steps)));
    payload.insert("speed_factor".to_string(), serde_json::Value::Number(serde_json::Number::from_f64(speed as f64).unwrap_or(serde_json::Number::from(1))));
    payload.insert("top_k".to_string(), serde_json::Value::Number(serde_json::Number::from(top_k)));
    payload.insert("top_p".to_string(), serde_json::Value::Number(serde_json::Number::from_f64(top_p as f64).unwrap_or(serde_json::Number::from(1))));
    payload.insert("temperature".to_string(), serde_json::Value::Number(serde_json::Number::from_f64(temperature as f64).unwrap_or(serde_json::Number::from(1))));
    if let Some(ref model) = model_name {
        if !model.is_empty() {
            payload.insert("model_name".to_string(), serde_json::Value::String(model.clone()));
        }
    }
    if !ref_obj.is_empty() {
        payload.insert("ref".to_string(), serde_json::Value::Object(ref_obj));
    }

    let json = serde_json::Value::Object(payload).to_string();
    ws.send(Message::Text(json)).await.map_err(|e| format!("WS send failed: {e}"))?;

    let mut received: usize = 0;
    let mut seen_indices: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut collected_wavs: Vec<Vec<u8>> = Vec::new();
    loop {
        match ws.next().await {
            Some(Ok(Message::Binary(data))) => {
                if data.len() < 4 { continue; }
                let idx = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
                if idx < sentences.len() {
                    if !seen_indices.insert(idx) { continue; }
                    if data.len() > 4 {
                        collected_wavs.push(data[4..].to_vec());
                    }
                    received += 1;
                }
            }
            Some(Ok(Message::Text(txt))) => {
                let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or_default();
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    if let Some(idx) = v.get("index").and_then(|i| i.as_u64()) {
                        if let Some(app) = WS_APP_HANDLE.get() {
                            let _ = app.emit("tts-sentence-failed", serde_json::json!({
                                "index": idx,
                                "error": err,
                            }));
                        }
                        received += 1;
                        continue;
                    }
                    return Err(format!("TTS error: {txt}"));
                }
                if v.get("done").is_some() { break; }
            }
            Some(Ok(Message::Close(_))) => { break; }
            Some(Err(e)) => {
                if received > 0 { break; }
                return Err(format!("WS error: {e}"));
            }
            None => break,
            _ => {}
        }
    }
    if received == 0 && !sentences.is_empty() {
        return Err(format!("WS got 0/{} sentences", sentences.len()));
    }
    if received < sentences.len() {
        return Err(format!("Partial: got {}/{} sentences", received, sentences.len()));
    }
    Ok(collected_wavs)
}
