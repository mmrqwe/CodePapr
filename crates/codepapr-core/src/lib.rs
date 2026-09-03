//! CodePapr core library.

pub mod agent_runtime;
pub mod agent_runtime_lsp;
pub mod agent_runtime_tools;
pub mod auth;
pub mod db;
pub mod download_verification;
pub mod events;
pub mod git_operations;
pub mod lsp;
pub mod lsp_fallback;
pub mod lsp_managed_tools;
pub mod mcp_host;
pub mod mcp_sse;
pub mod shared;
pub mod shell;
pub mod snapshot;
pub mod symbol_provider;
pub mod test_helpers;
pub mod web;
pub mod workspace_fs;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
