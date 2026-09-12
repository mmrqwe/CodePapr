use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::tts_player_lock;
use codepapr_core::shared::lock;
use crate::tts::server::GPT_SOVITS_API_PORT;

static WS_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

fn new_current_thread_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("Failed to build WS runtime")
}

pub(crate) fn set_ws_app_handle(handle: tauri::AppHandle) {
    let _ = WS_APP_HANDLE.set(handle);
}

pub(crate) const WS_PATH: &str = "/ws/synthesize";

pub(crate) fn ws_base_url() -> String {
    format!("ws://127.0.0.1:{GPT_SOVITS_API_PORT}{WS_PATH}")
}

pub(crate) fn is_ws_unavailable(e: &str) -> bool {
    let lower = e.to_ascii_lowercase();
    lower.contains("ws connect")
        || lower.contains("websocket connection failed")
        || lower.contains("websocket connect")
        || lower.contains("pool is empty")
        || lower.contains("pool channel closed")
        || lower.contains("pool closed")
}

pub(crate) fn place_wav_by_index(
    slots: &mut [Option<Vec<u8>>],
    seen: &mut HashSet<usize>,
    idx: usize,
    payload: Vec<u8>,
) -> bool {
    if idx >= slots.len() || !seen.insert(idx) {
        return false;
    }
    if !payload.is_empty() {
        slots[idx] = Some(payload);
    }
    true
}

pub(crate) fn wavs_in_index_order(slots: Vec<Option<Vec<u8>>>) -> Vec<Vec<u8>> {
    slots.into_iter().flatten().collect()
}

fn emit_ws_unavailable(err: &str) {
    if let Some(app) = WS_APP_HANDLE.get() {
        let _ = app.emit("tts-ws-unavailable", err);
    }
}

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Maximum time without any frame from the server before a batch is treated
/// as stalled. Without this, a hung request would keep its `seq` in the
/// reorder buffer forever and all later chunks would queue up unheard.
const WS_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30);

async fn collect_ws_audio(
    ws: &mut WsStream,
    sentence_count: usize,
    invalidate_on_transport_err: bool,
) -> Result<Vec<Vec<u8>>, String> {
    let mut received_count: usize = 0;
    let mut seen_indices: HashSet<usize> = HashSet::new();
    let mut slots: Vec<Option<Vec<u8>>> = vec![None; sentence_count];
    let mut last_activity = std::time::Instant::now();

    let ws_result = loop {
        if super::synthesis_is_cancelled() {
            let _ = ws.close(None).await;
            break Err("Synthesis cancelled by user".to_string());
        }
        match tokio::time::timeout(Duration::from_millis(200), ws.next()).await {
            Err(_elapsed) => {
                if last_activity.elapsed() > WS_INACTIVITY_TIMEOUT {
                    if invalidate_on_transport_err {
                        invalidate_pool();
                    }
                    break Err(format!(
                        "Synthesis stalled: no server data for {}s",
                        WS_INACTIVITY_TIMEOUT.as_secs()
                    ));
                }
                continue;
            }
            Ok(frame) => {
                last_activity = std::time::Instant::now();
                match frame {
                    None => break Ok(received_count),
                    Some(Ok(Message::Binary(data))) => {
                        if data.len() < 4 {
                            continue;
                        }
                        let idx = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
                        if place_wav_by_index(&mut slots, &mut seen_indices, idx, data[4..].to_vec()) {
                            received_count += 1;
                        }
                    }
                    Some(Ok(Message::Text(txt))) => {
                        let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or_default();
                        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                            if let Some(idx) = v.get("index").and_then(|i| i.as_u64()) {
                                if let Some(app) = WS_APP_HANDLE.get() {
                                    let _ = app.emit(
                                        "tts-sentence-failed",
                                        serde_json::json!({
                                            "index": idx,
                                            "error": err,
                                        }),
                                    );
                                }
                                let _ = seen_indices.insert(idx as usize);
                                received_count += 1;
                                continue;
                            }
                            if invalidate_on_transport_err {
                                invalidate_pool();
                            }
                            break Err(format!("TTS server error: {err}"));
                        }
                        if v.get("done").is_some() {
                            break Ok(received_count);
                        }
                        eprintln!("[tts-ws] unrecognised text frame: {txt}");
                    }
                    Some(Ok(Message::Close(_))) => {
                        if invalidate_on_transport_err {
                            invalidate_pool();
                        }
                        if received_count > 0 {
                            break Ok(received_count);
                        }
                        break Err("WebSocket closed by server before any data received".to_string());
                    }
                    Some(Err(e)) => {
                        if invalidate_on_transport_err {
                            invalidate_pool();
                        }
                        if received_count > 0 {
                            break Ok(received_count);
                        }
                        break Err(format!("WebSocket error: {e}"));
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    };

    let received_count = match ws_result {
        Ok(n) => n,
        Err(e) => return Err(e),
    };

    if received_count == 0 && sentence_count > 0 {
        return Err(format!(
            "WebSocket closed before any sentences were received (got 0/{sentence_count})"
        ));
    }

    if received_count < sentence_count {
        return Err(format!(
            "Partial synthesis: got {received_count}/{sentence_count} sentences"
        ));
    }

    Ok(wavs_in_index_order(slots))
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
    let mut player = codepapr_core::shared::lock(lock);
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
    /// Reorder-buffer generation captured when the request was dispatched.
    /// Using it at processing time (instead of reading the current value)
    /// guarantees results from before a stop/skip are dropped.
    generation: u64,
    done_tx: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
}

/// Number of persistent WebSocket connections in the pool.
///
/// 1 by design: all batches (blocking and non-blocking) are serialised on
/// this single connection. That keeps the Python side's loaded-model state
/// warm — a fresh connection used to reload the fine-tuned SoVITS weights
/// (multi-second stall) on every chunk — and matches the single-threaded
/// uvicorn worker, so extra connections only contend for the same GPU.
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
            let rt = new_current_thread_runtime();
            let _ = rt.block_on(async move {
                let url = ws_base_url();
                let (ws, _) = match connect_async(&url).await {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[tts-ws] pool conn #{i} connect error: {e}");
                        emit_ws_unavailable(&format!("WS connect failed: {e}"));
                        while let Ok(req) = rx.try_recv() {
                            if let Some(tx) = req.done_tx {
                                let _ = tx.send(Err(format!("WS connect failed: {e}")));
                                continue;
                            }
                            // Drop stale (stopped/skipped) chunks instead of
                            // playing them through the HTTP fallback.
                            if codepapr_core::shared::lock(reorder_buffer()).generation
                                != req.generation
                            {
                                continue;
                            }
                            // Fire-and-forget requests must not disappear
                            // silently: fall back to HTTP and advance the
                            // reorder sequence, exactly like the dispatcher.
                            let _ = super::http_fallback_sentences(
                                req.sentences,
                                req.model_name,
                                req.ref_audio_path,
                                req.prompt_text,
                                req.prompt_language,
                                req.text_language,
                                req.sample_steps,
                                req.speed,
                            );
                            insert_and_drain(req.seq, vec![], req.generation);
                        }
                        return;
                    }
                };
                run_pool_loop(ws, &mut rx).await;
                while let Ok(req) = rx.try_recv() {
                    if let Some(tx) = req.done_tx {
                        let _ = tx.send(Err("WebSocket pool closed".to_string()));
                        continue;
                    }
                    insert_and_drain(req.seq, vec![], req.generation);
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
        let gen = req.generation;
        // Stop/skip happened after this request was dispatched: drop it
        // without synthesising so a stale backlog cannot delay the next turn.
        if lock(reorder_buffer()).generation != gen {
            if let Some(done_tx) = req.done_tx {
                let _ = done_tx.send(Err("Synthesis cancelled by user".to_string()));
            }
            continue;
        }
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
            let lang = super::normalize_lang_code(
                req.prompt_language.as_deref().unwrap_or("zh"),
            )
            .to_string();
            ref_obj.insert(
                "prompt_language".to_string(),
                serde_json::Value::String(lang.clone()),
            );
            let text_lang = super::normalize_lang_code(
                req.text_language.as_deref().unwrap_or(lang.as_str()),
            )
            .to_string();
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

    collect_ws_audio(ws, req.sentences.len(), true).await
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
    generation: u64,
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
        generation,
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
        generation: u64,
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
            generation,
            Some(done_tx),
        )?;
        Ok(done_rx)
    }

    let gen = lock(reorder_buffer()).generation;
    let rx = do_send(
        &sentences, &model_name, &ref_audio_path,
        &prompt_text, &prompt_language, &text_language, sample_steps, speed,
        top_k, top_p, temperature, seq, gen,
    )?;
    match rx.blocking_recv() {
        Ok(result) => {
            if result.is_err() {
                let err = result.as_ref().unwrap_err();
                if err.contains("closed") || err.contains("failed") || err.contains("pipe") || err.contains("Broken") {
                    invalidate_pool();
                    let retry_gen = lock(reorder_buffer()).generation;
                    let rx2 = do_send(
                        &sentences, &model_name, &ref_audio_path,
                        &prompt_text, &prompt_language, &text_language, sample_steps, speed,
                        top_k, top_p, temperature, seq, retry_gen,
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
/// in a background thread with its own tokio runtime. Multiple chunks
/// can synthesise in parallel while earlier audio is still playing.
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
    // Route through the shared persistent connection instead of opening a
    // fresh WebSocket per chunk. The old per-chunk connection made the Python
    // side reload the fine-tuned SoVITS weights (and re-run GPU warmup plus
    // reference-embedding computation) on every chunk, which is exactly the
    // multi-second silence heard between chunks. The pool serialises
    // synthesis, which also matches the single-threaded uvicorn worker.
    if let Err(e) = send_to_pool(
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
        gen,
        None,
    ) {
        // Pool unavailable (server down / connection closed): fall back to
        // per-sentence HTTP, which enqueues straight into the player, then
        // advance the reorder sequence so later chunks are not blocked.
        if is_ws_unavailable(&e) {
            emit_ws_unavailable(&e);
            // Only play the fallback if a stop/skip has not invalidated this
            // chunk in the meantime.
            if lock(reorder_buffer()).generation == gen {
                let _ = super::http_fallback_sentences(
                    sentences,
                    model_name,
                    ref_audio_path,
                    prompt_text,
                    prompt_language,
                    text_language,
                    sample_steps,
                    speed,
                );
            }
        }
        insert_and_drain(seq, vec![], gen);
    }
}

