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
import { getTranslation } from '../utils/i18n';
import { loadProjectState } from '../utils/projectStorage';
import {
  loadSessions,
  loadSessionMessages,
  loadAllProjectMeta,
  aggregateSessionRuntimeInDb,
  waitForPendingProjectStateSave,
  loadContextCompactions,
  loadLatestMemoryRecall,
  archiveSessionById,
  restoreSessionById,
  loadArchivedSessions as loadArchivedSessionsFromDb,
  deleteSessionById,
} from '../utils/projectStorage';
import { getContextSurfaceCached, forgetContextSurface, hydrateSessionContext } from './internals/contextSurfaceStore';
import { runProjectDiagnostics } from '../utils/projectDiagnostics';
import { loadAppSettings, queueAppSettingsSave } from '../utils/appSettingsStorage';
import {
  snapshotEnsure,
  snapshotList,
  restoreExecute,
  restoreUndo,
  loadCheckpointRecords,
  deleteCheckpointByMessage,
  deleteCheckpointsForSession,
} from '../utils/snapshot';
import { nextCheckpointSequence } from '../utils/workspaceGitPanel';
import { acquireSleepPrevention, releaseSleepPrevention } from '../utils/sleepPrevention';
import { warmupLspForWorkspace, stopWorkspaceLsp } from '../utils/lspWarmup';
import { restoreTodoListContexts, clearAllTodoListContexts, resetTodoListContext } from '../tools/todoListTool';
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
  getSettingsError,
  isApiConfigured as _isApiConfigured,
  normalizeSettings,
  resolveProviderName,
} from './internals/settingsNormalizer';
import {
  addConversationRuntime,
  cloneConversationStats,
  getSessionConversationStats,
} from './internals/stats';
import {
  normalizeProjectSnapshot,
  normalizeSessionMetaList,
  normalizeSessionProvider,
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
  createAgent,
  setDefaultOnWorkspaceMutatedResolver,
  type AgentRuntimeConfig,
} from './internals/agentFactory';
import type { AgentRuntimeHandle } from '../agent/WorkerBackedAgent';
import { handleWorkspaceMutation } from './internals/backgroundDiagnostics';
import { createSendMessage, invalidateAgentHandle } from './internals/sendMessage';
import { loadMemoryBootstrapSection } from './internals/memoryLedgerStore';
import { buildPruneOptions } from '../agent/compactionHandler';
import { finalizeCancelledToolInvocations } from './internals/messageMutators';
import { useGoalStore } from './goalStore';
import { upsertRecentWorkspace, sortRecentWorkspaces } from './internals/recentWorkspaces';
import { toast } from './toastStore';
import { applySessionCharacterMap, syncActiveCharacterFromSession } from './charactersStore';
import type {
  AgentActions,
  AgentState,
  PendingRestoreUndo,
  ResetToMessageResult,
  SessionMeta,
  Settings,
  StoreGet,
  StoreSet,
  UIMessage,
  UndoConversationResetResult,
} from './internals/types';


// Re-exports preserved for the public agentStore module surface
export type {
  ApiFormat,
  ApiMode,
  CumulativeStats,
  AttachedFileMeta,
  ImagePreview,
  Lang,
  ModelProfile,
  PendingRestoreUndo,
  ProviderName,
  ResetToMessageResult,
  SessionInputState,
  SessionMeta,
  Settings,
  TextFileAttachment,
  ThinkingPayload,
  UIMessage,
  UIToolInvocation,
  UndoConversationResetResult,
  WorkspaceEntry,
} from './internals/types';
export {
  createDefaultProfile,
  findProfileById,
  getProviderLabel,
  getSettingsError,
  isApiConfigured,
  normalizeSettings,
  resolveFastProfile,
  resolveMentorProfile,
  resolvePrimaryProfile,
  resolveProviderName,
  resolveThinkingPayload,
} from './internals/settingsNormalizer';

// Marker to silence unused-import lint for re-exported helpers
void _getProviderLabel;
void _isApiConfigured;

/** Evict least-recently-used session messages so at most
 *  SESSION_MESSAGE_CACHE_LIMIT sessions stay resident in memory. Eviction only
 *  drops the in-memory copy — SQLite keeps the full history, and every mutation
 *  is persisted before eviction can run (saveCurrentProjectState captures the
 *  state snapshot at call time), so no data is lost.
 *
 *  The session that is currently mid-turn (loadingSessionId) is always
 *  protected: evicting it while a turn is in flight would make the turn-end
 *  write fall back to the wrong session's messages and corrupt its history. */
function evictSessionMessageCache(get: StoreGet, set: StoreSet, protectIds: string[]): void {
  const { sessionMessages, _sessionLru, loadingSessionId } = get();
  const loadedIds = Object.keys(sessionMessages);
  if (loadedIds.length <= SESSION_MESSAGE_CACHE_LIMIT) return;

  const protectedSet = new Set(protectIds);
  if (loadingSessionId) {
    protectedSet.add(loadingSessionId);
  }
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

// App Agent 初始化去重：并发的 papr://agent.run 请求共享同一次创建，
// 避免重复拉起 Worker。
let appAgentEnsureInFlight: Promise<AgentRuntimeHandle> | null = null;

// openWorkspace 的工作区身份令牌：每次打开递增；异步加载完成后凭令牌判断
// 是否仍是当前工作区，防止旧加载结果覆盖新工作区（读旧覆新）。
let openWorkspaceSeq = 0;

/** 销毁当前 agent 句柄（回收 Worker 进程 / 心跳定时器 / 事件监听器）。
 *  所有把 _agent 置 null 或替换掉的路径都必须先调用它，否则每个被丢弃的
 *  WorkerBackedAgent 会带着活 Worker + 5s 心跳 interval + visibilitychange
 *  监听器泄漏到应用退出。destroy() 内部会 reject 全部 pending 请求
 *  （以 WorkerCrashError 走崩溃恢复），不会让 await 中的回合挂死。
 *  注意：不要在 set() 的 updater 函数内调用（updater 必须无副作用）。 */
function disposeAgentHandle(get: StoreGet): void {
  const agent = get()._agent;
  if (!agent) return;
  try {
    agent.destroy();
  } catch {
    // already torn down
  }
}

function disposeAppAgentHandle(get: StoreGet): void {
  const agent = get()._appAgent;
  if (!agent) return;
  try {
    agent.destroy();
  } catch {
    // already torn down
  }
}

function disposeWorkspaceAgents(get: StoreGet): void {
  disposeAgentHandle(get);
  disposeAppAgentHandle(get);
}

/** 从侧栏/内存卸下会话（删除与归档共用）。归档时保留 checkpoint 与 DB 行。 */
function detachSessionFromUi(
  get: StoreGet,
  set: StoreSet,
  id: string,
  options: { deleteCheckpoints: boolean },
): void {
  const running = get();
  resetTodoListContext(id);
  if (running._agentSessionId === id && running._agent) {
    disposeAgentHandle(get);
  }
  if (running.workspacePath) {
    forgetContextSurface(running.workspacePath, id);
    if (options.deleteCheckpoints) {
      void deleteCheckpointsForSession(running.workspacePath, id).catch(() => undefined);
    }
  }
  set((s) => {
    const sessions = s.sessions.filter((x) => x.id !== id);
    const isActive = s.activeSessionId === id;
    const isAgentOwner = s._agentSessionId === id;
    const wasLoading = s.loadingSessionId === id;
    const sessionMessages = { ...s.sessionMessages };
    const sessionConversationStats = { ...s.sessionConversationStats };
    const sessionInputState = { ...s._sessionInputState };
    delete sessionMessages[id];
    delete sessionConversationStats[id];
    delete sessionInputState[id];
    return {
      sessions,
      activeSessionId: isActive ? null : s.activeSessionId,
      messages: isActive ? [] : s.messages,
      sessionMessagesLoading: isActive ? false : s.sessionMessagesLoading,
      sessionMessages,
      sessionConversationStats,
      conversationStats: isActive ? createEmptyConversationStats() : s.conversationStats,
      isLoading: wasLoading ? false : s.isLoading,
      loadingSessionId: wasLoading ? null : s.loadingSessionId,
      _agent: isAgentOwner ? null : s._agent,
      _agentModel: isAgentOwner ? null : s._agentModel,
      _agentPromptKey: isAgentOwner ? null : s._agentPromptKey,
      _agentSessionId: isAgentOwner ? null : s._agentSessionId,
      _latestContextSnapshot: isActive ? null : s._latestContextSnapshot,
      _sessionInputState: sessionInputState,
      _sessionLru: s._sessionLru.filter((x) => x !== id),
      _messageCheckpoints: Object.fromEntries(
        Object.entries(s._messageCheckpoints).filter(
          ([, entry]) => entry.sessionId !== id
        )
      ),
      _pendingRestoreUndos: s._pendingRestoreUndos.filter(
        (entry) => entry.sessionId !== id
      ),
    };
  });
}

/** 持久化设置：成功时清除历史持久化错误标记（横幅不再常驻）；
 *  失败时记录 _persistenceError 并 toast 提示。保存走串行队列。 */
function persistAppSettings(get: StoreGet, set: StoreSet, settings: Settings): void {
  void queueAppSettingsSave(settings).then(
    () => {
      if (get()._persistenceError) {
        set({ _persistenceError: null });
      }
    },
    (err) => {
      const message = `设置保存失败：${err instanceof Error ? err.message : String(err)}`;
      set({ _persistenceError: message });
      toast.error(message);
    },
  );
}

/** 为 App Agent 确保存在可用 Agent（独立 Worker，不占用聊天 `_agent`）。
 *  与 sendMessage 的创建路径对齐，但只产出「宿主」：空上下文、不绑定会话。 */
async function ensureAgentForAppInternal(
  get: StoreGet,
  set: StoreSet,
): Promise<AgentRuntimeHandle> {
  const existing = get()._appAgent;
  if (existing && !existing.isCrashed()) return existing;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      // already torn down
    }
    set({ _appAgent: null });
  }

  const normalizedSettings = normalizeSettings(get().settings);
  const settingsError = getSettingsError(normalizedSettings);
  if (settingsError) throw new Error(settingsError);

  // 兜底：没有打开任何项目时自动创建默认项目，保证文件工具有落点。
  if (!get().workspacePath.trim()) {
    await get().ensureDefaultWorkspace();
  }
  const workspacePath = get().workspacePath;
  if (!workspacePath.trim()) {
    throw new Error('没有可用的工作区，无法初始化 Agent');
  }

  let sessionId = get().activeSessionId;
  if (!sessionId) {
    get().newSession();
    sessionId = get().activeSessionId;
  }
  if (!sessionId) {
    throw new Error('无法初始化会话');
  }

  let memorySection: string | undefined;
  try {
    memorySection = await loadMemoryBootstrapSection(workspacePath);
  } catch {
    memorySection = undefined;
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

  // 竞态保护：异步加载期间工作区已切换，放弃本次创建由调用方重试。
  if (get().workspacePath !== workspacePath) {
    throw new Error('工作区已变更，请重试');
  }

  const runtimeConfig: AgentRuntimeConfig = {
    editHistory: get()._editHistory,
    rulesSection: get()._projectRulesSection,
    customPrompt: normalizedSettings.systemPrompt,
    memorySection,
    lang: normalizedSettings.lang,
    mode: 'app',
    skillDefinitions: get()._skillDefinitions,
    agentDefinitions: get()._agentDefinitions,
    mcpToolDefinitions,
    mcpToolMappings,
  };

  const agent = createAgent(normalizedSettings, sessionId, workspacePath, [], {}, runtimeConfig);
  set({ _appAgent: agent });
  return agent;
}

/** 重置撤销栈深度上限：防止无限连续重置导致栈（及其持久化体积）无界增长。 */
const MAX_RESTORE_UNDOS = 20;

/** 入栈并限深：超出上限时丢弃最旧条目，其 checkpoint timeline 记录一并删除
 *  （被截消息已无处回放，记录失去意义）。 */
function pushRestoreUndo(
  stack: PendingRestoreUndo[],
  entry: PendingRestoreUndo
): PendingRestoreUndo[] {
  const next = [...stack, entry];
  if (next.length <= MAX_RESTORE_UNDOS) {
    return next;
  }
  const dropped = next.slice(0, next.length - MAX_RESTORE_UNDOS);
  for (const d of dropped) {
    for (const id of Object.keys(d.removedCheckpoints)) {
      void deleteCheckpointByMessage(d.workspacePath, id).catch(() => undefined);
    }
  }
  return next.slice(next.length - MAX_RESTORE_UNDOS);
}

export const useAgentStore = create<AgentState & AgentActions>()((set, get) => ({
      settings: DEFAULT_SETTINGS,
      workspacePath: '',
  workspaceMutationVersion: 0,
      _pendingRestoreUndos: [],
      sessions: [],
      archivedSessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      skillEnabledById: {},
      conversationStats: createEmptyConversationStats(),
      sessionConversationStats: {},
      sessionMessagesLoading: false,
      projectDiagnosticsReport: null,
      isLoading: false,
      loadingSessionId: null,
      projectGraphLoading: false,
      projectGraphPhase: null as null | { phase: string; current: number; total: number },
      showSettings: false,
      settingsLoaded: false,
      _settingsPersistable: false,
      _messageLoadFailedSessions: {},
      _agent: null,
      _agentModel: null,
      _agentPromptKey: null,
      _agentSessionId: null,
      _appAgent: null,
      _sessionInputState: {},
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
      _persistenceError: null,
      _checkpointSeq: 0,
      _turnSeq: 0,
      _stopRequestedSeq: 0,
      _latestContextSnapshot: null,
      _currentMode: 'agent',
      _sessionLru: [],
      _pendingChatJump: null,
      _pendingSelectPath: null,

      loadSettings: async () => {
        let settings = get().settings;
        try {
          const storedSettings = await loadAppSettings();
          settings = normalizeSettings(storedSettings ?? get().settings);
          disposeWorkspaceAgents(get);
           set({ settings, settingsLoaded: true, _settingsPersistable: true, _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null, _appAgent: null });
           void applyBrowserEngine(settings.browserEngine);
           void invoke('set_external_access_yolo', { enabled: settings.folderAccessYolo }).catch(() => undefined);
           void invoke('lsp_set_disabled_families', { families: settings.lspDisabledFamilies }).catch(() => undefined);

          // No proactive write-back on load: legacy plaintext-key migration is
          // already handled (and re-persisted) by the backend's
          // migrate_and_inject_secrets. Writing normalized settings back here
          // would run on every launch and could feed an empty apiKey into the
          // vault (interpreted as "user cleared the key") when vault injection
          // returns nothing, destroying a stored key.
        } catch {
          // 加载失败：内存中是默认设置。保持 _settingsPersistable=false，
          // 禁止后续自动回写，避免用默认值（含空 apiKey）摧毁磁盘上的真实配置。
          settings = get().settings;
          disposeWorkspaceAgents(get);
          set({ settingsLoaded: true, _settingsPersistable: false, _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null, _appAgent: null });
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
            disposeWorkspaceAgents(get);
            set({ settings: nextSettings, _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null, _appAgent: null });
            if (get()._settingsPersistable) {
              // 持久化失败不可静默：内存已推进，磁盘仍是旧设置，下次启动即分叉。
              persistAppSettings(get, set, nextSettings);
            }
          }
        }

        // 兜底：没有任何可用项目（首次启动或全部 recent 已失效）时，
        // 自动创建并打开默认项目，保证对话产生的文件始终有落点。
        if (!openedWorkspace) {
          await get().ensureDefaultWorkspace();
        }
      },

      setSettings: (partial, options) => {
        const previousEngine = get().settings.browserEngine;
        const settings = normalizeSettings({ ...get().settings, ...partial });
        // N7：运行中的回合必须保留（继续用回合启动时的配置跑完），保存设置
        // 不得静默杀掉它；仅在回合空闲时销毁 agent（旧配置不得复用）。
        // 回合运行中变更设置时置空 _agentModel/_agentPromptKey：下一条消息
        // 的复用检查（model/promptKey 不匹配即重建）据此按新设置重建 agent，
        // 避免旧配置（temperature/maxTokens 等不进 promptKey 的字段）被复用。
        const turnRunning = get().isLoading;
        if (!options?.preserveAgent && !turnRunning) {
          disposeWorkspaceAgents(get);
        }
        set(options?.preserveAgent || turnRunning
          ? {
              settings,
              ...(turnRunning && !options?.preserveAgent
                ? { _agentModel: null, _agentPromptKey: null }
                : {}),
            }
          : { settings, _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null, _appAgent: null });
        // _settingsPersistable 为 false 表示启动时设置加载失败、内存中是默认值，
        // 此时回写会用默认值（含空 apiKey）覆盖磁盘真实配置：extract_and_store_secrets
        // 会把"存在但为空"的 apiKey 视为用户主动清除，导致 vault 密钥被永久删除。
        // 与 openWorkspace/loadSettings 的守卫一致：跳过持久化，并明确提示用户。
        if (get()._settingsPersistable) {
          persistAppSettings(get, set, settings);
        } else {
          set({ _persistenceError: '设置加载失败，更改将不会被保存到磁盘' });
        }
        void invoke('set_external_access_yolo', { enabled: settings.folderAccessYolo }).catch(() => undefined);
        void invoke('lsp_set_disabled_families', { families: settings.lspDisabledFamilies }).catch(() => undefined);
        if (settings.browserEngine !== previousEngine) {
          void applyBrowserEngine(settings.browserEngine);
        }
      },

      setWorkspacePath: (path) => {
        disposeWorkspaceAgents(get);
        clearAllTodoListContexts();
        set((s) => {
          if (s.workspacePath === path) {
            return { workspacePath: path, _agent: null, _appAgent: null, workspaceMutationVersion: 0 };
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
      _agentSessionId: null,
      _appAgent: null,
      _sessionInputState: {},
      _editHistory: new EditHistory(),
      _projectRulesSection: '',
      _skillDefinitions: [],
      _agentDefinitions: [...BUILTIN_AGENTS],
      _taskChecklists: {},
      _pendingRestoreUndos: [],
      _messageCheckpoints: {},
      _gitReady: false,
      _gitReadyError: null,
      _checkpointError: null,
      _persistenceError: null,
      _checkpointSeq: 0,
      _turnSeq: 0,
      _sessionLru: [],
          };
        });
        if (path) {
          void get()._loadProjectConfig(path);
          void get()._ensureWorkspaceGitReady(path);
          void warmupLspForWorkspace(path, get().settings.lspDisabledFamilies);
        }
      },

      closeWorkspace: () => {
        // 关闭工作区即放弃进行中的回合：destroy() 内部先 cancel 再 reject
        // 全部 pending 请求并终止 Worker，避免被遗弃的 worker 继续消耗资源/
        // 阻止系统休眠状态正确释放。
        // 同时递增工作区身份令牌：在飞的 openWorkspace 加载（先加载后切换，
        // N12）完成后必须丢弃结果，否则关闭后旧工作区会被重新打开。
        const previousPath = get().workspacePath;
        openWorkspaceSeq += 1;
        disposeWorkspaceAgents(get);
        clearAllTodoListContexts();
        set({
          workspacePath: '',
          workspaceMutationVersion: 0,
          projectGraphLoading: false,
          projectGraphPhase: null,
          sessions: [],
          archivedSessions: [],
          activeSessionId: null,
          messages: [],
          sessionMessages: {},
          skillEnabledById: {},
          conversationStats: createEmptyConversationStats(),
          sessionConversationStats: {},
          sessionMessagesLoading: false,
          projectDiagnosticsReport: null,
          isLoading: false,
          loadingSessionId: null,
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _agentSessionId: null,
          _appAgent: null,
          _sessionInputState: {},
          _editHistory: new EditHistory(),
          _projectRulesSection: '',
          _skillDefinitions: [],
          _agentDefinitions: [...BUILTIN_AGENTS],
          _taskChecklists: {},
          _pendingRestoreUndos: [],
          _messageCheckpoints: {},
          _gitReady: false,
          _gitReadyError: null,
          _checkpointError: null,
      _persistenceError: null,
          _checkpointSeq: 0,
          _turnSeq: 0,
          _sessionLru: [],
        });
        syncActiveCharacterFromSession(null);
        if (previousPath) {
          void stopWorkspaceLsp(previousPath);
        }
      },

      openWorkspace: async (path) => {
        const normalizedWorkspacePath = path.trim();

        // N12：先加载后切换——失效路径（目录被删除/移动）加载失败时，当前
        // 工作区必须保持原样，错误由调用方提示。旧实现先 closeWorkspace 再
        // 加载，失败不可恢复：静默落到空状态且把用户当前工作区一起关掉。
        // 加载成功后才关闭旧工作区并 set 新状态。

        // 工作区身份令牌：openWorkspace 是异步加载（loadSessions → set），
        // 期间用户可能再次切换工作区。旧实现没有守卫——前一次加载完成后
        // 无条件 set()，用旧工作区的数据覆盖新工作区的状态（读旧覆新）。
        // 每次打开递增令牌，set 前校验，不一致即丢弃本次结果。
        // closeWorkspace 同样递增令牌（见上），关闭后旧加载结果不得复活。
        const workspaceSeq = ++openWorkspaceSeq;

        // 读前先排空该工作区挂起的保存队列（与 legacy loadProjectState 的
        // waitForPendingProjectStateSave 对齐）：A→B→A 快速切换时，A 的
        // 挂起保存未落库就读 A 会读到旧数据，再被下方 saveCurrentProjectState
        // 回写，把新数据永久覆盖掉。
        await waitForPendingProjectStateSave(normalizedWorkspacePath);

        let sessions: SessionMeta[] = [];
        let sessionMessages: Record<string, UIMessage[]> = {};
        let activeSessionId: string | null = null;
        let skillEnabledById: Record<string, boolean> = {};
        let conversationStats = createEmptyConversationStats();
        let sessionConversationStats: Record<string, unknown> = {};
        let projectDiagnosticsReport: unknown = null;
        let messageCheckpoints: Record<string, { sha: string; sessionId: string }> = {};
        let sessionTodoLists: Record<string, unknown> = {};
        let pendingRestoreUndos: PendingRestoreUndo[] = [];
        const messageLoadFailed: Record<string, boolean> = {};

        try {
          sessions = (await loadSessions(normalizedWorkspacePath)).map((meta) => ({
            ...meta,
            provider: normalizeSessionProvider(meta.provider),
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt ?? meta.createdAt,
          }));

          const meta = await loadAllProjectMeta(normalizedWorkspacePath);
          const characterMap = (meta.session_active_characters as Record<string, string | null>) ?? {};
          sessions = applySessionCharacterMap(sessions, characterMap);
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
              sessionMessages[activeSessionId] = msgs;
            } catch {
              // 读取失败 ≠ 会话为空：置 [] 但标记失败，禁止后续把空数组
              // 全量替换回 DB（会抹掉该会话的全部消息）。
              sessionMessages[activeSessionId] = [];
              messageLoadFailed[activeSessionId] = true;
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
          // 恢复持久化的重置撤销栈（#20：重启后仍可撤销上次重置）。
          // 会话已不存在的条目无法回放消息，加载时即丢弃（其 timeline 记录
          // 随会话删除已清理）。
          const rawPendingUndos = (meta.pending_restore_undos as PendingRestoreUndo[] | null) ?? [];
          pendingRestoreUndos = rawPendingUndos.filter(
            (entry) =>
              entry &&
              typeof entry.workspacePath === 'string' &&
              (entry.sessionId === null || sessions.some((s) => s.id === entry.sessionId))
          );

          // 安全兜底：如果新表完全无数据（sessions 和 meta 都空），回退到旧格式
          if (sessions.length === 0 && Object.keys(meta).length === 0) {
            throw new Error('新表无数据，尝试旧格式');
          }
        } catch (metaErr) {
          console.warn('[CodePapr] 从新表加载失败，回退到旧格式:', metaErr);
          const snapshot = normalizeProjectSnapshot(await loadProjectState(normalizedWorkspacePath), {
            debugEnabled: get().settings.debugEnabled,
          });
          sessions = snapshot.sessions.map((meta) => ({
            ...meta,
            provider: normalizeSessionProvider(meta.provider),
            updatedAt: meta.updatedAt ?? meta.createdAt,
          }));
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
          // 旧格式锚点是纯字符串（无会话归属）：升级为 { sha, sessionId: '' }，
          // sessionId 为空永不匹配任何会话，clearMessages 不会误删。
          messageCheckpoints = Object.fromEntries(
            Object.entries(snapshot.messageCheckpoints ?? {}).map(([id, value]) => [
              id,
              typeof value === 'string'
                ? { sha: value, sessionId: '' }
                : value,
            ])
          ) as Record<string, { sha: string; sessionId: string }>;
          sessionTodoLists = snapshot.sessionTodoLists ?? {};
        }

        // 回填旧会话运行时长：session_conversation_stats 旧数据没有 runtimeMs
        // 字段，从 DB 消息时间戳聚合补齐（幂等：只处理 runtimeMs 为 undefined
        // 的条目，新回合实时累计后不会再触发）。
        try {
          const runtimeBySession = await aggregateSessionRuntimeInDb(normalizedWorkspacePath);
          for (const [sessionId, runtimeMs] of Object.entries(runtimeBySession)) {
            const existing = sessionConversationStats[sessionId] as
              | import('./internals/types').ConversationStats
              | undefined;
            if (existing && typeof existing.runtimeMs === 'number') continue;
            sessionConversationStats[sessionId] = addConversationRuntime(
              cloneConversationStats(existing),
              runtimeMs
            );
          }
        } catch (err) {
          console.warn(
            '[CodePapr] 回填会话运行时长失败:',
            err instanceof Error ? err.message : err
          );
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

        // 工作区身份守卫：加载期间用户又切换了工作区（openWorkspace 令牌已
        // 递增）则丢弃本次结果，绝不把旧工作区数据 set() 到新工作区上。
        if (workspaceSeq !== openWorkspaceSeq) {
          return;
        }

        // 加载成功：先持久化最近项目（原子读改写，重启不恢复成旧列表），
        // 再关闭旧工作区（销毁 agent/清空状态），随后 set 新工作区状态。
        await invoke('note_recent_workspace', { path: normalizedWorkspacePath }).catch(() => undefined);
        get().closeWorkspace();

        set({
          workspacePath: path,
          workspaceMutationVersion: 0,
          projectGraphLoading: false,
          projectGraphPhase: null,
          sessions,
          archivedSessions: [],
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
          _agentSessionId: null,
          _appAgent: null,
          _editHistory: new EditHistory(),
          _projectRulesSection: '',
          _skillDefinitions: [],
          _agentDefinitions: [...BUILTIN_AGENTS],
          _taskChecklists: {},
          _messageCheckpoints: { ...messageCheckpoints },
          _pendingRestoreUndos: pendingRestoreUndos,
          _gitReady: false,
          _gitReadyError: null,
          _checkpointError: null,
      _persistenceError: null,
          _checkpointSeq: 0,
          _turnSeq: 0,
          // Active session first; the rest follow the persisted (updatedAt DESC)
          // order as the initial LRU approximation.
          _sessionLru: [
            ...(activeSessionId ? [activeSessionId] : []),
            ...sessions.filter((s) => s.id !== activeSessionId).map((s) => s.id),
          ],
          _messageLoadFailedSessions: messageLoadFailed,
        });
        syncActiveCharacterFromSession(
          sessions.find((session) => session.id === activeSessionId)?.activeCharacterId ?? null
        );

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
        void warmupLspForWorkspace(path, get().settings.lspDisabledFamilies);

        const currentSettings = get().settings;
        // _settingsPersistable 为 false 表示启动时设置加载失败、内存中是默认值，
        // 此时回写会用默认设置（含空 apiKey）覆盖磁盘上的真实配置，必须跳过。
        if (get().settingsLoaded && get()._settingsPersistable && normalizedWorkspacePath) {
          const nextRecent = upsertRecentWorkspace(currentSettings.recentWorkspaces, normalizedWorkspacePath);
          const nextSettings = normalizeSettings({
            ...currentSettings,
            recentWorkspaces: nextRecent,
          });
          set({ settings: nextSettings });
          persistAppSettings(get, set, nextSettings);
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

      noteWorkspaceMutation: (paths, options) => {
        handleWorkspaceMutation({
          get,
          set,
          paths,
          scheduleDiagnostics: options?.scheduleDiagnostics ?? true,
          autoRepair: options?.autoRepair ?? (paths ?? []).length > 0,
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
        disposeWorkspaceAgents(get);
        set({
          _projectRulesSection: rulesSection,
          _skillDefinitions: enabledSkillDefinitions,
          _agentDefinitions: mergedAgents,
          _agent: null,
          _agentPromptKey: null,
          _agentSessionId: null,
          _appAgent: null,
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
              if (result.rebuilt) {
                // shadow repo 损坏被重建：历史快照已丢失（损坏目录保留在
                // .CodePapr/ 下），明确记录便于排查"回滚点消失"问题。
                console.warn('[CodePapr] shadow git 仓库损坏，已自动重建:', path);
              }
              set({ _gitReady: true, _gitReadyError: null });
              try {
                const [snapshots, records] = await Promise.all([
                  snapshotList(path, 200),
                  loadCheckpointRecords(path, undefined),
                ]);
                if (get().workspacePath !== path) return;
                if (records.length > 0) {
                  const cps: Record<string, { sha: string; sessionId: string }> = {};
                  let maxSeq = 0;
                  for (const r of records) {
                    cps[r.messageId] = { sha: r.sha, sessionId: r.sessionId };
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
      _persistenceError: null,
        });
      },

      setSkillEnabledState: (skillId, enabled) => {
        const normalizedSkillId = skillId.trim();
        if (!normalizedSkillId) {
          return;
        }

        disposeWorkspaceAgents(get);
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
            _agentSessionId: null,
            _appAgent: null,
          };
        });

        saveCurrentProjectState(get());
      },

      setSessionInputState: (sessionId, state) => {
        set((s) => ({
          _sessionInputState: { ...s._sessionInputState, [sessionId]: state },
        }));
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
          memorySection = await loadMemoryBootstrapSection(workspacePath);
        } catch {
          memorySection = undefined;
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

        // 与真实 agent 重建对齐：surface 节点水合 + 冻结 prune 参数，
        // 避免 Inspector 按全量 archive / 当前 settings 偏离实际请求上下文。
        let contextMessages = messages;
        let snapshotPruneOptions = buildPruneOptions(normalizedSettings);
        try {
          const hydrated = await hydrateSessionContext(
            workspacePath,
            activeSessionId,
            messages,
            snapshotPruneOptions
          );
          contextMessages = hydrated.messages as UIMessage[];
          snapshotPruneOptions = hydrated.pruneOptions;
        } catch {
          // surface 读取失败 → 沿用全量数组（与 sendMessage 重建兜底一致）。
        }

        const parts = buildAgentSessionParts(
          normalizedSettings,
          activeSessionId,
          workspacePath,
          contextMessages,
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
          },
          snapshotPruneOptions
        );

        const snapshot = buildContextSnapshot(
          {
            model: parts.model,
            messages: [...parts.prefix.toMessageArray(), ...parts.log.toMessageArray()],
            tools: [...parts.prefix.getToolDefinitions()],
          },
          0
        );

        // PR1：Context Inspector 观测数据（ADR-001/005）——current generation、
        // 最新 compaction、checkpoint 来源区间、surface 节点统计。
        try {
          const surface = await getContextSurfaceCached(workspacePath, activeSessionId);
          const compactions = surface
            ? await loadContextCompactions(workspacePath, activeSessionId, 1)
            : [];
          const latest = compactions[0] ?? null;
          snapshot.contextSurface = {
            generation: surface?.generation ?? null,
            nodeCount: surface?.nodes.length ?? 0,
            nodeKinds: (surface?.nodes ?? []).reduce<Record<string, number>>((acc, node) => {
              acc[node.nodeKind] = (acc[node.nodeKind] ?? 0) + 1;
              return acc;
            }, {}),
            latestCompaction: latest
              ? {
                  id: latest.id,
                  status: latest.status,
                  trigger: latest.trigger,
                  sourceGeneration: latest.sourceGeneration,
                  targetGeneration: latest.targetGeneration,
                  checkpointMessageId: latest.checkpointMessageId,
                  sourceStartMessageId: latest.sourceStartMessageId,
                  sourceEndMessageId: latest.sourceEndMessageId,
                  retainedTailStartMessageId: latest.retainedTailStartMessageId,
                  sourceMessageCount: latest.sourceMessageCount,
                  retainedMessageCount: latest.retainedMessageCount,
                  estimatedTokensBefore: latest.estimatedTokensBefore,
                  estimatedTokensAfter: latest.estimatedTokensAfter,
                  summaryMode: latest.summaryMode,
                  summaryModel: latest.summaryModel,
                  createdAt: latest.createdAt,
                  completedAt: latest.completedAt,
                }
              : null,
          };
        } catch {
          // surface 观测失败不阻塞上下文快照
        }

        // PR5：最新一次 Recall 审计（items 从 items_json 解析）。
        try {
          const recall = await loadLatestMemoryRecall(workspacePath, activeSessionId);
          if (recall) {
            let items: Array<{
              title: string;
              source: string;
              confidence: string;
              score: number;
            }> = [];
            try {
              const parsed: unknown = JSON.parse(recall.itemsJson);
              if (Array.isArray(parsed)) {
                items = parsed
                  .filter(
                    (item): item is { title: string; source: string; confidence: string; score: number } =>
                      !!item &&
                      typeof item === 'object' &&
                      typeof (item as Record<string, unknown>).title === 'string'
                  )
                  .map((item) => ({
                    title: item.title,
                    source: String(item.source ?? ''),
                    confidence: String(item.confidence ?? ''),
                    score: Number(item.score ?? 0),
                  }))
                  .slice(0, 8);
              }
            } catch {
              items = [];
            }
            snapshot.memoryRecall = {
              recallId: recall.id,
              query: recall.queryText,
              estimatedTokens: recall.estimatedTokens,
              createdAt: recall.createdAt,
              status: recall.status,
              items,
            };
          }
        } catch {
          // Recall 观测失败不阻塞上下文快照
        }

        set({ _latestContextSnapshot: { sessionId: activeSessionId, snapshot } });
      },

      ensureAgentForApp: () => {
        if (appAgentEnsureInFlight) return appAgentEnsureInFlight;
        const promise = ensureAgentForAppInternal(get, set).finally(() => {
          appAgentEnsureInFlight = null;
        });
        appAgentEnsureInFlight = promise;
        return promise;
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
          name: getTranslation(normalizedSettings.lang).newTask,
          provider: resolveProviderName(normalizedSettings),
          model: normalizedSettings.model,
          createdAt: now,
          updatedAt: now,
          activeCharacterId: null,
        };
        // N7：新建任务不得静默杀掉运行中的回合（agent 绑定运行会话 A，
        // 新建后 activeSessionId 变更，下一条消息由复用检查自动重建）。
        const turnRunning = get().isLoading;
        if (!turnRunning) {
          disposeAgentHandle(get);
        }
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
          _agent: turnRunning ? s._agent : null,
          _agentModel: turnRunning ? s._agentModel : null,
          _agentPromptKey: turnRunning ? s._agentPromptKey : null,
          _agentSessionId: turnRunning ? s._agentSessionId : null,
          _latestContextSnapshot: null,
          _sessionLru: [id, ...s._sessionLru.filter((x) => x !== id)],
        }));
        evictSessionMessageCache(get, set, [id]);
        saveCurrentProjectState(get());
        syncActiveCharacterFromSession(null);
      },

      selectSession: (id) => {
        const { sessions, activeSessionId, sessionConversationStats, workspacePath, loadingSessionId } = get();
        if (id === activeSessionId) return;
        const meta = sessions.find((s) => s.id === id);
        if (!meta) return;

        // 离开的会话若正在执行，保留 agent 句柄（回合继续、可取消）。N7：
        // 运行中的回合与用户正在查看哪个会话无关——只要某会话仍在执行
        // （loadingSessionId 非空），agent 就必须保留。旧实现只保留「当前或
        // 目标会话正在执行」的情况，A 运行→切 B→切 C 时把 A 的 agent 销毁，
        // A 的回合被静默终止。其余情况（无回合运行）清空并销毁，由下次发送重建。
        const keepAgent = loadingSessionId !== null;
        if (!keepAgent) {
          disposeAgentHandle(get);
        }

        set((s) => ({
          activeSessionId: id,
          conversationStats: getSessionConversationStats(sessionConversationStats, id),
          _agent: keepAgent ? s._agent : null,
          _agentModel: keepAgent ? s._agentModel : null,
          _agentPromptKey: keepAgent ? s._agentPromptKey : null,
          _agentSessionId: keepAgent ? s._agentSessionId : null,
          _sessionLru: [id, ...s._sessionLru.filter((x) => x !== id)],
        }));
        syncActiveCharacterFromSession(meta.activeCharacterId ?? null);

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
          // 读前排空该工作区挂起的保存队列（与 openWorkspace 对齐）：
          // 该会话的消息缓存可能刚被 LRU 逐出，其最新内容只存在于挂起的
          // 保存任务中尚未落库；不等队列直接读会读到旧数据。
          // （内部不会抛错。）
          await waitForPendingProjectStateSave(workspacePath);
          let loaded: UIMessage[] = [];
          let loadFailed = false;
          try {
            loaded = await loadSessionMessages(workspacePath, id);
          } catch {
            // 读取失败 ≠ 会话为空：标记失败，禁止把空数组全量替换回 DB。
            loaded = [];
            loadFailed = true;
          }
          // Race guard: the user may have switched to another session (or
          // workspace) while the load was in flight.
          const current = get();
          if (current.activeSessionId !== id || current.workspacePath !== workspacePath) return;
          set((s) => ({
            messages: loaded,
            sessionMessages: { ...s.sessionMessages, [id]: loaded },
            sessionMessagesLoading: false,
            _messageLoadFailedSessions: {
              ...s._messageLoadFailedSessions,
              [id]: loadFailed,
            },
          }));
          evictSessionMessageCache(get, set, [id]);
        })();
        // Persist the active-session switch immediately; the loaded messages
        // already live in SQLite and need no write-back.
        saveCurrentProjectState(get());
      },

      retryLoadSessionMessages: async (): Promise<boolean> => {
        const { workspacePath, activeSessionId } = get();
        if (!workspacePath || !activeSessionId) return false;
        // 未被标记失败：无需重试。
        if (!get()._messageLoadFailedSessions[activeSessionId]) return true;

        try {
          // 读前排空挂起保存队列（与 selectSession/openWorkspace 对齐），
          // 避免读到旧数据。
          await waitForPendingProjectStateSave(workspacePath);
          const loaded = await loadSessionMessages(
            workspacePath,
            activeSessionId
          );
          // 竞态守卫：加载期间用户可能已切换会话/工作区。
          const current = get();
          if (
            current.activeSessionId !== activeSessionId ||
            current.workspacePath !== workspacePath
          ) {
            return false;
          }
          set((s) => ({
            messages: loaded,
            sessionMessages: { ...s.sessionMessages, [activeSessionId]: loaded },
            sessionMessagesLoading: false,
            _messageLoadFailedSessions: {
              ...s._messageLoadFailedSessions,
              [activeSessionId]: false,
            },
          }));
          evictSessionMessageCache(get, set, [activeSessionId]);
          saveCurrentProjectState(get());
          return true;
        } catch {
          // 仍失败：保留失败标记（防止空视图回写覆盖 DB 历史）。
          return false;
        }
      },

      deleteSession: (id) => {
        detachSessionFromUi(get, set, id, { deleteCheckpoints: true });
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
      },

      archiveSession: (id) => {
        const running = get();
        const session = running.sessions.find((item) => item.id === id);
        if (!session) return;
        if (running.workspacePath) {
          void archiveSessionById(running.workspacePath, id).catch((err) => {
            const message = `${getTranslation(get().settings.lang).archiveFailed}：${
              err instanceof Error ? err.message : String(err)
            }`;
            toast.error(message);
          });
        }
        detachSessionFromUi(get, set, id, { deleteCheckpoints: false });
        set((s) => ({
          archivedSessions: [
            { ...session, archivedAt: Date.now() },
            ...s.archivedSessions.filter((item) => item.id !== id),
          ],
        }));
        saveCurrentProjectState(get());
      },

      loadArchivedSessions: async () => {
        const path = get().workspacePath;
        if (!path) {
          set({ archivedSessions: [] });
          return;
        }
        try {
          const list = await loadArchivedSessionsFromDb(path);
          set({ archivedSessions: normalizeSessionMetaList(list) });
        } catch (err) {
          console.warn(
            '[CodePapr] 加载归档会话失败:',
            err instanceof Error ? err.message : err
          );
          set({ archivedSessions: [] });
        }
      },

      restoreArchivedSession: async (id) => {
        const path = get().workspacePath;
        if (path) {
          try {
            await restoreSessionById(path, id);
          } catch (err) {
            const message = `${getTranslation(get().settings.lang).restoreFailed}：${
              err instanceof Error ? err.message : String(err)
            }`;
            toast.error(message);
            return;
          }
        }
        const archived = get().archivedSessions.find((item) => item.id === id);
        const now = Date.now();
        if (archived) {
          const restored: SessionMeta = {
            ...archived,
            archivedAt: null,
            updatedAt: now,
          };
          set((s) => ({
            sessions: normalizeSessionMetaList([
              restored,
              ...s.sessions.filter((item) => item.id !== id),
            ]),
            archivedSessions: s.archivedSessions.filter((item) => item.id !== id),
          }));
        } else if (path) {
          try {
            const list = await loadSessions(path);
            set({ sessions: normalizeSessionMetaList(list) });
            await get().loadArchivedSessions();
          } catch (err) {
            console.warn(
              '[CodePapr] 恢复后刷新会话列表失败:',
              err instanceof Error ? err.message : err
            );
          }
        }
        saveCurrentProjectState(get());
      },

      deleteArchivedSession: (id) => {
        const running = get();
        if (running.sessions.some((item) => item.id === id)) {
          get().deleteSession(id);
        }
        resetTodoListContext(id);
        if (running.workspacePath) {
          forgetContextSurface(running.workspacePath, id);
          void deleteCheckpointsForSession(running.workspacePath, id).catch(() => undefined);
          void deleteSessionById(running.workspacePath, id).catch((err) => {
            toast.error(
              `${getTranslation(get().settings.lang).deleteSession}：${
                err instanceof Error ? err.message : String(err)
              }`
            );
          });
        }
        set((s) => ({
          archivedSessions: s.archivedSessions.filter((item) => item.id !== id),
          _messageCheckpoints: Object.fromEntries(
            Object.entries(s._messageCheckpoints).filter(([, entry]) => entry.sessionId !== id)
          ),
          _pendingRestoreUndos: s._pendingRestoreUndos.filter((entry) => entry.sessionId !== id),
        }));
      },

      clearMessages: () => {
        // N7：不得静默杀掉运行中的回合——disposeAgentHandle 会以
        // AgentDestroyedError 终止在飞回合；清空运行中会话的消息也会让
        // 回合的消息写入落在空视图上。与 newSession/setSettings/selectSession
        // 的回合守卫保持一致。
        if (get().isLoading) return;
        const sessionId = get().activeSessionId;
        disposeAgentHandle(get);
        // surface 内存缓存失效：消息已清空，缓存的 surface 节点全部脱节。
        if (sessionId && get().workspacePath) {
          forgetContextSurface(get().workspacePath, sessionId);
        }
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
          // 只清当前会话的 checkpoint 锚点：其他会话的历史锚点（resetToMessage
          // 依赖）必须保留——旧实现整体置 {} 会丢光所有会话的回滚点。
          _messageCheckpoints: s.activeSessionId
            ? Object.fromEntries(
                Object.entries(s._messageCheckpoints).filter(
                  ([, entry]) => entry.sessionId !== s.activeSessionId
                )
              )
            : s._messageCheckpoints,
          // 清空会话会删掉该会话全部 checkpoint timeline 记录（含待撤销重置
          // 截掉的那些）——归属该会话的撤销条目失去持久化基础，一并失效。
          _pendingRestoreUndos: s._pendingRestoreUndos.filter(
            (entry) => entry.sessionId !== sessionId
          ),
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _agentSessionId: null,
          _checkpointSeq: 0,
          _turnSeq: 0,
          _checkpointError: null,
      _persistenceError: null,
          _latestContextSnapshot: null,
        }));
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
        if (sessionId) {
          void deleteCheckpointsForSession(get().workspacePath, sessionId).catch(() => undefined);
        }
      },

      resetToMessage: async (messageId): Promise<ResetToMessageResult> => {
        // 纵深防御：UI 在回合运行中已隐藏重置入口，store 层再守一道——
        // 运行中的回合会持续写文件/消息，重置会与它互相践踏。
        if (get().isLoading) {
          return { ok: false, reason: 'turn-running' };
        }

        const { messages, activeSessionId, _messageCheckpoints, workspacePath } = get();
        const targetSha = _messageCheckpoints[messageId]?.sha;
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

        let filesChanged = 0;
        let backupSha: string | null = null;

        try {
          const r = await restoreExecute(workspacePath, targetSha);
          // Rust 侧失败通常走 Err（invoke 抛出），但 ok=false 是显式失败信号，
          // 同样必须按 git-failed 处理，不得继续截断对话。
          if (!r.ok) {
            return {
              ok: false,
              reason: 'git-failed',
              error: r.error ?? undefined,
            };
          }
          filesChanged = r.filesRestored;
          backupSha = r.backupSha ?? null;
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
        const nextCheckpoints: Record<string, { sha: string; sessionId: string }> = {};
        const removedCheckpoints: Record<string, { sha: string; sessionId: string }> = {};
        for (const [id, entry] of Object.entries(_messageCheckpoints)) {
          // 其他会话的锚点必须原样保留：重置只截断当前会话，旧实现把
          // 不在 keptIds 里的锚点全部移除，会连带销毁其他会话的回滚点。
          if (keptIds.has(id) || entry.sessionId !== activeSessionId) {
            nextCheckpoints[id] = entry;
          } else {
            removedCheckpoints[id] = entry;
          }
        }
        // 被截掉的 checkpoint 的 timeline 记录暂不删除：撤销（undoConversationReset）
        // 还要靠它们恢复锚点，删了的话撤销后一重启锚点就永久丢失。
        // 记录的删除推迟到撤销条目真正失效时（dismissRestoreUndo / 会话删除 /
        // 清空会话）。多级撤销栈下，栈中较早条目的记录同样保留。

        disposeAgentHandle(get);
        // surface 内存缓存失效：消息被截断，缓存的 surface 节点可能引用已删消息。
        if (activeSessionId && workspacePath) {
          forgetContextSurface(workspacePath, activeSessionId);
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
          _agentSessionId: null,
          _latestContextSnapshot: null,
          // N8：备份被截掉的尾部消息与 checkpoint 锚点，供撤销入口回放。
          // 入栈（栈顶=最近一次）：连续多次重置可逐级撤销。
          // backupSha：撤销时校验 BACKUP_REF 未被其它破坏性操作覆盖。
          _pendingRestoreUndos: pushRestoreUndo(get()._pendingRestoreUndos, {
            workspacePath,
            sessionId: activeSessionId,
            truncatedMessages: messages.slice(cutIndex),
            removedCheckpoints,
            filesRestored: true,
            backupSha,
          }),
        });

        get()._editHistory.clear();
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
        get().noteWorkspaceMutation();

        return {
          ok: true,
          codeReset: 'git',
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

      undoConversationReset: async (): Promise<UndoConversationResetResult> => {
        const stack = get()._pendingRestoreUndos;
        const pending = stack[stack.length - 1];
        if (!pending) {
          return { ok: false, message: 'nothing-to-undo' };
        }
        // 工作区已切换：撤销只对发起重置时的工作区有意义，拒绝跨工作区撤销。
        if (pending.workspacePath !== get().workspacePath) {
          return { ok: false, message: 'workspace-changed' };
        }

        // N8：代码回退撤销——把工作区文件恢复到重置前状态。仅当重置确实
        // 执行了文件回滚时才处理。优先走 restore_undo 并传入重置时拿到的
        // backupSha 校验（BACKUP_REF 被所有破坏性操作共用，若重置后又做过
        // 其它 git 操作，备份已被覆盖，Rust 侧会拒绝）。校验失败时降级为
        // restore_execute(backupSha)：备份提交是不可变的，直接 reset 到它
        // 仍是"恢复到重置前状态"的正确语义（且会先备份当前状态，可再撤销）。
        // 多级撤销栈中撤销较早条目时，BACKUP_REF 必然已被后续操作覆盖，
        // 降级路径是它们的唯一可行路径。
        if (pending.filesRestored) {
          try {
            await restoreUndo(pending.workspacePath, pending.backupSha);
          } catch (err) {
            if (pending.backupSha) {
              try {
                const r = await restoreExecute(pending.workspacePath, pending.backupSha);
                if (!r.ok) {
                  return { ok: false, message: r.error ?? 'restore failed' };
                }
              } catch (fallbackErr) {
                return {
                  ok: false,
                  message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
                };
              }
            } else {
              return {
                ok: false,
                message: err instanceof Error ? err.message : String(err),
              };
            }
          }
        }

        const { sessionId, truncatedMessages, removedCheckpoints } = pending;
        const sessionExists =
          sessionId !== null && get().sessions.some((s) => s.id === sessionId);
        if (sessionId && sessionExists && truncatedMessages.length > 0) {
          set((s) => {
            const current = s.sessionMessages[sessionId] ?? [];
            const existingIds = new Set(current.map((m) => m.id));
            // 重置后用户可能又发过消息：按 id 去重，只回放仍缺失的尾部消息。
            const restored = [
              ...current,
              ...truncatedMessages.filter((m) => !existingIds.has(m.id)),
            ];
            return {
              messages: s.activeSessionId === sessionId ? restored : s.messages,
              sessionMessages: { ...s.sessionMessages, [sessionId]: restored },
              _messageCheckpoints: {
                ...s._messageCheckpoints,
                ...removedCheckpoints,
              },
              _latestContextSnapshot: null,
            };
          });
        }

        // 上下文已变：失效 agent，下一条消息按恢复后的 sessionMessages 重建。
        invalidateAgentHandle(get, set);
        // surface 内存缓存失效：消息尾部被回放，缓存的 surface 节点可能已脱节。
        if (sessionId && sessionExists) {
          forgetContextSurface(pending.workspacePath, sessionId);
        }
        // 弹出栈顶：栈中仍有较早条目时，撤销入口继续显示下一级。
        set({ _pendingRestoreUndos: stack.slice(0, -1) });
        get().noteWorkspaceMutation();
        saveCurrentProjectState(get());
        return { ok: true };
      },

      dismissRestoreUndo: () => {
        // 用户放弃栈顶条目：被截掉的消息再也无法回放，此时才删除其 checkpoint
        // 的 timeline 记录（重置时延迟删除，保证撤销后重启锚点仍在）。
        const stack = get()._pendingRestoreUndos;
        const pending = stack[stack.length - 1];
        if (pending && Object.keys(pending.removedCheckpoints).length > 0) {
          for (const id of Object.keys(pending.removedCheckpoints)) {
            void deleteCheckpointByMessage(pending.workspacePath, id).catch(() => undefined);
          }
        }
        set({ _pendingRestoreUndos: stack.slice(0, -1) });
      },

      setPersistenceError: (message) => {
        set({ _persistenceError: message });
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
        const { _agent, isLoading, loadingSessionId } = get();

        // N5：goal 外循环的验证阶段没有在飞的 agent 请求（120s 验证命令 +
        // verifier 只读子代理在主线程独立执行），cancelSession 是空操作——停止
        // 按钮必须通过 goalStore 的 aborted 标志 + goalAbortController 让
        // GoalRunner / verifier 子代理感知中断（在飞的命令/子代理调用完成后
        // 立即停下；verifier 子代理中飞可通过 abort 信号直接取消）。
        useGoalStore.getState().abortGoal();

        if (!isLoading) return;

        // N11：agent 创建前的前置 await 阶段（MCP 发现/图缓存等，可达数十
        // 秒）没有在飞的 agent 请求可取消——记录停止请求序号，sendMessage
        // 的前置 await 检查到变化即抛 AbortError 终止回合。
        set({ _stopRequestedSeq: get()._stopRequestedSeq + 1 });

        if (_agent) {
          // 停止按钮只取消当前聊天回合：旧实现调用 cancel() 会连带
          // cancelAllAppAgents()，把独立的 papr app-agent 运行一并杀掉。
          _agent.cancelSession();

          // 失效 agent（N3）：取消的回合不会进入 agent 的 logStore（worker
          // 取消不提交 delta），复用旧实例会让下一条消息的上下文缺少被取消
          // 回合——UI 显示但模型看不到。必须与 isLoading 复位同步完成：复位
          // 后立刻发送的新消息不能撞上仍存活的旧 agent。
          invalidateAgentHandle(get, set);
        }

        set((s) => {
          const sessionId = loadingSessionId ?? s.activeSessionId;
          if (!sessionId) return { isLoading: false, loadingSessionId: null };

          const currentMessages = s.sessionMessages[sessionId] ?? s.messages;
          // 补上取消时刻的时间戳：与 sendMessage 的取消路径（accumulateTurnRuntime）
          // 保持同口径，保证按消息时间戳回溯运行时长时不丢这一段。
          // N10：同步把仍显示"执行中"的工具调用标记为已取消（晚到的 end
          // 事件会被丢弃，不清理的话琥珀色脉冲点永远常亮）。
          const nextMessages = currentMessages.map((message) => {
            const next = message.isStreaming
              ? { ...message, isStreaming: false, statusText: undefined, timestamp: Date.now() }
              : message;
            return finalizeCancelledToolInvocations(next);
          });

          return {
            isLoading: false,
            loadingSessionId: null,
            messages: sessionId === s.activeSessionId ? nextMessages : s.messages,
            sessionMessages: {
              ...s.sessionMessages,
              [sessionId]: nextMessages,
            },
          };
        });
        saveCurrentProjectState(get());
      },

      requestChatScrollToMessage: (messageId: string) => {
        if (!messageId) return;
        set((s) => ({
          _pendingChatJump: { messageId, seq: (s._pendingChatJump?.seq ?? 0) + 1 },
        }));
      },

      requestSelectWorkspaceFile: (path: string) => {
        const trimmed = path.trim();
        if (!trimmed) return;
        set({ _pendingSelectPath: trimmed });
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
