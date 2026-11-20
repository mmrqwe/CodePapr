use codepapr_core::shell::process_tree::background_command;
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::Stdio,
};

use base64::Engine;
use rodio::{Decoder, Source};

use super::{sanitize_character_id, validate_voice_path_in};

pub(super) fn save_voice_file(
    dir: &Path,
    character_id: &str,
    base64_data: &str,
    extension: &str,
) -> Result<String, String> {
    sanitize_character_id(character_id)?;
    let extension = extension.to_ascii_lowercase();
    if extension.is_empty()
        || extension.len() > 16
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err("Invalid file extension".to_string());
    }

    let encoded = base64_data
        .split_once(";base64,")
        .map_or(base64_data, |(_, data)| data);
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Invalid audio data: {error}"))?;
    fs::create_dir_all(dir).map_err(|error| format!("Cannot create voices directory: {error}"))?;
    let staging = tempfile::tempdir_in(dir)
        .map_err(|error| format!("Cannot prepare reference audio: {error}"))?;
    let staged_wav = staging.path().join("reference.wav");
    match extension.as_str() {
        "wav" => fs::write(&staged_wav, &data)
            .map_err(|error| format!("Cannot write reference audio: {error}"))?,
        "mp3" => convert_mp3_to_wav(data, &staged_wav)?,
        _ => {
            let input = staging.path().join(format!("input.{extension}"));
            fs::write(&input, &data)
                .map_err(|error| format!("Cannot write reference audio: {error}"))?;
            convert_with_ffmpeg(&input, &staged_wav)?;
        }
    }

    // Replace the previous clip only after the new WAV has been written successfully.
    let destination = dir.join(format!("{character_id}_ref.wav"));
    fs::rename(&staged_wav, &destination)
        .map_err(|error| format!("Cannot save reference audio: {error}"))?;
    let path = validate_voice_path_in(&destination.to_string_lossy(), dir, true)?;
    Ok(path.to_string_lossy().into_owned())
}

fn convert_mp3_to_wav(data: Vec<u8>, output: &Path) -> Result<(), String> {
    let mut decoder = Decoder::new_mp3(Cursor::new(data))
        .map_err(|error| format!("Cannot decode MP3: {error}"))?;
    let channels = usize::from(decoder.channels());
    let sample_rate = decoder.sample_rate();
    if channels == 0 || sample_rate == 0 {
        return Err("MP3 has an invalid audio format".to_string());
    }
    let mut samples = std::iter::from_fn(|| {
        let first = i32::from(decoder.next()?);
        let rest = decoder
            .by_ref()
            .take(channels - 1)
            .map(i32::from)
            .sum::<i32>();
        Some(((first + rest) / channels as i32) as i16)
    })
    .peekable();
    if samples.peek().is_none() {
        return Err("MP3 contains no audio samples".to_string());
    }

    let write_wav = || -> Result<(), hound::Error> {
        let mut writer = hound::WavWriter::create(
            output,
            hound::WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )?;
        for sample in samples {
            writer.write_sample(sample)?;
        }
        writer.finalize()
    };
    write_wav().map_err(|error| format!("Cannot write reference WAV: {error}"))
}

fn convert_with_ffmpeg(input: &Path, output: &Path) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or("FFmpeg is required to convert this audio format")?;
    let result = background_command(ffmpeg)
        .args(["-nostdin", "-loglevel", "error", "-i"])
        .arg(input)
        .args(["-ar", "16000", "-ac", "1", "-sample_fmt", "s16"])
        .arg(output)
        .output()
        .map_err(|error| format!("Cannot run FFmpeg: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "Cannot convert audio to WAV: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(())
}

fn find_ffmpeg() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("ffmpeg")];
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        candidates.push(local_app_data.join("Microsoft/WinGet/Links/ffmpeg.exe"));
        candidates.push(local_app_data.join("codepapr/bin/ffmpeg.exe"));
    }
    #[cfg(not(windows))]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        PathBuf::from("/usr/local/bin/ffmpeg"),
    ]);

    candidates.into_iter().find(|candidate| {
        background_command(candidate)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_mp3_as_mono_wav_and_preserves_it_on_failed_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let mp3 = include_bytes!("fixtures/stereo-tone.mp3");
        let data_url = format!(
            "data:audio/mpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(mp3)
        );
        let path = save_voice_file(dir.path(), "char_test", &data_url, "MP3").unwrap();
        assert!(path.ends_with("char_test_ref.wav"));

        let mut reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 32_000);
        assert_eq!(reader.spec().bits_per_sample, 16);
        assert!(reader.duration() > reader.spec().sample_rate / 10);
        assert!(reader.samples::<i16>().any(|sample| sample.unwrap() != 0));
        drop(reader);

        let valid_wav = fs::read(&path).unwrap();
        assert!(save_voice_file(dir.path(), "char_test", "YmFkIG1wMw==", "mp3").is_err());
        assert_eq!(fs::read(&path).unwrap(), valid_wav);
        let replacement = save_voice_file(dir.path(), "char_test", &data_url, "mp3").unwrap();
        assert_eq!(replacement, path);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
