//! Stronghold-backed secret storage for API keys.
//!
//! Replaces OS keychain with [IOTA Stronghold](https://github.com/iotaledger/stronghold.rs)
//! to avoid macOS Keychain permission prompts on every read.
//!
//! Architecture:
//! - `vault.key`  → random 32‑byte key (generated once, OS file perms protect it)
//! - `salt.txt`   → argon2 salt (generated once)
//! - `vault.hold` → Stronghold encrypted snapshot
//!
//! On first launch we generate the vault key + salt, derive the argon2 hash, and
//! create the Stronghold snapshot.  Subsequent launches read the key file and
//! re‑derive the same hash to unlock the vault.
//!
//! Migration: on first successful vault open, we attempt to import any existing
//! API keys from the OS keychain (the old `keyring`‑based storage) and then
//! delete them from the keychain so the user never sees a prompt again.

#![forbid(unsafe_code)]

use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::Arc,
};

use rand::RngCore;
use tauri_plugin_stronghold::{
    kdf::KeyDerivation,
    stronghold::{Error as StrongholdError, Stronghold},
};
use zeroize::Zeroizing;

// ── File names ────────────────────────────────────────────────────────

const VAULT_KEY_FILE: &str = "vault.key";
const VAULT_SALT_FILE: &str = "salt.txt";
const VAULT_SNAPSHOT_FILE: &str = "vault.hold";
const CLIENT_NAME: &[u8] = b"codepapr";

const VAULT_KEY_LEN: usize = 32;

// ── Error helpers ─────────────────────────────────────────────────────

fn map_stronghold_err(err: StrongholdError) -> String {
    format!("Stronghold 操作失败: {err}")
}

// ── AppSecrets ────────────────────────────────────────────────────────

/// Manages encrypted persistent storage of API keys via Stronghold.
///
/// Wrapped in `Arc` so it can be shared across Tauri command handlers.
/// All public methods take `&self` — Stronghold uses internal locking.
#[derive(Clone)]
pub(crate) struct AppSecrets {
    stronghold: Arc<Stronghold>,
}

impl AppSecrets {
    // ── Initialization ────────────────────────────────────────────────

    /// Initialise (or open) the Stronghold vault under `app_data_dir`.
    ///
    /// If the vault doesn't exist yet, a random key is generated and
    /// persisted to `vault.key`.  The key is hashed with argon2 (using a
    /// once‑generated salt) and fed to Stronghold as the password.
    pub(crate) fn init(app_data_dir: &Path) -> Result<Self, String> {
        let key_path = app_data_dir.join(VAULT_KEY_FILE);
        let salt_path = app_data_dir.join(VAULT_SALT_FILE);
        let snapshot_path = app_data_dir.join(VAULT_SNAPSHOT_FILE);

        // Ensure the data directory exists.
        fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("创建数据目录失败: {e}"))?;

        // Generate or read the vault key.
        let vault_key = Self::load_or_create_vault_key(&key_path)?;

        // Generate or read the argon2 salt.
        let _salt = Self::load_or_create_salt(&salt_path)?;

        // Derive the 32‑byte password via argon2.
        //
        // 主密钥必须先 hex 编码再作为 argon2 口令：32 字节随机密钥直接走
        // String::from_utf8_lossy（旧实现）时，所有非法 UTF-8 序列都被替换成
        // 同一个 U+FFFD，口令实际熵从 256bit 坍缩到远低于设计值，拿到
        // vault.hold + salt.txt 的攻击者离线爆破成本骤降。
        let password = Zeroizing::new(KeyDerivation::argon2(
            &hex::encode(&*vault_key),
            &salt_path,
        ));

        // Open or create the Stronghold snapshot.
        // 存量 vault 是旧口令（lossy UTF-8）加密的：先用新口令尝试打开，
        // 失败则用旧口令打开并以新口令重加密落盘（一次性迁移）。
        let stronghold = if snapshot_path.exists() {
            match Stronghold::new(&snapshot_path, password.to_vec()) {
                Ok(stronghold) => stronghold,
                Err(_) => {
                    let legacy_password = Zeroizing::new(KeyDerivation::argon2(
                        &String::from_utf8_lossy(&vault_key),
                        &salt_path,
                    ));
                    let legacy = Stronghold::new(&snapshot_path, legacy_password.to_vec())
                        .map_err(map_stronghold_err)?;
                    // 必须先把 client 状态从快照载入内存，否则 commit 写入的
                    // 内存 clients 映射为空，重加密会丢光所有已存密钥。
                    // 载入失败必须中止：若静默继续，重加密将把整个快照覆写成空
                    // 状态，用户全部密钥永久丢失。
                    legacy.load_client(CLIENT_NAME).map_err(|e| {
                        format!("Stronghold 旧快照加载失败(已中止,未改动快照): {e}")
                    })?;
                    let new_keyprovider =
                        iota_stronghold::KeyProvider::try_from(password.clone())
                            .map_err(|e| format!("Stronghold 操作失败: {e}"))?;
                    let snapshot = iota_stronghold::SnapshotPath::from_path(&snapshot_path);
                    legacy
                        .inner()
                        .commit_with_keyprovider(&snapshot, &new_keyprovider)
                        .map_err(|e| format!("Stronghold 操作失败: {e}"))?;
                    drop(legacy);
                    Stronghold::new(&snapshot_path, password.to_vec())
                        .map_err(map_stronghold_err)?
                }
            }
        } else {
            Stronghold::new(&snapshot_path, password.to_vec()).map_err(map_stronghold_err)?
        };

        // Restore client state from the loaded snapshot into the in-memory
        // HashMap. Without this, get_client only sees an empty HashMap and
        // the fallback below creates a fresh empty client that overwrites
        // the snapshot on save(), destroying all persisted secrets.
        // 快照已存在但载入失败时必须中止：继续往下走会用空 client 覆写
        // 快照,静默丢光全部密钥。首次启动(无快照)则无需载入。
        if snapshot_path.exists() {
            stronghold.load_client(CLIENT_NAME).map_err(|e| {
                format!("Stronghold 快照加载失败(已中止,未改动快照): {e}")
            })?;
        }

        // Only create a new client if the snapshot truly doesn't contain one
        // yet (i.e. this is the very first launch).
        if stronghold.get_client(CLIENT_NAME).is_err() {
            stronghold
                .create_client(CLIENT_NAME)
                .map_err(|e| format!("Stronghold 操作失败: {e}"))?;
            // Persist immediately so the client survives restarts.
            stronghold.save().map_err(map_stronghold_err)?;
        }

        Ok(Self {
            stronghold: Arc::new(stronghold),
        })
    }

    // ── Secret CRUD ───────────────────────────────────────────────────

    /// Retrieve a secret from the vault. Returns `None` if the key doesn't
    /// exist or on any read error (graceful degradation).
    pub(crate) fn get_secret(&self, account: &str) -> Option<String> {
        let client = self.stronghold.get_client(CLIENT_NAME).ok()?;
        let data = client.store().get(account.as_ref()).ok()??;
        String::from_utf8(data).ok()
    }

    /// Store a secret in the vault.  The vault is **not** auto‑saved —
    /// call [`save`] afterwards to persist.
    ///
    /// [`save`]: Self::save
    pub(crate) fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let client = self
            .stronghold
            .get_client(CLIENT_NAME)
            .map_err(|e| format!("Stronghold 操作失败: {e}"))?;
        client
            .store()
            .insert(
                account.as_bytes().to_vec(),
                value.as_bytes().to_vec(),
                None, // no expiry
            )
            .map_err(|e| format!("Stronghold 操作失败: {e}"))?;
        Ok(())
    }

    /// Delete a secret from the vault.  Idempotent — no error if the key
    /// doesn't exist.  Call [`save`] afterwards to persist.
    ///
    /// [`save`]: Self::save
    pub(crate) fn delete_secret(&self, account: &str) -> Result<(), String> {
        let client = self
            .stronghold
            .get_client(CLIENT_NAME)
            .map_err(|e| format!("Stronghold 操作失败: {e}"))?;
        // `delete` returns an error when the key is not found; we treat
        // that as success (idempotent delete).
        let _ = client.store().delete(account.as_ref());
        Ok(())
    }

    /// Persist all in‑memory changes to the encrypted snapshot on disk.
    pub(crate) fn save(&self) -> Result<(), String> {
        self.stronghold.save().map_err(map_stronghold_err)
    }

    // ── Internals ─────────────────────────────────────────────────────

    fn load_or_create_vault_key(key_path: &Path) -> Result<Zeroizing<Vec<u8>>, String> {
        if key_path.exists() {
            let mut buf = Vec::new();
            fs::File::open(key_path)
                .map_err(|e| format!("读取 vault 密钥文件失败: {e}"))?
                .read_to_end(&mut buf)
                .map_err(|e| format!("读取 vault 密钥文件失败: {e}"))?;
            if buf.len() != VAULT_KEY_LEN {
                return Err("vault 密钥文件长度不正确".into());
            }
            return Ok(Zeroizing::new(buf));
        }

        // Generate a fresh random key.
        let mut key = vec![0u8; VAULT_KEY_LEN];
        rand::rngs::OsRng.fill_bytes(&mut key);
        // Unix 上以 0600 原子创建：旧实现先按默认权限创建再 chmod，存在主密钥
        // 短暂全局可读的窗口。
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(key_path)
                .map_err(|e| format!("创建 vault 密钥文件失败: {e}"))?
                .write_all(&key)
                .map_err(|e| format!("写入 vault 密钥文件失败: {e}"))?;
        }
        #[cfg(not(unix))]
        {
            fs::File::create(key_path)
                .map_err(|e| format!("创建 vault 密钥文件失败: {e}"))?
                .write_all(&key)
                .map_err(|e| format!("写入 vault 密钥文件失败: {e}"))?;
        }

        // Restrict permissions on Unix so only the owner can read (兜底覆盖
        // 旧版本遗留文件的权限)。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(key_path, fs::Permissions::from_mode(0o600));
        }

        Ok(Zeroizing::new(key))
    }

    fn load_or_create_salt(salt_path: &Path) -> Result<Vec<u8>, String> {
        if salt_path.exists() {
            let mut buf = Vec::new();
            fs::File::open(salt_path)
                .map_err(|e| format!("读取 salt 文件失败: {e}"))?
                .read_to_end(&mut buf)
                .map_err(|e| format!("读取 salt 文件失败: {e}"))?;
            return Ok(buf);
        }

        // Generate a fresh random salt (32 bytes is plenty for argon2).
        let mut salt = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        fs::File::create(salt_path)
            .map_err(|e| format!("创建 salt 文件失败: {e}"))?
            .write_all(&salt)
            .map_err(|e| format!("写入 salt 文件失败: {e}"))?;
        Ok(salt)
    }
}

// ── Migration from legacy keyring ─────────────────────────────────────

/// Attempt to migrate API keys from the OS keychain into Stronghold.
///
/// Called once after vault initialisation.  Keys that are successfully
/// migrated are removed from the keychain so the user won't be prompted
/// again.
pub(crate) fn migrate_from_keyring(
    app_secrets: &AppSecrets,
    accounts: &[&str],
) -> Result<usize, String> {
    let mut migrated = 0usize;

    for &account in accounts {
        // Try the old keyring backend.
        let old_secret = match keyring::Entry::new("CodePapr", account) {
            Ok(entry) => match entry.get_password() {
                Ok(val) if !val.is_empty() => Some(val),
                _ => None,
            },
            Err(_) => None,
        };

        if let Some(value) = old_secret {
            // Only migrate if the stronghold doesn't already have this key.
            if app_secrets.get_secret(account).is_none() {
                app_secrets.set_secret(account, &value)?;
                // 先落盘成功再删 Keychain 条目：否则一旦后续保存失败(磁盘满、
                // 权限异常),密钥只存在于内存,重启后旧条目已被删、新快照里没有,
                // 用户密钥永久丢失。
                app_secrets.save()?;
                migrated += 1;
            }

            // Best-effort delete from keychain.
            if let Ok(entry) = keyring::Entry::new("CodePapr", account) {
                let _ = entry.delete_credential();
            }
        }
    }

    Ok(migrated)
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        // 每个测试独立目录：仅用 PID 作后缀时并行运行的 vault 测试共享同一目录，
        // 一个测试的 remove_dir_all 会摧毁另一个测试正在使用的 vault，导致随机失败。
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "codepapr-vault-test-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_creates_vault_and_persists() {
        let dir = temp_dir();
        let secrets = AppSecrets::init(&dir).expect("init should succeed");

        // Key, salt, and snapshot files must exist.
        assert!(dir.join(VAULT_KEY_FILE).exists());
        assert!(dir.join(VAULT_SALT_FILE).exists());
        assert!(dir.join(VAULT_SNAPSHOT_FILE).exists());

        // Round-trip a secret.
        secrets
            .set_secret("test_key", "my-api-token-123")
            .expect("set should succeed");
        secrets.save().expect("save should succeed");

        let value = secrets.get_secret("test_key");
        assert_eq!(value.as_deref(), Some("my-api-token-123"));

        // Drop and re-open – should survive.
        drop(secrets);
        let secrets2 = AppSecrets::init(&dir).expect("re-init should succeed");
        let value2 = secrets2.get_secret("test_key");
        assert_eq!(value2.as_deref(), Some("my-api-token-123"));

        // Cleanup.
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = temp_dir();
        let secrets = AppSecrets::init(&dir).expect("init should succeed");

        // Delete non-existent key should not error.
        assert!(secrets.delete_secret("no-such-key").is_ok());

        // Set, then delete.
        secrets.set_secret("del_key", "val").unwrap();
        secrets.save().unwrap();
        assert_eq!(secrets.get_secret("del_key").as_deref(), Some("val"));

        secrets.delete_secret("del_key").unwrap();
        secrets.save().unwrap();
        assert!(secrets.get_secret("del_key").is_none());

        // Delete again – still ok.
        assert!(secrets.delete_secret("del_key").is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_lossy_password_vault() {
        let dir = temp_dir();
        let key_path = dir.join(VAULT_KEY_FILE);
        let salt_path = dir.join(VAULT_SALT_FILE);
        let snapshot_path = dir.join(VAULT_SNAPSHOT_FILE);

        // 手工构造旧版本 vault：口令为原始密钥字节的 lossy UTF-8 字符串。
        let vault_key: Vec<u8> = (0..VAULT_KEY_LEN as u8).collect();
        fs::write(&key_path, &vault_key).unwrap();
        let legacy_password =
            KeyDerivation::argon2(&String::from_utf8_lossy(&vault_key), &salt_path);
        let legacy = Stronghold::new(&snapshot_path, legacy_password).unwrap();
        legacy.create_client(CLIENT_NAME).unwrap();
        let client = legacy.get_client(CLIENT_NAME).unwrap();
        client
            .store()
            .insert(b"legacy_key".to_vec(), b"legacy-secret".to_vec(), None)
            .unwrap();
        legacy.save().unwrap();
        drop(legacy);

        // 新版 init 必须自动迁移并能读到旧密钥。
        let secrets = AppSecrets::init(&dir).expect("init should migrate legacy vault");
        assert_eq!(
            secrets.get_secret("legacy_key").as_deref(),
            Some("legacy-secret")
        );

        // 迁移后重启（此时快照已是新口令）仍能打开。
        drop(secrets);
        let secrets2 = AppSecrets::init(&dir).expect("re-init after migration should succeed");
        assert_eq!(
            secrets2.get_secret("legacy_key").as_deref(),
            Some("legacy-secret")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrite_updates_value() {
        let dir = temp_dir();
        let secrets = AppSecrets::init(&dir).expect("init should succeed");

        secrets.set_secret("k", "v1").unwrap();
        secrets.save().unwrap();
        assert_eq!(secrets.get_secret("k").as_deref(), Some("v1"));

        secrets.set_secret("k", "v2").unwrap();
        secrets.save().unwrap();
        assert_eq!(secrets.get_secret("k").as_deref(), Some("v2"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_snapshot_fails_instead_of_overwriting() {
        let dir = temp_dir();
        let snapshot_path = dir.join(VAULT_SNAPSHOT_FILE);

        // 先建立正常 vault 并写入密钥。
        let secrets = AppSecrets::init(&dir).expect("init should succeed");
        secrets.set_secret("k", "v").unwrap();
        secrets.save().unwrap();
        drop(secrets);

        // 把快照破坏成无法解析的字节。再次 init 必须报错,
        // 绝不能静默建空 client 后把快照覆写成空状态。
        fs::write(&snapshot_path, b"not-a-valid-stronghold-snapshot").unwrap();
        assert!(AppSecrets::init(&dir).is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}
