use std::sync::Arc;
use serde_json::{json, Value};
use codepapr_core::db::{InMemorySecretStorage, SecretStorage};
use codepapr_core::events::SharedEventSink;
use codepapr_core::lsp::LspBatchSymbolInput;
use codepapr_core::mcp_host::McpSettings;
use codepapr_core::shell::sandbox::SandboxAccessArgs;
use codepapr_core::workspace_fs::stats::StatsProgressCallback;

pub struct ServerContext {
    pub default_workspace: Option<String>,
    pub event_sink: SharedEventSink,
    pub secrets: Arc<InMemorySecretStorage>,
}

impl ServerContext {
    pub fn new(default_workspace: Option<String>, event_sink: SharedEventSink) -> Self {
        Self {
            default_workspace,
            event_sink,
            secrets: Arc::new(InMemorySecretStorage::new()),
        }
    }
}

pub async fn handle_request(ctx: &Arc<ServerContext>, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "initialize" => Ok(json!({
            "serverInfo": {
                "name": "codepapr-server",
                "version": codepapr_core::version(),
            },
            "capabilities": {
                "fs": true, "git": true, "shell": true, "lsp": true,
                "agent": true, "db": true, "snapshot": true, "mcp": true, "web": true,
                // headless harness 帧通道（harness/ping 握手是权威判定；
                // 此处仅为信息位，随 sidecar 一起构建）。
                "harness": 1,
            },
            "workspace": ctx.default_workspace,
        })),
        "ping" => Ok(json!("pong")),
        "secrets/import" => {
            if let Some(map) = params.as_object() {
                for (key, value) in map {
                    if let Some(secret) = value.as_str() {
                        ctx.secrets.set_secret(key, secret)?;
                    }
                }
            }
            Ok(json!({ "ok": true }))
        }

        // ── FS ────────────────────────────────────────────────────────────
        "fs/readTextFile" => json_ok(codepapr_core::workspace_fs::read::read_text_file(
            require_workspace(ctx, &params)?,
            require_path(&params)?,
            opt_usize(&params, "maxBytes"),
            opt_usize(&params, "startLine"),
            opt_usize(&params, "endLine"),
            opt_usize(&params, "aroundLine"),
            opt_usize(&params, "contextLines"),
        ).await?),
        "fs/readTextFilesBatch" => json_ok(codepapr_core::workspace_fs::read::read_text_files_batch(
            require_workspace(ctx, &params)?,
            parse_string_vec(&params, "relativePaths").unwrap_or_default(),
            opt_usize(&params, "maxBytes"),
        ).await?),
        "fs/readImageFile" => json_ok(codepapr_core::workspace_fs::read::read_image_file(
            require_workspace(ctx, &params)?,
            require_path(&params)?,
            opt_usize(&params, "maxBytes"),
        ).await?),
        "fs/readArtifact" => json_ok(codepapr_core::workspace_fs::read::read_artifact(
            require_workspace(ctx, &params)?,
            require_string(&params, "artifactId")?,
            opt_usize(&params, "offsetChars"),
            opt_usize(&params, "limitChars"),
        ).await?),
        "fs/writeTextFile" => json_ok(codepapr_core::workspace_fs::write::write_text_file(
            require_workspace(ctx, &params)?,
            require_path(&params)?,
            require_string(&params, "content")?,
        ).await?),
        "fs/deleteFile" => json_ok(codepapr_core::workspace_fs::write::delete_workspace_file(
            require_workspace(ctx, &params)?,
            require_path(&params)?,
        ).await?),
        "fs/deleteDir" => json_ok(codepapr_core::workspace_fs::write::delete_workspace_dir(
            require_workspace(ctx, &params)?,
            require_path(&params)?,
        ).await?),
        "fs/listFiles" => json_ok(codepapr_core::workspace_fs::list::list_workspace_files(
            require_workspace(ctx, &params)?,
            opt_string(&params, "relativePath").or_else(|| opt_string(&params, "subPath")),
            opt_usize(&params, "maxDepth"),
            opt_bool(&params, "includeCodepaprApps"),
        ).await?),
        "fs/search" => json_ok(codepapr_core::workspace_fs::search::search_workspace_text(
            require_workspace(ctx, &params)?,
            require_string(&params, "query")?,
            opt_bool(&params, "caseSensitive"),
            opt_bool(&params, "isRegexp"),
            opt_usize(&params, "contextLines"),
            opt_usize(&params, "maxResults"),
            opt_usize(&params, "maxMatchesPerFile"),
            opt_usize(&params, "maxBytesPerFile"),
            opt_bool(&params, "includeCodepaprApps"),
            opt_bool(&params, "includeIgnoredDirs"),
            parse_string_vec(&params, "includeGlobs"),
            parse_string_vec(&params, "excludeGlobs"),
        ).await?),
        "fs/searchPaths" => json_ok(codepapr_core::workspace_fs::search::search_workspace_paths(
            require_workspace(ctx, &params)?,
            require_string(&params, "query")?,
            opt_bool(&params, "caseSensitive"),
            opt_bool(&params, "isRegexp"),
            opt_usize(&params, "maxResults"),
            opt_bool(&params, "includeCodepaprApps"),
            opt_bool(&params, "includeIgnoredDirs"),
            parse_string_vec(&params, "includeGlobs"),
            parse_string_vec(&params, "excludeGlobs"),
        ).await?),
        "fs/checkExternalPath" => json_ok(codepapr_core::workspace_fs::access::check_external_path(
            require_workspace(ctx, &params)?,
            require_string(&params, "rawPath")?,
        )?),
        "fs/getExternalAccessPolicy" => json_ok(codepapr_core::workspace_fs::access::get_external_access_policy()?),
        "fs/setExternalAccessYolo" => json_ok(codepapr_core::workspace_fs::access::set_external_access_yolo(
            opt_bool(&params, "enabled").unwrap_or(false),
        )?),
        "fs/grantExternalAccess" => json_ok(codepapr_core::workspace_fs::access::grant_external_access(
            require_workspace(ctx, &params)?,
            require_string(&params, "rawPath")?,
            require_string(&params, "scope")?,
        )?),
        "fs/revokeExternalAccess" => json_ok(codepapr_core::workspace_fs::access::revoke_external_access(
            require_string(&params, "rawPath")?,
            require_string(&params, "scope")?,
        )?),
        "fs/clearExternalAccessGrants" => json_ok(codepapr_core::workspace_fs::access::clear_external_access_grants()?),
        "fs/ensureDefaultProject" => {
            let base = opt_string(&params, "baseOverride").map(std::path::PathBuf::from);
            json_ok(codepapr_core::workspace_fs::default_project::ensure_default_project(base).await?)
        }
        "fs/computeProjectStats" => {
            let ws = require_workspace(ctx, &params)?;
            let sink = Arc::clone(&ctx.event_sink);
            let progress_key = ws.clone();
            let cb: StatsProgressCallback = Arc::new(move |path, files| {
                sink.emit(
                    "project-stats-progress",
                    json!({ "workspacePath": path, "files": files, "key": progress_key }),
                );
            });
            json_ok(codepapr_core::workspace_fs::stats::compute_project_stats(ws, Some(cb)).await?)
        }
        "fs/cancelProjectStats" => {
            codepapr_core::workspace_fs::stats::cancel_project_stats(require_workspace(ctx, &params)?);
            Ok(json!({ "ok": true }))
        }
        "fs/saveChatImage" => json_ok(codepapr_core::workspace_fs::chat_images::save_chat_image(
            require_workspace(ctx, &params)?,
            require_string(&params, "mediaType")?,
            require_string(&params, "dataBase64")?,
        ).await?),
        "fs/loadChatImages" => json_ok(codepapr_core::workspace_fs::chat_images::load_chat_images(
            require_workspace(ctx, &params)?,
            parse_string_vec(&params, "paths").unwrap_or_default(),
        ).await?),
        "fs/startWatcher" => {
            codepapr_core::workspace_fs::watcher::start_workspace_watcher(
                require_workspace(ctx, &params)?,
                Arc::clone(&ctx.event_sink),
            )?;
            Ok(json!({ "ok": true }))
        }
        "fs/stopWatcher" => {
            codepapr_core::workspace_fs::watcher::stop_workspace_watcher()?;
            Ok(json!({ "ok": true }))
        }

        // ── Git ───────────────────────────────────────────────────────────
        "git/status" => json_ok(codepapr_core::git_operations::status::git_status(require_workspace(ctx, &params)?).await),
        "git/diff" => json_ok(codepapr_core::git_operations::diff::git_diff(
            require_workspace(ctx, &params)?,
            opt_bool(&params, "staged"),
            parse_string_vec(&params, "pathspecs"),
        ).await),
        "git/log" => json_ok(codepapr_core::git_operations::log::git_log(
            require_workspace(ctx, &params)?,
            opt_usize(&params, "limit"),
        ).await),
        "git/stage" => json_ok(codepapr_core::git_operations::stage::git_stage(
            require_workspace(ctx, &params)?,
            opt_bool(&params, "all"),
            parse_string_vec(&params, "pathspecs"),
        ).await),
        "git/commit" => json_ok(codepapr_core::git_operations::commit::git_commit(
            require_workspace(ctx, &params)?,
            require_string(&params, "message")?,
            opt_bool(&params, "stageAll"),
            parse_string_vec(&params, "pathspecs"),
            opt_bool(&params, "allowEmpty"),
        ).await),
        "git/branchList" => json_ok(codepapr_core::git_operations::branch::git_branch_list(require_workspace(ctx, &params)?).await),
        "git/branchCheckout" => json_ok(codepapr_core::git_operations::branch::git_branch_checkout(
            require_workspace(ctx, &params)?,
            require_string(&params, "branchName")?,
            opt_bool(&params, "create"),
            opt_bool(&params, "createIfMissing"),
            opt_string(&params, "startPoint"),
        ).await),
        "git/restoreFiles" => json_ok(codepapr_core::git_operations::restore_files::git_restore_files(
            require_workspace(ctx, &params)?,
            parse_string_vec(&params, "pathspecs"),
            opt_string(&params, "source"),
            opt_bool(&params, "includeUntracked"),
        ).await),

        // ── Shell ─────────────────────────────────────────────────────────
        "shell/execute" => json_ok(codepapr_core::shell::run_workspace_command(
            require_workspace(ctx, &params)?,
            require_string(&params, "command")?,
            parse_string_vec(&params, "args"),
            opt_u64(&params, "timeoutSeconds"),
            opt_string(&params, "workdir"),
            opt_string(&params, "cancelToken"),
        ).await?),
        "shell/executeShell" => json_ok(codepapr_core::shell::background::run_workspace_shell_command(
            require_workspace(ctx, &params)?,
            require_string(&params, "command")?,
            opt_string(&params, "workdir"),
            opt_u64(&params, "timeoutSeconds"),
            opt_sandbox(&params),
            opt_string(&params, "cancelToken"),
        ).await?),
        "shell/cancel" => json_ok(codepapr_core::shell::background::cancel_running_command(
            require_string(&params, "token")?,
        )?),
        "shell/startBackground" => json_ok(codepapr_core::shell::background::start_workspace_background_command(
            require_workspace(ctx, &params)?,
            require_string(&params, "command")?,
            parse_string_vec(&params, "args"),
            opt_string(&params, "workdir"),
            opt_string(&params, "previewUrl"),
            opt_sandbox(&params),
            parse_env_map(&params),
        )?),
        // papr 后端 app 专用：cwd 由服务端 resolve_app_dir 按 appId 解析，
        // global 应用无需工作区也能启动（workspacePath 可为空）。
        "shell/startAppBackground" => json_ok(codepapr_core::shell::background::start_app_background_command(
            opt_string(&params, "workspacePath").unwrap_or_default(),
            require_string(&params, "appId")?,
            require_string(&params, "command")?,
            parse_string_vec(&params, "args"),
            opt_string(&params, "previewUrl"),
            opt_sandbox(&params),
            parse_env_map(&params),
        )?),
        "shell/startShellBackground" => json_ok(codepapr_core::shell::background::start_workspace_shell_background_command(
            require_workspace(ctx, &params)?,
            require_string(&params, "command")?,
            opt_string(&params, "workdir"),
            opt_string(&params, "previewUrl"),
            opt_sandbox(&params),
        )?),
        "shell/listBackground" => json_ok(codepapr_core::shell::background::list_background_processes(
            opt_string(&params, "workspacePath"),
        )?),
        "shell/logUiEvent" => {
            codepapr_core::shell::background::log_ui_event(
                require_workspace(ctx, &params)?,
                require_string(&params, "message")?,
            );
            Ok(json!({ "ok": true }))
        }
        "shell/backgroundAlive" => Ok(json!(codepapr_core::shell::background::background_process_alive(
            opt_u64(&params, "pid").unwrap_or(0) as u32,
        ))),
        "shell/backgroundExitInfo" => json_ok(codepapr_core::shell::background::background_process_exit_info(
            opt_u64(&params, "pid").unwrap_or(0) as u32,
        )?),
        "shell/stopBackground" => json_ok(codepapr_core::shell::background::stop_background_process(
            opt_u64(&params, "pid").unwrap_or(0) as u32,
            opt_string(&params, "source"),
        )?),
        "shell/stopAllBackground" => json_ok(codepapr_core::shell::background::stop_all_background_processes(
            opt_string(&params, "workspacePath"),
            opt_string(&params, "source"),
        )?),
        "shell/openSession" => json_ok(codepapr_core::shell::session::open_shell_session(
            require_workspace(ctx, &params)?,
            opt_string(&params, "shell"),
        )?),
        "shell/listSessions" => json_ok(codepapr_core::shell::session::list_shell_sessions(
            opt_string(&params, "workspacePath"),
        )?),
        "shell/sendCommand" => json_ok(codepapr_core::shell::session::send_shell_command(
            require_string(&params, "sessionId")?,
            require_string(&params, "command")?,
            parse_string_vec(&params, "args"),
        )?),
        "shell/sendInput" => json_ok(codepapr_core::shell::session::send_shell_input(
            require_string(&params, "sessionId")?,
            require_string(&params, "input")?,
        )?),
        "shell/readOutput" => json_ok(codepapr_core::shell::session::read_shell_output(
            require_string(&params, "sessionId")?,
        )?),
        "shell/closeSession" => json_ok(codepapr_core::shell::session::close_shell_session(
            require_string(&params, "sessionId")?,
        )?),

        // ── Agent ─────────────────────────────────────────────────────────
        "agent/start" => {
            let resource_dir = opt_string(&params, "resourceDir").map(std::path::PathBuf::from);
            let runtime_id = codepapr_core::agent_runtime::agent_runtime_start(
                Arc::clone(&ctx.event_sink),
                resource_dir,
            )?;
            Ok(json!({ "runtimeId": runtime_id }))
        }
        "agent/send" => {
            codepapr_core::agent_runtime::agent_runtime_send(
                require_string(&params, "runtimeId")?,
                require_string(&params, "line")?,
            )?;
            Ok(json!({ "success": true }))
        }
        "agent/stop" => {
            codepapr_core::agent_runtime::agent_runtime_stop(require_string(&params, "runtimeId")?)?;
            Ok(json!({ "success": true }))
        }
        "agent/respondPermission" => {
            codepapr_core::agent_runtime_tools::agent_runtime_permission_respond(
                require_string(&params, "requestId")?,
                opt_bool(&params, "approved").unwrap_or(false),
                // Least privilege: a client that omits `scope` approves only
                // this operation; persisted grants must be asked for by name.
                opt_string(&params, "scope").unwrap_or_else(|| "once".to_string()),
            )?;
            Ok(json!({ "success": true }))
        }
        "agent/stopAll" => {
            codepapr_core::agent_runtime::stop_all();
            Ok(json!({ "ok": true }))
        }

        // ── DB ────────────────────────────────────────────────────────────
        "db/loadSettings" => json_ok(codepapr_core::db::load_app_settings(Some(&*ctx.secrets))?),
        "db/saveSettings" => json_ok(codepapr_core::db::save_app_settings(
            Some(Arc::clone(&ctx.secrets) as Arc<dyn codepapr_core::db::SecretStorage>),
            require_string(&params, "settingsJson")?,
        ).await?),
        "db/noteRecentWorkspace" => json_ok(codepapr_core::db::note_recent_workspace(require_string(&params, "path")?)?),
        "db/setRecentWorkspaces" => json_ok(codepapr_core::db::set_recent_workspaces(require_string(&params, "workspacesJson")?)?),
        "db/loadCharacters" => json_ok(codepapr_core::db::load_app_characters()?),
        "db/saveCharacters" => json_ok(codepapr_core::db::save_app_characters(require_string(&params, "charactersJson")?)?),
        "db/loadProjectState" => json_ok(codepapr_core::db::load_project_state(require_workspace(ctx, &params)?)?),
        "db/saveProjectState" => json_ok(codepapr_core::db::save_project_state(
            require_workspace(ctx, &params)?,
            require_string(&params, "stateJson")?,
            opt_bool(&params, "purgeDeletedContent"),
        )?),
        "db/saveSession" => { codepapr_core::db::save_session(require_workspace(ctx, &params)?, require_string(&params, "sessionJson")?)?; Ok(json!({ "ok": true })) }
        "db/loadSessions" => json_ok(codepapr_core::db::load_sessions(require_workspace(ctx, &params)?)?),
        "db/loadArchivedSessions" => json_ok(codepapr_core::db::load_archived_sessions(require_workspace(ctx, &params)?)?),
        "db/archiveSession" => { codepapr_core::db::archive_session(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?)?; Ok(json!({ "ok": true })) }
        "db/restoreSession" => { codepapr_core::db::restore_session(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?)?; Ok(json!({ "ok": true })) }
        "db/deleteSession" => { codepapr_core::db::delete_session(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?)?; Ok(json!({ "ok": true })) }
        "db/saveMessageBatch" => { codepapr_core::db::save_message_batch(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?, require_string(&params, "messagesJson")?)?; Ok(json!({ "ok": true })) }
        "db/loadSessionMessages" => json_ok(codepapr_core::db::load_session_messages(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?)?),
        "db/loadAllSessionMessages" => json_ok(codepapr_core::db::load_all_session_messages(require_workspace(ctx, &params)?)?),
        "db/aggregateToolUsage" => json_ok(codepapr_core::db::aggregate_tool_usage(require_workspace(ctx, &params)?)?),
        "db/aggregateSessionRuntime" => json_ok(codepapr_core::db::aggregate_session_runtime(require_workspace(ctx, &params)?)?),
        "db/saveProjectMeta" => { codepapr_core::db::save_project_meta(require_workspace(ctx, &params)?, require_string(&params, "key")?, require_string(&params, "value")?)?; Ok(json!({ "ok": true })) }
        "db/loadProjectMeta" => json_ok(codepapr_core::db::load_project_meta(require_workspace(ctx, &params)?, require_string(&params, "key")?)?),
        "db/loadAllProjectMeta" => json_ok(codepapr_core::db::load_all_project_meta(require_workspace(ctx, &params)?)?),
        "db/loadContextSurface" => json_ok(codepapr_core::db::load_context_surface(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?, opt_i64(&params, "generation"))?),
        "db/saveContextSurface" => { codepapr_core::db::save_context_surface(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?, opt_i64(&params, "generation").unwrap_or(0), opt_i64(&params, "parentGeneration"), opt_string(&params, "compactionId"), require_string(&params, "renderParamsJson")?, require_string(&params, "nodesJson")?)?; Ok(json!({ "ok": true })) }
        "db/discardContextSurfacesFromGeneration" => { codepapr_core::db::discard_context_surfaces_from_generation(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?, opt_i64(&params, "fromGeneration").unwrap_or(0))?; Ok(json!({ "ok": true })) }
        "db/commitContextCompaction" => json_ok(codepapr_core::db::commit_context_compaction(require_workspace(ctx, &params)?, require_string(&params, "requestJson")?)?),
        "db/markContextCompactionFailed" => { codepapr_core::db::mark_context_compaction_failed(require_workspace(ctx, &params)?, require_string(&params, "failureJson")?)?; Ok(json!({ "ok": true })) }
        "db/loadContextCompactions" => json_ok(codepapr_core::db::load_context_compactions(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?, opt_i64(&params, "limit"))?),
        "db/saveMemoryCandidate" => json_ok(codepapr_core::db::save_memory_candidate(require_workspace(ctx, &params)?, require_string(&params, "candidateJson")?)?),
        "db/admitMemoryCandidate" => json_ok(codepapr_core::db::admit_memory_candidate(require_workspace(ctx, &params)?, require_string(&params, "candidateId")?, require_string(&params, "entryId")?)?),
        "db/rejectMemoryCandidate" => { codepapr_core::db::reject_memory_candidate(require_workspace(ctx, &params)?, require_string(&params, "candidateId")?, opt_string(&params, "reason"))?; Ok(json!({ "ok": true })) }
        "db/forgetMemoryEntry" => { codepapr_core::db::forget_memory_entry(require_workspace(ctx, &params)?, require_string(&params, "entryId")?, opt_string(&params, "reason"))?; Ok(json!({ "ok": true })) }
        "db/reviveMemoryEntry" => { codepapr_core::db::revive_memory_entry(require_workspace(ctx, &params)?, require_string(&params, "entryId")?)?; Ok(json!({ "ok": true })) }
        "db/loadMemoryEntries" => json_ok(codepapr_core::db::load_memory_entries(require_workspace(ctx, &params)?, opt_bool(&params, "onlyActive"))?),
        "db/loadMemoryCandidates" => json_ok(codepapr_core::db::load_memory_candidates(require_workspace(ctx, &params)?, opt_string(&params, "status"))?),
        "db/projectMemoryFile" => { codepapr_core::db::project_memory_file(require_workspace(ctx, &params)?, require_string(&params, "managedZoneMarkdown")?)?; Ok(json!({ "ok": true })) }
        "db/syncUserZoneToLedger" => { codepapr_core::db::sync_user_zone_to_ledger(require_workspace(ctx, &params)?)?; Ok(json!({ "ok": true })) }
        "db/ingestLegacyMemoryMd" => json_ok(codepapr_core::db::ingest_legacy_memory_md(require_workspace(ctx, &params)?)?),
        "db/updateMemoryEntryContent" => { codepapr_core::db::update_memory_entry_content(require_workspace(ctx, &params)?, require_string(&params, "entryId")?, require_string(&params, "content")?)?; Ok(json!({ "ok": true })) }
        "db/saveMemoryRecall" => { codepapr_core::db::save_memory_recall(require_workspace(ctx, &params)?, require_string(&params, "recallJson")?)?; Ok(json!({ "ok": true })) }
        "db/archiveMemoryRecall" => { codepapr_core::db::archive_memory_recall(require_workspace(ctx, &params)?, require_string(&params, "recallId")?)?; Ok(json!({ "ok": true })) }
        "db/loadLatestMemoryRecall" => json_ok(codepapr_core::db::load_latest_memory_recall(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?)?),
        "db/searchMemoryForRecall" => json_ok(codepapr_core::db::search_memory_for_recall(require_workspace(ctx, &params)?, require_string(&params, "queryJson")?)?),
        "db/saveCheckpointRecord" => { codepapr_core::db::save_checkpoint_record(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?, require_string(&params, "messageId")?, require_string(&params, "sha")?, require_string(&params, "label")?, opt_i64(&params, "fileCount").unwrap_or(0))?; Ok(json!({ "ok": true })) }
        "db/loadCheckpointRecords" => json_ok(codepapr_core::db::load_checkpoint_records(require_workspace(ctx, &params)?, opt_string(&params, "sessionId"))?),
        "db/deleteCheckpointByMessage" => { codepapr_core::db::delete_checkpoint_by_message(require_workspace(ctx, &params)?, require_string(&params, "messageId")?)?; Ok(json!({ "ok": true })) }
        "db/deleteCheckpointsForSession" => { codepapr_core::db::delete_checkpoints_for_session(require_workspace(ctx, &params)?, require_string(&params, "sessionId")?)?; Ok(json!({ "ok": true })) }
        "db/saveProjectgraphCache" => {
            let cache = require_string(&params, "cacheData").or_else(|_| require_string(&params, "cacheJson"))?;
            codepapr_core::db::save_projectgraph_cache(require_workspace(ctx, &params)?, cache)?;
            Ok(json!({ "ok": true }))
        }
        "db/loadProjectgraphCache" => json_ok(codepapr_core::db::load_projectgraph_cache(require_workspace(ctx, &params)?)?),
        "db/cacheGet" => json_ok(codepapr_core::db::cache_get(require_string(&params, "key")?)?),
        "db/cacheSet" => { codepapr_core::db::cache_set(require_string(&params, "key")?, require_string(&params, "value")?, opt_i64(&params, "ttlMs"))?; Ok(json!({ "ok": true })) }
        "db/cacheRemove" => { codepapr_core::db::cache_remove(require_string(&params, "key")?)?; Ok(json!({ "ok": true })) }
        "db/settingsSaveState" => Ok(json!({
            "epoch": codepapr_core::db::settings_save_epoch(),
            "requests": codepapr_core::db::settings_save_requests(),
        })),
        "db/paprStorageGet" => json_ok(codepapr_core::db::papr_storage_get(&require_workspace(ctx, &params)?, &require_string(&params, "appId")?, &require_string(&params, "key")?)?),
        "db/paprStorageSet" => { codepapr_core::db::papr_storage_set(&require_workspace(ctx, &params)?, &require_string(&params, "appId")?, &require_string(&params, "key")?, &require_string(&params, "value")?)?; Ok(json!({ "ok": true })) }
        "db/paprStorageDelete" => { codepapr_core::db::papr_storage_delete(&require_workspace(ctx, &params)?, &require_string(&params, "appId")?, &require_string(&params, "key")?)?; Ok(json!({ "ok": true })) }
        "db/paprStorageKeys" => json_ok(codepapr_core::db::papr_storage_keys(&require_workspace(ctx, &params)?, &require_string(&params, "appId")?)?),
        "db/paprInboxAppend" => {
            let payload = params.get("payload").cloned().unwrap_or(Value::Null);
            json_ok(codepapr_core::db::papr_inbox_append(
                &require_workspace(ctx, &params)?,
                &require_string(&params, "appId")?,
                &require_string(&params, "channel")?,
                &payload.to_string(),
                opt_usize(&params, "cap"),
            )?)
        }
        "db/paprLoadPermissionSettings" => json_ok(codepapr_core::db::papr_load_permission_settings()?),
        "db/paprSavePermissionSettings" => { codepapr_core::db::papr_save_permission_settings(&require_string(&params, "settingsJson")?)?; Ok(json!({ "ok": true })) }

        // ── Snapshot ──────────────────────────────────────────────────────
        "snapshot/ensure" => json_ok(codepapr_core::snapshot::snapshot_ensure(require_workspace(ctx, &params)?).await),
        "snapshot/create" => json_ok(codepapr_core::snapshot::snapshot_create(require_workspace(ctx, &params)?, require_string(&params, "label")?).await?),
        "snapshot/list" => json_ok(codepapr_core::snapshot::snapshot_list(require_workspace(ctx, &params)?, opt_usize(&params, "limit")).await?),
        "snapshot/headSha" => Ok(json!(codepapr_core::snapshot::snapshot_head_sha(require_workspace(ctx, &params)?).await)),
        "snapshot/restorePlan" => json_ok(codepapr_core::snapshot::restore_plan(require_workspace(ctx, &params)?, require_string(&params, "targetSha")?).await?),
        "snapshot/restoreExecute" => json_ok(codepapr_core::snapshot::restore_execute(require_workspace(ctx, &params)?, require_string(&params, "targetSha")?).await?),
        "snapshot/restoreUndo" => json_ok(codepapr_core::snapshot::restore_undo(require_workspace(ctx, &params)?, opt_string(&params, "expectedBackupSha")).await?),
        "snapshot/changedFiles" => json_ok(codepapr_core::snapshot::snapshot_changed_files(require_workspace(ctx, &params)?, require_string(&params, "sha")?).await?),
        "snapshot/diff" => json_ok(codepapr_core::snapshot::diff_snapshots(require_workspace(ctx, &params)?, require_string(&params, "fromSha")?, require_string(&params, "toSha")?).await?),
        "snapshot/fileContent" => json_ok(codepapr_core::snapshot::snapshot_file_content(require_workspace(ctx, &params)?, require_string(&params, "sha")?, require_string(&params, "path")?).await?),
        "snapshot/indexFileContent" => json_ok(codepapr_core::snapshot::snapshot_index_file_content(require_workspace(ctx, &params)?, require_string(&params, "path")?).await?),

        // ── LSP / symbols ─────────────────────────────────────────────────
        "lsp/startServer" => json_ok(codepapr_core::lsp::lsp_start_server(require_workspace(ctx, &params)?, require_string(&params, "languageId")?).await?),
        "lsp/queryAvailability" => json_ok(codepapr_core::lsp::lsp_query_availability(require_workspace(ctx, &params)?, require_string(&params, "languageId")?).await?),
        "lsp/listComponents" => json_ok(codepapr_core::lsp::lsp_list_components().await?),
        "lsp/setDisabledFamilies" => { codepapr_core::lsp::lsp_set_disabled_families(parse_string_vec(&params, "families").unwrap_or_default()).await?; Ok(json!({ "ok": true })) }
        "lsp/openDocument" => json_ok(codepapr_core::lsp::lsp_open_document_with_sink(
            Some(ctx.event_sink.as_ref()),
            require_workspace(ctx, &params)?,
            require_string(&params, "languageId")?,
            require_string(&params, "relativePath")?,
            require_string(&params, "content")?,
            opt_i64(&params, "version").unwrap_or(1) as i32,
            opt_u64(&params, "diagWaitMs"),
        )?),
        "lsp/closeDocument" => json_ok(codepapr_core::lsp::lsp_close_document(require_workspace(ctx, &params)?, require_string(&params, "languageId")?, require_string(&params, "relativePath")?).await?),
        "lsp/request" => json_ok(codepapr_core::lsp::lsp_request(require_workspace(ctx, &params)?, require_string(&params, "languageId")?, require_string(&params, "lspMethod").or_else(|_| require_string(&params, "method"))?, params.get("lspParams").or_else(|| params.get("params")).cloned().unwrap_or(Value::Null)).await?),
        "lsp/diagnostics" => json_ok(codepapr_core::lsp::lsp_get_diagnostics(require_workspace(ctx, &params)?, require_string(&params, "languageId")?, opt_string(&params, "relativePath")).await?),
        "lsp/stopServer" => json_ok(codepapr_core::lsp::lsp_stop_server(require_workspace(ctx, &params)?, require_string(&params, "languageId")?).await?),
        "lsp/stopAll" => {
            codepapr_core::lsp::stop_all_servers();
            Ok(json!({ "ok": true }))
        }
        "lsp/batchSymbols" => {
            let files: Vec<LspBatchSymbolInput> = serde_json::from_value(params.get("files").cloned().unwrap_or(json!([]))).map_err(|e| e.to_string())?;
            json_ok(codepapr_core::lsp::lsp_batch_symbols(require_workspace(ctx, &params)?, files).await?)
        }
        "lsp/batchEnrich" => {
            let files: Vec<codepapr_core::lsp::LspBatchEnrichFile> = serde_json::from_value(params.get("files").cloned().unwrap_or(json!([]))).map_err(|e| e.to_string())?;
            json_ok(codepapr_core::lsp::lsp_batch_enrich(require_workspace(ctx, &params)?, files).await?)
        }
        "symbols/resolveProvider" => json_ok(codepapr_core::symbol_provider::resolve_symbol_provider(require_string(&params, "languageId")?)?),
        "symbols/listProviders" => json_ok(codepapr_core::symbol_provider::list_available_symbol_providers()?),
        "symbols/resolve" => json_ok(codepapr_core::symbol_provider::resolve_symbols(require_string(&params, "languageId")?, require_string(&params, "path")?, require_string(&params, "content")?)?),
        "symbols/hover" => json_ok(codepapr_core::symbol_provider::resolve_symbol_hover(require_string(&params, "languageId")?, require_string(&params, "path")?, require_string(&params, "content")?, opt_u64(&params, "line").unwrap_or(0) as usize, opt_u64(&params, "character").unwrap_or(0) as usize)?),
        "symbols/definition" => json_ok(codepapr_core::symbol_provider::resolve_symbol_definition(require_string(&params, "languageId")?, require_string(&params, "path")?, require_string(&params, "content")?, opt_u64(&params, "line").unwrap_or(0) as usize, opt_u64(&params, "character").unwrap_or(0) as usize)?),
        "symbols/references" => json_ok(codepapr_core::symbol_provider::resolve_symbol_references(require_string(&params, "languageId")?, require_string(&params, "path")?, require_string(&params, "content")?, opt_u64(&params, "line").unwrap_or(0) as usize, opt_u64(&params, "character").unwrap_or(0) as usize)?),
        "symbols/checkSyntax" => json_ok(codepapr_core::symbol_provider::check_syntax(require_string(&params, "languageId")?, require_string(&params, "content")?)?),
        "symbols/extractFileSymbols" => json_ok(codepapr_core::symbol_provider::extract_file_symbols(require_string(&params, "languageId")?, require_string(&params, "content")?)?),

        // ── MCP ───────────────────────────────────────────────────────────
        "mcp/listTools" => json_ok(codepapr_core::mcp_host::list_tools(parse_mcp_settings(&params)?, opt_bool(&params, "refresh").unwrap_or(false)).await?),
        "mcp/updateSettings" => { codepapr_core::mcp_host::update_settings(parse_mcp_settings(&params)?).await; Ok(json!({ "ok": true })) }
        "mcp/callTool" => json_ok(codepapr_core::mcp_host::call_tool(
            Some(Arc::clone(&ctx.event_sink)),
            params.get("settings").cloned().and_then(|v| serde_json::from_value(v).ok()),
            require_string(&params, "serverId")?,
            require_string(&params, "toolName")?,
            params.get("arguments").cloned().unwrap_or(json!({})),
        ).await?),
        "mcp/listStatus" => json_ok(codepapr_core::mcp_host::list_status(parse_mcp_settings(&params)?).await),
        "mcp/disconnectAll" => json_ok(codepapr_core::mcp_host::disconnect_all().await?),
        "mcp/testServer" => json_ok(codepapr_core::mcp_host::test_server(parse_mcp_settings(&params)?, require_string(&params, "serverId")?).await?),
        "mcp/previewServer" => json_ok(codepapr_core::mcp_host::preview_mcp_server(require_string(&params, "url")?, require_string(&params, "transport")?, opt_u64(&params, "timeoutSeconds")).await?),
        "mcp/disconnectServer" => json_ok(codepapr_core::mcp_host::disconnect_server(parse_mcp_settings(&params)?, require_string(&params, "serverId")?).await?),
        "mcp/confirmResponse" => { codepapr_core::mcp_host::resolve_confirmation(require_string(&params, "requestId")?, opt_bool(&params, "approved").unwrap_or(false)).await?; Ok(json!({ "ok": true })) }
        "mcp/healthCheck" => json_ok(codepapr_core::mcp_host::health_check().await),

        // ── Web ───────────────────────────────────────────────────────────
        "web/search" => json_ok(codepapr_core::web::search::search_web(
            require_string(&params, "query")?,
            opt_usize(&params, "maxResults"),
            opt_bool(&params, "searxngEnabled"),
            opt_string(&params, "searxngBaseUrl"),
            opt_string(&params, "searxngCategories"),
            opt_string(&params, "searxngTimeRange"),
            opt_string(&params, "searxngLanguage"),
            opt_u64(&params, "searxngSafeSearch").map(|v| v as u8),
            opt_string(&params, "searxngEngines"),
        ).await?),
        "web/fetchUrl" => json_ok(codepapr_core::web::fetch::fetch_web_url(require_string(&params, "url")?, opt_usize(&params, "maxBytes")).await?),
        "web/testSearxng" => json_ok(codepapr_core::web::search::probe_searxng(require_string(&params, "baseUrl")?).await),
        "web/downloadFile" => json_ok(codepapr_core::web::fetch::download_web_file(require_workspace(ctx, &params)?, require_string(&params, "url")?, opt_string(&params, "relativePath")).await?),

        // ── Task queue ────────────────────────────────────────────────────
        "task/enqueue" => Ok(json!(crate::tasks::enqueue(
            &require_string(&params, "taskType")?,
            require_workspace(ctx, &params)?,
            opt_string(&params, "relativePath"),
            opt_usize(&params, "maxDepth"),
            opt_usize(&params, "maxBytes"),
            opt_string(&params, "command"),
            parse_string_vec(&params, "args"),
            opt_u64(&params, "timeoutSeconds"),
        )?)),
        "task/poll" => Ok(crate::tasks::poll(opt_u64(&params, "taskId").unwrap_or(0))),

        unknown => Err(format!("Unknown JSON-RPC method: {unknown}")),
    }
}

fn json_ok(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn pget<'a>(params: &'a Value, camel: &str) -> Option<&'a Value> {
    if let Some(v) = params.get(camel) {
        return Some(v);
    }
    let mut snake = String::new();
    for (i, c) in camel.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                snake.push('_');
            }
            snake.extend(c.to_lowercase());
        } else {
            snake.push(c);
        }
    }
    params.get(&snake)
}

fn require_workspace(ctx: &Arc<ServerContext>, params: &Value) -> Result<String, String> {
    if let Some(ws) = pget(params, "workspacePath").and_then(|v| v.as_str()) {
        if !ws.trim().is_empty() {
            return Ok(ws.to_string());
        }
    }
    if let Some(ref default) = ctx.default_workspace {
        return Ok(default.clone());
    }
    Err("workspacePath is required in params or via --workspace flag".to_string())
}

fn require_path(params: &Value) -> Result<String, String> {
    require_string(params, "path")
        .or_else(|_| require_string(params, "relativePath"))
}

fn require_string(params: &Value, camel: &str) -> Result<String, String> {
    pget(params, camel)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Missing required string parameter: {camel}"))
}

fn opt_string(params: &Value, camel: &str) -> Option<String> {
    pget(params, camel).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn opt_bool(params: &Value, camel: &str) -> Option<bool> {
    pget(params, camel).and_then(|v| v.as_bool())
}

fn opt_u64(params: &Value, camel: &str) -> Option<u64> {
    pget(params, camel).and_then(|v| v.as_u64())
}

fn opt_i64(params: &Value, camel: &str) -> Option<i64> {
    pget(params, camel).and_then(|v| v.as_i64()).or_else(|| opt_u64(params, camel).map(|v| v as i64))
}

fn opt_usize(params: &Value, camel: &str) -> Option<usize> {
    opt_u64(params, camel).map(|v| v as usize)
}

fn parse_string_vec(params: &Value, camel: &str) -> Option<Vec<String>> {
    pget(params, camel).and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
    })
}

fn parse_env_map(params: &Value) -> Option<std::collections::HashMap<String, String>> {
    pget(params, "env").and_then(|v| v.as_object()).map(|obj| {
        obj.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect()
    })
}

fn opt_sandbox(params: &Value) -> Option<SandboxAccessArgs> {
    pget(params, "sandbox").and_then(|v| serde_json::from_value(v.clone()).ok())
}

fn parse_mcp_settings(params: &Value) -> Result<McpSettings, String> {
    let raw = pget(params, "settings").cloned().unwrap_or_else(|| params.clone());
    serde_json::from_value(raw).map_err(|e| format!("Invalid MCP settings: {e}"))
}
