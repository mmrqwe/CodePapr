import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toast } from './toastStore';
import {
  applySkillEnablement,
  BUILTIN_AGENTS,
  CommandDefinition,
  EditHistory,
  type AgentDefinition,
  type SkillDefinition,
  expandCommandTemplate,
  getBuiltinPromptCommand,
  mergeAgentDefinitions,
  parseSlashInput,
  sanitizeAgentPrompt,
  parseGoalCondition,
  evaluateGoalCondition,
  GoalRunner,
  serializeGoalState,
  GoalConditionParseError,
  renderTodoListDigest,
} from '@codepapr/core';
import type {
  IAgentResponse,
  ICacheStatistics,
  IToolDefinition,
  GoalCondition,
} from '@codepapr/types';
import { CacheValidator, RequestBuilder } from '@codepapr/api';
import { createId } from '../utils/createId';
import { loadProjectState } from '../utils/projectStorage';
import {
  loadSessions,
  loadSessionMessages,
  loadAllSessionMessages,
  loadAllProjectMeta,
} from '../utils/projectStorage';
import { runProjectDiagnostics } from '../utils/projectDiagnostics';
import { loadAppSettings, saveAppSettings } from '../utils/appSettingsStorage';
import {
  snapshotEnsure,
  snapshotCreate,
  snapshotList,
  restoreExecute,
  saveCheckpointRecord,
  loadCheckpointRecords,
  deleteCheckpointByMessage,
  deleteCheckpointsForSession,
} from '../utils/snapshot';
import {
  buildCheckpointCommitMessage,
  nextCheckpointSequence,
} from '../utils/workspaceGitPanel';
import type { WorkMode } from '../utils/agentPrompts';
import { buildModePrompt } from '../utils/agentPrompts';
import { getTranslation } from '../utils/i18n';
import { yieldToMainThread } from '../utils/taskScheduling';
import {
  buildPrimaryModelRoute,
  selectTaskModelRoute,
} from '../utils/modelRouting';
import {
  bootstrapMemoryContent,
  consolidateMemoryContent,
  MEMORY_CONSOLIDATION_MAX_LINES,
  planMemoryConsolidation,
} from '../utils/memoryConsolidation';
import {
  accumulateCacheStats,
  buildExecutionContextSummary,
  collectExecutedTools,
  type ExecutedToolSummary,
} from '../utils/agentExecution';
import { restoreTodoListContexts, getTodoListContext } from '../tools/todoListTool';
import { getActiveCharacterPrompt } from './charactersStore';
import { loadMcpToolDefinitions } from '../tools/mcpTools';
import {
  listCommandDefinitions,
  loadAgentDefinitions,
  loadCommandDefinition,
  loadProjectRulesSection,
  loadSkillDefinitions,
  readWorkspaceTextFile,
  runWorkspaceInlineCommand,
} from '../utils/projectConfigLoader';

import { createEmptyConversationStats, DEFAULT_SETTINGS } from './internals/defaults';
import {
  getProviderLabel as _getProviderLabel,
  getSettingsError,
  isApiConfigured as _isApiConfigured,
  normalizeSettings,
  resolveProviderName,
} from './internals/settingsNormalizer';
import { addConversationStats, cloneConversationStats, getSessionConversationStats } from './internals/stats';
import {
  normalizeProjectSnapshot,
  normalizeSkillEnabledState,
  maybeApplySessionTitle,
} from './internals/persistence';
import { saveCurrentProjectState } from './internals/projectSnapshot';
import {
  appendErrorMessage,
  appendInfoMessage,
  appendStreamingAssistantMessage,
  applyToolStreamEvent,
  cleanupStreamingAssistantMessage,
  mergeMessageText,
  updateAssistantMessage,
} from './internals/messageMutators';
import { formatAgentError } from './internals/errorFormatting';
import { buildCommandHelpMessage } from './internals/commandHelp';
import { shouldFallbackToPrimaryModel } from './internals/fallbackPolicy';
import {
  buildAgentRuntimeSystemPrompt,
  buildAgentRuntimeUserPrompt,
  buildAgentSessionBootstrapPrompt,
  buildProjectGraphBootstrapSummary,
} from './internals/promptBuilders';
import {
  AgentRuntimeConfig,
  createAgent,
  getAgentMessagesSince,
  setDefaultOnWorkspaceMutatedResolver,
} from './internals/agentFactory';
import { buildProviderInstance } from './internals/providerFactory';
import { WorkerCrashError } from '../agent/WorkerBackedAgent';
import { maybeGenerateContextCheckpoint } from './internals/contextCheckpoint';
import { insertCheckpointAtRetainedBoundary } from '../utils/contextCompaction';
import { handleWorkspaceMutation } from './internals/backgroundDiagnostics';
import { runVerifier } from '../utils/verifierRunner';
import { useGoalStore } from './goalStore';
import type { CommandResult } from '../tools/streamingWorkspaceCommand';
import type {
  AgentActions,
  AgentState,
  ConversationStats,
  Lang,
  ResetToMessageResult,
  SessionMeta,
  UIMessage,
  UIToolInvocation,
  WorkspaceEntry,
} from './internals/types';

// Re-exports preserved for the public agentStore module surface
export type {
  ApiFormat,
  ApiMode,
  CumulativeStats,
  Lang,
  ProviderName,
  ResetToMessageResult,
  SessionMeta,
  Settings,
  UIMessage,
  UIToolInvocation,
  WorkspaceEntry,
} from './internals/types';
export {
  getProviderLabel,
  getSettingsError,
  isApiConfigured,
  normalizeSettings,
  resolveProviderName,
} from './internals/settingsNormalizer';

// Marker to silence unused-import lint for re-exported helpers
void _getProviderLabel;
void _isApiConfigured;

// Guards cold-start memory.md bootstrap so concurrent sendMessage calls
// don't trigger duplicate generation. Module-level on purpose: the guard
// spans the whole session, not a single store snapshot.
let memoryBootstrapInFlight = false;

// Serializes background memory.md read-modify-write operations (cold-start
// bootstrap and post-reply consolidation). They share one file and each does a
// full-overwrite write; without serialization a slow bootstrap write can land
// between a consolidation's read and write (or vice versa) and clobber it. The
// chain never rejects, so a failing task does not wedge subsequent ones.
let memoryWriteChain: Promise<void> = Promise.resolve();
function withMemoryLock<T>(task: () => Promise<T>): Promise<T> {
  const result = memoryWriteChain.then(task);
  memoryWriteChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// Snapshot the current todo digest so a context checkpoint can freeze it. The
// frozen digest is reused on every rebuild (instead of re-rendering from live
// todo state), keeping the rebuilt context byte-stable for the prefix cache.
function currentTodoDigest(sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;
  const ctx = getTodoListContext(sessionId);
  if (!ctx || ctx.tasks.length === 0) return undefined;
  return renderTodoListDigest(ctx);
}

// Per-session cache of the session-bootstrap prompt. The bootstrap embeds
// volatile disk state (memory.md, project-graph summary) that changes on file
// edits; rebuilding the agent whenever that changes breaks DeepSeek's prefix
// cache for the whole history. We freeze the bootstrap per (session × stable
// signature) so volatile changes do NOT force a rebuild — memory/graph updates
// take effect on the next session or when a stable input (mode/rules/lang/
// skills/system prompt/character) changes.
const sessionBootstrapCache = new Map<string, { signature: string; bootstrap: string }>();

function resolveSessionBootstrap(
  sessionId: string | null,
  signature: string,
  computeFresh: () => string
): string {
  if (!sessionId) return computeFresh();
  const cached = sessionBootstrapCache.get(sessionId);
  if (cached && cached.signature === signature) {
    return cached.bootstrap;
  }
  const bootstrap = computeFresh();
  sessionBootstrapCache.set(sessionId, { signature, bootstrap });
  return bootstrap;
}

function upsertRecentWorkspace(
  recent: WorkspaceEntry[],
  path: string,
): WorkspaceEntry[] {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return recent;
  }
  const name = normalizedPath.split(/[\\/]/).filter(Boolean).pop() ?? normalizedPath;
  const existingIndex = recent.findIndex((entry) => entry.path === normalizedPath);
  const now = Date.now();
  if (existingIndex >= 0) {
    const entry = recent[existingIndex];
    const updated = { ...entry, name: name || entry.name, lastOpenedAt: now, path: normalizedPath };
    const rest = recent.filter((_, i) => i !== existingIndex);
    return [updated, ...rest];
  }
  const newEntry: WorkspaceEntry = { path: normalizedPath, name, lastOpenedAt: now, pinned: false };
  return [newEntry, ...recent].slice(0, 10);
}

function sortRecentWorkspaces(recent: WorkspaceEntry[]): WorkspaceEntry[] {
  const pinned = recent.filter((e) => e.pinned);
  const unpinned = recent.filter((e) => !e.pinned);
  unpinned.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return [...pinned, ...unpinned];
}

function extractFilePathsFromToolInvocations(
  invocations: readonly UIToolInvocation[] = [],
): string[] {
  const paths = new Set<string>();
  for (const tool of invocations) {
    const args = tool.arguments ?? {};
    const path = extractFilePathFromArgs(args);
    if (path) {
      paths.add(path);
    }
  }
  return Array.from(paths);
}

function extractFilePathsFromExecutedTools(
  tools: readonly ExecutedToolSummary[] = [],
): string[] {
  const paths = new Set<string>();
  for (const tool of tools) {
    const args = tool.arguments ?? {};
    const path = extractFilePathFromArgs(args);
    if (path) {
      paths.add(path);
    }
  }
  return Array.from(paths);
}

function extractFilePathFromArgs(args: Record<string, unknown>): string {
  return (
    (typeof args.relativePath === 'string' ? (args.relativePath as string) : '') ||
    (typeof args.path === 'string' ? (args.path as string) : '') ||
    (typeof args.filePath === 'string' ? (args.filePath as string) : '')
  );
}

function buildModeSwitchMessage(mode: WorkMode): UIMessage {
  return {
    id: createId(),
    role: 'assistant' as const,
    workMode: mode,
    content: `[Mode: ${mode.toUpperCase()}] ${mode === 'app' ? 'You are now in App mode. Generate interactive HTML applications for data visualization and exploration. Use tools to analyze data, write HTML, and then render with app_render.' : `You are now in ${mode} mode with full tool access. Previous ask-mode responses are for context only; use tools proactively for this task.`}`,
    synthetic: true,
    hidden: true,
    carryForwardInContext: true,
    timestamp: Date.now(),
  };
}

export const useAgentStore = create<AgentState & AgentActions>()((set, get) => ({
      settings: DEFAULT_SETTINGS,
      workspacePath: '',
  workspaceMutationVersion: 0,
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      skillEnabledById: {},
      conversationStats: createEmptyConversationStats(),
      sessionConversationStats: {},
      projectDiagnosticsReport: null,
      isLoading: false,
      projectGraphLoading: false,
      projectGraphPhase: null as null | { phase: string; current: number; total: number },
      showSettings: false,
      settingsLoaded: false,
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _requestBuilder: new RequestBuilder(),
      _cacheValidator: new CacheValidator(),
      _editHistory: new EditHistory(),
      _projectRulesSection: '',
      _skillDefinitions: [],
      _agentDefinitions: [...BUILTIN_AGENTS],
      _taskChecklists: {},
      _messageCheckpoints: {},
      _gitReady: false,
      _gitReadyError: null,
      _checkpointError: null,
      _checkpointSeq: 0,
      _pendingMemoryConsolidation: false,
      _latestContextSnapshot: null,

      loadSettings: async () => {
        let settings = get().settings;
        try {
          const storedSettings = await loadAppSettings();
          settings = normalizeSettings(storedSettings ?? get().settings);
          set({ settings, settingsLoaded: true, _agent: null, _agentModel: null, _agentPromptKey: null });

          // No proactive write-back on load: legacy plaintext-key migration is
          // already handled (and re-persisted) by the backend's
          // migrate_and_inject_secrets. Writing normalized settings back here
          // would run on every launch and could feed an empty apiKey into the
          // vault (interpreted as "user cleared the key") when vault injection
          // returns nothing, destroying a stored key.
        } catch {
          settings = get().settings;
          set({ settingsLoaded: true, _agent: null, _agentModel: null, _agentPromptKey: null });
        }

        const recentWorkspaces = sortRecentWorkspaces(settings.recentWorkspaces);
        let openedWorkspace = false;
        for (const entry of recentWorkspaces) {
          try {
            await get().openWorkspace(entry.path);
            openedWorkspace = true;
            break;
          } catch {
            const currentSettings = get().settings;
            const withoutFailed = currentSettings.recentWorkspaces.filter(
              (e) => e.path !== entry.path,
            );
            const nextSettings = normalizeSettings({
              ...currentSettings,
              recentWorkspaces: withoutFailed,
            });
            set({ settings: nextSettings, _agent: null, _agentModel: null, _agentPromptKey: null });
            void saveAppSettings(nextSettings).catch(() => undefined);
          }
        }

        // 兜底：没有任何可用项目（首次启动或全部 recent 已失效）时，
        // 自动创建并打开默认项目，保证对话产生的文件始终有落点。
        if (!openedWorkspace) {
          await get().ensureDefaultWorkspace();
        }
      },

      setSettings: (partial) => {
        const settings = normalizeSettings({ ...get().settings, ...partial });
        set({ settings, _agent: null, _agentModel: null, _agentPromptKey: null });
        void saveAppSettings(settings).catch(() => undefined);
      },

      setWorkspacePath: (path) => {
        set((s) => {
          if (s.workspacePath === path) {
            return { workspacePath: path, _agent: null, workspaceMutationVersion: 0 };
          }
          return {
            workspacePath: path,
            workspaceMutationVersion: 0,
            sessions: [],
            activeSessionId: null,
            messages: [],
            sessionMessages: {},
            skillEnabledById: {},
            conversationStats: createEmptyConversationStats(),
            sessionConversationStats: {},
      projectDiagnosticsReport: null,
      projectGraphLoading: false,
      projectGraphPhase: null,
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _editHistory: new EditHistory(),
      _projectRulesSection: '',
      _skillDefinitions: [],
      _agentDefinitions: [...BUILTIN_AGENTS],
      _taskChecklists: {},
      _messageCheckpoints: {},
      _gitReady: false,
      _gitReadyError: null,
      _checkpointError: null,
      _checkpointSeq: 0,
          };
        });
        if (path) {
          void get()._loadProjectConfig(path);
          void get()._ensureWorkspaceGitReady(path);
        }
      },

      closeWorkspace: () => {
        set({
          workspacePath: '',
          workspaceMutationVersion: 0,
          projectGraphLoading: false,
          projectGraphPhase: null,
          sessions: [],
          activeSessionId: null,
          messages: [],
          sessionMessages: {},
          skillEnabledById: {},
          conversationStats: createEmptyConversationStats(),
          sessionConversationStats: {},
          projectDiagnosticsReport: null,
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _editHistory: new EditHistory(),
          _projectRulesSection: '',
          _skillDefinitions: [],
          _agentDefinitions: [...BUILTIN_AGENTS],
          _taskChecklists: {},
          _messageCheckpoints: {},
          _gitReady: false,
          _gitReadyError: null,
          _checkpointError: null,
          _checkpointSeq: 0,
        });
      },

      openWorkspace: async (path) => {
        // 切换 = 先关闭（同步清空 UI，避免 async 加载期间显示旧浮层）+ 再打开
        get().closeWorkspace();

        const normalizedWorkspacePath = path.trim();

        let sessions: SessionMeta[] = [];
        let sessionMessages: Record<string, UIMessage[]> = {};
        let activeSessionId: string | null = null;
        let skillEnabledById: Record<string, boolean> = {};
        let conversationStats = createEmptyConversationStats();
        let sessionConversationStats: Record<string, unknown> = {};
        let projectDiagnosticsReport: unknown = null;
        let messageCheckpoints: Record<string, string> = {};
        let sessionTodoLists: Record<string, unknown> = {};

        try {
          sessions = (await loadSessions(normalizedWorkspacePath)).map((meta) => ({
            ...meta,
            createdAt: meta.createdAt,
          })) as unknown as SessionMeta[];

          // Batch-load every session's messages in a single IPC round-trip (one
          // connection open) instead of one load per session. Fall back to
          // per-session loads if the batch command is unavailable/errors.
          let batchedMessages: Record<string, UIMessage[]> | null = null;
          try {
            const loaded = await loadAllSessionMessages(normalizedWorkspacePath);
            batchedMessages = {};
            for (const [id, msgs] of Object.entries(loaded)) {
              batchedMessages[id] = msgs as unknown as UIMessage[];
            }
          } catch {
            batchedMessages = null;
          }
          for (const s of sessions) {
            if (batchedMessages) {
              sessionMessages[s.id] = batchedMessages[s.id] ?? [];
            } else {
              try {
                const msgs = await loadSessionMessages(normalizedWorkspacePath, s.id);
                sessionMessages[s.id] = msgs as unknown as UIMessage[];
              } catch {
                sessionMessages[s.id] = [];
              }
            }
          }

          const meta = await loadAllProjectMeta(normalizedWorkspacePath);
          const rawActiveSessionId = (meta.active_session_id as string) ?? null;
          activeSessionId = rawActiveSessionId && sessions.some(s => s.id === rawActiveSessionId)
            ? rawActiveSessionId
            : null;
          skillEnabledById = (meta.skill_enabled_by_id as Record<string, boolean>) ?? {};
          const rawStats = meta.conversation_stats as { primary?: unknown; fast?: unknown } | null;
          // cloneConversationStats fills in any tier missing from older persisted
          // data (e.g. the mentor tier added later), so loaded stats always have
          // a complete primary/fast/mentor shape.
          conversationStats = rawStats && rawStats.primary && rawStats.fast
            ? cloneConversationStats(rawStats as Parameters<typeof cloneConversationStats>[0])
            : createEmptyConversationStats();
          const rawSessionStats = meta.session_conversation_stats as Record<string, unknown> | null;
          sessionConversationStats = {};
          for (const [id, stats] of Object.entries(rawSessionStats ?? {})) {
            sessionConversationStats[id] = cloneConversationStats(
              stats as Parameters<typeof cloneConversationStats>[0]
            );
          }
          projectDiagnosticsReport = meta.project_diagnostics_report ?? null;
          sessionTodoLists = (meta.session_todo_lists as Record<string, unknown>) ?? {};

          // 安全兜底：如果新表完全无数据（sessions 和 meta 都空），回退到旧格式
          if (sessions.length === 0 && Object.keys(meta).length === 0) {
            throw new Error('新表无数据，尝试旧格式');
          }
        } catch (metaErr) {
          console.warn('[CodePapr] 从新表加载失败，回退到旧格式:', metaErr);
          const snapshot = normalizeProjectSnapshot(await loadProjectState(normalizedWorkspacePath), {
            debugEnabled: get().settings.debugEnabled,
          });
          sessions = snapshot.sessions as SessionMeta[];
          sessionMessages = snapshot.sessionMessages as Record<string, UIMessage[]>;
          activeSessionId = snapshot.activeSessionId;
          skillEnabledById = normalizeSkillEnabledState(snapshot.skillEnabledById);
          conversationStats = snapshot.activeSessionId
            ? getSessionConversationStats(snapshot.sessionConversationStats ?? {}, snapshot.activeSessionId)
            : createEmptyConversationStats();
          sessionConversationStats = {};
          for (const [id, stats] of Object.entries(snapshot.sessionConversationStats ?? {})) {
            sessionConversationStats[id] = cloneConversationStats(
              stats as Parameters<typeof cloneConversationStats>[0]
            );
          }
          projectDiagnosticsReport = snapshot.projectDiagnosticsReport;
          messageCheckpoints = snapshot.messageCheckpoints ?? {};
          sessionTodoLists = snapshot.sessionTodoLists ?? {};
        }

        const messages = activeSessionId
          ? (sessionMessages[activeSessionId] ?? [])
          : [];

        const finalConversationStats = activeSessionId
          ? getSessionConversationStats(
              sessionConversationStats as Record<string, import('./internals/types').ConversationStats>,
              activeSessionId
            )
          : conversationStats;

        set({
          workspacePath: path,
          workspaceMutationVersion: 0,
          projectGraphLoading: false,
          projectGraphPhase: null,
          sessions,
          activeSessionId,
          messages,
          sessionMessages,
          skillEnabledById,
          conversationStats: finalConversationStats,
          sessionConversationStats: sessionConversationStats as Record<string, import('./internals/types').ConversationStats>,
          projectDiagnosticsReport: projectDiagnosticsReport as import('../utils/projectDiagnostics').ProjectDiagnosticsReport | null,
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _editHistory: new EditHistory(),
          _projectRulesSection: '',
          _skillDefinitions: [],
          _agentDefinitions: [...BUILTIN_AGENTS],
          _taskChecklists: {},
          _messageCheckpoints: { ...messageCheckpoints },
          _gitReady: false,
          _gitReadyError: null,
          _checkpointError: null,
          _checkpointSeq: 0,
        });

        if (sessionTodoLists && Object.keys(sessionTodoLists).length > 0) {
          restoreTodoListContexts(sessionTodoLists as Record<string, import('@codepapr/types').TodoListContext>);
        }

        // 仅当确实加载到会话时才回写，避免用空状态覆盖磁盘上的历史数据
        // （加载失败/数据库为空等场景下不应触发回写）
        if (sessions.length > 0) {
          saveCurrentProjectState(get());
        }
        await get()._loadProjectConfig(path);
        void get()._ensureWorkspaceGitReady(path);

        const currentSettings = get().settings;
        if (get().settingsLoaded && normalizedWorkspacePath) {
          const nextRecent = upsertRecentWorkspace(currentSettings.recentWorkspaces, normalizedWorkspacePath);
          const nextSettings = normalizeSettings({
            ...currentSettings,
            recentWorkspaces: nextRecent,
          });
          set({ settings: nextSettings });
          void saveAppSettings(nextSettings).catch(() => undefined);
        }
      },

      ensureDefaultWorkspace: async () => {
        try {
          const result = await invoke<{ path: string }>('ensure_default_project');
          const path = result?.path?.trim();
          if (!path) return null;
          await get().openWorkspace(path);
          return path;
        } catch (err) {
          console.warn('[CodePapr] 创建默认项目失败:', err);
          return null;
        }
      },

      noteWorkspaceMutation: (paths) => {
        handleWorkspaceMutation({
          get,
          set,
          paths,
          scheduleDiagnostics: true,
          autoRepair: (paths ?? []).length > 0,
        });
      },

      _loadProjectConfig: async (path) => {
        if (!path) {
          return;
        }
        const [rulesSection, skillDefinitions, agentDefinitions] = await Promise.all([
          loadProjectRulesSection(invoke, path).catch(() => ''),
          loadSkillDefinitions(invoke, path).catch(() => [] as SkillDefinition[]),
          loadAgentDefinitions(invoke, path).catch(() => [] as AgentDefinition[]),
        ]);
        const mergedAgents = mergeAgentDefinitions(BUILTIN_AGENTS, agentDefinitions);
        const { settings } = get();
        const customPrompts: Record<string, string> = {
          explore: settings.explorePrompt,
          scout: settings.scoutPrompt,
          mentor: settings.mentorPrompt,
        };
        for (const agent of mergedAgents) {
          const custom = customPrompts[agent.name];
          if (custom?.trim()) {
            agent.prompt = sanitizeAgentPrompt(custom.trim());
          }
        }
        // 仅当仍停留在同一工作区时写回，避免竞态覆盖。
        if (get().workspacePath !== path) {
          return;
        }
        const enabledSkillDefinitions = applySkillEnablement(
          skillDefinitions,
          get().skillEnabledById
        );
        set({
          _projectRulesSection: rulesSection,
          _skillDefinitions: enabledSkillDefinitions,
          _agentDefinitions: mergedAgents,
          _agent: null,
          _agentPromptKey: null,
        });
      },

      _ensureWorkspaceGitReady: async (path) => {
        if (!path) {
          set({ _gitReady: false, _gitReadyError: null, _checkpointError: null });
          return;
        }
        // 最多重试 2 次：并发初始化时可能因 index.lock 冲突而失败，
        // 等待 500ms 后重试可以解决绝大多数竞态。
        let lastError: string | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await snapshotEnsure(path);
            if (get().workspacePath !== path) return;
            if (result.ready) {
              set({ _gitReady: true, _gitReadyError: null });
              try {
                const [snapshots, records] = await Promise.all([
                  snapshotList(path, 200),
                  loadCheckpointRecords(path, undefined),
                ]);
                if (get().workspacePath !== path) return;
                if (records.length > 0) {
                  const cps: Record<string, string> = {};
                  let maxSeq = 0;
                  for (const r of records) {
                    cps[r.messageId] = r.sha;
                    const seqMatch = r.label.match(/checkpoint #(\d+)/);
                    if (seqMatch) {
                      maxSeq = Math.max(maxSeq, parseInt(seqMatch[1], 10));
                    }
                  }
                  set({ _messageCheckpoints: cps, _checkpointSeq: maxSeq });
                } else {
                  const subjects = snapshots.map((s) => s.label);
                  const next = nextCheckpointSequence(subjects);
                  set({ _checkpointSeq: Math.max(0, next - 1) });
                }
              } catch {
                // 推断失败不影响功能，序号会从 0 开始
              }
              return;
            }
            lastError = result.error ?? null;
          } catch (err) {
            if (get().workspacePath !== path) return;
            lastError = err instanceof Error ? err.message : String(err);
          }
          // 等待 500ms 后重试（最后一次不等待）
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        // 所有重试都失败
        if (get().workspacePath !== path) return;
        set({
          _gitReady: false,
          _gitReadyError: lastError,
          _checkpointError: null,
        });
      },

      setSkillEnabledState: (skillId, enabled) => {
        const normalizedSkillId = skillId.trim();
        if (!normalizedSkillId) {
          return;
        }

        set((state) => {
          const skillEnabledById = { ...state.skillEnabledById };
          if (enabled === null || enabled) {
            delete skillEnabledById[normalizedSkillId];
          } else {
            skillEnabledById[normalizedSkillId] = false;
          }

          return {
            skillEnabledById,
            _skillDefinitions: state._skillDefinitions.map((skill) =>
              skill.id === normalizedSkillId ? { ...skill, enabled: enabled !== false } : skill
            ),
            _agent: null,
            _agentPromptKey: null,
          };
        });

        saveCurrentProjectState(get());
      },

      setShowSettings: (v) => set({ showSettings: v }),
      setProjectGraphLoading: (loading, phase) =>
        set({ projectGraphLoading: loading, projectGraphPhase: phase ?? null }),

      newSession: () => {
        const { settings } = get();
        const normalizedSettings = normalizeSettings(settings);
        const id = createId();
        const meta: SessionMeta = {
          id,
          name: '新任务',
          provider: resolveProviderName(normalizedSettings),
          model: normalizedSettings.model,
          createdAt: Date.now(),
        };
        set((s) => ({
          sessions: [meta, ...s.sessions],
          activeSessionId: id,
          messages: [],
          sessionMessages: {
            ...s.sessionMessages,
            [id]: [],
          },
          conversationStats: createEmptyConversationStats(),
          sessionConversationStats: {
            ...s.sessionConversationStats,
            [id]: createEmptyConversationStats(),
          },
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _latestContextSnapshot: null,
        }));
        saveCurrentProjectState(get());
      },

      selectSession: (id) => {
        const { sessions, activeSessionId, sessionMessages, sessionConversationStats } = get();
        if (id === activeSessionId) return;
        const meta = sessions.find((s) => s.id === id);
        if (!meta) return;
        const messages = sessionMessages[id] ?? [];
        set({
          activeSessionId: id,
          messages,
          conversationStats: getSessionConversationStats(sessionConversationStats, id),
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
        });
        saveCurrentProjectState(get());
      },

      deleteSession: (id) => {
        set((s) => {
          const sessions = s.sessions.filter((x) => x.id !== id);
          const isActive = s.activeSessionId === id;
          const sessionMessages = { ...s.sessionMessages };
          const sessionConversationStats = { ...s.sessionConversationStats };
          delete sessionMessages[id];
          delete sessionConversationStats[id];
          return {
            sessions,
            activeSessionId: isActive ? null : s.activeSessionId,
            messages: isActive ? [] : s.messages,
            sessionMessages,
            sessionConversationStats,
            conversationStats: isActive ? createEmptyConversationStats() : s.conversationStats,
            _agent: isActive ? null : s._agent,
            _agentModel: isActive ? null : s._agentModel,
            _agentPromptKey: isActive ? null : s._agentPromptKey,
            _latestContextSnapshot: isActive ? null : s._latestContextSnapshot,
          };
        });
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
      },

      clearMessages: () => {
        const sessionId = get().activeSessionId;
        set((s) => ({
          messages: [],
          sessionMessages: s.activeSessionId
            ? {
                ...s.sessionMessages,
                [s.activeSessionId]: [],
              }
            : s.sessionMessages,
          sessionConversationStats: s.activeSessionId
            ? {
                ...s.sessionConversationStats,
                [s.activeSessionId]: createEmptyConversationStats(),
              }
            : s.sessionConversationStats,
          conversationStats: s.activeSessionId ? createEmptyConversationStats() : s.conversationStats,
          _taskChecklists: s.activeSessionId
            ? { ...s._taskChecklists, [s.activeSessionId]: null }
            : s._taskChecklists,
          _messageCheckpoints: {},
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _checkpointSeq: 0,
          _checkpointError: null,
          _latestContextSnapshot: null,
        }));
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
        if (sessionId) {
          void deleteCheckpointsForSession(get().workspacePath, sessionId).catch(() => undefined);
        }
      },

      resetToMessage: async (messageId): Promise<ResetToMessageResult> => {
        const { messages, activeSessionId, _messageCheckpoints, workspacePath } = get();
        const targetSha = _messageCheckpoints[messageId];
        if (!targetSha) return { ok: false, reason: 'no-checkpoint' };

        const msgIndex = messages.findIndex((m) => m.id === messageId);
        if (msgIndex === -1) return { ok: false, reason: 'message-not-found' };

        // checkpoint 锚定的是"发送这条消息之前的代码状态"——既然要回到那一刻，
        // 这条用户消息和之后的所有内容都应被截掉。被截的用户消息内容会通过
        // 返回的 restoredInput 由调用方回填到输入框，方便用户修改后重发。
        const cutIndex = msgIndex;
        const messagesRemoved = messages.length - cutIndex;
        const restoredInput = messages[msgIndex]?.content ?? '';
        const restoredImages = messages[msgIndex]?.images;

        let codeReset: 'git' | 'none' = 'none';
        let filesChanged = 0;

        try {
          const r = await restoreExecute(workspacePath, targetSha);
          codeReset = 'git';
          filesChanged = r.filesRestored;
        } catch (err) {
          // git2 reset 失败：通常是 .git 损坏或权限问题。本期不再做 EditHistory 降级，
          // 因为 git2 在 ensure 阶段已确保仓库可用，失败是真实异常。
          return {
            ok: false,
            reason: 'git-failed',
            error: err instanceof Error ? err.message : String(err),
          };
        }

        const truncatedMessages = messages.slice(0, cutIndex);
        const keptIds = new Set(truncatedMessages.map((m) => m.id));
        const nextCheckpoints: Record<string, string> = {};
        const removedIds: string[] = [];
        for (const [id, sha] of Object.entries(_messageCheckpoints)) {
          if (keptIds.has(id)) {
            nextCheckpoints[id] = sha;
          } else {
            removedIds.push(id);
          }
        }
        // 清理 timeline 表中被截掉的 checkpoint 记录
        for (const id of removedIds) {
          void deleteCheckpointByMessage(get().workspacePath, id).catch(() => undefined);
        }

        set({
          messages: truncatedMessages,
          sessionMessages: activeSessionId
            ? { ...get().sessionMessages, [activeSessionId]: truncatedMessages }
            : get().sessionMessages,
          _messageCheckpoints: nextCheckpoints,
          _taskChecklists: activeSessionId
            ? { ...get()._taskChecklists, [activeSessionId]: null }
            : get()._taskChecklists,
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _latestContextSnapshot: null,
        });

        get()._editHistory.clear();
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
        get().noteWorkspaceMutation();

        return {
          ok: true,
          codeReset,
          filesChanged,
          messagesRemoved,
          restoredInput,
          restoredImages,
        };
      },

      setProjectDiagnosticsReport: (report) => {
        set({ projectDiagnosticsReport: report });
        saveCurrentProjectState(get());
      },

      refreshProjectDiagnostics: async () => {
        const workspacePath = get().workspacePath.trim();
        if (!workspacePath) {
          get().setProjectDiagnosticsReport(null);
          return null;
        }

        const report = await runProjectDiagnostics(workspacePath, invoke);
        get().setProjectDiagnosticsReport(report);
        return report;
      },

      cancelMessage: () => {
        const { _agent, isLoading } = get();
        if (!isLoading || !_agent) return;

        _agent.cancel();

        set((s) => {
          const { activeSessionId } = s;
          if (!activeSessionId) return {};

          const currentMessages = s.sessionMessages[activeSessionId] ?? s.messages;
          const nextMessages = currentMessages.map((message) =>
            message.isStreaming
              ? { ...message, isStreaming: false, statusText: undefined }
              : message
          );

          return {
            isLoading: false,
            messages: nextMessages,
            sessionMessages: {
              ...s.sessionMessages,
              [activeSessionId]: nextMessages,
            },
          };
        });
        saveCurrentProjectState(get());
      },

      sendMessage: async (input, displayContent, mode = 'agent', projectDiagnosticsReport = null, images) => {
        const { settings } = get();
        const normalizedSettings = normalizeSettings(settings);
        let assistantMessageId: string | null = null;
        let assistantStep = 1;
        let sessionLogStartIndex: number | null = null;
        let userMsg: UIMessage | null = null;

        let effectiveInput = input;
        let effectiveDisplay = displayContent;
        let slashCommandModelHint: 'primary' | 'fast' | undefined;
        let isGoalMode = false;
        let goalCondition: GoalCondition | null = null;
        let goalUserText = '';

        // 聊天命令：先处理本地命令，再处理项目自定义模板，最后落到内置提示模板。
        const slash = parseSlashInput(input);
        if (slash) {
          const workspaceForSlash = get().workspacePath;
          const lower = slash.name.toLowerCase();
          if (lower === 'help' || lower === 'commands') {
            const customCommands = workspaceForSlash
              ? await listCommandDefinitions(invoke, workspaceForSlash).catch(() => [] as CommandDefinition[])
              : [];
            appendInfoMessage(set, buildCommandHelpMessage(customCommands));
            return;
          }
          if (lower === 'compact') {
            const sessionMsgs = get().sessionMessages[get().activeSessionId ?? ''] ?? [];
            const checkpointResult = await maybeGenerateContextCheckpoint(
              normalizedSettings,
              sessionMsgs,
              true,
              currentTodoDigest(get().activeSessionId)
            );
            if (checkpointResult) {
              if (checkpointResult.cacheStats) {
                const cpTier: 'primary' | 'fast' = checkpointResult.modelTier === 'primary' ? 'primary' : 'fast';
                set((s) => ({
                  conversationStats: addConversationStats(
                    s.conversationStats,
                    cpTier,
                    checkpointResult.cacheStats!
                  ),
                  sessionConversationStats: {
                    ...s.sessionConversationStats,
                    [s.activeSessionId!]: addConversationStats(
                      getSessionConversationStats(s.sessionConversationStats, s.activeSessionId!),
                      cpTier,
                      checkpointResult.cacheStats!
                    ),
                  },
                }));
              }
              set((s) => {
                const nextMessages = insertCheckpointAtRetainedBoundary(
                  sessionMsgs,
                  checkpointResult.message,
                  checkpointResult.insertIndex
                );
                return {
                  messages: nextMessages,
                  sessionMessages: { ...s.sessionMessages, [s.activeSessionId!]: nextMessages },
                };
              });
              appendInfoMessage(
                set,
                `对话已压缩。${checkpointResult.message.contextCheckpoint?.sourceMessageCount ?? 0} 条消息合并为检查点，节省 ${
                  checkpointResult.message.contextCheckpoint?.sourceChars
                    ? `${Math.round(checkpointResult.message.contextCheckpoint.sourceChars / 1024)} KB`
                    : '若干'
                } 上下文。`
              );
            } else {
              appendInfoMessage(set, '当前上下文无需压缩。');
            }
            set({ _pendingMemoryConsolidation: true });
            return;
          }
          if (lower === 'goal') {
            const goalArgs = slash.args.join(' ');
            try {
              const condition = parseGoalCondition(goalArgs);
              goalCondition = condition;
              const hr = condition.humanReadable;
              const parenIdx = hr.indexOf('（验收:');
              goalUserText = parenIdx > 0 ? hr.slice(0, parenIdx).trim() : (condition.clauses.length === 0 ? hr : '');
              isGoalMode = true;
              effectiveInput = goalUserText || condition.humanReadable;
              effectiveDisplay = input;
            } catch (err) {
              const msg = err instanceof GoalConditionParseError
                ? err.message
                : `Goal 条件解析失败: ${(err as Error).message}`;
              appendInfoMessage(set, msg);
              return;
            }
          }
          if (!isGoalMode && workspaceForSlash) {
            const def = await loadCommandDefinition(invoke, workspaceForSlash, slash.name).catch(() => null);
            const promptCommand = def ?? getBuiltinPromptCommand(lower);
            if (promptCommand) {
              if (promptCommand.model === 'fast') {
                slashCommandModelHint = 'fast';
              }
              try {
                const expanded = await expandCommandTemplate(promptCommand.template, slash.args, {
                  readFile: (p) => readWorkspaceTextFile(invoke, workspaceForSlash, p),
                  runShell: (command) => runWorkspaceInlineCommand(invoke, workspaceForSlash, command),
                });
                effectiveInput = expanded;
                effectiveDisplay = input;
              } catch (err) {
                appendErrorMessage(set, formatAgentError(err, normalizedSettings.lang ?? 'zh-CN'));
                return;
              }
            }
          } else if (!isGoalMode) {
            const promptCommand = getBuiltinPromptCommand(lower);
            if (promptCommand) {
              if (promptCommand.model === 'fast') {
                slashCommandModelHint = 'fast';
              }
              try {
                const expanded = await expandCommandTemplate(promptCommand.template, slash.args, {});
                effectiveInput = expanded;
                effectiveDisplay = input;
              } catch (err) {
                appendErrorMessage(set, formatAgentError(err, normalizedSettings.lang ?? 'zh-CN'));
                return;
              }
            }
          }
        }

        const settingsError = getSettingsError(normalizedSettings);
        if (settingsError) {
          appendErrorMessage(set, settingsError);
          saveCurrentProjectState(get());
          return;
        }

        // 兜底：若当前没有打开任何项目（如用户中途关闭了工作区），自动创建并打开
        // 默认项目，保证本次对话的文件工具有可用工作目录。失败时保持空工作区，
        // 退化到原有的 requireWorkspace 报错行为。
        if (!get().workspacePath.trim()) {
          await get().ensureDefaultWorkspace();
        }

        // Idle safety net: guarantees isLoading/isStreaming can never stay stuck
        // ON if the agent promise somehow never settles. Threshold sits above the
        // worker-level idle backstop; the timer resets on every stream event, so
        // an actively streaming/working turn never trips it. Under normal operation
        // the stream/worker idle timeouts settle the promise first and the finally
        // below clears this timer before it ever fires.
        const STORE_IDLE_TIMEOUT_MS = 330_000;
        let storeIdleTimer: ReturnType<typeof setTimeout> | undefined;
        const clearStoreIdle = () => {
          if (storeIdleTimer !== undefined) {
            clearTimeout(storeIdleTimer);
            storeIdleTimer = undefined;
          }
        };
        const armStoreIdle = () => {
          clearStoreIdle();
          storeIdleTimer = setTimeout(() => {
            storeIdleTimer = undefined;
            if (!get().isLoading) return;
            console.warn(
              '[sendMessage] idle watchdog: no activity for',
              STORE_IDLE_TIMEOUT_MS,
              'ms; forcing recovery'
            );
            try {
              get()._agent?.cancel();
            } catch {
              // ignore — we still force-clear UI state below
            }
            set((s) => {
              const { activeSessionId } = s;
              if (!activeSessionId) return { isLoading: false };
              const currentMessages = s.sessionMessages[activeSessionId] ?? s.messages;
              const nextMessages = currentMessages.map((message) =>
                message.isStreaming
                  ? { ...message, isStreaming: false, statusText: undefined }
                  : message
              );
              return {
                isLoading: false,
                messages: nextMessages,
                sessionMessages: {
                  ...s.sessionMessages,
                  [activeSessionId]: nextMessages,
                },
              };
            });
            saveCurrentProjectState(get());
          }, STORE_IDLE_TIMEOUT_MS);
        };

        try {
          const { workspacePath, sessionMessages } = get();

          // ── optimistic UI: show user message immediately, before any awaits ──
          let optimisticSid = get().activeSessionId;
          if (!optimisticSid) {
            get().newSession();
            optimisticSid = get().activeSessionId!;
          }
          const _userMsgId = createId();
          userMsg = {
            id: _userMsgId,
            role: 'user',
            workMode: mode,
            content: effectiveDisplay ?? effectiveInput,
            timestamp: Date.now(),
            images: images && images.length ? images : undefined,
          };
          set((s) => {
            const currentMsgs = s.sessionMessages[optimisticSid!] ?? s.messages;
            const next = [...currentMsgs, userMsg!];
            const updatedSessions = maybeApplySessionTitle(
              s.sessions, optimisticSid!, effectiveDisplay ?? effectiveInput,
              currentMsgs
            );
            return {
              sessions: updatedSessions,
              messages: next,
              sessionMessages: { ...s.sessionMessages, [optimisticSid!]: next },
              isLoading: true,
            };
          });
          saveCurrentProjectState(get());
          armStoreIdle();

          const diagnosticsForPrompt = projectDiagnosticsReport ?? get().projectDiagnosticsReport;
          const rulesSection = get()._projectRulesSection;
          const skillDefinitions = get()._skillDefinitions;
          let projectGraphBootstrapSummary: string | undefined;
          try {
            const cachedRaw = await invoke<string | null>(
              'load_projectgraph_cache',
              { workspacePath },
            );
            if (cachedRaw) {
              const cacheData = JSON.parse(cachedRaw);
              if (cacheData?.projectGraph) {
                projectGraphBootstrapSummary = buildProjectGraphBootstrapSummary(cacheData.projectGraph);
              }
            }
          } catch {
            // Cache not available - proceed without
          }
          let memorySection: string | undefined;
          try {
            const memoryResult = await invoke<{ path: string; content: string; bytes: number }>(
              'read_text_file',
              {
                workspacePath,
                relativePath: '.CodePapr/memory.md',
                maxBytes: 50_000,
              }
            );
            memorySection = memoryResult.content?.trim();
          } catch {
            // No memory file - proceed without
          }
          if (planMemoryConsolidation(memorySection, MEMORY_CONSOLIDATION_MAX_LINES)) {
            set({ _pendingMemoryConsolidation: true });
          }
          // Cold-start bootstrap: when memory.md is empty/missing and a
          // ProjectGraph summary is available, generate an initial memory
          // in the background so the next session doesn't explore from zero.
          // Runs only when there's no consolidation pending (avoid clobbering
          // an over-long file) and deduped via a module-level guard.
          if (!memorySection && projectGraphBootstrapSummary && !memoryBootstrapInFlight) {
            memoryBootstrapInFlight = true;
            const bootstrapInput = {
              projectGraphSummary: projectGraphBootstrapSummary,
              rulesSection,
              firstUserMessage: effectiveInput,
            };
            void (async () => {
              try {
                await withMemoryLock(async () => {
                  const generated = await bootstrapMemoryContent(bootstrapInput, normalizedSettings);
                  if (generated) {
                    await invoke('write_text_file', {
                      workspacePath,
                      relativePath: '.CodePapr/memory.md',
                      content: generated,
                    });
                  }
                });
              } catch {
                // Silent fail - don't disrupt the session
              } finally {
                memoryBootstrapInFlight = false;
              }
            })();
          }
          let mcpToolDefinitions: IToolDefinition[] = [];
          let mcpToolMappings: Array<{ serverId: string; toolName: string; displayName: string }> = [];
          if (normalizedSettings.mcp.enabled && normalizedSettings.mcp.exposeTools) {
            try {
              const loadedMcpTools = await loadMcpToolDefinitions(normalizedSettings.mcp);
              mcpToolDefinitions = loadedMcpTools.definitions;
              mcpToolMappings = loadedMcpTools.toolMappings;
              if (loadedMcpTools.errors.length > 0) {
                console.warn('[MCP] Some MCP servers failed during tool discovery:', loadedMcpTools.errors);
                const names = loadedMcpTools.errors.map((e) => e.serverId).join(', ');
                toast.warning(`MCP 初始化失败 (${loadedMcpTools.errors.length}): ${names}`, { durationMs: 8000 });
              }
            } catch (err) {
              console.warn('[MCP] Tool discovery failed:', err);
            }
          }

          const runtimeAgentConfig: AgentRuntimeConfig = {
            editHistory: get()._editHistory,
            mcpToolDefinitions,
            mcpToolMappings,
            rulesSection,
            memorySection,
            projectGraphSummary: projectGraphBootstrapSummary,
            customPrompt: normalizedSettings.systemPrompt,
            lang: normalizedSettings.lang,
            mode,
            skillDefinitions,
            agentDefinitions: get()._agentDefinitions,
            onWorkspaceMutated: (paths) => {
              // Skip background follow-up while the active agent run is mutating files.
              // Let the model decide whether to continue or validate next.
              handleWorkspaceMutation({
                get,
                set,
                paths,
                scheduleDiagnostics: false,
                autoRepair: false,
              });
            },
            onStreamSnapshot: () => {
              // Debounced by WorkerBackedAgent (every ~2s during streaming).
              // Persists in-flight content so crash recovery can offer "retry".
              saveCurrentProjectState(get());
            },
          };
          const runtimeSystemPrompt = buildAgentRuntimeSystemPrompt(
            normalizedSettings,
            mode,
            workspacePath,
            rulesSection,
            {
              agentDefinitions: get()._agentDefinitions,
            }
          );
          // Signature of the STABLE bootstrap inputs. Volatile disk state
          // (memory.md, project-graph summary) is deliberately excluded so its
          // changes don't rebuild the agent and break the prefix cache.
          const bootstrapSignature = [
            runtimeSystemPrompt,
            JSON.stringify(skillDefinitions),
            normalizedSettings.systemPrompt ?? '',
            getActiveCharacterPrompt() ?? '',
          ].join('\u0000');
          const runtimeSessionBootstrapPrompt = resolveSessionBootstrap(
            get().activeSessionId,
            bootstrapSignature,
            () =>
              buildAgentSessionBootstrapPrompt(
                normalizedSettings,
                workspacePath,
                skillDefinitions,
                projectGraphBootstrapSummary,
                memorySection
              )
          );
          // Inject the frozen, memory-containing bootstrap so the main agent's
          // log[0] actually carries memory.md / project-graph. The factory prefers
          // runtime.sessionBootstrapPrompt over its skills+custom-only fallback
          // (agentFactory.ts); without this the computed bootstrap above is used
          // only as a cache key and memory never reaches the primary agent.
          runtimeAgentConfig.sessionBootstrapPrompt = runtimeSessionBootstrapPrompt;
          const runtimePromptKey = [
            runtimeSystemPrompt,
            runtimeSessionBootstrapPrompt,
          ]
            .filter(Boolean)
            .join('\n\n--- session-bootstrap ---\n\n');
          const runtimeUserPrompt = buildAgentRuntimeUserPrompt({
            settings: normalizedSettings,
            mode,
            workspacePath,
            input: effectiveInput,
            projectDiagnosticsReport: diagnosticsForPrompt,
            todoDigest: currentTodoDigest(optimisticSid),
          });
          let { _agent: agent, activeSessionId } = get();
          const { _agentModel: agentModel, _agentPromptKey: agentPromptKey } = get();
          const taskText = effectiveDisplay ?? effectiveInput;
          let accumulatedStats: ICacheStatistics | undefined;
          let accumulatedSubagentFast: ICacheStatistics | undefined;
          let accumulatedSubagentPrimary: ICacheStatistics | undefined;
          let accumulatedSubagentMentor: ICacheStatistics | undefined;
          let route = selectTaskModelRoute(
            {
              model: normalizedSettings.model,
              fastModelEnabled: normalizedSettings.fastModelEnabled,
              fastModel: normalizedSettings.fastModel,
              temperature: normalizedSettings.temperature,
              maxTokens: normalizedSettings.maxTokens,
              thinkingEnabled: normalizedSettings.thinkingEnabled,
            },
            mode,
            taskText,
            slashCommandModelHint
          );
          const primaryRoute = buildPrimaryModelRoute(
            {
              model: normalizedSettings.model,
              fastModelEnabled: normalizedSettings.fastModelEnabled,
              fastModel: normalizedSettings.fastModel,
              temperature: normalizedSettings.temperature,
              maxTokens: normalizedSettings.maxTokens,
              thinkingEnabled: normalizedSettings.thinkingEnabled,
            },
            'fast-fallback'
          );

          // 首次发消息时自动创建会话；恢复后的旧会话则原地重建 agent。
          if (!agent || agentModel !== route.model || (agentPromptKey !== null && agentPromptKey !== runtimePromptKey)) {
            if (activeSessionId) {
              let contextMessages = sessionMessages[activeSessionId] ?? [];
              if (mode !== 'ask' && contextMessages.some((m) => m.role === 'assistant' && m.workMode === 'ask')) {
                contextMessages = [...contextMessages, buildModeSwitchMessage(mode)];
              }
              agent = createAgent(
                normalizedSettings,
                activeSessionId,
                workspacePath,
                contextMessages,
                {
                  model: route.model,
                  thinkingEnabled: route.thinkingEnabled,
                  temperature: route.temperature,
                  maxTokens: route.maxTokens,
                  systemPrompt: runtimeSystemPrompt,
                },
                runtimeAgentConfig,
              );
              set({ _agent: agent, _agentModel: route.model, _agentPromptKey: runtimePromptKey });
            } else {
              get().newSession();
              ({ activeSessionId } = get());
              if (activeSessionId) {
                agent = createAgent(
                  normalizedSettings,
                  activeSessionId,
                  workspacePath,
                  [],
                  {
                    model: route.model,
                    thinkingEnabled: route.thinkingEnabled,
                    temperature: route.temperature,
                    maxTokens: route.maxTokens,
                    systemPrompt: runtimeSystemPrompt,
                  },
                  runtimeAgentConfig,
                );
                set({ _agent: agent, _agentModel: route.model, _agentPromptKey: runtimePromptKey });
              }
            }
          }

          if (!agent || !activeSessionId) {
            throw new Error('无法初始化会话，请检查模型配置后重试');
          }

          sessionLogStartIndex =
            typeof agent.getSession === 'function' ? agent.getSession().logStore.length() : null;

          // userMsg is already in UI — fill in promptContent for debug display
          if (userMsg) {
            userMsg.promptContent =
              effectiveDisplay && effectiveDisplay !== runtimeUserPrompt
                ? runtimeUserPrompt
                : runtimeUserPrompt !== effectiveInput
                ? runtimeUserPrompt
                : undefined;
            set((s) => {
              const sessionMsgs = s.sessionMessages[activeSessionId!] ?? s.messages;
              const updated = sessionMsgs.map((m) =>
                m.id === userMsg!.id ? { ...m, promptContent: userMsg!.promptContent } : m
              );
              return {
                messages: updated,
                sessionMessages: { ...s.sessionMessages, [activeSessionId!]: updated },
              };
            });
          }

          // git checkpoint (anchored to the already-displayed user message)
          if (get()._gitReady && userMsg) {
            try {
              const sequence = (get()._checkpointSeq ?? 0) + 1;
              const previewSource =
                effectiveDisplay ?? effectiveInput ?? runtimeUserPrompt ?? '';
              const label = buildCheckpointCommitMessage({
                sequence,
                userMessageId: userMsg.id,
                userMessageText: previewSource,
              });
              const cp = await snapshotCreate(get().workspacePath, label);
              if (cp) {
                set((s) => ({
                  _messageCheckpoints: { ...s._messageCheckpoints, [userMsg!.id]: cp.sha },
                  _checkpointSeq: sequence,
                  _checkpointError: null,
                }));
                void saveCheckpointRecord(
                  get().workspacePath,
                  activeSessionId!,
                  userMsg!.id,
                  cp.sha,
                  label,
                  cp.fileCount,
                ).catch(() => undefined);
              } else {
                // Empty/new workspace (or all files ignored): nothing to snapshot.
                // Benign skip — do not surface a "snapshot failed" banner. (The
                // Rust side still logs "0 files to snapshot" to stderr for debug.)
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn('[CodePapr] checkpoint 创建失败:', msg);
              set({ _checkpointError: msg });
            }
          }

          let retryBaseMessages = [...(sessionMessages[activeSessionId!] ?? []), userMsg!];
          if (mode !== 'ask' && retryBaseMessages.some((m) => m.role === 'assistant' && m.workMode === 'ask')) {
            retryBaseMessages = [...retryBaseMessages, buildModeSwitchMessage(mode)];
          }
          assistantMessageId = createId();

          const createStreamingAssistantMsg = (messageId: string, statusText: string): UIMessage => ({
            id: messageId,
            role: 'assistant',
            workMode: mode,
            content: '',
            reasoningContent: '',
            modelTier: route.tier,
            modelName: route.model,
            agentStep: assistantStep,
            isStreaming: true,
            statusText,
            timestamp: Date.now(),
          });
          appendStreamingAssistantMessage(
            set,
            activeSessionId!,
            createStreamingAssistantMsg(
              assistantMessageId,
              getTranslation(normalizedSettings.lang).streamingStatus
            )
          );
          await yieldToMainThread();

          const runAgentPass = async (passInput: string, passImages?: import('@codepapr/types').IImageContent[]) => {
            const response = await agent!.chat(passInput, (event) => {
              armStoreIdle();
              if (event.type === 'assistant-round-start') {
                if (!assistantMessageId) return;

                assistantStep += 1;
                const nextAssistantMessageId = createId();
                set((s) => {
                  const currentSessionMessages = s.sessionMessages[activeSessionId!] ?? s.messages;
                  const nextMessages = currentSessionMessages
                    .map((message) =>
                      message.id === assistantMessageId
                        ? {
                            ...message,
                            isStreaming: false,
                            statusText: undefined,
                          }
                        : message
                    )
                    .concat(
                      createStreamingAssistantMsg(
                        nextAssistantMessageId,
                        getTranslation(normalizedSettings.lang).streamingStatus
                      )
                    );

                  return {
                    messages: nextMessages,
                    sessionMessages: {
                      ...s.sessionMessages,
                      [activeSessionId!]: nextMessages,
                    },
                  };
                });
                assistantMessageId = nextAssistantMessageId;
                return;
              }

              if (!assistantMessageId) return;

              if (event.type === 'request-context') {
                set({
                  _latestContextSnapshot: {
                    sessionId: activeSessionId!,
                    snapshot: event.snapshot,
                  },
                });
              }

              updateAssistantMessage(set, activeSessionId!, assistantMessageId, (message) => {
                if (event.type === 'request-context') {
                  return normalizedSettings.debugEnabled
                    ? {
                        ...message,
                        promptContent: event.content,
                      }
                    : message;
                }

                if (event.type === 'assistant-round-complete') {
                  return {
                    ...message,
                    content: mergeMessageText(message.content, event.content) ?? '',
                    reasoningContent: mergeMessageText(
                      message.reasoningContent,
                      event.reasoningContent
                    ),
                    isStreaming: false,
                    statusText: undefined,
                  };
                }

                if (event.type === 'reasoning-delta') {
                  return {
                    ...message,
                    reasoningContent: `${message.reasoningContent ?? ''}${event.delta}`,
                    isStreaming: true,
                    statusText: undefined,
                  };
                }

                if (event.type === 'content-delta') {
                  return {
                    ...message,
                    content: `${message.content}${event.delta}`,
                    isStreaming: true,
                    statusText: undefined,
                  };
                }

                if (event.type === 'context-compacted') {
                  // Context epoch reset happened inside the agent loop; no message
                  // mutation is needed here (the log was replaced internally).
                  return message;
                }

                return applyToolStreamEvent(message, event);
              });
            }, passImages);

            accumulatedStats = accumulateCacheStats(accumulatedStats, response.cacheStats);
            if (response.subagentCacheStatsByTier?.fast) {
              accumulatedSubagentFast = accumulateCacheStats(
                accumulatedSubagentFast,
                response.subagentCacheStatsByTier.fast
              );
            }
            if (response.subagentCacheStatsByTier?.primary) {
              accumulatedSubagentPrimary = accumulateCacheStats(
                accumulatedSubagentPrimary,
                response.subagentCacheStatsByTier.primary
              );
            }
            if (response.subagentCacheStatsByTier?.mentor) {
              accumulatedSubagentMentor = accumulateCacheStats(
                accumulatedSubagentMentor,
                response.subagentCacheStatsByTier.mentor
              );
            }
            return response;
          };

          const getCurrentAssistantMessage = () =>
            assistantMessageId
              ? get().sessionMessages[activeSessionId!]?.find(
                  (message) => message.id === assistantMessageId
                )
              : undefined;

          let resp: IAgentResponse;
          if (isGoalMode && goalCondition) {
            // ── Goal 自主循环（Worker + Evaluator 双模型） ──
            // eslint-disable-next-line no-console
            console.log('[Goal] Starting goal loop:', goalCondition.humanReadable);
            useGoalStore.getState().setGoalActive(goalCondition, goalUserText);
            const verifierProvider = buildProviderInstance(normalizedSettings);
            const verifierProviderName = resolveProviderName(normalizedSettings);
            /** 追踪最后一轮 Worker 的输出，用于最终回复 */
            let lastWorkerContent = '';

            const goalRunner = new GoalRunner({
              condition: goalCondition,
              userGoalText: goalUserText,
              lang: normalizedSettings.lang,
              limits: {
                maxIterations: normalizedSettings.goalMaxIterations,
                maxWallClockMs: normalizedSettings.goalMaxWallClockMs,
                planFirst: goalCondition.planFirst,
              },
              callbacks: {
                runWorkerTurn: async (turnPrompt, isFeedback) => {
                  // eslint-disable-next-line no-console
            console.log('[Goal] runWorkerTurn start', { isFeedback, promptLength: turnPrompt.length });
                  if (isFeedback) {
                    if (assistantMessageId) {
                      updateAssistantMessage(set, activeSessionId!, assistantMessageId, (msg) => ({
                        ...msg,
                        isStreaming: false,
                        statusText: undefined,
                      }));
                    }
                    const feedbackMsg: UIMessage = {
                      id: createId(),
                      role: 'assistant',
                      workMode: mode,
                      content: turnPrompt.slice(0, 1000),
                      synthetic: true,
                      carryForwardInContext: false,
                      timestamp: Date.now(),
                    };
                    set((s) => {
                      const cur = s.sessionMessages[activeSessionId!] ?? [];
                      const next = [...cur, feedbackMsg];
                      return {
                        messages: next,
                        sessionMessages: { ...s.sessionMessages, [activeSessionId!]: next },
                      };
                    });
                    assistantMessageId = createId();
                    assistantStep = 1;
                    appendStreamingAssistantMessage(
                      set,
                      activeSessionId!,
                      createStreamingAssistantMsg(
                        assistantMessageId,
                        getTranslation(normalizedSettings.lang).streamingStatus
                      )
                    );
                    await yieldToMainThread();
                  }

                  const turnStartIndex = sessionLogStartIndex;
                  const response = await runAgentPass(turnPrompt);
                  lastWorkerContent = response.content;

                  sessionLogStartIndex =
                    typeof agent?.getSession === 'function'
                      ? agent.getSession().logStore.length()
                      : sessionLogStartIndex;

                  const turnMessages = getAgentMessagesSince(agent, turnStartIndex);
                  const transcript = turnMessages
                    .filter(
                      (m) =>
                        m.role === 'tool' ||
                        (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0)
                    )
                    .map((m) => {
                      if (m.role === 'tool') {
                        const c =
                          typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                        return `[Tool Result] ${c.slice(0, 800)}`;
                      }
                      if (m.toolCalls) {
                        return `[Tool Calls] ${m.toolCalls
                          .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`)
                          .join(', ')}`;
                      }
                      return '';
                    })
                    .filter(Boolean)
                    .join('\n');

                  return {
                    content: response.content,
                    transcript,
                    outputTokens: response.cacheStats?.outputTokens ?? 0,
                  };
                },
                runVerifier: async (transcript, conditionResult) => {
                  const isSubjective = goalCondition!.clauses.length === 0;
                  const currentState = goalRunner.getState();
                  const verifierResult = await runVerifier(
                    transcript,
                    conditionResult,
                    goalCondition!.humanReadable,
                    isSubjective,
                    goalCondition!.strictness,
                    (normalizedSettings.lang ?? 'zh-CN') as 'zh-CN' | 'zh-TW' | 'en',
                    currentState.iteration,
                    normalizedSettings.goalMaxIterations,
                    {
                      provider: verifierProvider,
                      providerName: verifierProviderName,
                      settings: normalizedSettings,
                      primaryModel: normalizedSettings.model,
                      fastModel: normalizedSettings.fastModel,
                      fastModelEnabled: normalizedSettings.fastModelEnabled,
                    }
                  );
                  if (verifierResult.cacheStats) {
                    if (verifierResult.tier === 'fast') {
                      accumulatedSubagentFast = accumulateCacheStats(
                        accumulatedSubagentFast,
                        verifierResult.cacheStats
                      );
                    } else {
                      accumulatedSubagentPrimary = accumulateCacheStats(
                        accumulatedSubagentPrimary,
                        verifierResult.cacheStats
                      );
                    }
                  }
                  return verifierResult.verdict;
                },
                evaluateCondition: async () => {
                  return evaluateGoalCondition(goalCondition!, workspacePath, {
                    runCommand: async (ws, cmd, args) => {
                      const result = await invoke<CommandResult>(
                        'run_workspace_command',
                        {
                          workspacePath: ws,
                          command: cmd,
                          args,
                          timeoutSeconds: 120,
                        }
                      );
                      return {
                        exitCode: result.status,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        timedOut: result.timedOut,
                      };
                    },
                  });
                },
                onStateChange: (state) =>
                  useGoalStore.getState().setGoalState(state),
                onCompaction: async () => {
                  const sessionMsgs =
                    get().sessionMessages[activeSessionId!] ?? [];
                  const cp = await maybeGenerateContextCheckpoint(
                    normalizedSettings,
                    sessionMsgs,
                    true,
                    currentTodoDigest(activeSessionId)
                  );
                  if (cp) {
                    if (cp.cacheStats) {
                      const cpTier: 'primary' | 'fast' = cp.modelTier === 'primary' ? 'primary' : 'fast';
                      if (cpTier === 'fast') {
                        accumulatedSubagentFast = accumulateCacheStats(accumulatedSubagentFast, cp.cacheStats);
                      } else {
                        accumulatedSubagentPrimary = accumulateCacheStats(accumulatedSubagentPrimary, cp.cacheStats);
                      }
                    }
                    set((s) => {
                      const next = insertCheckpointAtRetainedBoundary(
                        s.sessionMessages[activeSessionId!] ?? [],
                        cp.message,
                        cp.insertIndex
                      );
                      return {
                        messages: next,
                        sessionMessages: {
                          ...s.sessionMessages,
                          [activeSessionId!]: next,
                        },
                      };
                    });
                  }
                },
                writeGoalState: async (state) => {
                  try {
                    await invoke('write_text_file', {
                      workspacePath,
                      relativePath: '.CodePapr/goal-state.md',
                      content: serializeGoalState(
                        state,
                        goalCondition!,
                        goalUserText
                      ),
                    });
                  } catch {
                    // silent fail
                  }
                },
                isAborted: () => useGoalStore.getState().isAborted(),
              },
            });

            let goalResult;
            try {
              goalResult = await goalRunner.run();
            } catch (goalErr) {
              console.error('[Goal] loop threw:', goalErr);
              useGoalStore.getState().clearGoal();
              const goalErrMsg = normalizedSettings.lang === 'en'
                ? `Goal loop error: ${(goalErr as Error).message}`
                : `Goal 循环出错: ${(goalErr as Error).message}`;
              appendErrorMessage(set, goalErrMsg);
              saveCurrentProjectState(get());
              return;
            }
            useGoalStore.getState().clearGoal();

            const isEn = normalizedSettings.lang === 'en';
            const isTw = normalizedSettings.lang === 'zh-TW';
            let goalStatusLine: string;
            if (goalResult.status === 'satisfied') {
              goalStatusLine = isEn
                ? `✅ Goal satisfied (${goalResult.iteration} iterations, ${Math.round(goalResult.elapsedMs / 1000)}s)`
                : isTw
                  ? `✅ 目標達成（${goalResult.iteration} 輪，${Math.round(goalResult.elapsedMs / 1000)} 秒）`
                  : `✅ 目标达成（${goalResult.iteration} 轮，${Math.round(goalResult.elapsedMs / 1000)} 秒）`;
            } else if (goalResult.status === 'interrupted') {
              goalStatusLine = isEn ? '⏹ Goal interrupted by user.' : isTw ? '⏹ 目標已中斷。' : '⏹ 目标已中断。';
            } else if (goalResult.status === 'limit_exceeded') {
              goalStatusLine = isEn
                ? `⚠ Goal limit exceeded (${goalResult.iteration} iterations)`
                : isTw
                  ? `⚠ 超過限制（${goalResult.iteration} 輪）`
                  : `⚠ 超过限制（${goalResult.iteration} 轮）`;
            } else {
              goalStatusLine = isEn
                ? `❌ Goal error: ${goalResult.error ?? 'unknown'}`
                : `❌ Goal 出错: ${goalResult.error ?? '未知'}`;
            }

            resp = {
              role: 'assistant',
              content: lastWorkerContent
                ? `${goalStatusLine}\n\n---\n\n${lastWorkerContent}`
                : goalStatusLine,
              cacheStats: accumulatedStats,
            };
          } else {
          try {
            resp = await runAgentPass(runtimeUserPrompt, images);
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              throw error;
            }
            if (!shouldFallbackToPrimaryModel(error, route, normalizedSettings)) {
              throw error;
            }

            route = primaryRoute;
            agent = createAgent(
              normalizedSettings,
              activeSessionId,
              workspacePath,
              retryBaseMessages,
              {
                model: route.model,
                thinkingEnabled: route.thinkingEnabled,
                temperature: route.temperature,
                maxTokens: route.maxTokens,
                systemPrompt: runtimeSystemPrompt,
              },
              runtimeAgentConfig,
            );
            set({ _agent: agent, _agentModel: route.model, _agentPromptKey: runtimePromptKey });

            if (assistantMessageId) {
              updateAssistantMessage(set, activeSessionId, assistantMessageId, (message) => ({
                ...message,
                content: '',
                reasoningContent: '',
                displayReasoningContent: undefined,
                toolInvocations: undefined,
                modelTier: route.tier,
                modelName: route.model,
                statusText: getTranslation(normalizedSettings.lang).streamingStatus,
              }));
            }

            await yieldToMainThread();
            resp = await runAgentPass(runtimeUserPrompt, images);
          }
          }

          const currentAssistantMessage = getCurrentAssistantMessage();
          const executedTools = collectExecutedTools(getAgentMessagesSince(agent, sessionLogStartIndex));
          const toolFilePaths = extractFilePathsFromToolInvocations([
            ...(currentAssistantMessage?.toolInvocations ?? []),
          ]);
          const executedToolPaths = extractFilePathsFromExecutedTools(executedTools);
          const relatedFilePaths = Array.from(new Set([...toolFilePaths, ...executedToolPaths]));
          const assistantMsg: UIMessage = {
            id: assistantMessageId,
            role: 'assistant',
            workMode: mode,
            content: mergeMessageText(currentAssistantMessage?.content, resp.content) ?? '',
            reasoningContent: mergeMessageText(
              currentAssistantMessage?.reasoningContent,
              resp.reasoningContent
            ),
            promptContent: currentAssistantMessage?.promptContent,
            modelTier: route.tier,
            modelName: route.model,
            agentStep: assistantStep,
            toolInvocations: currentAssistantMessage?.toolInvocations,
            relatedFilePaths,
            question: resp.question,
            isStreaming: false,
            timestamp: Date.now(),
          };
          const finalizedAssistantMsg: UIMessage = assistantMsg;
          const executionContextSummary =
            mode === 'agent'
              ? buildExecutionContextSummary({
                  lang: normalizedSettings.lang,
                  executedTools,
                })
              : '';
          const executionContextMsg: UIMessage | null = executionContextSummary
            ? {
                id: createId(),
                role: 'assistant',
                workMode: mode,
                content: executionContextSummary,
                hidden: true,
                synthetic: true,
                carryForwardInContext: true,
                timestamp: Date.now(),
              }
            : null;

          set((s) => {
            const currentSessionMessages = s.sessionMessages[activeSessionId!] ?? s.messages;
            const hasPlaceholder = currentSessionMessages.some((message) => message.id === assistantMessageId);
            const nextMessages = hasPlaceholder
              ? currentSessionMessages.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        ...finalizedAssistantMsg,
                        statusText: undefined,
                        toolInvocations: message.toolInvocations,
                      }
                    : message
                )
              : [...currentSessionMessages, finalizedAssistantMsg];
            const persistedMessages = executionContextMsg
              ? [...nextMessages, executionContextMsg]
              : nextMessages;

            const tierDeltas: Array<{
              tier: 'primary' | 'fast' | 'mentor';
              stats: ICacheStatistics;
              incrementRounds?: boolean;
            }> = [];
            if (accumulatedStats) {
              tierDeltas.push({ tier: route.tier, stats: accumulatedStats, incrementRounds: true });
            }
            if (accumulatedSubagentFast) {
              tierDeltas.push({ tier: 'fast', stats: accumulatedSubagentFast });
            }
            if (accumulatedSubagentPrimary) {
              tierDeltas.push({ tier: 'primary', stats: accumulatedSubagentPrimary });
            }
            if (accumulatedSubagentMentor) {
              tierDeltas.push({ tier: 'mentor', stats: accumulatedSubagentMentor });
            }
            const applyTierDeltas = (
              base: ConversationStats,
            ): ConversationStats =>
              tierDeltas.reduce(
                (acc, delta) =>
                  addConversationStats(acc, delta.tier, delta.stats, delta.incrementRounds ? { incrementRounds: true } : undefined),
                base,
              );

            return {
              messages: persistedMessages,
              sessionMessages: {
                ...s.sessionMessages,
                [activeSessionId!]: persistedMessages,
              },
              isLoading: false,
              conversationStats: applyTierDeltas(s.conversationStats),
              sessionConversationStats: {
                ...s.sessionConversationStats,
                [activeSessionId!]: applyTierDeltas(
                  getSessionConversationStats(s.sessionConversationStats, activeSessionId!)
                ),
              },
            };
          });
          const checkpointResult = await maybeGenerateContextCheckpoint(
            normalizedSettings,
            get().sessionMessages[activeSessionId] ?? [],
            undefined,
            currentTodoDigest(activeSessionId)
          );
          if (checkpointResult) {
            set((s) => {
              const currentSessionMessages = s.sessionMessages[activeSessionId!] ?? [];
              const nextSessionMessages = insertCheckpointAtRetainedBoundary(
                currentSessionMessages,
                checkpointResult.message,
                checkpointResult.insertIndex
              );
              const isCurrentSession = s.activeSessionId === activeSessionId;

              return {
                messages: isCurrentSession ? nextSessionMessages : s.messages,
                sessionMessages: {
                  ...s.sessionMessages,
                  [activeSessionId!]: nextSessionMessages,
                },
                _agent:
                  isCurrentSession
                    ? createAgent(
                        normalizedSettings,
                        activeSessionId!,
                        s.workspacePath,
                        nextSessionMessages,
                        {
                          model: route.model,
                          thinkingEnabled: route.thinkingEnabled,
                          temperature: route.temperature,
                          maxTokens: route.maxTokens,
                          systemPrompt: runtimeSystemPrompt,
                        },
                        runtimeAgentConfig,
                      )
                    : s._agent,
                _agentModel: isCurrentSession ? route.model : s._agentModel,
                _agentPromptKey: isCurrentSession ? runtimePromptKey : s._agentPromptKey,
                conversationStats: checkpointResult.cacheStats
                  ? addConversationStats(
                      s.conversationStats,
                      checkpointResult.modelTier === 'primary' ? 'primary' : 'fast',
                      checkpointResult.cacheStats
                    )
                  : s.conversationStats,
                sessionConversationStats: checkpointResult.cacheStats
                  ? {
                      ...s.sessionConversationStats,
                      [activeSessionId!]: addConversationStats(
                        getSessionConversationStats(s.sessionConversationStats, activeSessionId!),
                        checkpointResult.modelTier === 'primary' ? 'primary' : 'fast',
                        checkpointResult.cacheStats
                      ),
                    }
                  : s.sessionConversationStats,
                _pendingMemoryConsolidation: true,
              };
          });
          }
          if (get()._pendingMemoryConsolidation) {
            set({ _pendingMemoryConsolidation: false });
            const ws = get().workspacePath;
            void (async () => {
              try {
                await withMemoryLock(async () => {
                  const memResult = await invoke<{ path: string; content: string; bytes: number }>(
                    'read_text_file',
                    {
                      workspacePath: ws,
                      relativePath: '.CodePapr/memory.md',
                      maxBytes: 50_000,
                    }
                  );
                  const content = memResult.content?.trim();
                  if (!content || !planMemoryConsolidation(content, MEMORY_CONSOLIDATION_MAX_LINES)) return;
                  const consolidated = await consolidateMemoryContent(content, normalizedSettings);
                  if (consolidated && consolidated !== content) {
                    await invoke('write_text_file', {
                      workspacePath: ws,
                      relativePath: '.CodePapr/memory.md',
                      content: consolidated,
                    });
                  }
                });
              } catch {
                // Silent fail - don't disrupt the session
              }
            })();
          }
          saveCurrentProjectState(get());
        } catch (err) {
          console.error('[sendMessage] outer catch:', err);
          if (err instanceof DOMException && err.name === 'AbortError') {
            set({ isLoading: false });
            if (assistantMessageId && get().activeSessionId) {
              cleanupStreamingAssistantMessage(set, get().activeSessionId!, assistantMessageId);
            }
            saveCurrentProjectState(get());
            return;
          }

          // Worker crash: null out the agent so a fresh one is created on retry.
          const isWorkerCrash = err instanceof WorkerCrashError;
          if (isWorkerCrash) {
            set({ _agent: null, isLoading: false });
          } else {
            set({ isLoading: false });
          }

          if (assistantMessageId && get().activeSessionId) {
            cleanupStreamingAssistantMessage(set, get().activeSessionId!, assistantMessageId);
          }
          const crashPrefix = isWorkerCrash
            ? (normalizedSettings.lang === 'en'
              ? 'Agent worker crashed. '
              : normalizedSettings.lang === 'zh-TW'
                ? 'Agent Worker 崩潰。'
                : 'Agent Worker 崩溃。')
            : '';
          appendErrorMessage(set, crashPrefix + formatAgentError(err, normalizedSettings.lang ?? 'zh-CN'));
          saveCurrentProjectState(get());
        } finally {
          clearStoreIdle();
        }
      },
    }));

// Wire the agent factory's lazy fallback resolver to the live store.
// This breaks the static import cycle while preserving the original behavior:
// callers that omit `onWorkspaceMutated` fall back to the store's noteWorkspaceMutation.
setDefaultOnWorkspaceMutatedResolver(() => useAgentStore.getState().noteWorkspaceMutation);

export function buildChatInputPrompt(
  mode: WorkMode,
  workspacePath: string,
  input: string,
  lang: Lang | undefined,
  projectDiagnosticsReport?: import('../utils/projectDiagnostics').ProjectDiagnosticsReport | null
): string {
  return buildModePrompt(
    mode,
    workspacePath,
    input,
    lang ?? 'zh-CN',
    projectDiagnosticsReport
  );
}
