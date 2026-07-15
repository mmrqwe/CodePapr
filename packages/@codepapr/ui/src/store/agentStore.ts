import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toast } from './toastStore';
import {
  applySkillEnablement,
  BUILTIN_AGENTS,
  CommandDefinition,
  EditHistory,
  Serializer,
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
import { runProjectDiagnostics } from '../utils/projectDiagnostics';
import { loadAppSettings, saveAppSettings } from '../utils/appSettingsStorage';
import {
  gitCheckpointCreate,
  gitCheckpointEnsure,
  gitCheckpointReset,
} from '../utils/gitCheckpoint';
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
  consolidateMemoryContent,
  MEMORY_CONSOLIDATION_MAX_LINES,
  planMemoryConsolidation,
} from '../utils/memoryConsolidation';
import {
  accumulateCacheStats,
  buildExecutionContextSummary,
  collectExecutedTools,
} from '../utils/agentExecution';
import { restoreTodoListContexts } from '../tools/todoListTool';
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
import { addConversationStats, getSessionConversationStats } from './internals/stats';
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

function upsertRecentWorkspace(
  recent: WorkspaceEntry[],
  path: string,
): WorkspaceEntry[] {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return recent;
  }
  const name = normalizedPath.split(/[\\/]/).filter(Boolean).pop() ?? normalizedPath;
  const existingIndex = recent.findIndex(
    (entry) => entry.path === normalizedPath || entry.path === path.trim(),
  );
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
      _checkpointSeq: 0,
      _pendingMemoryConsolidation: false,

      loadSettings: async () => {
        let settings = get().settings;
        try {
          const storedSettings = await loadAppSettings();
          settings = normalizeSettings(storedSettings ?? get().settings);
          set({ settings, settingsLoaded: true, _agent: null, _agentModel: null, _agentPromptKey: null });

          // Only write back when there are real stored settings to migrate.
          // On first launch `storedSettings` is null; saving defaults here would
          // erase any API key that the backend just injected from the vault.
          if (storedSettings && Serializer.stringify(storedSettings) !== Serializer.stringify(settings)) {
            await saveAppSettings(settings);
          }
        } catch {
          settings = get().settings;
          set({ settingsLoaded: true, _agent: null, _agentModel: null, _agentPromptKey: null });
        }

        const recentWorkspaces = sortRecentWorkspaces(settings.recentWorkspaces);
        if (recentWorkspaces.length === 0) {
          return;
        }

        for (const entry of recentWorkspaces) {
          try {
            await get().openWorkspace(entry.path);
            return;
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
      _checkpointSeq: 0,
          };
        });
        if (path) {
          void get()._loadProjectConfig(path);
          void get()._ensureWorkspaceGitReady(path);
        }
      },

      openWorkspace: async (path) => {
        const snapshot = normalizeProjectSnapshot(await loadProjectState(path), {
          debugEnabled: get().settings.debugEnabled,
        });
        set({
          workspacePath: path,
          workspaceMutationVersion: 0,
          projectGraphLoading: false,
          projectGraphPhase: null,
          sessions: snapshot.sessions as SessionMeta[],
          activeSessionId: snapshot.activeSessionId,
          messages: snapshot.activeSessionId
            ? (snapshot.sessionMessages[snapshot.activeSessionId] as UIMessage[] | undefined) ?? []
            : [],
          sessionMessages: snapshot.sessionMessages as Record<string, UIMessage[]>,
          skillEnabledById: normalizeSkillEnabledState(snapshot.skillEnabledById),
          conversationStats: snapshot.activeSessionId
            ? getSessionConversationStats(snapshot.sessionConversationStats ?? {}, snapshot.activeSessionId)
            : createEmptyConversationStats(),
          sessionConversationStats: snapshot.sessionConversationStats ?? {},
          projectDiagnosticsReport: snapshot.projectDiagnosticsReport,
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
          _editHistory: new EditHistory(),
          _projectRulesSection: '',
          _skillDefinitions: [],
          _agentDefinitions: [...BUILTIN_AGENTS],
      _taskChecklists: {},
      _messageCheckpoints: { ...(snapshot.messageCheckpoints ?? {}) },
      _gitReady: false,
      _gitReadyError: null,
      _checkpointSeq: 0,
        });

        // 恢复持久化的 TodoList 上下文
        if (snapshot.sessionTodoLists) {
          restoreTodoListContexts(snapshot.sessionTodoLists as Record<string, unknown> as Record<string, import('@codepapr/types').TodoListContext>);
        }

        saveCurrentProjectState(get());
        await get()._loadProjectConfig(path);
        void get()._ensureWorkspaceGitReady(path);

        const normalizedPath = path.trim();
        const currentSettings = get().settings;
        if (get().settingsLoaded && normalizedPath) {
          const nextRecent = upsertRecentWorkspace(currentSettings.recentWorkspaces, normalizedPath);
          const nextSettings = normalizeSettings({
            ...currentSettings,
            recentWorkspaces: nextRecent,
          });
          set({ settings: nextSettings });
          void saveAppSettings(nextSettings).catch(() => undefined);
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
          set({ _gitReady: false, _gitReadyError: null });
          return;
        }
        try {
          const result = await gitCheckpointEnsure(path);
          // 仅当仍停留在同一工作区时写回，避免竞态。
          if (get().workspacePath !== path) return;
          set({
            _gitReady: result.ready,
            _gitReadyError: result.error,
          });
          // ensure 成功后从 git log 推断当前 checkpoint 最大序号，
          // 避免 App 重启或切换工作区后序号从 1 重新开始。
          if (result.ready) {
            try {
              const logResult = await invoke<{ stdout: string; status: number | null }>(
                'run_workspace_command',
                {
                  workspacePath: path,
                  command: 'git',
                  args: ['log', '--pretty=format:%s', '-n', '200'],
                  timeoutSeconds: 10,
                }
              );
              if (get().workspacePath !== path) return;
              if ((logResult.status ?? 1) === 0) {
                const subjects = (logResult.stdout ?? '')
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean);
                const next = nextCheckpointSequence(subjects);
                set({ _checkpointSeq: Math.max(0, next - 1) });
              }
            } catch {
              // 推断失败不影响功能，序号会从 0 开始
            }
          }
        } catch (err) {
          if (get().workspacePath !== path) return;
          set({
            _gitReady: false,
            _gitReadyError: err instanceof Error ? err.message : String(err),
          });
        }
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
          };
        });
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
      },

      clearMessages: () => {
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
        }));
        saveCurrentProjectState(get(), { purgeDeletedContent: true });
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
          const r = await gitCheckpointReset(workspacePath, targetSha);
          codeReset = 'git';
          filesChanged = r.filesChanged;
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
        for (const [id, sha] of Object.entries(_messageCheckpoints)) {
          if (keptIds.has(id)) {
            nextCheckpoints[id] = sha;
          }
        }

        set({
          messages: truncatedMessages,
          sessionMessages: activeSessionId
            ? { ...get().sessionMessages, [activeSessionId]: truncatedMessages }
            : get().sessionMessages,
          _messageCheckpoints: nextCheckpoints,
          _agent: null,
          _agentModel: null,
          _agentPromptKey: null,
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
          if (lower === 'undo' || lower === 'redo') {
            appendInfoMessage(
              set,
              '命令已移除。请直接让代理执行回滚，或在 Git 面板中做显式恢复/回退。'
            );
            return;
          }
          if (lower === 'help' || lower === 'commands') {
            const customCommands = await listCommandDefinitions(invoke, workspaceForSlash).catch(
              () => [] as CommandDefinition[]
            );
            appendInfoMessage(set, buildCommandHelpMessage(customCommands));
            return;
          }
          if (lower === 'compact') {
            const sessionMsgs = get().sessionMessages[get().activeSessionId ?? ''] ?? [];
            const checkpointResult = await maybeGenerateContextCheckpoint(
              normalizedSettings,
              sessionMsgs,
              true
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
                const nextMessages = [...sessionMsgs, checkpointResult.message];
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
              const pipeIndex = goalArgs.indexOf('|');
              goalUserText = pipeIndex > 0 ? goalArgs.slice(0, pipeIndex).trim() : '';
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
          // 自定义命令优先；找不到时使用内置提示模板。
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
        }

        const settingsError = getSettingsError(normalizedSettings);
        if (settingsError) {
          appendErrorMessage(set, settingsError);
          saveCurrentProjectState(get());
          return;
        }

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
            customPrompt: normalizedSettings.systemPrompt,
            lang: normalizedSettings.lang,
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
          const runtimeSessionBootstrapPrompt = buildAgentSessionBootstrapPrompt(
            normalizedSettings,
            workspacePath,
            skillDefinitions,
            projectGraphBootstrapSummary,
            memorySection
          );
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
          });
          let { _agent: agent, activeSessionId } = get();
          const { _agentModel: agentModel, _agentPromptKey: agentPromptKey } = get();
          const taskText = effectiveDisplay ?? effectiveInput;
          let accumulatedStats: ICacheStatistics | undefined;
          let accumulatedSubagentFast: ICacheStatistics | undefined;
          let accumulatedSubagentPrimary: ICacheStatistics | undefined;
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
                contextMessages = [...contextMessages, {
                  id: createId(),
                  role: 'assistant' as const,
                  workMode: mode,
                  content: `[Mode: ${mode.toUpperCase()}] You are now in ${mode} mode with full tool access. Previous ask-mode responses are for context only; use tools proactively for this task.`,
                  synthetic: true,
                  hidden: true,
                  carryForwardInContext: true,
                  timestamp: Date.now(),
                }];
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
              const cp = await gitCheckpointCreate(get().workspacePath, label);
              set((s) => ({
                _messageCheckpoints: { ...s._messageCheckpoints, [userMsg!.id]: cp.sha },
                _checkpointSeq: sequence,
              }));
            } catch {
              // checkpoint write failure doesn't block conversation
            }
          }

          let retryBaseMessages = [...(sessionMessages[activeSessionId!] ?? []), userMsg!];
          if (mode !== 'ask' && retryBaseMessages.some((m) => m.role === 'assistant' && m.workMode === 'ask')) {
            retryBaseMessages = [...retryBaseMessages, {
              id: createId(),
              role: 'assistant' as const,
              workMode: mode,
              content: `[Mode: ${mode.toUpperCase()}] You are now in ${mode} mode with full tool access. Previous ask-mode responses are for context only; use tools proactively for this task.`,
              synthetic: true,
              hidden: true,
              carryForwardInContext: true,
              timestamp: Date.now(),
            }];
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
                  const verifierResult = await runVerifier(transcript, conditionResult, goalCondition!.humanReadable, isSubjective, {
                    provider: verifierProvider,
                    providerName: verifierProviderName,
                    settings: normalizedSettings,
                    primaryModel: normalizedSettings.model,
                    fastModel: normalizedSettings.fastModel,
                    fastModelEnabled: normalizedSettings.fastModelEnabled,
                  });
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
                    true
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
                      const next = [
                        ...(s.sessionMessages[activeSessionId!] ?? []),
                        cp.message,
                      ];
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
              // eslint-disable-next-line no-console
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
            question: resp.question,
            isStreaming: false,
            timestamp: Date.now(),
          };
          const finalizedAssistantMsg: UIMessage = assistantMsg;
          const executedTools = collectExecutedTools(getAgentMessagesSince(agent, sessionLogStartIndex));
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
              tier: 'primary' | 'fast';
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
            get().sessionMessages[activeSessionId] ?? []
          );
          if (checkpointResult) {
            set((s) => {
              const currentSessionMessages = s.sessionMessages[activeSessionId!] ?? [];
              const nextSessionMessages = [...currentSessionMessages, checkpointResult.message];
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
              } catch {
                // Silent fail - don't disrupt the session
              }
            })();
          }
          saveCurrentProjectState(get());
        } catch (err) {
          // eslint-disable-next-line no-console
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
            set({ _agent: null });
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
