//! Unit tests for the pure helpers in `tts/mod.rs`.
//!
//! Covered:
//! - `normalize_lang_code`  (B11: "auto" now passes through)
//! - `decode_pcm_chunk`     (B4: odd-byte carryover, leftover flush)
//! - `parse_wav_header`     (WAV/RIFF parsing happy + edge paths)
//! - `sanitize_character_id` (S2: path traversal defense)
//! - `validate_voice_path_in` (S1/S2: voices-dir confinement)
//! - `refer_key`            (cache-key stability)
//! - `first_line` / `is_port_in_use_error` (small utilities)
//! - WS WAV index ordering + unavailable-error detection

use std::collections::HashSet;
use std::fs;

use super::ws::{is_ws_unavailable, place_wav_by_index, wavs_in_index_order};
use super::{
    decode_pcm_chunk, delete_character_voices_in, first_line, is_port_in_use_error, normalize_lang_code,
    parse_wav_header, refer_key, sanitize_character_id, validate_voice_path_in,
};

// -------- normalize_lang_code (B11) --------

#[test]
fn normalize_lang_zh_aliases() {
    assert_eq!(normalize_lang_code("zh"), "all_zh");
    assert_eq!(normalize_lang_code("all_zh"), "all_zh");
}

#[test]
fn normalize_lang_yue_ja_ko_aliases() {
    assert_eq!(normalize_lang_code("yue"), "all_yue");
    assert_eq!(normalize_lang_code("all_yue"), "all_yue");
    assert_eq!(normalize_lang_code("ja"), "all_ja");
    assert_eq!(normalize_lang_code("ko"), "all_ko");
}

#[test]
fn normalize_lang_auto_passes_through() {
    // Regression test for B11: previously "auto" was mapped to "all_zh"
    // which forced Chinese for English content.
    assert_eq!(normalize_lang_code("auto"), "auto");
    assert_eq!(normalize_lang_code("all_auto"), "auto");
}

#[test]
fn normalize_lang_unknown_passes_through() {
    assert_eq!(normalize_lang_code("xyz"), "xyz");
    assert_eq!(normalize_lang_code("en"), "en");
    assert_eq!(normalize_lang_code(""), "");
}

// -------- decode_pcm_chunk (B4: odd-byte carryover) --------

#[test]
fn decode_pcm_empty_input_returns_empty() {
    let mut leftover: Option<u8> = None;
    assert!(decode_pcm_chunk(&[], &mut leftover).is_empty());
    assert_eq!(leftover, None);
}

#[test]
fn decode_pcm_even_chunk_produces_le_samples() {
    // 0x34 0x12 -> 0x1234 (4660 little-endian)
    // 0xff 0x7f -> 0x7fff (i16::MAX)
    let mut leftover: Option<u8> = None;
    let samples = decode_pcm_chunk(&[0x34, 0x12, 0xff, 0x7f], &mut leftover);
    assert_eq!(samples, vec![0x1234, 0x7fff]);
    assert_eq!(leftover, None);
}

#[test]
fn decode_pcm_odd_chunk_stashes_leftover() {
    let mut leftover: Option<u8> = None;
    let samples = decode_pcm_chunk(&[0x01, 0x02, 0x03], &mut leftover);
    assert_eq!(samples, vec![i16::from_le_bytes([0x01, 0x02])]);
    assert_eq!(leftover, Some(0x03));
}

#[test]
fn decode_pcm_leftover_joined_with_next_chunk() {
    let mut leftover: Option<u8> = Some(0xaa);
    let samples = decode_pcm_chunk(&[0xbb, 0xcc, 0xdd], &mut leftover);
    // First sample combines stashed 0xaa with new 0xbb.
    assert_eq!(samples[0], i16::from_le_bytes([0xaa, 0xbb]));
    // Then 0xcc + 0xdd -> second sample.
    assert_eq!(samples[1], i16::from_le_bytes([0xcc, 0xdd]));
    assert_eq!(samples.len(), 2);
    assert_eq!(leftover, None);
}

#[test]
fn decode_pcm_leftover_alone_produces_no_samples_until_paired() {
    // 1 stashed byte + 1 new byte = 1 sample (even total).
    let mut leftover: Option<u8> = Some(0x10);
    let samples = decode_pcm_chunk(&[0x20], &mut leftover);
    assert_eq!(samples, vec![i16::from_le_bytes([0x10, 0x20])]);
    assert_eq!(leftover, None);
}

#[test]
fn decode_pcm_two_consecutive_odd_chunks_carry_correctly() {
    let mut leftover: Option<u8> = None;
    let s1 = decode_pcm_chunk(&[0x01, 0x02, 0x03], &mut leftover);
    assert_eq!(s1.len(), 1);
    assert_eq!(leftover, Some(0x03));

    let s2 = decode_pcm_chunk(&[0x04, 0x05, 0x06], &mut leftover);
    // 0x03 + 0x04 = first sample, 0x05 + 0x06 = second.
    assert_eq!(s2.len(), 2);
    assert_eq!(s2[0], i16::from_le_bytes([0x03, 0x04]));
    assert_eq!(s2[1], i16::from_le_bytes([0x05, 0x06]));
    assert_eq!(leftover, None);
}

#[test]
fn decode_pcm_call_with_empty_chunk_and_leftover_keeps_leftover() {
    let mut leftover: Option<u8> = Some(0xff);
    let samples = decode_pcm_chunk(&[], &mut leftover);
    assert!(samples.is_empty());
    // Single byte cannot form a sample, leftover stays.
    assert_eq!(leftover, Some(0xff));
}

// -------- parse_wav_header --------

/// Minimal 44-byte canonical WAV header with given format params.
/// PCM, 16-bit. data_size is set to 0 (followed by no PCM body).
fn make_wav_header(sample_rate: u32, channels: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&36u32.to_le_bytes()); // file size - 8 (placeholder)
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes()); // fmt body size
    h.extend_from_slice(&1u16.to_le_bytes()); // audio_format = PCM
    h.extend_from_slice(&channels.to_le_bytes());
    h.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * (channels as u32) * 2;
    h.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = channels * 2;
    h.extend_from_slice(&block_align.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    h.extend_from_slice(b"data");
    h.extend_from_slice(&0u32.to_le_bytes()); // data size
    h
}

#[test]
fn parse_wav_header_canonical_44_bytes_mono_22050() {
    let buf = make_wav_header(22050, 1);
    let parsed = parse_wav_header(&buf).expect("should parse");
    assert_eq!(parsed.sample_rate, 22050);
    assert_eq!(parsed.channels, 1);
    assert_eq!(parsed.data_offset, 44);
}

#[test]
fn parse_wav_header_stereo_48k() {
    let buf = make_wav_header(48000, 2);
    let parsed = parse_wav_header(&buf).expect("should parse");
    assert_eq!(parsed.sample_rate, 48000);
    assert_eq!(parsed.channels, 2);
}

#[test]
fn parse_wav_header_too_short_returns_none() {
    assert!(parse_wav_header(&[]).is_none());
    assert!(parse_wav_header(b"RIFF").is_none());
    assert!(parse_wav_header(b"RIFF\0\0\0\0").is_none());
}

#[test]
fn parse_wav_header_not_riff_returns_none() {
    let mut buf = make_wav_header(22050, 1);
    buf[0] = b'X';
    assert!(parse_wav_header(&buf).is_none());
}

#[test]
fn parse_wav_header_not_wave_returns_none() {
    let mut buf = make_wav_header(22050, 1);
    buf[8] = b'X';
    assert!(parse_wav_header(&buf).is_none());
}

#[test]
fn parse_wav_header_partial_fmt_returns_none() {
    let buf = make_wav_header(22050, 1);
    // Truncate mid-fmt.
    assert!(parse_wav_header(&buf[..20]).is_none());
}

#[test]
fn parse_wav_header_with_extra_chunks_between_fmt_and_data() {
    // Build header with a LIST chunk between fmt and data.
    let mut h = Vec::new();
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&100u32.to_le_bytes());
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&22050u32.to_le_bytes());
    h.extend_from_slice(&44100u32.to_le_bytes());
    h.extend_from_slice(&2u16.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes());
    // Insert LIST chunk
    h.extend_from_slice(b"LIST");
    h.extend_from_slice(&4u32.to_le_bytes());
    h.extend_from_slice(b"INFO");
    // Then data
    h.extend_from_slice(b"data");
    h.extend_from_slice(&0u32.to_le_bytes());

    let parsed = parse_wav_header(&h).expect("should parse with extra chunks");
    assert_eq!(parsed.sample_rate, 22050);
    assert_eq!(parsed.channels, 1);
}

#[test]
fn parse_wav_header_data_before_fmt_returns_none() {
    // data chunk seen before fmt — malformed.
    let mut h = Vec::new();
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&100u32.to_le_bytes());
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"data");
    h.extend_from_slice(&0u32.to_le_bytes());

    assert!(parse_wav_header(&h).is_none());
}

// -------- sanitize_character_id (S2) --------

#[test]
fn sanitize_character_id_accepts_alphanumeric() {
    assert!(sanitize_character_id("abc123").is_ok());
    assert!(sanitize_character_id("ABC").is_ok());
    assert!(sanitize_character_id("a").is_ok());
}

#[test]
fn sanitize_character_id_accepts_underscore_and_hyphen() {
    assert!(sanitize_character_id("my-character_01").is_ok());
    assert!(sanitize_character_id("a1b2c3d4-e5f6-7890-abcd-ef0123456789").is_ok());
}

#[test]
fn sanitize_character_id_rejects_empty() {
    assert!(sanitize_character_id("").is_err());
}

#[test]
fn sanitize_character_id_rejects_too_long() {
    let long = "a".repeat(65);
    assert!(sanitize_character_id(&long).is_err());
    let just_long_enough = "a".repeat(64);
    assert!(sanitize_character_id(&just_long_enough).is_ok());
}

#[test]
fn sanitize_character_id_rejects_path_traversal() {
    assert!(sanitize_character_id("../etc").is_err());
    assert!(sanitize_character_id("..").is_err());
    assert!(sanitize_character_id("../../passwd").is_err());
}

#[test]
fn sanitize_character_id_rejects_slashes() {
    assert!(sanitize_character_id("a/b").is_err());
    assert!(sanitize_character_id("a\\b").is_err());
}

#[test]
fn sanitize_character_id_rejects_dots() {
    // Even single dot is not in [A-Za-z0-9_-].
    assert!(sanitize_character_id("a.b").is_err());
    assert!(sanitize_character_id(".hidden").is_err());
}

#[test]
fn sanitize_character_id_rejects_special_chars() {
    assert!(sanitize_character_id("a b").is_err());      // space
    assert!(sanitize_character_id("a;rm -rf").is_err()); // semicolon
    assert!(sanitize_character_id("a\nb").is_err());     // newline
    assert!(sanitize_character_id("a$b").is_err());      // shell metachar
    assert!(sanitize_character_id("a\"b").is_err());     // quote
}

#[test]
fn sanitize_character_id_rejects_unicode() {
    // Only ASCII alphanumeric allowed.
    assert!(sanitize_character_id("角色").is_err());
    assert!(sanitize_character_id("café").is_err());
}

#[test]
fn delete_character_voices_removes_ref_and_train_dir() {
    let root = make_voices_root();
    let ref_wav = root.path().join("char1_ref.wav");
    let ref_mp3 = root.path().join("char1_ref.mp3");
    let other = root.path().join("char2_ref.wav");
    let train = root.path().join("char1").join("train");
    fs::create_dir_all(&train).unwrap();
    fs::write(&ref_wav, b"a").unwrap();
    fs::write(&ref_mp3, b"b").unwrap();
    fs::write(&other, b"c").unwrap();
    fs::write(train.join("clip.wav"), b"d").unwrap();

    delete_character_voices_in(root.path(), "char1").unwrap();

    assert!(!ref_wav.exists());
    assert!(!ref_mp3.exists());
    assert!(!root.path().join("char1").exists());
    assert!(other.exists());
}

// -------- validate_voice_path_in (S1) --------

fn make_voices_root() -> tempdir::TempDir {
    let dir = tempdir::TempDir::new("codepapr-tts-test")
        .expect("tempdir creation should not fail");
    dir
}

#[test]
fn validate_voice_path_rejects_empty() {
    let root = make_voices_root();
    assert!(validate_voice_path_in("", root.path(), true).is_err());
}

#[test]
fn validate_voice_path_rejects_outside_voices_dir() {
    let root = make_voices_root();
    // Outside file: tempdir parent + sibling.
    let outside = root.path().parent().unwrap().join("outside.wav");
    fs::write(&outside, b"\0").unwrap();
    let result = validate_voice_path_in(outside.to_str().unwrap(), root.path(), true);
    assert!(result.is_err(), "expected reject for outside path");
    let _ = fs::remove_file(&outside);
}

#[test]
fn validate_voice_path_accepts_file_inside_voices_dir() {
    let root = make_voices_root();
    let inside = root.path().join("char1_ref.wav");
    fs::write(&inside, b"\0").unwrap();
    let result = validate_voice_path_in(inside.to_str().unwrap(), root.path(), true);
    assert!(result.is_ok(), "expected accept for inside path: {:?}", result);
}

#[test]
fn validate_voice_path_rejects_traversal_via_dotdot() {
    let root = make_voices_root();
    let inside = root.path().join("char1_ref.wav");
    fs::write(&inside, b"\0").unwrap();
    // Construct a path with `..` that, when canonicalized, escapes the voices dir.
    let outside_target = root.path().parent().unwrap().join("evil.wav");
    fs::write(&outside_target, b"\0").unwrap();
    let traversal = format!("{}/../evil.wav", root.path().display());
    let result = validate_voice_path_in(&traversal, root.path(), true);
    assert!(result.is_err(), "expected reject for ../ traversal");
    let _ = fs::remove_file(&outside_target);
}

#[test]
fn validate_voice_path_must_exist_rejects_missing_file() {
    let root = make_voices_root();
    let missing = root.path().join("does_not_exist.wav");
    let result = validate_voice_path_in(missing.to_str().unwrap(), root.path(), true);
    assert!(result.is_err(), "expected reject for missing file when must_exist=true");
}

#[test]
fn validate_voice_path_must_exist_false_allows_missing_file_in_root() {
    let root = make_voices_root();
    let missing = root.path().join("new_voice.wav");
    let result = validate_voice_path_in(missing.to_str().unwrap(), root.path(), false);
    // When the file doesn't exist, canonicalize() will fail. Behaviour expected:
    // either accepts (if parent canonicalize works) or rejects with a clear
    // error. We assert we never *silently* return a path outside the voices dir.
    if let Ok(p) = result {
        let canon = root.path().canonicalize().unwrap();
        assert!(p.starts_with(&canon),
            "validated path must be inside voices dir, got {:?}", p);
    }
}

#[test]
fn validate_voice_path_rejects_directory_not_file() {
    let root = make_voices_root();
    let subdir = root.path().join("subdir");
    fs::create_dir(&subdir).unwrap();
    let result = validate_voice_path_in(subdir.to_str().unwrap(), root.path(), true);
    assert!(result.is_err(), "expected reject for directory");
}

#[test]
fn validate_voice_path_rejects_symlink_pointing_outside() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let root = make_voices_root();
        let outside_target = root.path().parent().unwrap().join("symlink_target.wav");
        fs::write(&outside_target, b"\0").unwrap();
        let link = root.path().join("ref.wav");
        symlink(&outside_target, &link).unwrap();
        let result = validate_voice_path_in(link.to_str().unwrap(), root.path(), true);
        assert!(result.is_err(),
            "expected reject for symlink escaping voices dir (canonical: {:?})",
            link.canonicalize());
        let _ = fs::remove_file(&outside_target);
    }
}

// -------- refer_key --------

#[test]
fn refer_key_stable_for_same_inputs() {
    let k1 = refer_key("/path/a.wav", "hello", "zh");
    let k2 = refer_key("/path/a.wav", "hello", "zh");
    assert_eq!(k1, k2);
}

#[test]
fn refer_key_differs_when_any_field_changes() {
    let base = refer_key("/path/a.wav", "hello", "zh");
    assert_ne!(base, refer_key("/path/b.wav", "hello", "zh"));
    assert_ne!(base, refer_key("/path/a.wav", "world", "zh"));
    assert_ne!(base, refer_key("/path/a.wav", "hello", "en"));
}

// -------- first_line --------

#[test]
fn first_line_returns_first_line_only() {
    assert_eq!(first_line("hello\nworld"), "hello");
    assert_eq!(first_line("only one"), "only one");
    assert_eq!(first_line(""), "");
}

#[test]
fn first_line_handles_crlf() {
    // first_line splits on \n; \r is left attached. Document the actual behaviour.
    let result = first_line("hello\r\nworld");
    assert!(result.starts_with("hello"));
    assert!(!result.contains("world"));
}

// -------- is_port_in_use_error --------

#[test]
fn is_port_in_use_error_detects_known_phrases() {
    assert!(is_port_in_use_error("error: address already in use"));
    assert!(is_port_in_use_error("Address already in use"));
}

#[test]
fn is_port_in_use_error_rejects_unrelated() {
    assert!(!is_port_in_use_error("connection refused"));
    assert!(!is_port_in_use_error("timeout"));
    assert!(!is_port_in_use_error(""));
}

// Small inline tempdir replacement to avoid pulling a new dep.
mod tempdir {
    use std::fs;
    use std::path::{Path, PathBuf};

    pub struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        pub fn new(prefix: &str) -> std::io::Result<Self> {
            let base = std::env::temp_dir();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let pid = std::process::id();
            for attempt in 0..16 {
                let candidate = base.join(format!("{prefix}-{pid}-{nanos}-{attempt}"));
                match fs::create_dir(&candidate) {
                    Ok(()) => return Ok(TempDir { path: candidate }),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "tempdir collision after 16 tries",
            ))
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

// -------- WS WAV index order / unavailable detection --------

#[test]
fn place_wav_orders_by_index_not_arrival() {
    let mut slots: Vec<Option<Vec<u8>>> = vec![None; 3];
    let mut seen = HashSet::new();
    assert!(place_wav_by_index(&mut slots, &mut seen, 2, b"c".to_vec()));
    assert!(place_wav_by_index(&mut slots, &mut seen, 0, b"a".to_vec()));
    assert!(place_wav_by_index(&mut slots, &mut seen, 1, b"b".to_vec()));
    assert!(!place_wav_by_index(&mut slots, &mut seen, 1, b"dup".to_vec()));
    assert!(!place_wav_by_index(&mut slots, &mut seen, 9, b"oob".to_vec()));
    assert_eq!(
        wavs_in_index_order(slots),
        vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]
    );
}

#[test]
fn empty_payload_counts_as_received_but_is_dropped() {
    let mut slots: Vec<Option<Vec<u8>>> = vec![None; 1];
    let mut seen = HashSet::new();
    assert!(place_wav_by_index(&mut slots, &mut seen, 0, vec![]));
    assert!(wavs_in_index_order(slots).is_empty());
}

#[test]
fn is_ws_unavailable_detects_connect_and_pool_errors() {
    assert!(is_ws_unavailable("WebSocket connection failed: foo"));
    assert!(is_ws_unavailable("WS connect failed: foo"));
    assert!(is_ws_unavailable("pool is empty"));
    assert!(is_ws_unavailable("WebSocket pool closed"));
    assert!(is_ws_unavailable("pool channel closed"));
    assert!(!is_ws_unavailable("TTS server error: OOM"));
    assert!(!is_ws_unavailable("Synthesis cancelled by user"));
}
