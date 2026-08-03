import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { applyBrowserEngine } from './browserViewStore';
import {
  applySkillEnablement,
  BUILTIN_AGENTS,
  EditHistory,
  type AgentDefinition,
  type SkillDefinition,
  mergeAgentDefinitions,
  sanitizeAgentPrompt,
  buildContextSnapshot,
} from '@codepapr/core';
import type { IToolDefinition } from '@codepapr/types';
import { CacheValidator, RequestBuilder } from '@codepapr/api';
import { createId } from '../utils/createId';
import { loadProjectState } from '../utils/projectStorage';
import {
  loadSessions,
  loadSessionMessages,
  loadAllProjectMeta,
} from '../utils/projectStorage';
import { runProjectDiagnostics } from '../utils/projectDiagnostics';
import { loadAppSettings, saveAppSettings } from '../utils/appSettingsStorage';
import {
  snapshotEnsure,
  snapshotList,
  restoreExecute,
  loadCheckpointRecords,
  deleteCheckpointByMessage,
  deleteCheckpointsForSession,
} from '../utils/snapshot';
import { nextCheckpointSequence } from '../utils/workspaceGitPanel';
import type { WorkMode } from '../utils/agentPrompts';
import { buildModePrompt } from '../utils/agentPrompts';
import { acquireSleepPrevention, releaseSleepPrevention } from '../utils/sleepPrevention';
import { restoreTodoListContexts } from '../tools/todoListTool';
import { loadMcpToolDefinitions } from '../tools/mcpTools';
import {
  loadSkillDefinitions,
  loadAgentDefinitions,
  loadProjectRulesSection,
} from '../utils/projectConfigLoader';

import {
  createEmptyConversationStats,
  DEFAULT_SETTINGS,
  SESSION_MESSAGE_CACHE_LIMIT,
} from './internals/defaults';
import {
  getProviderLabel as _getProviderLabel,
  isApiConfigured as _isApiConfigured,
  normalizeSettings,
  resolveProviderName,
} from './internals/settingsNormalizer';
import { cloneConversationStats, getSessionConversationStats } from './internals/stats';
import {
  normalizeProjectSnapshot,
  normalizeSkillEnabledState,
} from './internals/persistence';
import { saveCurrentProjectState } from './internals/projectSnapshot';
import {
  buildAgentRuntimeSystemPrompt,
  buildAgentSessionBootstrapPrompt,
  buildProjectGraphBootstrapSummary,
} from './internals/promptBuilders';
import {
  buildAgentSessionParts,
  setDefaultOnWorkspaceMutatedResolver,
} from './internals/agentFactory';
import { handleWorkspaceMutation } from './internals/backgroundDiagnostics';
import { createSendMessage } from './internals/sendMessage';
import { upsertRecentWorkspace, sortRecentWorkspaces } from './internals/recentWorkspaces';
import type {
  AgentActions,
  AgentState,
  Lang,
  ResetToMessageResult,
  SessionMeta,
  StoreGet,
  StoreSet,
  UIMessage,
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

/** Evict least-recently-used session messages so at most
 *  SESSION_MESSAGE_CACHE_LIMIT sessions stay resident in memory. Eviction only
 *  drops the in-memory copy — SQLite keeps the full history, and every mutation
 *  is persisted before eviction can run (saveCurrentProjectState captures the
 *  state snapshot at call time), so no data is lost. */
function evictSessionMessageCache(get: StoreGet, set: StoreSet, protectIds: string[]): void {
  const { sessionMessages, _sessionLru } = get();
  const loadedIds = Object.keys(sessionMessages);
  if (loadedIds.length <= SESSION_MESSAGE_CACHE_LIMIT) return;

  const protectedSet = new Set(protectIds);
  const loadedSet = new Set(loadedIds);
  const evictIds: string[] = [];
  const remaining = () => loadedSet.size - evictIds.length;

  for (let i = _sessionLru.length - 1; i >= 0 && remaining() > SESSION_MESSAGE_CACHE_LIMIT; i--) {
    const id = _sessionLru[i];
    if (protectedSet.has(id) || !loadedSet.has(id)) continue;
    evictIds.push(id);
  }
  // Sessions loaded but missing from the LRU (defensive): evict them too.
  for (const id of loadedIds) {
    if (remaining() <= SESSION_MESSAGE_CACHE_LIMIT) break;
    if (protectedSet.has(id) || evictIds.includes(id)) continue;
    evictIds.push(id);
  }
  if (evictIds.length === 0) return;

  set((s) => {
    const next = { ...s.sessionMessages };
    for (const id of evictIds) {
      delete next[id];
    }
    return { sessionMessages: next };
  });
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
      sessionMessagesLoading: false,
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
      _currentMode: 'agent',
      _sessionLru: [],

      loadSettings: async () => {
        let settings = get().settings;
        try {
          const storedSettings = await loadAppSettings();
          settings = normalizeSettings(storedSettings ?? get().settings);
          set({ settings, settingsLoaded: true, _agent: null, _agentModel: null, _agentPromptKey: null });
          void applyBrowserEngine(settings.browserEngine);

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
        const previousEngine = get().settings.browserEngine;
        const settings = normalizeSettings({ ...get().settings, ...partial });
        set({ settings, _agent: null, _agentModel: null, _agentPromptKey: null });
        void saveAppSettings(settings).catch(() => undefined);
        if (settings.browserEngine !== previousEngine) {
          void applyBrowserEngine(settings.browserEngine);
        }
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
            sessionMessagesLoading: false,
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
      _sessionLru: [],
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
          sessionMessagesLoading: false,
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
          _sessionLru: [],
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
            updatedAt: meta.updatedAt ?? meta.createdAt,
          })) as unknown as SessionMeta[];

          const meta = await loadAllProjectMeta(normalizedWorkspacePath);
          const rawActiveSessionId = (meta.active_session_id as string) ?? null;
          activeSessionId = rawActiveSessionId && sessions.some(s => s.id === rawActiveSessionId)
            ? rawActiveSessionId
            : null;

          // Lazy loading: only the active session's messages are loaded upfront.
          // Other sessions are loaded on demand in selectSession and cached with
          // an LRU limit, keeping workspace open fast and memory bounded even
          // with many sessions.
          if (activeSessionId) {
            try {
              const msgs = await loadSessionMessages(normalizedWorkspacePath, activeSessionId);
              sessionMessages[activeSessionId] = msgs as unknown as UIMessage[];
            } catch {
              sessionMessages[activeSessionId] = [];
            }
          }

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
          activeSessionId = snapshot.activeSessionId;
          // Keep only the active session's messages resident; the rest are
          // loaded on demand (see selectSession).
          const snapshotMessages = snapshot.sessionMessages as Record<string, UIMessage[]>;
          sessionMessages = activeSessionId
            ? { [activeSessionId]: snapshotMessages[activeSessionId] ?? [] }
            : {};
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
          sessionMessagesLoading: false,
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
          // Active session first; the rest follow the persisted (updatedAt DESC)
          // order as the initial LRU approximation.
          _sessionLru: [
            ...(activeSessionId ? [activeSessionId] : []),
            ...sessions.filter((s) => s.id !== activeSessionId).map((s) => s.id),
          ],
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

      computeContextSnapshot: async () => {
        const { workspacePath, activeSessionId, sessionMessages, settings } = get();
        if (!activeSessionId || !workspacePath) return;
        const normalizedSettings = normalizeSettings(settings);
        const messages = sessionMessages[activeSessionId] ?? [];
        const rulesSection = get()._projectRulesSection;
        const skillDefinitions = get()._skillDefinitions;
        const agentDefinitions = get()._agentDefinitions;
        const mode = get()._currentMode;

        let projectGraphSummary: string | undefined;
        try {
          const cachedRaw = await invoke<string | null>('load_projectgraph_cache', { workspacePath });
          if (cachedRaw) {
            const cacheData = JSON.parse(cachedRaw);
            if (cacheData?.projectGraph) {
              projectGraphSummary = buildProjectGraphBootstrapSummary(cacheData.projectGraph);
            }
          }
        } catch {
          // 无 ProjectGraph 缓存：跳过
        }

        let memorySection: string | undefined;
        try {
          const memoryResult = await invoke<{ content: string }>('read_text_file', {
            workspacePath,
            relativePath: '.CodePapr/memory.md',
            maxBytes: 50_000,
          });
          memorySection = memoryResult.content?.trim();
        } catch {
          // 无 memory.md：跳过
        }

        let mcpToolDefinitions: IToolDefinition[] = [];
        let mcpToolMappings: Array<{ serverId: string; toolName: string; displayName: string }> = [];
        if (normalizedSettings.mcp.enabled && normalizedSettings.mcp.exposeTools) {
          try {
            const loadedMcpTools = await loadMcpToolDefinitions(normalizedSettings.mcp);
            mcpToolDefinitions = loadedMcpTools.definitions;
            mcpToolMappings = loadedMcpTools.toolMappings;
          } catch {
            // MCP 工具发现失败：跳过
          }
        }

        const runtimeSystemPrompt = buildAgentRuntimeSystemPrompt(
          normalizedSettings,
          mode,
          workspacePath,
          rulesSection,
          { agentDefinitions }
        );
        const sessionBootstrapPrompt = buildAgentSessionBootstrapPrompt(
          normalizedSettings,
          workspacePath,
          skillDefinitions,
          memorySection
        );

        const parts = buildAgentSessionParts(
          normalizedSettings,
          activeSessionId,
          workspacePath,
          messages,
          { systemPrompt: runtimeSystemPrompt },
          {
            editHistory: get()._editHistory,
            mcpToolDefinitions,
            mcpToolMappings,
            rulesSection,
            memorySection,
            projectGraphSummary,
            customPrompt: normalizedSettings.systemPrompt,
            lang: normalizedSettings.lang,
            mode,
            skillDefinitions,
            agentDefinitions,
            sessionBootstrapPrompt,
            onWorkspaceMutated: () => {},
          }
        );

        const snapshot = buildContextSnapshot(
          {
            model: parts.model,
            messages: [...parts.prefix.toMessageArray(), ...parts.log.toMessageArray()],
            tools: [...parts.prefix.getToolDefinitions()],
          },
          0
        );

        set({ _latestContextSnapshot: { sessionId: activeSessionId, snapshot } });
      },

      setShowSettings: (v) => set({ showSettings: v }),
      setProjectGraphLoading: (loading, phase) =>
        set({ projectGraphLoading: loading, projectGraphPhase: phase ?? null }),

      newSession: () => {
        const { settings } = get();
        const normalizedSettings = normalizeSettings(settings);
        const id = createId();
        const now = Date.now();
        const meta: SessionMeta = {
          id,
          name: '新任务',
          provider: resolveProviderName(normalizedSettings),
          model: normalizedSettings.model,
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          sessions: [meta, ...s.sessions],
          activeSessionId: id,
          messages: [],
          sessionMessagesLoading: false,
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
          _sessionLru: [id, ...s._sessionLru.filter((x) => x !== id)],
        }));
        evictSessionMessageCache(get, set, [id]);
        saveCurrentProjectState(get());
      },

      selectSession: (id) => {
        const { sessions, activeSessionId, sessionConversationStats, workspacePath } = get();
        if (id === activeSessionId) return;
        const meta = sessions.find((s) => s.id === id);
        if (!meta) return;

        set((s) => ({
          activeSessionId: id,
          conversationStats: getSessionConversationStats(sessionConversationStats, id),
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _sessionLru: [id, ...s._sessionLru.filter((x) => x !== id)],
        }));

        const cached = get().sessionMessages[id];
        if (cached) {
          set({ messages: cached, sessionMessagesLoading: false });
          saveCurrentProjectState(get());
          return;
        }

        // On-demand load: messages were evicted (or never loaded). SQLite is
        // the source of truth, so load from there instead of keeping every
        // session resident in memory.
        set({ messages: [], sessionMessagesLoading: true });
        void (async () => {
          let loaded: UIMessage[] = [];
          try {
            loaded = (await loadSessionMessages(workspacePath, id)) as unknown as UIMessage[];
          } catch {
            loaded = [];
          }
          // Race guard: the user may have switched to another session (or
          // workspace) while the load was in flight.
          const current = get();
          if (current.activeSessionId !== id || current.workspacePath !== workspacePath) return;
          set((s) => ({
            messages: loaded,
            sessionMessages: { ...s.sessionMessages, [id]: loaded },
            sessionMessagesLoading: false,
          }));
          evictSessionMessageCache(get, set, [id]);
        })();
        // Persist the active-session switch immediately; the loaded messages
        // already live in SQLite and need no write-back.
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
            sessionMessagesLoading: isActive ? false : s.sessionMessagesLoading,
            sessionMessages,
            sessionConversationStats,
            conversationStats: isActive ? createEmptyConversationStats() : s.conversationStats,
            _agent: isActive ? null : s._agent,
            _agentModel: isActive ? null : s._agentModel,
            _agentPromptKey: isActive ? null : s._agentPromptKey,
            _latestContextSnapshot: isActive ? null : s._latestContextSnapshot,
            _sessionLru: s._sessionLru.filter((x) => x !== id),
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

      sendMessage: createSendMessage(set, get),
    }));

// Wire the agent factory's lazy fallback resolver to the live store.
// This breaks the static import cycle while preserving the original behavior:
// callers that omit `onWorkspaceMutated` fall back to the store's noteWorkspaceMutation.
setDefaultOnWorkspaceMutatedResolver(() => useAgentStore.getState().noteWorkspaceMutation);

// 回合进行中阻止系统空闲休眠：macOS 休眠/唤醒循环会让 WKWebView 静默杀掉
// Agent Worker，导致回合丢失（见 power.rs）。isLoading 覆盖普通回合、Goal
// 循环与后台修复流；App Agent 运行在 usePaprBridge 中单独持有。
let sleepBlockHeld = false;
useAgentStore.subscribe((state, prevState) => {
  if (state.isLoading === prevState.isLoading) return;
  if (state.isLoading && !sleepBlockHeld) {
    sleepBlockHeld = true;
    void acquireSleepPrevention();
  } else if (!state.isLoading && sleepBlockHeld) {
    sleepBlockHeld = false;
    void releaseSleepPrevention();
  }
});

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
