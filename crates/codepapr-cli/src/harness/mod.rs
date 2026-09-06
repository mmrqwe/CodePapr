//! Harness support for `codepapr run`: stable NDJSON event protocol and
//! permission allowlist. The agent runtime itself lives in the shared
//! Node sidecar; this module only handles CLI-side IO and policy inputs.

pub mod allowlist;
pub mod events;
