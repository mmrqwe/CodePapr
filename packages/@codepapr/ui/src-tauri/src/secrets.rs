//! Secret storage facade — delegates to the Stronghold-backed vault.
//!
//! This module exists for backward compatibility with `db/mod.rs` which
//! references the account name constants (`PRIMARY_KEY_ACCOUNT`,
//! `MENTOR_KEY_ACCOUNT`) and imports `crate::secrets`.
//!
//! All actual I/O is performed by [`crate::vault::AppSecrets`].

use crate::vault::AppSecrets;

pub(crate) const PRIMARY_KEY_ACCOUNT: &str = "api_key";
pub(crate) const MENTOR_KEY_ACCOUNT: &str = "mentor_api_key";

/// Read a secret from the Stronghold vault.
pub(crate) fn get_secret(app_secrets: &AppSecrets, account: &str) -> Option<String> {
    app_secrets.get_secret(account)
}

/// Write a secret into the Stronghold vault.
///
/// **Does not persist automatically.**  The caller must invoke
/// [`AppSecrets::save`] after all writes are done.
pub(crate) fn set_secret(app_secrets: &AppSecrets, account: &str, value: &str) -> Result<(), String> {
    app_secrets.set_secret(account, value)
}

/// Remove a secret from the Stronghold vault (idempotent).
///
/// **Does not persist automatically.**  The caller must invoke
/// [`AppSecrets::save`] after all writes are done.
pub(crate) fn delete_secret(app_secrets: &AppSecrets, account: &str) -> Result<(), String> {
    app_secrets.delete_secret(account)
}
