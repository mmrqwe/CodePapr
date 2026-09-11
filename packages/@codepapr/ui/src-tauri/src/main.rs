// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![deny(unsafe_op_in_unsafe_fn)]

mod app_runtime;
mod app_market_install;
mod asset_scope;
mod browser;
mod character_card;
mod commands;
mod embedded_browser;
mod file_export;
mod host;
mod papr_runtime;
mod power;
mod secrets;
mod tts;
mod vault;

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;
#[allow(unused_imports)]
use tauri_plugin_dialog::DialogExt;
use tauri::Emitter;

use crate::secrets::{PRIMARY_KEY_ACCOUNT, MENTOR_KEY_ACCOUNT};
use crate::vault::{migrate_from_keyring, AppSecrets};

const DISABLE_CONTEXT_MENU_INIT_SCRIPT: &str = "";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_prevent_default::Builder::new()
            .with_flags(tauri_plugin_prevent_default::Flags::CONTEXT_MENU)
            .build())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|_password| {
                vec![0u8; 32]
            })
            .build(),
        )
        .register_uri_scheme_protocol("codepapr-app", app_runtime::handle_app_protocol)
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
            let app_secrets = AppSecrets::init(&app_data_dir)
                .map_err(|e| format!("初始化密钥库失败: {e}"))?;

            let migrated = migrate_from_keyring(
                &app_secrets,
                &[PRIMARY_KEY_ACCOUNT, MENTOR_KEY_ACCOUNT],
            )
            .unwrap_or(0);
            if migrated > 0 {
                eprintln!("[CodePapr] 从系统钥匙串迁移了 {migrated} 个密钥到 Stronghold");
            }

            app.manage(app_secrets);

            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("codepapr-host-start".into())
                .spawn(move || {
                    eprintln!("[CodePapr] host thread: starting");
                    match tauri::async_runtime::block_on(host::start(&handle)) {
                        Ok(_) => {
                            tauri::async_runtime::block_on(host::import_vault_secrets(&handle));
                            eprintln!("[CodePapr] host thread: ready");
                        }
                        Err(e) => {
                            eprintln!("[CodePapr] 连接 codepapr-server 失败: {e}");
                        }
                    }
                })
                .map_err(|e| format!("无法启动 codepapr-server 线程: {e}"))?;

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
            commands::load_app_settings,
            commands::save_app_settings,
            commands::note_recent_workspace,
            commands::set_recent_workspaces,
            commands::load_app_characters,
            commands::save_app_characters,
            commands::mcp_list_tools,
            commands::mcp_update_settings,
            commands::mcp_call_tool,
            commands::mcp_list_status,
            commands::mcp_disconnect_all,
            commands::mcp_test_server,
            commands::mcp_preview_server,
            commands::mcp_disconnect_server,
            commands::mcp_confirm_response,
            commands::mcp_health_check,
            commands::load_project_state,
            commands::save_project_state,
            commands::save_session,
            commands::load_sessions,
            commands::load_archived_sessions,
            commands::archive_session,
            commands::restore_session,
            commands::delete_session,
            commands::save_message_batch,
            commands::load_session_messages,
            commands::load_all_session_messages,
            commands::aggregate_tool_usage,
            commands::aggregate_session_runtime,
            commands::save_project_meta,
            commands::load_project_meta,
            commands::load_all_project_meta,
            commands::load_context_surface,
            commands::save_context_surface,
            commands::discard_context_surfaces_from_generation,
            commands::commit_context_compaction,
            commands::mark_context_compaction_failed,
            commands::load_context_compactions,
            commands::save_checkpoint_record,
            commands::load_checkpoint_records,
            commands::delete_checkpoint_by_message,
            commands::delete_checkpoints_for_session,
            commands::save_projectgraph_cache,
            commands::load_projectgraph_cache,
            commands::cache_get,
            commands::cache_set,
            commands::cache_remove,
            commands::list_workspace_files,
            commands::check_external_path,
            commands::get_external_access_policy,
            commands::set_external_access_yolo,
            commands::grant_external_access,
            commands::revoke_external_access,
            commands::clear_external_access_grants,
            commands::ensure_default_project,
            commands::compute_project_stats,
            commands::cancel_project_stats,
            commands::read_text_file,
            commands::read_text_files_batch,
            commands::read_image_file,
            commands::read_artifact,
            commands::write_text_file,
            commands::delete_workspace_file,
            commands::delete_workspace_dir,
            commands::save_chat_image,
            commands::load_chat_images,
            asset_scope::grant_workspace_asset_scope,
            commands::run_workspace_command,
            commands::run_workspace_shell_command,
            commands::cancel_running_command,
            commands::classify_dangerous_command,
            commands::snapshot_ensure,
            commands::snapshot_create,
            commands::snapshot_list,
            commands::snapshot_head_sha,
            commands::restore_plan,
            commands::restore_execute,
            commands::restore_undo,
            commands::snapshot_changed_files,
            commands::diff_snapshots,
            commands::snapshot_file_content,
            commands::snapshot_index_file_content,
            commands::git_status,
            commands::git_diff,
            commands::git_log,
            commands::git_stage,
            commands::git_commit,
            commands::git_branch_list,
            commands::git_branch_checkout,
            commands::git_restore_files,
            commands::enqueue_workspace_task,
            commands::poll_workspace_task,
            commands::start_workspace_background_command,
            commands::start_workspace_shell_background_command,
            commands::start_app_background_command,
            commands::list_background_processes,
            commands::log_ui_event,
            commands::background_process_alive,
            commands::background_process_exit_info,
            commands::stop_background_process,
            commands::stop_all_background_processes,
            commands::search_workspace_text,
            commands::search_workspace_paths,
            commands::start_workspace_watcher,
            commands::stop_workspace_watcher,
            commands::search_web,
            commands::fetch_web_url,
            commands::test_searxng_connection,
            commands::download_web_file,
            browser::page::open_browser_target,
            browser::page::open_browser_page,
            browser::page::navigate_browser_page,
            browser::page::get_browser_page_state,
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
            commands::open_shell_session,
            commands::list_shell_sessions,
            commands::read_shell_output,
            commands::send_shell_input,
            commands::send_shell_command,
            commands::close_shell_session,
            commands::lsp_start_server,
            commands::lsp_query_availability,
            commands::lsp_list_components,
            commands::lsp_set_disabled_families,
            commands::lsp_open_document,
            commands::lsp_close_document,
            commands::lsp_request,
            commands::lsp_get_diagnostics,
            commands::lsp_stop_server,
            commands::lsp_batch_symbols,
            commands::lsp_batch_enrich,
            commands::resolve_symbol_provider,
            commands::list_available_symbol_providers,
            commands::resolve_symbols,
            commands::resolve_symbol_hover,
            commands::resolve_symbol_definition,
            commands::resolve_symbol_references,
            commands::check_syntax,
            commands::extract_file_symbols,
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
            tts::tts_voice_storage_summary,
            tts::tts_prune_voice_storage,
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
            app_market_install::papr_install_app_files,
            app_market_install::papr_uninstall_app,
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
            papr_runtime::app_storage::papr_inbox_append,
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
            power::allow_idle_sleep,
            commands::agent_runtime_start,
            commands::agent_runtime_send,
            commands::agent_runtime_stop,
            commands::agent_runtime_permission_respond
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                request_quit_after_settings_flush(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            match event {
                tauri::RunEvent::Exit => {
                    codepapr_core::shared::enter_fast_child_reap();
                    run_shutdown_cleanup();
                    let _ = handle;
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } if label == "main" => {
                    handle.exit(0);
                }
                _ => {}
            }
        });
}

fn request_quit_after_settings_flush(app: &tauri::AppHandle) {
    static EXITING: AtomicBool = AtomicBool::new(false);
    if EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    const FLUSH_BUDGET: std::time::Duration = std::time::Duration::from_millis(2000);
    let _ = app.emit("codepapr:flush-settings", ());
    let before = host::call_blocking("db/settingsSaveState", serde_json::json!({}))
        .ok()
        .unwrap_or(serde_json::json!({}));
    let requests_before = before.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
    let epoch_before = before.get("epoch").and_then(|v| v.as_u64()).unwrap_or(0);
    let deadline = std::time::Instant::now() + FLUSH_BUDGET;
    let probe_until = std::time::Instant::now() + std::time::Duration::from_millis(500);
    let mut saw_request = false;
    while std::time::Instant::now() < probe_until {
        let state = host::call_blocking("db/settingsSaveState", serde_json::json!({}))
            .ok()
            .unwrap_or(serde_json::json!({}));
        let requests = state.get("requests").and_then(|v| v.as_u64()).unwrap_or(0);
        if requests > requests_before {
            saw_request = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    if saw_request {
        while std::time::Instant::now() < deadline {
            let state = host::call_blocking("db/settingsSaveState", serde_json::json!({}))
                .ok()
                .unwrap_or(serde_json::json!({}));
            let epoch = state.get("epoch").and_then(|v| v.as_u64()).unwrap_or(0);
            if epoch > epoch_before {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    }
    app.exit(0);
}

fn run_shutdown_cleanup() {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(host) = host::global() {
        host.shutdown();
    }
    tts::tts_server_stop_internal();
    tts::finetune::cancel();
    tts::installer::cancel();
    browser::page::close_all_browser_pages();
    embedded_browser::close_all_sessions();
    power::release_all();
}

#[cfg(test)]
mod tests {}
