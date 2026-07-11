// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod character_card;
mod db;
mod git_checkpoint;
mod lsp;
mod lsp_fallback;
mod lsp_managed_tools;
mod mcp_host;
mod secrets;
mod shared;
mod shell;
mod symbol_provider;
mod task_queue;
mod tts;
mod vault;
mod web;
mod workspace_fs;

#[cfg(test)]
mod test_helpers;

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    thread,
};
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;
#[allow(unused_imports)]
use tauri_plugin_dialog::DialogExt;

use crate::secrets::{PRIMARY_KEY_ACCOUNT, MENTOR_KEY_ACCOUNT};
use crate::vault::{migrate_from_keyring, AppSecrets};

const DISABLE_CONTEXT_MENU_INIT_SCRIPT: &str = "";

#[tauri::command]
async fn mcp_list_tools(
    settings: mcp_host::McpSettings,
    refresh: Option<bool>,
) -> Result<mcp_host::McpListToolsResult, String> {
    mcp_host::list_tools(settings, refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn mcp_call_tool(
    settings: mcp_host::McpSettings,
    server_id: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<mcp_host::McpCallToolResult, String> {
    mcp_host::call_tool(settings, server_id, tool_name, arguments).await
}

#[tauri::command]
async fn mcp_list_status(
    settings: mcp_host::McpSettings,
) -> Result<Vec<mcp_host::McpServerStatus>, String> {
    Ok(mcp_host::list_status(settings).await)
}

#[tauri::command]
async fn mcp_disconnect_all() -> Result<usize, String> {
    mcp_host::disconnect_all().await
}

#[tauri::command]
async fn mcp_clear_tool_cache() -> Result<usize, String> {
    Ok(mcp_host::clear_tool_cache().await)
}

#[tauri::command]
async fn mcp_test_server(
    settings: mcp_host::McpSettings,
    server_id: String,
) -> Result<mcp_host::McpTestServerResult, String> {
    mcp_host::test_server(settings, server_id).await
}

#[tauri::command]
async fn mcp_preview_server(
    url: String,
    transport: String,
    timeout_seconds: Option<u64>,
) -> Result<mcp_host::McpPreviewResult, String> {
    mcp_host::preview_mcp_server(url, transport, timeout_seconds).await
}

#[tauri::command]
async fn mcp_disconnect_server(
    settings: mcp_host::McpSettings,
    server_id: String,
) -> Result<usize, String> {
    mcp_host::disconnect_server(settings, server_id).await
}

fn main() {
    let (tx, rx) = std::sync::mpsc::sync_channel::<task_queue::WorkspaceTask>(256);
    if task_queue::TASK_TX.set(tx).is_err() {
        panic!("task queue already initialized");
    }
    if task_queue::TASK_RESULTS
        .set(Mutex::new(task_queue::TaskQueueState {
            pending_results: HashMap::new(),
            completed_order: VecDeque::new(),
        }))
        .is_err()
    {
        panic!("task results already initialized");
    }
    thread::spawn(move || task_queue::task_worker(rx));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_prevent_default::Builder::new()
            .with_flags(tauri_plugin_prevent_default::Flags::CONTEXT_MENU)
            .build())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|_password| {
                // Placeholder: we manage our own Stronghold instance via
                // the Rust API (see vault.rs).  This hash function is
                // never invoked for our use case.
                vec![0u8; 32]
            })
            .build(),
        )
        .setup(|app| {
            symbol_provider::register_default_providers();

            // ── Vault initialization ────────────────────────────────
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
            let app_secrets = AppSecrets::init(&app_data_dir)
                .map_err(|e| format!("初始化密钥库失败: {e}"))?;

            // Migrate any legacy API keys from the OS keychain into
            // Stronghold (best-effort; failures are non-fatal).
            let migrated = migrate_from_keyring(
                &app_secrets,
                &[PRIMARY_KEY_ACCOUNT, MENTOR_KEY_ACCOUNT],
            )
            .unwrap_or(0);
            if migrated > 0 {
                eprintln!("[CodePapr] 从系统钥匙串迁移了 {migrated} 个密钥到 Stronghold");
            }

            app.manage(app_secrets);
            // ── End vault init ───────────────────────────────────────

            if app.get_webview_window("main").is_none() {
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("CodePapr")
                    .inner_size(1400.0, 900.0)
                    .min_inner_size(1000.0, 680.0)
                    .resizable(true)
                    .fullscreen(false)
                    .devtools(false)
                    .initialization_script_for_all_frames(DISABLE_CONTEXT_MENU_INIT_SCRIPT)
                    .build()?;
            }

            #[cfg(target_os = "macos")]
            {
                let about = MenuItemBuilder::with_id("about", "About CodePapr")
                    .accelerator("CmdOrCtrl+I")
                    .build(app)?;
                let submenu = SubmenuBuilder::new(app, "CodePapr")
                    .item(&about)
                    .separator()
                    .quit()
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&submenu)
                    .item(&edit_menu)
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    let id = event.id().0.as_str();
                    if id == "about" {
                        let _ = app.dialog()
                            .message(format!(
                                "CodePapr\nVersion {}\n\nLocal-first coding agent workbench\nOptimized for DeepSeek prefix caching\n\n© 2025-2026 CodePapr Contributors",
                                env!("CARGO_PKG_VERSION")
                            ))
                            .title("About CodePapr")
                            .kind(tauri_plugin_dialog::MessageDialogKind::Info)
                            .blocking_show();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::load_app_settings,
            db::save_app_settings,
            db::load_app_characters,
            db::save_app_characters,
            mcp_list_tools,
            mcp_call_tool,
            mcp_list_status,
            mcp_disconnect_all,
            mcp_clear_tool_cache,
            mcp_test_server,
            mcp_preview_server,
            mcp_disconnect_server,
            db::load_project_state,
            db::save_project_state,
            db::save_projectgraph_cache,
            db::load_projectgraph_cache,
            workspace_fs::list::list_workspace_files,
            workspace_fs::read::read_text_file,
            workspace_fs::read::read_text_files_batch,
            workspace_fs::write::write_text_file,
            workspace_fs::write::delete_workspace_file,
            workspace_fs::write::delete_workspace_dir,
            shell::background::run_workspace_command,
            git_checkpoint::git_checkpoint_ensure,
            git_checkpoint::git_checkpoint_create,
            git_checkpoint::git_checkpoint_reset,
            git_checkpoint::git_checkpoint_head_sha,
            git_checkpoint::git_checkpoint_changed_files,
            task_queue::enqueue_workspace_task,
            task_queue::poll_workspace_task,
            shell::background::start_workspace_background_command,
            shell::background::list_background_processes,
            shell::background::stop_background_process,
            shell::background::stop_all_background_processes,
            workspace_fs::search::search_workspace_text,
            workspace_fs::search::search_workspace_paths,
            web::search::search_web,
            web::fetch::fetch_web_url,
            web::fetch::download_web_file,
            browser::page::open_browser_target,
            browser::page::open_browser_page,
            browser::page::navigate_browser_page,
            browser::page::reload_browser_page,
            browser::page::click_browser_page_element,
            browser::page::input_browser_page_text,
            browser::page::read_browser_page_dom,
            browser::page::screenshot_browser_page,
            browser::page::close_browser_page,
            shell::session::open_shell_session,
            shell::session::list_shell_sessions,
            shell::session::read_shell_output,
            shell::session::send_shell_input,
            shell::session::send_shell_command,
            shell::session::close_shell_session,
            lsp::lsp_start_server,
            lsp::lsp_open_document,
            lsp::lsp_close_document,
            lsp::lsp_request,
            lsp::lsp_get_diagnostics,
            lsp::lsp_stop_server,
            symbol_provider::resolve_symbol_provider,
            symbol_provider::list_available_symbol_providers,
            symbol_provider::resolve_symbols,
            symbol_provider::resolve_symbol_hover,
            symbol_provider::resolve_symbol_definition,
            symbol_provider::resolve_symbol_references,
            tts::tts_server_start,
            tts::tts_server_stop,
            tts::tts_server_status,
            tts::tts_set_model,
            tts::tts_warmup_gpu,
            tts::tts_synthesize_and_play,
            tts::tts_synthesize_batch_ws,
            tts::tts_synthesize_batch_ws_nonblocking,
            tts::tts_stop_playback,
            tts::tts_install,
            tts::tts_install_cancel,
            tts::tts_check_installed,
            tts::tts_save_voice_file,
            tts::tts_read_voice_file,
            tts::tts_finetune_start,
            tts::tts_finetune_collect_and_start,
            tts::tts_finetune_cancel,
            tts::tts_finetune_status,
            tts::tts_check_training_data_exists,
            tts::tts_generate_training_data,
            character_card::export_character_card
        ])
        .on_window_event(|_, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                lsp::stop_all_servers();
                tts::tts_server_stop_internal();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {}
