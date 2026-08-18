use std::io::Cursor;
use std::sync::Mutex;

use rodio::buffer::SamplesBuffer;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};

/// `OutputStream` is `!Send` on macOS (cpal CoreAudio), so it cannot live in
/// a `static Mutex`. We still `forget` each stream so the device stays open,
/// but we *can* replace the `OutputStreamHandle` when the default device
/// changes — the previous stream leaks until process exit, which is the
/// same trade-off rodio 0.20 forces, just recoverable without an app restart.
static PLAYER_HANDLE: std::sync::OnceLock<Mutex<Option<OutputStreamHandle>>> =
    std::sync::OnceLock::new();

fn player_handle_lock() -> &'static Mutex<Option<OutputStreamHandle>> {
    PLAYER_HANDLE.get_or_init(|| Mutex::new(None))
}

fn open_default_handle() -> Result<OutputStreamHandle, String> {
    let (stream, handle) = OutputStream::try_default()
        .map_err(|e| format!("Audio device not available: {e}"))?;
    std::mem::forget(stream);
    Ok(handle)
}

fn current_output_handle() -> Result<OutputStreamHandle, String> {
    let lock = player_handle_lock();
    let mut guard = lock
        .lock()
        .map_err(|e| format!("Audio device lock error: {e}"))?;
    if guard.is_none() {
        *guard = Some(open_default_handle()?);
    }
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "Audio device not available".to_string())
}

/// Open a fresh default output device. Existing sinks bound to the old
/// handle become invalid; the caller must `stop()` first.
pub(crate) fn reset_output_device() -> Result<(), String> {
    let handle = open_default_handle()?;
    let lock = player_handle_lock();
    let mut guard = lock
        .lock()
        .map_err(|e| format!("Audio device lock error: {e}"))?;
    *guard = Some(handle);
    Ok(())
}

fn is_device_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("audio device")
        || lower.contains("audio sink")
        || lower.contains("no device")
        || lower.contains("device not available")
}

/// Audio playback layer that supports three distinct entry points
/// matching the three TTS playback strategies the user can choose from
/// on a per-character basis:
///
/// 1. `play_wav` — destroy any existing sink and play a single complete
///    WAV file. Used by Mode A (whole-passage synthesis).
/// 2. `enqueue_wav` — append a complete WAV decoder to the current sink
///    so that consecutive sentences play back-to-back without the audible
///    "click" of a sink rebuild. Used by Mode B (streamed-pipeline).
/// 3. `start_pcm_stream` + `push_pcm_samples` — accept raw 16-bit PCM
///    samples and stream them into the sink as they arrive over HTTP.
///    Used by Mode F (streamed-pcm).
pub(crate) struct AudioPlayer {
    sink: Option<Sink>,
    /// Sample rate / channel count of the active streaming PCM session, if any.
    /// `None` when no PCM stream is currently being fed.
    pcm_format: Option<(u32, u16)>,
    volume: f32,
}

#[allow(dead_code)]
impl AudioPlayer {
    pub(crate) fn new() -> Self {
        Self {
            sink: None,
            pcm_format: None,
            volume: 1.0,
        }
    }

    /// Rebuild the default output device (headphones swapped, etc.) and
    /// drop any in-flight sink that was bound to the old stream.
    pub(crate) fn recreate_output(&mut self) -> Result<(), String> {
        self.stop();
        reset_output_device()
    }

    fn recover_device_if_needed(&mut self, err: &str) -> Result<(), String> {
        if !is_device_error(err) {
            return Err(err.to_string());
        }
        self.recreate_output()
    }

    /// Set the playback volume (clamped to 0.0-2.0). Applies to the active
    /// sink immediately and to every sink created afterwards.
    pub(crate) fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 2.0);
        if let Some(ref sink) = self.sink {
            sink.set_volume(self.volume);
        }
    }

    pub(crate) fn volume(&self) -> f32 {
        self.volume
    }

    /// Mode A entry-point. Replaces any in-flight playback with a single
    /// fully-decoded WAV.
    pub(crate) fn play_wav(&mut self, wav_bytes: &[u8]) -> Result<(), String> {
        match self.play_wav_inner(wav_bytes) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.recover_device_if_needed(&e)?;
                self.play_wav_inner(wav_bytes)
            }
        }
    }

    fn play_wav_inner(&mut self, wav_bytes: &[u8]) -> Result<(), String> {
        let handle = current_output_handle()?;
        let cursor = Cursor::new(wav_bytes.to_vec());
        let source = Decoder::new(cursor).map_err(|e| format!("WAV decode error: {e}"))?;
        let sink = Sink::try_new(&handle).map_err(|e| format!("Audio sink error: {e}"))?;
        sink.set_volume(self.volume);
        sink.append(source);
        self.sink = Some(sink);
        self.pcm_format = None;
        Ok(())
    }

    /// Mode B entry-point. Append a complete WAV to the existing sink so
    /// the next sentence joins seamlessly onto whatever is currently
    /// playing. Only creates a new sink when none exists — recreating
    /// on drain causes a race between the rodio worker finishing playback
    /// and the next sentence arriving, which can clobber in-flight audio.
    pub(crate) fn enqueue_wav(&mut self, wav_bytes: &[u8]) -> Result<(), String> {
        match self.enqueue_wav_inner(wav_bytes) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.recover_device_if_needed(&e)?;
                self.enqueue_wav_inner(wav_bytes)
            }
        }
    }

    fn enqueue_wav_inner(&mut self, wav_bytes: &[u8]) -> Result<(), String> {
        let handle = current_output_handle()?;
        let cursor = Cursor::new(wav_bytes.to_vec());
        let source = Decoder::new(cursor).map_err(|e| format!("WAV decode error: {e}"))?;
        if self.sink.is_none() {
            let sink = Sink::try_new(&handle).map_err(|e| format!("Audio sink error: {e}"))?;
            sink.set_volume(self.volume);
            self.sink = Some(sink);
        }
        self.sink
            .as_ref()
            .ok_or_else(|| "Audio sink unavailable".to_string())?
            .append(source);
        self.pcm_format = None;
        Ok(())
    }

    /// Mode F / Mode B PCM entry-point part 1. Initialise (or join) a
    /// raw-PCM streaming session with the given format.
    pub(crate) fn start_pcm_stream(
        &mut self,
        sample_rate: u32,
        channels: u16,
    ) -> Result<(), String> {
        match self.start_pcm_stream_inner(sample_rate, channels) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.recover_device_if_needed(&e)?;
                self.start_pcm_stream_inner(sample_rate, channels)
            }
        }
    }

    fn start_pcm_stream_inner(
        &mut self,
        sample_rate: u32,
        channels: u16,
    ) -> Result<(), String> {
        if !(channels == 1 || channels == 2) {
            return Err(format!("Unsupported channel count: {channels}"));
        }
        let handle = current_output_handle()?;
        let format_changed = self.pcm_format != Some((sample_rate, channels));
        if self.sink.is_none() || format_changed {
            let sink = Sink::try_new(&handle).map_err(|e| format!("Audio sink error: {e}"))?;
            sink.set_volume(self.volume);
            if let Some(old) = self.sink.replace(sink) {
                old.stop();
            }
        }
        self.pcm_format = Some((sample_rate, channels));
        Ok(())
    }

    /// Mode F entry-point part 2. Feed raw 16-bit PCM samples (interleaved
    /// for multi-channel) into the active stream.
    pub(crate) fn push_pcm_samples(&mut self, samples: Vec<i16>) -> Result<(), String> {
        let (rate, channels) = self
            .pcm_format
            .ok_or_else(|| "PCM stream not initialised — call start_pcm_stream first".to_string())?;
        let sink = self
            .sink
            .as_ref()
            .ok_or_else(|| "PCM stream sink missing".to_string())?;
        if samples.is_empty() {
            return Ok(());
        }
        let buf = SamplesBuffer::new(channels, rate, samples);
        sink.append(buf);
        Ok(())
    }

    pub(crate) fn stop(&mut self) {
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
        self.pcm_format = None;
    }

    pub(crate) fn is_playing(&self) -> bool {
        self.sink.as_ref().is_some_and(|s| !s.empty())
    }

    pub(crate) fn wait_done(&self) {
        if let Some(ref sink) = self.sink {
            sink.sleep_until_end();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AudioPlayer;

    #[test]
    fn new_audio_player_is_not_playing() {
        let player = AudioPlayer::new();
        assert!(!player.is_playing());
    }

    #[test]
    fn stop_on_fresh_player_is_safe_noop() {
        let mut player = AudioPlayer::new();
        player.stop();
        assert!(!player.is_playing());
    }

    #[test]
    fn push_pcm_samples_without_start_pcm_stream_errors() {
        let mut player = AudioPlayer::new();
        let result = player.push_pcm_samples(vec![1, 2, 3]);
        assert!(
            result.is_err(),
            "push_pcm_samples must reject when pcm_format is None"
        );
    }

    #[test]
    fn play_wav_rejects_garbage_input_or_no_device() {
        // Either the WAV decode fails (most environments) or the audio
        // device is missing (CI). Both should surface a clean Err, never
        // panic.
        let mut player = AudioPlayer::new();
        let result = player.play_wav(b"not a wav");
        assert!(result.is_err());
    }

    #[test]
    fn set_volume_clamps_and_is_readable() {
        let mut player = AudioPlayer::new();
        player.set_volume(9.0);
        assert_eq!(player.volume(), 2.0);
        player.set_volume(-1.0);
        assert_eq!(player.volume(), 0.0);
    }
}
