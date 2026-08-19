// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Unsafe blocks must not be wrapped in unsafe fns without explicit
// documentation; all unsafe is reviewed.
#![deny(unsafe_op_in_unsafe_fn)]

mod app_runtime;
mod browser;
mod character_card;
mod db;
mod download_verification;
mod embedded_browser;
mod file_export;
mod git_operations;
mod lsp;
mod lsp_fallback;
mod lsp_managed_tools;
mod mcp_host;
mod papr_runtime;
mod power;
mod secrets;
mod shared;
mod shell;
mod snapshot;
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
use tauri::Emitter;

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
async fn mcp_update_settings(settings: mcp_host::McpSettings) -> Result<(), String> {
    mcp_host::update_settings(settings).await;
    Ok(())
}

#[tauri::command]
async fn mcp_call_tool(
    app: tauri::AppHandle,
    settings: Option<mcp_host::McpSettings>,
    server_id: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<mcp_host::McpCallToolResult, String> {
    mcp_host::call_tool(Some(app), settings, server_id, tool_name, arguments).await
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

#[tauri::command]
async fn mcp_confirm_response(
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    mcp_host::resolve_confirmation(request_id, approved).await
}

#[tauri::command]
async fn mcp_health_check() -> Result<Vec<String>, String> {
    Ok(mcp_host::health_check().await)
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
        .register_uri_scheme_protocol("codepapr-app", app_runtime::handle_app_protocol)
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
            db::note_recent_workspace,
            db::set_recent_workspaces,
            db::load_app_characters,
            db::save_app_characters,
            mcp_list_tools,
            mcp_update_settings,
            mcp_call_tool,
            mcp_list_status,
            mcp_disconnect_all,
            mcp_test_server,
            mcp_preview_server,
            mcp_disconnect_server,
            mcp_confirm_response,
            mcp_health_check,
            db::load_project_state,
            db::save_project_state,
            db::save_session,
            db::load_sessions,
            db::delete_session,
            db::save_message_batch,
            db::load_session_messages,
            db::load_all_session_messages,
            db::aggregate_tool_usage,
            db::aggregate_session_runtime,
            db::save_project_meta,
            db::load_project_meta,
            db::load_all_project_meta,
            db::load_context_surface,
            db::save_context_surface,
            db::discard_context_surfaces_from_generation,
            db::commit_context_compaction,
            db::mark_context_compaction_failed,
            db::load_context_compactions,
            db::save_memory_candidate,
            db::admit_memory_candidate,
            db::reject_memory_candidate,
            db::forget_memory_entry,
            db::load_memory_entries,
            db::load_memory_candidates,
            db::project_memory_file,
            db::sync_user_zone_to_ledger,
            db::ingest_legacy_memory_md,
            db::update_memory_entry_content,
            db::save_memory_recall,
            db::archive_memory_recall,
            db::load_latest_memory_recall,
            db::search_memory_for_recall,
            db::save_checkpoint_record,
            db::load_checkpoint_records,
            db::delete_checkpoint_by_message,
            db::delete_checkpoints_for_session,
            db::save_projectgraph_cache,
            db::load_projectgraph_cache,
            db::cache_get,
            db::cache_set,
            db::cache_remove,
            workspace_fs::list::list_workspace_files,
            workspace_fs::access::check_external_path,
            workspace_fs::access::get_external_access_policy,
            workspace_fs::access::set_external_access_yolo,
            workspace_fs::access::grant_external_access,
            workspace_fs::access::revoke_external_access,
            workspace_fs::access::clear_external_access_grants,
            workspace_fs::default_project::ensure_default_project,
            workspace_fs::stats::compute_project_stats,
            workspace_fs::stats::cancel_project_stats,
            workspace_fs::read::read_text_file,
            workspace_fs::read::read_text_files_batch,
            workspace_fs::read::read_image_file,
            workspace_fs::read::read_artifact,
            workspace_fs::write::write_text_file,
            workspace_fs::write::delete_workspace_file,
            workspace_fs::write::delete_workspace_dir,
            shell::background::run_workspace_command,
            shell::background::run_workspace_shell_command,
            shell::background::cancel_running_command,
            snapshot::snapshot_ensure,
            snapshot::snapshot_create,
            snapshot::snapshot_list,
            snapshot::snapshot_head_sha,
            snapshot::restore_plan,
            snapshot::restore_execute,
            snapshot::restore_undo,
            snapshot::snapshot_changed_files,
            snapshot::diff_snapshots,
            snapshot::snapshot_file_content,
            snapshot::snapshot_index_file_content,
            git_operations::status::git_status,
            git_operations::diff::git_diff,
            git_operations::log::git_log,
            git_operations::stage::git_stage,
            git_operations::commit::git_commit,
            git_operations::branch::git_branch_list,
            git_operations::branch::git_branch_checkout,
            git_operations::restore_files::git_restore_files,
            task_queue::enqueue_workspace_task,
            task_queue::poll_workspace_task,
            shell::background::start_workspace_background_command,
            shell::background::start_workspace_shell_background_command,
            shell::background::list_background_processes,
            shell::background::log_ui_event,
            shell::background::background_process_alive,
            shell::background::background_process_exit_info,
            shell::background::stop_background_process,
            shell::background::stop_all_background_processes,
            workspace_fs::search::search_workspace_text,
            workspace_fs::search::search_workspace_paths,
            workspace_fs::watcher::start_workspace_watcher,
            workspace_fs::watcher::stop_workspace_watcher,
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
            embedded_browser::page::embedded_browser_open,
            embedded_browser::page::embedded_browser_navigate,
            embedded_browser::page::embedded_browser_reload,
            embedded_browser::page::embedded_browser_history,
            embedded_browser::page::embedded_browser_click,
            embedded_browser::page::embedded_browser_input,
            embedded_browser::page::embedded_browser_read_dom,
            embedded_browser::page::embedded_browser_screenshot,
            embedded_browser::page::embedded_browser_close,
            embedded_browser::page::embedded_browser_get_state,
            embedded_browser::page::embedded_browser_set_bounds,
            embedded_browser::page::embedded_browser_show,
            embedded_browser::page::embedded_browser_hide,
            embedded_browser::page::set_browser_engine,
            embedded_browser::page::get_browser_engine,
            shell::session::open_shell_session,
            shell::session::list_shell_sessions,
            shell::session::read_shell_output,
            shell::session::send_shell_input,
            shell::session::send_shell_command,
            shell::session::close_shell_session,
            lsp::lsp_start_server,
            lsp::lsp_query_availability,
            lsp::lsp_open_document,
            lsp::lsp_close_document,
            lsp::lsp_request,
            lsp::lsp_get_diagnostics,
            lsp::lsp_stop_server,
            lsp::lsp_batch_symbols,
            lsp::lsp_batch_enrich,
            symbol_provider::resolve_symbol_provider,
            symbol_provider::list_available_symbol_providers,
            symbol_provider::resolve_symbols,
            symbol_provider::resolve_symbol_hover,
            symbol_provider::resolve_symbol_definition,
            symbol_provider::resolve_symbol_references,
            symbol_provider::check_syntax,
            symbol_provider::extract_file_symbols,
            tts::tts_server_start,
            tts::tts_server_stop,
            tts::tts_server_status,
            tts::tts_set_model,
            tts::tts_warmup_gpu,
            tts::tts_synthesize_and_play,
            tts::tts_synthesize_batch_ws,
            tts::tts_synthesize_batch_ws_nonblocking,
            tts::tts_stop_playback,
            tts::tts_is_playing,
            tts::tts_set_volume,
            tts::tts_reset_audio_device,
            tts::tts_install,
            tts::tts_install_cancel,
            tts::tts_check_installed,
            tts::tts_save_voice_file,
            tts::tts_delete_character_voices,
            tts::tts_read_voice_file,
            tts::tts_finetune_start,
            tts::tts_finetune_collect_and_start,
            tts::tts_finetune_cancel,
            tts::tts_finetune_status,
            tts::tts_check_training_data_exists,
            tts::tts_generate_training_data,
            character_card::export_character_card,
            character_card::save_character_avatar,
            character_card::read_character_avatar,
            character_card::delete_character_avatar,
            file_export::export_text_file,
            app_runtime::register_app_workspace,
            app_runtime::unregister_app_workspace,
            app_runtime::register_app_backend_port,
            app_runtime::unregister_app_backend_port,
            app_runtime::allocate_app_port,
            app_runtime::app_frontend_mtime,
            app_runtime::install_app_npm_deps,
            app_runtime::papr_snapshot_app,
            app_runtime::papr_export_app,
            app_runtime::check_port_available,
            app_runtime::check_port_available_detail,
            app_runtime::check_port_available_structured,
            app_runtime::check_port_owner,
            app_runtime::check_port_owned_by,
            app_runtime::check_port_bind_address,
            app_runtime::scan_workspace_apps,
            papr_runtime::app_storage::papr_storage_get,
            papr_runtime::app_storage::papr_storage_set,
            papr_runtime::app_storage::papr_storage_delete,
            papr_runtime::app_storage::papr_storage_keys,
            papr_runtime::app_storage::papr_get_manifest,
            papr_runtime::app_storage::papr_get_app_settings,
            papr_runtime::app_storage::papr_set_app_settings,
            papr_runtime::services::papr_http_get,
            papr_runtime::services::papr_http_post,
            papr_runtime::services::papr_http_request,
            papr_runtime::services::papr_fs_read,
            papr_runtime::services::papr_fs_write,
            papr_runtime::services::papr_fs_list,
            papr_runtime::services::papr_fs_delete,
            papr_runtime::services::papr_fs_exists,
            papr_runtime::services::papr_delete_app,
            power::prevent_idle_sleep,
            power::allow_idle_sleep
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                // 先发出退出请求，再做清理：exit(0) 走 ExitRequested→Exit，
                // 窗口销毁路径（Destroyed→ExitRequested→ControlFlow::Exit）本身也能退出。
                // 若先跑清理，任何阻塞调用（child.wait、CDP close）都会卡死退出链路。
                if window.app_handle().windows().len() <= 1 {
                    // 退出前给前端最后一次持久化机会：emit 事件后前端会把
                    // 在途/最新的设置与角色卡状态重新落库，这里等待保存完成
                    // （save_app_settings 已是异步命令，主线程等待期间它照常执行），
                    // 避免"切项目/改设置/改角色后立刻退出"丢最后写入。
                    let _ = window.emit("codepapr:flush-settings", ());
                    let epoch_before = db::settings_save_epoch();
                    db::wait_for_settings_save_epoch(epoch_before, std::time::Duration::from_millis(2000));
                    window.app_handle().exit(0);
                }
                run_shutdown_cleanup();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_handle, event| {
            // CloseRequested covers normal window close; Exit also fires on
            // programmatic exit / last-window-close paths, so reap backend
            // processes here too (idempotent) to avoid orphaned servers.
            // 清理必须在独立线程执行：tao 的 run() 在 run_return 返回后才
            // process::exit，RunEvent::Exit 回调若阻塞（CDP close 可达 120s/页、
            // child.wait 无限等待），进程会永远残留在后台并触发 macOS
            // "正在后台运行"通知。
            if matches!(event, tauri::RunEvent::Exit) {
                std::thread::spawn(run_shutdown_cleanup);
            }
        });
}

/// 关闭/退出时的尽力而为清理。每个子调用都应是有界等待（见各模块超时封装）；
/// 该函数由调用方放在独立线程执行，绝不阻塞主线程的退出链路。
fn run_shutdown_cleanup() {
    lsp::stop_all_servers();
    tts::tts_server_stop_internal();
    tts::finetune::cancel();
    tts::installer::cancel();
    let _ = shell::background::stop_all_background_processes(None, Some("host-exit".to_string()));
    shell::session::stop_all_shell_sessions();
    browser::page::close_all_browser_pages();
    embedded_browser::close_all_sessions();
    mcp_host::disconnect_all_blocking();
    workspace_fs::watcher::stop_workspace_watcher_impl();
    power::release_all();
}

#[cfg(test)]
mod tests {}
