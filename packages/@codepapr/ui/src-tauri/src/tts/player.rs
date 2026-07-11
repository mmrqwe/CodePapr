use std::io::Cursor;

use rodio::buffer::SamplesBuffer;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};

static PLAYER_OUTPUT: std::sync::OnceLock<Option<OutputStreamHandle>> =
    std::sync::OnceLock::new();

fn output_handle() -> Option<&'static OutputStreamHandle> {
    let opt = PLAYER_OUTPUT.get_or_init(|| {
        OutputStream::try_default().ok().map(|(stream, handle)| {
            // The OutputStream must outlive all Sinks.  We never drop it,
            // which means the audio device is held open for the entire
            // process lifetime.  rodio 0.20 does not offer a way to
            // re-acquire the default device after drop, so `forget` is
            // the least-bad option.  Trade-off: switching output devices
            // requires an application restart.
            std::mem::forget(stream);
            handle
        })
    });
    opt.as_ref()
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

    /// Mode A entry-point. Replaces any in-flight playback with a single
    /// fully-decoded WAV.
    pub(crate) fn play_wav(&mut self, wav_bytes: &[u8]) -> Result<(), String> {
        let handle = output_handle()
            .ok_or_else(|| "Audio device not available".to_string())?;
        let cursor = Cursor::new(wav_bytes.to_vec());
        let source = Decoder::new(cursor).map_err(|e| format!("WAV decode error: {e}"))?;

        let sink = Sink::try_new(handle).map_err(|e| format!("Audio sink error: {e}"))?;
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
        let handle = output_handle()
            .ok_or_else(|| "Audio device not available".to_string())?;
        let cursor = Cursor::new(wav_bytes.to_vec());
        let source = Decoder::new(cursor).map_err(|e| format!("WAV decode error: {e}"))?;

        if self.sink.is_none() {
            let sink = Sink::try_new(handle).map_err(|e| format!("Audio sink error: {e}"))?;
            sink.set_volume(self.volume);
            self.sink = Some(sink);
        }

        self.sink.as_ref().unwrap().append(source);
        self.pcm_format = None;
        Ok(())
    }

    /// Mode F / Mode B PCM entry-point part 1. Initialise (or join) a
    /// raw-PCM streaming session with the given format.
    ///
    /// We only create a new sink when there is no sink yet (first call
    /// after `stop()` or app start) or when the PCM format actually
    /// changed (different sample rate / channels). Previously we also
    /// recreated on `sink.empty()`, but that races with the rodio worker
    /// finishing playback and causes sentences to be silently dropped.
    pub(crate) fn start_pcm_stream(
        &mut self,
        sample_rate: u32,
        channels: u16,
    ) -> Result<(), String> {
        if !(channels == 1 || channels == 2) {
            return Err(format!("Unsupported channel count: {channels}"));
        }
        let handle = output_handle()
            .ok_or_else(|| "Audio device not available".to_string())?;

        let format_changed = self.pcm_format != Some((sample_rate, channels));

        if self.sink.is_none() || format_changed {
            let sink = Sink::try_new(handle).map_err(|e| format!("Audio sink error: {e}"))?;
            sink.set_volume(self.volume);
            if let Some(old) = self.sink.replace(sink) {
                old.stop();
            }
        }

        self.pcm_format = Some((sample_rate, channels));
        Ok(())
    }

    /// Mode F entry-point part 2. Feed raw 16-bit PCM samples (interleaved
    /// for multi-channel) into the active stream. Each chunk becomes its
    /// own `SamplesBuffer` source appended to the shared sink, which rodio
    /// plays back-to-back without gaps.
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
        self.sink.as_ref().map_or(false, |s| !s.empty())
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
        assert!(result.is_err(),
            "push_pcm_samples must reject when pcm_format is None");
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
}
