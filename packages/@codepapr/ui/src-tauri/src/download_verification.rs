//! 下载校验共享模块：构建期（build.rs）与运行时（托管 LSP 下载）共用。
//!
//! 校验优先级：
//! 1. 锁定清单（`pinned_checksum`）：按完整 URL 精确匹配的 sha256/sha512，
//!    随二进制发布，攻击者无法在不重新编译的情况下篡改。
//! 2. 官方校验源（`fetch_official_checksum`）：nodejs.org SHASUMS256、
//!    Adoptium checksum API、.NET SHA512 文件、Eclipse `.sha256` 文件。
//! 3. 两者都没有：记录计算出的哈希并继续（不阻断功能）。
//!
//! 哈希不匹配一律是硬错误；校验源获取失败不阻断（记录警告），
//! 以保证校验端点临时不可用时功能仍然完整。
//!
//! 注意：运行时不提供任何环境变量绕过入口。

use sha2::{Digest, Sha256, Sha512};
use std::{fs, io::Read, path::Path, time::Duration};

const CHECKSUM_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// 计算文件的 SHA-256（`use_sha512 = false`）或 SHA-512 哈希，输出小写十六进制。
pub fn compute_file_hash(path: &Path, use_sha512: bool) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|err| format!("无法打开 {} 用于计算哈希: {err}", path.display()))?;
    let mut buffer = [0u8; 64 * 1024];

    if use_sha512 {
        let mut hasher = Sha512::new();
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|err| format!("读取 {} 计算哈希失败: {err}", path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(bytes_to_hex(hasher.finalize()))
    } else {
        let mut hasher = Sha256::new();
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|err| format!("读取 {} 计算哈希失败: {err}", path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(bytes_to_hex(hasher.finalize()))
    }
}

fn bytes_to_hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// 校验文件 SHA-256，不匹配时返回错误。
pub fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    verify_hash(path, expected_hex, "SHA256")
}

/// 校验文件 SHA-512，不匹配时返回错误。
pub fn verify_sha512(path: &Path, expected_hex: &str) -> Result<(), String> {
    verify_hash(path, expected_hex, "SHA512")
}

fn verify_hash(path: &Path, expected_hex: &str, algorithm: &str) -> Result<(), String> {
    let computed = compute_file_hash(path, algorithm == "SHA512")?;
    let expected = normalize_hash(expected_hex);
    if computed != expected {
        return Err(format!(
            "校验和不匹配 ({algorithm}): {}\n  预期: {expected}\n  实际: {computed}",
            path.display()
        ));
    }
    Ok(())
}

fn normalize_hash(hash: &str) -> String {
    hash.trim().to_ascii_lowercase()
}

/// 抓取小型文本资源（校验和文件专用）。
pub fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(CHECKSUM_FETCH_TIMEOUT)
        .user_agent("CodePapr/0.1")
        .build()
        .map_err(|err| format!("初始化校验和 HTTP 客户端失败: {err}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|err| format!("获取校验和 {url} 失败: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("获取校验和 {url} 返回 {}", response.status()));
    }
    response
        .text()
        .map_err(|err| format!("读取校验和响应 {url} 失败: {err}"))
}

/// 尝试获取下载 URL 对应的官方校验和。
/// 返回 `(预期哈希, 是否 SHA-512, 来源描述)`；无官方来源时返回 `Ok(None)`。
pub fn fetch_official_checksum(url: &str) -> Result<Option<(String, bool, &'static str)>, String> {
    // Node.js: https://nodejs.org/dist/{version}/node-{version}-{platform}-{arch}.{ext}
    if url.starts_with("https://nodejs.org/dist/") {
        return fetch_nodejs_checksum(url)
            .map(|hash| hash.map(|h| (h, false, "nodejs.org SHASUMS256")));
    }

    // Temurin JRE: https://api.adoptium.net/v3/binary/latest/{ver}/ga/...
    if url.starts_with("https://api.adoptium.net/v3/binary/") {
        let checksum_url = url.replace("/v3/binary/", "/v3/checksum/");
        let hash = fetch_text(&checksum_url)?;
        return Ok(Some((hash.trim().to_string(), false, "Adoptium API")));
    }

    // .NET SDK: https://dotnetcli.azureedge.net/dotnet/Sdk/{version}/{filename}
    if url.starts_with("https://dotnetcli.azureedge.net/dotnet/Sdk/") {
        return fetch_dotnet_checksum(url).map(|hash| hash.map(|h| (h, true, ".NET SHA512")));
    }

    // Eclipse JDTLS: 官方在压缩包旁提供同名 .sha256 文件
    if url.starts_with("https://download.eclipse.org/jdtls/") {
        let hash = fetch_text(&format!("{url}.sha256"))?;
        // .sha256 文件可能只含哈希，也可能带文件名后缀
        let hash = hash
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        if hash.is_empty() {
            return Err(format!("官方校验和文件内容为空: {url}.sha256"));
        }
        return Ok(Some((hash, false, "download.eclipse.org .sha256")));
    }

    Ok(None)
}

fn fetch_nodejs_checksum(url: &str) -> Result<Option<String>, String> {
    let version = url
        .split('/')
        .nth(4)
        .ok_or_else(|| format!("无法从 {url} 解析 Node.js 版本"))?;
    let filename = url
        .rsplit('/')
        .next()
        .ok_or_else(|| format!("无法从 {url} 解析文件名"))?;

    let shasums_url = format!("https://nodejs.org/dist/{version}/SHASUMS256.txt");
    let shasums = fetch_text(&shasums_url)?;

    for line in shasums.lines() {
        let parts: Vec<&str> = line.splitn(2, "  ").collect();
        if parts.len() == 2 && parts[1].trim() == filename {
            return Ok(Some(parts[0].trim().to_string()));
        }
    }

    Ok(None)
}

fn fetch_dotnet_checksum(url: &str) -> Result<Option<String>, String> {
    let parts: Vec<&str> = url.split('/').collect();
    if parts.len() < 7 {
        return Ok(None);
    }
    let version = parts[5];
    let filename = parts[6];

    let checksum_url =
        format!("https://dotnetcli.azureedge.net/dotnet/Sdk/{version}/SHA512/{filename}.sha512");
    let checksum = fetch_text(&checksum_url)?;
    Ok(Some(checksum.trim().to_string()))
}

/// 锁定清单：随源码发布的预期哈希，按完整 URL 精确匹配。
/// 返回 `(预期哈希, 是否 SHA-512)`。
///
/// 升级工具版本时必须同步更新此表（哈希可由 `shasum -a 256 <文件>` 计算）。
pub fn pinned_checksum(url: &str) -> Option<(&'static str, bool)> {
    const PINNED: &[(&str, &str, bool)] = &[
        // clangd 22.1.6（GitHub release 无官方校验和，锁定哈希）
        (
            "https://github.com/clangd/clangd/releases/download/22.1.6/clangd-mac-22.1.6.zip",
            "631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d",
            false,
        ),
        (
            "https://github.com/clangd/clangd/releases/download/22.1.6/clangd-linux-22.1.6.zip",
            "a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa",
            false,
        ),
        (
            "https://github.com/clangd/clangd/releases/download/22.1.6/clangd-windows-22.1.6.zip",
            "ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1",
            false,
        ),
        // sqls v0.2.48（GitHub release 无官方校验和，锁定哈希）
        (
            "https://github.com/sqls-server/sqls/releases/download/v0.2.48/sqls-darwin-0.2.48.zip",
            "b44165ca597a4b4298d56657bc911aa3ca8a591befefde4e29566923c6229f3d",
            false,
        ),
        (
            "https://github.com/sqls-server/sqls/releases/download/v0.2.48/sqls-linux-0.2.48.zip",
            "30047b92c41658c821b7803d2c2a3a1ce4e17ee769ceff6f24bb9e3daaf5d4dc",
            false,
        ),
        (
            "https://github.com/sqls-server/sqls/releases/download/v0.2.48/sqls-windows-0.2.48.zip",
            "df6453b2ddcb4e748547d0288b826251a24af099749dc7a9ddea587aac3d4365",
            false,
        ),
        // marksman 2026-02-08（GitHub release 无官方校验和，锁定哈希；linux 用 musl 静态构建）
        (
            "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman-macos",
            "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
            false,
        ),
        (
            "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman-linux-musl-x64",
            "d33df4544bb1f9f1b93b862ea78375ca8c04cd467ed2bcee354d605fc483ceee",
            false,
        ),
        (
            "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman-linux-musl-arm64",
            "cd3b91b630042cc09b20505583203f875fbb4bf2fdf74dd6d87fddc3238d2798",
            false,
        ),
        (
            "https://github.com/artempyanykh/marksman/releases/download/2026-02-08/marksman.exe",
            "a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705",
            false,
        ),
        // JDTLS 1.54.0 milestone（官方亦提供 .sha256，此处双保险）
        (
            "https://download.eclipse.org/jdtls/milestones/1.54.0/jdt-language-server-1.54.0-202511261751.tar.gz",
            "1a291a269bd88b3c4048219122961a52ec80872afbc7a3f34270b2ce77f7a14c",
            false,
        ),
    ];

    PINNED
        .iter()
        .find(|(pinned_url, _, _)| *pinned_url == url)
        .map(|(_, hash, use_sha512)| (*hash, *use_sha512))
}

/// 校验结果。`Err` 仅在校验和不匹配（或无法读取文件计算哈希）时返回。
#[derive(Debug)]
pub enum VerificationOutcome {
    /// 校验通过。
    Verified {
        algorithm: &'static str,
        source: &'static str,
    },
    /// 没有锁定哈希，也没有官方校验源；附带计算出的 SHA-256 供记录。
    NoChecksumSource { computed_sha256: String },
    /// 存在官方校验源但获取失败（网络问题等）；不阻断安装，附带计算哈希。
    ChecksumUnavailable {
        computed_sha256: String,
        error: String,
    },
}

impl VerificationOutcome {
    pub fn description(&self) -> String {
        match self {
            VerificationOutcome::Verified { algorithm, source } => {
                format!("校验通过 ({algorithm}, 来源: {source})")
            }
            VerificationOutcome::NoChecksumSource { computed_sha256 } => {
                format!("无可用校验源 (sha256={computed_sha256})")
            }
            VerificationOutcome::ChecksumUnavailable {
                computed_sha256,
                error,
            } => {
                format!("校验源获取失败: {error} (sha256={computed_sha256})")
            }
        }
    }
}

/// 校验已下载文件。哈希不匹配返回 `Err`（调用方必须中止安装并清理临时文件）。
pub fn verify_download(url: &str, path: &Path) -> Result<VerificationOutcome, String> {
    if let Some((expected, use_sha512)) = pinned_checksum(url) {
        let result = if use_sha512 {
            verify_sha512(path, expected)
        } else {
            verify_sha256(path, expected)
        };
        result.map_err(|err| format!("锁定清单校验失败: {url}\n{err}"))?;
        return Ok(VerificationOutcome::Verified {
            algorithm: if use_sha512 { "SHA512" } else { "SHA256" },
            source: "锁定清单",
        });
    }

    let computed_sha256 = compute_file_hash(path, false)?;
    match fetch_official_checksum(url) {
        Ok(Some((expected, use_sha512, source))) => {
            let computed = if use_sha512 {
                compute_file_hash(path, true)?
            } else {
                computed_sha256.clone()
            };
            if computed != normalize_hash(&expected) {
                let algorithm = if use_sha512 { "SHA512" } else { "SHA256" };
                return Err(format!(
                    "官方校验和不匹配 ({algorithm}, 来源: {source}): {url}\n  预期: {}\n  实际: {computed}",
                    expected.trim()
                ));
            }
            Ok(VerificationOutcome::Verified {
                algorithm: if use_sha512 { "SHA512" } else { "SHA256" },
                source,
            })
        }
        Ok(None) => Ok(VerificationOutcome::NoChecksumSource { computed_sha256 }),
        Err(error) => Ok(VerificationOutcome::ChecksumUnavailable {
            computed_sha256,
            error,
        }),
    }
}
