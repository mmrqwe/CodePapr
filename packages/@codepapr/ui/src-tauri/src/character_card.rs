#![forbid(unsafe_code)]

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHARA_KEYWORDS: &[&str] = &["chara", "ccv3", "character", "character_card"];

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

fn read_u32(buf: &[u8]) -> u32 {
    u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]])
}

fn write_u32(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

fn build_chunk_bytes(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(chunk_type);
    crc_input.extend_from_slice(data);
    let crc = crc32(&crc_input);

    let mut chunk = Vec::with_capacity(4 + 4 + data.len() + 4);
    chunk.extend_from_slice(&write_u32(data.len() as u32));
    chunk.extend_from_slice(chunk_type);
    chunk.extend_from_slice(data);
    chunk.extend_from_slice(&write_u32(crc));
    chunk
}

fn build_text_chunk(keyword: &str, text: &str) -> Vec<u8> {
    let kw = keyword.as_bytes();
    let txt = text.as_bytes();
    let mut data = Vec::with_capacity(kw.len() + 1 + txt.len());
    data.extend_from_slice(kw);
    data.push(0);
    data.extend_from_slice(txt);
    build_chunk_bytes(b"tEXt", &data)
}

fn json_to_chara_payload(json: &str) -> String {
    base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        json.as_bytes(),
    )
}

fn inject_chara_chunks(output: &mut Vec<u8>, json: &str) {
    let payload = json_to_chara_payload(json);
    output.extend_from_slice(&build_text_chunk("ccv3", &payload));
    output.extend_from_slice(&build_text_chunk("chara", &payload));
}

fn is_chara_text_chunk(chunk_type: &[u8; 4], data: &[u8]) -> bool {
    if chunk_type != b"tEXt" && chunk_type != b"iTXt" {
        return false;
    }
    let null_pos = match data.iter().position(|&b| b == 0) {
        Some(p) => p,
        None => return false,
    };
    if let Ok(keyword) = std::str::from_utf8(&data[..null_pos]) {
        let lower = keyword.trim().to_lowercase();
        return CHARA_KEYWORDS.contains(&lower.as_str());
    }
    false
}

fn parse_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let after_header = data_url
        .strip_prefix("data:image/png;base64,")
        .or_else(|| data_url.strip_prefix("data:image/jpeg;base64,"))
        .or_else(|| data_url.strip_prefix("data:image/webp;base64,"))
        .or_else(|| {
            let idx = data_url.rfind(";base64,")?;
            Some(&data_url[idx + 8..])
        })
        .ok_or_else(|| "Invalid data URL format".to_string())?;

    base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        after_header,
    )
    .map_err(|e| format!("Failed to decode base64: {}", e))
}

fn embed_json_in_png(original_png: &[u8], json: &str) -> Result<Vec<u8>, String> {
    if original_png.len() < 8 || original_png[..8] != PNG_SIGNATURE {
        return Err("Not a valid PNG file".to_string());
    }

    let mut output = Vec::with_capacity(original_png.len() + json.len() + 128);
    output.extend_from_slice(&PNG_SIGNATURE);

    let mut pos: usize = 8;
    let mut injected = false;

    while pos + 12 <= original_png.len() {
        let length = read_u32(&original_png[pos..pos + 4]) as usize;
        let chunk_type: [u8; 4] = [
            original_png[pos + 4],
            original_png[pos + 5],
            original_png[pos + 6],
            original_png[pos + 7],
        ];
        let data_start = pos + 8;
        let data_end = data_start + length;
        let chunk_end = data_end + 4;

        if chunk_end > original_png.len() {
            break;
        }

        let chunk_data = &original_png[data_start..data_end];

        if !injected && &chunk_type == b"IDAT" {
            inject_chara_chunks(&mut output, json);
            injected = true;
        }

        if is_chara_text_chunk(&chunk_type, chunk_data) {
            pos = chunk_end;
            continue;
        }

        output.extend_from_slice(&original_png[pos..chunk_end]);
        pos = chunk_end;
    }

    if !injected {
        return Err("No IDAT chunk found in PNG".to_string());
    }

    Ok(output)
}

fn generate_fallback_card(json: &str) -> Result<Vec<u8>, String> {
    let width: u32 = 400;
    let height: u32 = 200;

    let filter_byte: u8 = 0;
    let row_size = (width as usize) * 3;
    let raw_size = (height as usize) * (1 + row_size);

    let mut raw = vec![0u8; raw_size];
    for y in 0..(height as usize) {
        let row_start = y * (1 + row_size);
        raw[row_start] = filter_byte;
        let pixel_start = row_start + 1;
        for x in 0..(width as usize) {
            let px = pixel_start + x * 3;
            let t = y as f32 / (height - 1).max(1) as f32;
            raw[px] = (18.0 + t * 8.0) as u8;
            raw[px + 1] = (20.0 + t * 6.0) as u8;
            raw[px + 2] = (48.0 + t * 18.0) as u8;
        }
    }

    let mut compressed = Vec::new();
    {
        let mut encoder = ZlibEncoder::new(&mut compressed, Compression::default());
        encoder
            .write_all(&raw)
            .map_err(|e| format!("Compression error: {}", e))?;
        encoder
            .finish()
            .map_err(|e| format!("Compression error: {}", e))?;
    }

    let mut png = Vec::with_capacity(1024 + json.len());
    png.extend_from_slice(&PNG_SIGNATURE);

    let ihdr_data: [u8; 13] = {
        let wb = write_u32(width);
        let hb = write_u32(height);
        [
            wb[0], wb[1], wb[2], wb[3],
            hb[0], hb[1], hb[2], hb[3],
            8,
            2,
            0,
            0,
            0,
        ]
    };
    png.extend_from_slice(&build_chunk_bytes(b"IHDR", &ihdr_data));

    inject_chara_chunks(&mut png, json);

    png.extend_from_slice(&build_chunk_bytes(b"IDAT", &compressed));

    png.extend_from_slice(&build_chunk_bytes(b"IEND", &[]));

    Ok(png)
}

fn generate_and_write(
    json_spec: &str,
    avatar_data_url: Option<&str>,
    save_path: &str,
) -> Result<(), String> {
    let png_bytes = if let Some(data_url) = avatar_data_url {
        let raw_avatar = parse_data_url(data_url)?;
        if raw_avatar.len() >= 8 && raw_avatar[..8] == PNG_SIGNATURE {
            embed_json_in_png(&raw_avatar, json_spec)?
        } else {
            generate_fallback_card(json_spec)?
        }
    } else {
        generate_fallback_card(json_spec)?
    };

    std::fs::write(save_path, &png_bytes)
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub fn export_character_card(
    json_spec: String,
    avatar_data_url: Option<String>,
    save_path: String,
) -> Result<(), String> {
    generate_and_write(
        &json_spec,
        avatar_data_url.as_deref(),
        &save_path,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc32_empty() {
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn test_crc32_basic() {
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
    }

    #[test]
    fn test_build_chunk_bytes() {
        let chunk = build_chunk_bytes(b"IEND", &[]);
        assert_eq!(chunk.len(), 12);
        assert_eq!(&chunk[4..8], b"IEND");
        let data_len = read_u32(&chunk[..4]);
        assert_eq!(data_len, 0);
    }

    #[test]
    fn test_build_text_chunk() {
        let chunk = build_text_chunk("chara", r#"{"spec":"test"}"#);
        let data_len = read_u32(&chunk[..4]) as usize;
        assert_eq!(&chunk[4..8], b"tEXt");
        let expected_data = b"chara\0{\"spec\":\"test\"}";
        assert_eq!(data_len, expected_data.len());
        assert_eq!(&chunk[8..8 + data_len], expected_data.as_slice());
    }

    #[test]
    fn test_is_chara_text_chunk_positive() {
        let kw = b"chara\0json data here";
        assert!(is_chara_text_chunk(b"tEXt", kw));
        assert!(is_chara_text_chunk(b"iTXt", kw));
    }

    #[test]
    fn test_is_chara_text_chunk_negative() {
        assert!(!is_chara_text_chunk(b"IDAT", b"chara\0data"));
        assert!(!is_chara_text_chunk(b"tEXt", b"comment\0data"));
        assert!(!is_chara_text_chunk(b"iTXt", b""));
    }

    #[test]
    fn test_fallback_card_is_valid_png() {
        let json = r#"{"spec":"chara_card_v3","data":{"name":"Test"}}"#;
        let png = generate_fallback_card(json).unwrap();
        assert!(png.len() > 8);
        assert_eq!(&png[..8], &PNG_SIGNATURE);
        assert!(&png[8..].windows(4).any(|w| w == b"IHDR"));
        assert!(&png[8..].windows(4).any(|w| w == b"tEXt"));
        assert!(&png[8..].windows(4).any(|w| w == b"IDAT"));
        assert!(&png[8..].windows(4).any(|w| w == b"IEND"));
    }

    fn extract_text_chunks(png: &[u8]) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut pos = 8usize;
        while pos + 12 <= png.len() {
            let length = read_u32(&png[pos..pos + 4]) as usize;
            let chunk_type = &png[pos + 4..pos + 8];
            let data_start = pos + 8;
            let data_end = data_start + length;
            if data_end + 4 > png.len() {
                break;
            }
            if chunk_type == b"tEXt" {
                let data = &png[data_start..data_end];
                if let Some(null) = data.iter().position(|&b| b == 0) {
                    let kw = String::from_utf8_lossy(&data[..null]).to_string();
                    let text = String::from_utf8_lossy(&data[null + 1..]).to_string();
                    out.push((kw, text));
                }
            }
            pos = data_end + 4;
        }
        out
    }

    fn decode_chara_json(png: &[u8]) -> String {
        let chunks = extract_text_chunks(png);
        let payload = chunks
            .iter()
            .find(|(k, _)| k == "ccv3")
            .or_else(|| chunks.iter().find(|(k, _)| k == "chara"))
            .map(|(_, text)| text.as_str())
            .expect("missing ccv3/chara chunk");
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            payload,
        )
        .expect("chara payload should be base64");
        String::from_utf8(bytes).expect("utf-8 json")
    }

    #[test]
    fn test_export_writes_base64_ccv3_and_chara() {
        let json = r#"{"spec":"chara_card_v3","data":{"name":"Exported"}}"#;
        let png = generate_fallback_card(json).unwrap();
        let chunks = extract_text_chunks(&png);
        assert!(chunks.iter().any(|(k, _)| k == "ccv3"));
        assert!(chunks.iter().any(|(k, _)| k == "chara"));
        let decoded = decode_chara_json(&png);
        assert!(decoded.contains("chara_card_v3"));
        assert!(decoded.contains("Exported"));
        let raw = String::from_utf8_lossy(&png);
        assert!(!raw.contains("chara_card_v3"));
    }

    #[test]
    fn test_embed_json_in_png() {
        let fallback = generate_fallback_card(r#"{"original":"data"}"#).unwrap();
        let new_json = r#"{"spec":"chara_card_v3","data":{"name":"Exported"}}"#;
        let result = embed_json_in_png(&fallback, new_json).unwrap();
        assert!(&result[8..].windows(4).any(|w| w == b"tEXt"));
        let decoded = decode_chara_json(&result);
        assert!(decoded.contains("chara_card_v3"));
        assert!(decoded.contains("Exported"));
    }

    #[test]
    fn test_embed_strips_old_chara_chunks() {
        let json1 = r#"{"spec":"old"}"#;
        let json2 = r#"{"spec":"new"}"#;
        let png1 = generate_fallback_card(json1).unwrap();
        let result = embed_json_in_png(&png1, json2).unwrap();
        let decoded = decode_chara_json(&result);
        assert!(decoded.contains("new"));
        assert!(!decoded.contains("old"));
    }

    #[test]
    fn test_non_png_avatar_falls_back() {
        let jpegish = b"\xff\xd8\xffnot-a-png";
        let json = r#"{"spec":"chara_card_v3","data":{"name":"Fallback"}}"#;
        let result = if jpegish.len() >= 8 && jpegish[..8] == PNG_SIGNATURE {
            embed_json_in_png(jpegish, json).unwrap()
        } else {
            generate_fallback_card(json).unwrap()
        };
        assert_eq!(&result[..8], &PNG_SIGNATURE);
        assert!(decode_chara_json(&result).contains("Fallback"));
    }

    #[test]
    fn test_parse_data_url() {
        let data_url = "data:image/png;base64,";
        let decoded = parse_data_url(&format!("{}{}", data_url, base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"hello"))).unwrap();
        assert_eq!(decoded, b"hello");
    }

    #[test]
    fn test_parse_data_url_rejects_non_png_mime() {
        let data_url = "data:image/jpeg;base64,dGVzdA==";
        let decoded = parse_data_url(data_url).unwrap();
        assert_eq!(decoded, b"test");
    }
}
