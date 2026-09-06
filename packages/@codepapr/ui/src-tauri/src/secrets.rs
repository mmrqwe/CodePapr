//! Secret storage facade — account name constants shared with `db/mod.rs`.
//!
//! All actual vault I/O is performed directly by [`crate::vault::AppSecrets`].

#![forbid(unsafe_code)]

pub(crate) const PRIMARY_KEY_ACCOUNT: &str = "api_key";
pub(crate) const MENTOR_KEY_ACCOUNT: &str = "mentor_api_key";
