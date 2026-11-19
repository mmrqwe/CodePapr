use std::net::SocketAddrV4;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use codepapr_core::shared::lock;

use super::{check_generation, synthesis_generation};

type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const WS_PATH: &str = "/ws/synthesize";
const WS_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(90);
static WORKER: Mutex<Option<(SocketAddrV4, mpsc::Sender<Request>)>> = Mutex::new(None);

pub(super) fn disconnect(address: SocketAddrV4) {
    let mut worker = lock(&WORKER);
    if worker
        .as_ref()
        .is_some_and(|(current, _)| *current == address)
    {
        super::cancel_synthesis();
        *worker = None;
    }
}

#[derive(serde::Serialize)]
pub(super) struct Batch {
    pub texts: Vec<String>,
    pub sample_steps: u32,
    pub speed_factor: f32,
    pub top_k: u32,
    pub top_p: f32,
    pub temperature: f32,
    pub model_name: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Reference,
}

#[derive(serde::Serialize)]
pub(super) struct Reference {
    pub refer_wav_path: Option<String>,
    pub prompt_text: Option<String>,
    pub prompt_language: String,
    pub text_language: String,
}

struct Request {
    batch: Batch,
    generation: u64,
    done: tokio::sync::oneshot::Sender<Result<usize, String>>,
}

pub(super) async fn synthesize(address: SocketAddrV4, batch: Batch) -> Result<usize, String> {
    let (done, result) = tokio::sync::oneshot::channel();
    let request = Request {
        batch,
        generation: synthesis_generation(),
        done,
    };
    {
        let mut worker = lock(&WORKER);
        if worker
            .as_ref()
            .is_none_or(|(current, _)| *current != address)
        {
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || run_worker(address, rx));
            *worker = Some((address, tx));
        }
        let (_, sender) = worker.as_ref().unwrap();
        if sender.send(request).is_err() {
            *worker = None;
            return Err("WebSocket synthesis worker stopped".to_string());
        }
    }
    result
        .await
        .map_err(|_| "WebSocket synthesis worker stopped".to_string())?
}

fn run_worker(address: SocketAddrV4, rx: mpsc::Receiver<Request>) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let mut connection = None;
    while let Ok(request) = rx.recv() {
        let result = play_batch(&runtime, address, &mut connection, &request);
        let _ = request.done.send(result);
    }
}

fn enqueue(wav: &[u8], generation: u64) -> Result<(), String> {
    let mut player = lock(super::tts_player_lock());
    check_generation(generation)?;
    player.enqueue_wav(wav)
}

fn play_batch(
    runtime: &tokio::runtime::Runtime,
    address: SocketAddrV4,
    connection: &mut Option<WsStream>,
    request: &Request,
) -> Result<usize, String> {
    let Request {
        batch, generation, ..
    } = request;
    let generation = *generation;
    check_generation(generation)?;
    let mut audio = OrderedAudio::new(batch.texts.len());
    let mut transport_error = None;

    // Reconnect once if the idle connection closed before it returned audio.
    for _ in 0..2 {
        let result = runtime.block_on(async {
            if connection.is_none() {
                let url = format!("ws://{address}{WS_PATH}");
                let (ws, _) = tokio::time::timeout(Duration::from_secs(5), connect_async(url))
                    .await
                    .map_err(|e| format!("WebSocket connect timed out: {e}"))?
                    .map_err(|e| format!("WebSocket connect failed: {e}"))?;
                *connection = Some(ws);
            }
            receive_audio(connection.as_mut().unwrap(), batch, &mut audio, generation).await
        });
        match result {
            Ok(()) => break,
            Err(err) => {
                *connection = None;
                check_generation(generation)?;
                let can_reconnect = audio.next == 0
                    && audio.pending.iter().all(Option::is_none)
                    && (err.starts_with("WebSocket closed") || err.starts_with("WebSocket send"));
                transport_error = Some(err);
                if !can_reconnect {
                    break;
                }
            }
        }
    }

    let mut recovered = 0;
    let mut failed = Vec::new();
    // Keep received WAVs on either side of a missing index. Fetch only the
    // missing audio, in order, through HTTP before playing later indices.
    while audio.next < batch.texts.len() {
        check_generation(generation)?;
        let index = audio.next;
        let wav = match audio.pending[index].take() {
            Some(wav) => Ok(wav),
            None => {
                recovered += 1;
                fetch_wav(address, batch, index, generation)
            }
        };
        check_generation(generation)?;
        if let Err(err) = wav.and_then(|wav| enqueue(&wav, generation)) {
            failed.push(format!("{}: {err}", index + 1));
        }
        audio.next += 1;
    }

    if failed.is_empty() {
        Ok(recovered)
    } else {
        let cause = transport_error.as_deref().unwrap_or("missing audio");
        Err(format!(
            "TTS could not play {} sentence(s) ({cause}): {}",
            failed.len(),
            failed.join("; ")
        ))
    }
}

fn fetch_wav(
    address: SocketAddrV4,
    batch: &Batch,
    index: usize,
    generation: u64,
) -> Result<Vec<u8>, String> {
    let reference = &batch.reference;
    let mut response = super::request_audio(
        address,
        batch.texts[index].clone(),
        batch.model_name.clone(),
        reference.refer_wav_path.clone(),
        reference.prompt_text.clone(),
        Some(reference.prompt_language.clone()),
        Some(reference.text_language.clone()),
        batch.sample_steps,
        batch.speed_factor,
    )?;
    super::read_response_to_end(&mut response, generation)
}

struct OrderedAudio {
    next: usize,
    pending: Vec<Option<Vec<u8>>>,
}

impl OrderedAudio {
    fn new(len: usize) -> Self {
        Self {
            next: 0,
            pending: vec![None; len],
        }
    }

    fn accept(
        &mut self,
        index: usize,
        wav: Vec<u8>,
        mut play: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        if index < self.next || index >= self.pending.len() || self.pending[index].is_some() {
            return Ok(());
        }
        self.pending[index] = Some(wav);
        while let Some(Some(wav)) = self.pending.get(self.next) {
            if let Err(err) = play(wav) {
                // A corrupt WAV should be regenerated by the HTTP fallback.
                self.pending[self.next] = None;
                return Err(err);
            }
            self.pending[self.next] = None;
            self.next += 1;
        }
        Ok(())
    }
}

async fn receive_audio(
    ws: &mut WsStream,
    batch: &Batch,
    audio: &mut OrderedAudio,
    generation: u64,
) -> Result<(), String> {
    let json = serde_json::to_string(batch).map_err(|e| e.to_string())?;
    ws.send(Message::Text(json))
        .await
        .map_err(|e| format!("WebSocket send failed: {e}"))?;
    let mut last_activity = std::time::Instant::now();

    loop {
        check_generation(generation)?;
        let frame = match tokio::time::timeout(Duration::from_millis(200), ws.next()).await {
            Ok(frame) => frame,
            Err(_) if last_activity.elapsed() < WS_INACTIVITY_TIMEOUT => continue,
            Err(_) => return Err("WebSocket synthesis stalled".to_string()),
        };
        last_activity = std::time::Instant::now();
        match frame {
            Some(Ok(Message::Binary(frame))) if frame.len() > 48 && &frame[4..8] == b"RIFF" => {
                let index = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
                audio.accept(index, frame[4..].to_vec(), |wav| enqueue(wav, generation))?;
            }
            Some(Ok(Message::Text(text))) => {
                let status: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if status.get("done").and_then(|v| v.as_bool()) == Some(true) {
                    return Ok(());
                }
                if let Some(error) = status.get("error").and_then(|v| v.as_str()) {
                    if status.get("index").is_none() {
                        return Err(format!("TTS server error: {error}"));
                    }
                    // Leave this slot empty so it can be recovered in place.
                }
            }
            Some(Err(err)) => return Err(format!("WebSocket receive failed: {err}")),
            None | Some(Ok(Message::Close(_))) => {
                return Err("WebSocket closed during synthesis".to_string())
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OrderedAudio;

    #[test]
    fn delivers_frames_in_order_and_ignores_duplicates() {
        let mut audio = OrderedAudio::new(3);
        let mut played = Vec::new();
        let mut play = |wav: &[u8]| {
            played.extend_from_slice(wav);
            Ok(())
        };
        audio.accept(2, vec![3], &mut play).unwrap();
        audio.accept(0, vec![1], &mut play).unwrap();
        audio.accept(0, vec![9], &mut play).unwrap();
        audio.accept(1, vec![2], &mut play).unwrap();
        assert_eq!(played, [1, 2, 3]);
        assert_eq!(audio.next, 3);
    }

    #[test]
    fn missing_index_keeps_the_later_audio_for_ordered_recovery() {
        let mut audio = OrderedAudio::new(4);
        let mut played = Vec::new();
        let mut play = |wav: &[u8]| {
            played.extend_from_slice(wav);
            Ok(())
        };
        audio.accept(0, vec![1], &mut play).unwrap();
        audio.accept(2, vec![3], &mut play).unwrap();
        audio.accept(3, vec![4], &mut play).unwrap();
        assert_eq!(played, [1]);
        assert_eq!(audio.next, 1);
        assert_eq!(audio.pending, [None, None, Some(vec![3]), Some(vec![4])]);
    }
}
