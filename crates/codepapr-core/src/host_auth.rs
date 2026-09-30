//! Loopback TCP handshake for `codepapr-server`.
//!
//! The token never travels on the socket. The server sends a nonce, the client
//! proves it knows the token with HMAC-SHA256, and the server proves the same
//! back. Stdio has no listener, so it does not use this handshake.

use std::path::Path;

use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const HMAC_BLOCK: usize = 64;

pub fn random_token() -> String {
    new_nonce()
}

pub fn new_nonce() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn client_proof(token: &str, server_nonce: &str, client_nonce: &str) -> String {
    let message = format!("client:{server_nonce}:{client_nonce}");
    hex::encode(hmac_sha256(token.as_bytes(), message.as_bytes()))
}

pub fn server_proof(token: &str, server_nonce: &str, client_nonce: &str) -> String {
    let message = format!("server:{server_nonce}:{client_nonce}");
    hex::encode(hmac_sha256(token.as_bytes(), message.as_bytes()))
}

pub fn proofs_match(expected: &str, actual: &str) -> bool {
    let a = expected.as_bytes();
    let b = actual.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

pub fn challenge_line(server_nonce: &str) -> String {
    let value = json!({
        "jsonrpc": "2.0",
        "method": "auth/challenge",
        "params": { "nonce": server_nonce },
    });
    format!("{value}\n")
}

pub fn auth_request_line(client_nonce: &str, proof: &str) -> String {
    let value = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "auth",
        "params": {
            "clientNonce": client_nonce,
            "proof": proof,
        },
    });
    format!("{value}\n")
}

/// Checks one client auth line and returns `(request id, server proof)`.
pub fn accept_client_auth(
    token: &str,
    server_nonce: &str,
    line: &str,
) -> Result<(Value, String), String> {
    let value: Value = serde_json::from_str(line.trim())
        .map_err(|_| "认证请求不是合法 JSON".to_string())?;
    if value.get("method").and_then(|v| v.as_str()) != Some("auth") {
        return Err("连接后的第一条请求必须是 auth".to_string());
    }
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let client_nonce = params
        .get("clientNonce")
        .and_then(|v| v.as_str())
        .filter(|nonce| nonce.len() >= 32)
        .ok_or_else(|| "认证请求缺少 clientNonce".to_string())?;
    let proof = params
        .get("proof")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "认证请求缺少 proof".to_string())?;
    let expected = client_proof(token, server_nonce, client_nonce);
    if !proofs_match(&expected, proof) {
        return Err("认证失败".to_string());
    }
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    Ok((id, server_proof(token, server_nonce, client_nonce)))
}

pub fn verify_server_auth(
    token: &str,
    server_nonce: &str,
    client_nonce: &str,
    line: &str,
) -> Result<(), String> {
    let value: Value = serde_json::from_str(line.trim())
        .map_err(|_| "认证响应不是合法 JSON".to_string())?;
    if let Some(err) = value.get("error") {
        let message = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("认证失败");
        return Err(message.to_string());
    }
    let proof = value
        .pointer("/result/serverProof")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "认证响应缺少 serverProof".to_string())?;
    let expected = server_proof(token, server_nonce, client_nonce);
    if !proofs_match(&expected, proof) {
        return Err("服务端认证失败".to_string());
    }
    Ok(())
}

pub fn parse_challenge_nonce(line: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(line.trim())
        .map_err(|_| "认证挑战不是合法 JSON".to_string())?;
    if value.get("method").and_then(|v| v.as_str()) != Some("auth/challenge") {
        return Err("服务端未发起认证挑战".to_string());
    }
    value
        .pointer("/params/nonce")
        .and_then(|v| v.as_str())
        .filter(|nonce| nonce.len() >= 32)
        .map(|nonce| nonce.to_string())
        .ok_or_else(|| "认证挑战缺少 nonce".to_string())
}

/// TCP clients may only talk to loopback. `addr` is `host:port`.
pub fn ensure_loopback_addr(addr: &str) -> Result<(), String> {
    let host = addr
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(addr)
        .trim()
        .trim_matches(['[', ']']);
    if matches!(host, "127.0.0.1" | "localhost" | "::1") {
        Ok(())
    } else {
        Err(format!(
            "codepapr-server 只接受本机回环地址，拒绝连接 {addr}"
        ))
    }
}

pub fn read_token_file(path: &Path) -> Result<String, String> {
    let token = std::fs::read_to_string(path)
        .map_err(|err| format!("读取认证令牌失败: {err}"))?;
    normalize_token(&token)
}

pub fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("创建认证令牌目录失败: {err}"))?;
        }
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|err| format!("写入认证令牌失败: {err}"))?;
        file.write_all(token.as_bytes())
            .map_err(|err| format!("写入认证令牌失败: {err}"))?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, token).map_err(|err| format!("写入认证令牌失败: {err}"))
    }
}

pub fn read_stdin_token() -> Result<String, String> {
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|err| format!("读取标准输入中的认证令牌失败: {err}"))?;
    normalize_token(&buf)
}

pub fn normalize_token(raw: &str) -> Result<String, String> {
    let token = raw.trim().to_string();
    if token.len() < 32 {
        return Err("认证令牌长度不足".to_string());
    }
    Ok(token)
}

pub async fn client_handshake(
    stream: &mut tokio::net::TcpStream,
    token: &str,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let line = read_line_exact(stream, "读取认证挑战失败").await?;
    let server_nonce = parse_challenge_nonce(&line)?;
    let client_nonce = new_nonce();
    let proof = client_proof(token, &server_nonce, &client_nonce);
    stream
        .write_all(auth_request_line(&client_nonce, &proof).as_bytes())
        .await
        .map_err(|err| format!("发送认证请求失败: {err}"))?;
    stream
        .flush()
        .await
        .map_err(|err| format!("发送认证请求失败: {err}"))?;
    let line = read_line_exact(stream, "读取认证响应失败").await?;
    verify_server_auth(token, &server_nonce, &client_nonce, &line)
}

async fn read_line_exact(
    stream: &mut tokio::net::TcpStream,
    context: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|err| format!("{context}: {err}"))?;
        if n == 0 {
            if buf.is_empty() {
                return Err("codepapr-server 在认证完成前关闭了连接".to_string());
            }
            break;
        }
        buf.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
        if buf.len() > 8192 {
            return Err("认证报文过长".to_string());
        }
    }
    String::from_utf8(buf).map_err(|_| "认证报文不是 UTF-8".to_string())
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key_block = [0u8; HMAC_BLOCK];
    if key.len() > HMAC_BLOCK {
        let digest = Sha256::digest(key);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; HMAC_BLOCK];
    let mut opad = [0x5cu8; HMAC_BLOCK];
    for i in 0..HMAC_BLOCK {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    let digest = outer.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_matches_rfc_4231_case_1() {
        let key = [0x0bu8; 20];
        let mac = hmac_sha256(&key, b"Hi There");
        assert_eq!(
            hex::encode(mac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn proofs_are_directional_and_constant_width() {
        let token = "token-token-token-token-token-token";
        let client = client_proof(token, "server-nonce-server-nonce-server", "client-nonce-client-nonce-client");
        let server = server_proof(token, "server-nonce-server-nonce-server", "client-nonce-client-nonce-client");
        assert_ne!(client, server);
        assert!(proofs_match(&client, &client));
        assert!(!proofs_match(&client, &server));
        assert!(!proofs_match(&client, "short"));
    }

    #[test]
    fn loopback_addr_rejects_other_hosts() {
        assert!(ensure_loopback_addr("127.0.0.1:9090").is_ok());
        assert!(ensure_loopback_addr("[::1]:9090").is_ok());
        assert!(ensure_loopback_addr("localhost:1").is_ok());
        assert!(ensure_loopback_addr("192.168.1.2:9090").is_err());
        assert!(ensure_loopback_addr("0.0.0.0:9090").is_err());
    }

    #[tokio::test]
    async fn handshake_accepts_the_token_holder() {
        let token = random_token();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_token = token.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let nonce = new_nonce();
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
            socket
                .write_all(challenge_line(&nonce).as_bytes())
                .await
                .unwrap();
            let mut reader = tokio::io::BufReader::new(&mut socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let (id, proof) = accept_client_auth(&server_token, &nonce, &line).unwrap();
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "serverProof": proof },
            });
            reader
                .get_mut()
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        });

        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        client_handshake(&mut client, &token).await.unwrap();
        server.await.unwrap();
    }
}
