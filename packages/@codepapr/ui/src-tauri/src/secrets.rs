//! Secret storage facade — account name constants shared with `db/mod.rs`.
//!
//! All actual vault I/O is performed directly by [`crate::vault::AppSecrets`].

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const PRIMARY_KEY_ACCOUNT: &str = "api_key";
pub(crate) const MENTOR_KEY_ACCOUNT: &str = "mentor_api_key";
pub(crate) const FAST_KEY_ACCOUNT: &str = "fast_api_key";

static SECRETS_READY: AtomicBool = AtomicBool::new(false);

/// Settings may be saved only after the vault has been copied into the host.
/// An earlier save still holds the empty injected key fields and would wipe
/// Stronghold.
pub(crate) fn mark_secrets_ready() {
    SECRETS_READY.store(true, Ordering::SeqCst);
}

pub(crate) fn secrets_ready() -> bool {
    SECRETS_READY.load(Ordering::SeqCst)
}
