import { invoke } from '@tauri-apps/api/core';
import { toast } from '../toastStore';
import {
  type CommandDefinition,
  expandCommandTemplate,
  getBuiltinPromptCommand,
  parseSlashInput,
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
import { createId } from '../../utils/createId';
import { snapshotCreate, saveCheckpointRecord } from '../../utils/snapshot';
import { buildCheckpointCommitMessage } from '../../utils/workspaceGitPanel';
import type { WorkMode } from '../../utils/agentPrompts';
import { getTranslation } from '../../utils/i18n';
import { yieldToMainThread } from '../../utils/taskScheduling';
import {
  buildPrimaryModelRoute,
  selectTaskModelRoute,
} from '../../utils/modelRouting';
import {
  bootstrapMemoryContent,
  consolidateMemoryContent,
  MEMORY_CONSOLIDATION_MAX_LINES,
  planMemoryConsolidation,
} from '../../utils/memoryConsolidation';
import {
  accumulateCacheStats,
  buildExecutionContextSummary,
  collectExecutedTools,
  type ExecutedToolSummary,
} from '../../utils/agentExecution';
import { getTodoListContext } from '../../tools/todoListTool';
import { getActiveCharacterPrompt } from '../charactersStore';
import { loadMcpToolDefinitions } from '../../tools/mcpTools';
import {
  listCommandDefinitions,
  loadCommandDefinition,
  readWorkspaceTextFile,
  runWorkspaceInlineCommand,
} from '../../utils/projectConfigLoader';
import { WorkerCrashError } from '../../agent/WorkerBackedAgent';
import { delay, waitForPageVisible } from '../../utils/crashRecovery';
import { insertCheckpointAtRetainedBoundary } from '../../utils/contextCompaction';
import { runVerifier } from '../../utils/verifierRunner';
import { useGoalStore } from '../goalStore';
import type { CommandResult } from '../../tools/streamingWorkspaceCommand';

import { normalizeSettings, getSettingsError, resolveProviderName } from './settingsNormalizer';
import { addConversationStats, getSessionConversationStats } from './stats';
import { maybeApplySessionTitle, touchSession } from './persistence';
import { saveCurrentProjectState } from './projectSnapshot';
import {
  appendErrorMessage,
  appendInfoMessage,
  appendStreamingAssistantMessage,
  applyToolStreamEvent,
  cleanupStreamingAssistantMessage,
  mergeMessageText,
  updateAssistantMessage,
} from './messageMutators';
import { formatAgentError } from './errorFormatting';
import { buildCommandHelpMessage } from './commandHelp';
import { shouldFallbackToPrimaryModel } from './fallbackPolicy';
import {
  buildAgentRuntimeSystemPrompt,
  buildAgentRuntimeUserPrompt,
  buildAgentSessionBootstrapPrompt,
  buildProjectGraphBootstrapSummary,
} from './promptBuilders';
import {
  AgentRuntimeConfig,
  createAgent,
  createMainThreadAgent,
  getAgentMessagesSince,
} from './agentFactory';
import { buildProviderInstance } from './providerFactory';
import { maybeGenerateContextCheckpoint } from './contextCheckpoint';
import { handleWorkspaceMutation } from './backgroundDiagnostics';
import type {
  AgentActions,
  ConversationStats,
  StoreGet,
  StoreSet,
  UIMessage,
  UIToolInvocation,
} from './types';

// Worker 崩溃恢复链参数：先重建 Worker 重试（每次先等页面恢复可见，避开解冻
// 节流期），达到上限后降级主线程 Agent 把回合跑完——崩溃对用户永不表现为
// 「报错停止」。延迟递增，避免热循环。
const CRASH_RECOVERY_MAX_WORKER_RETRIES = 3;
const CRASH_RECOVERY_RETRY_DELAYS_MS = [200, 500, 1000];
const CRASH_RECOVERY_VISIBLE_WAIT_MS = 30_000;

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

export function createSendMessage(set: StoreSet, get: StoreGet): AgentActions['sendMessage'] {
  return async (input, displayContent, mode = 'agent', images) => {
        const { settings } = get();
        const normalizedSettings = normalizeSettings(settings);
        let assistantMessageId: string | null = null;
        let assistantStep = 1;
        let sessionLogStartIndex: number | null = null;
        let userMsg: UIMessage | null = null;
        // 本回合归属的会话（catch 中用于收尾，try 内的同名局部变量不在 catch 作用域）。
        let turnSessionId: string | null = null;

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
            // 以 await 前捕获的会话为准：压缩模型调用期间用户可能切换会话，
            // 压缩结果不得写入其它会话，也不得污染当前查看会话的视图。
            const compactSessionId = get().activeSessionId;
            const sessionMsgs = get().sessionMessages[compactSessionId ?? ''] ?? [];
            const checkpointResult = await maybeGenerateContextCheckpoint(
              normalizedSettings,
              sessionMsgs,
              true,
              currentTodoDigest(compactSessionId)
            );
            if (checkpointResult) {
              if (checkpointResult.cacheStats && compactSessionId) {
                const cpTier: 'primary' | 'fast' = checkpointResult.modelTier === 'primary' ? 'primary' : 'fast';
                set((s) => ({
                  conversationStats:
                    s.activeSessionId === compactSessionId
                      ? addConversationStats(s.conversationStats, cpTier, checkpointResult.cacheStats!)
                      : s.conversationStats,
                  sessionConversationStats: {
                    ...s.sessionConversationStats,
                    [compactSessionId]: addConversationStats(
                      getSessionConversationStats(s.sessionConversationStats, compactSessionId),
                      cpTier,
                      checkpointResult.cacheStats!
                    ),
                  },
                }));
              }
              if (compactSessionId) {
                set((s) => {
                  // 必须在 updater 内读最新消息：/compact 不置 isLoading，压缩
                  // 模型调用期间用户可继续发消息，用 await 前捕获的 sessionMsgs
                  // 写回会把 await 期间产生的消息整个覆盖丢失。insertIndex 由
                  // insertCheckpointAtRetainedBoundary 内部做 clamp。
                  const liveMessages = s.sessionMessages[compactSessionId] ?? [];
                  const nextMessages = insertCheckpointAtRetainedBoundary(
                    liveMessages,
                    checkpointResult.message,
                    checkpointResult.insertIndex
                  );
                  return {
                    messages: s.activeSessionId === compactSessionId ? nextMessages : s.messages,
                    sessionMessages: { ...s.sessionMessages, [compactSessionId]: nextMessages },
                  };
                });
              }
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
              // 以实际执行回合的会话为准（用户可能已切换到别的会话查看）。
              const sessionId = s.loadingSessionId ?? s.activeSessionId;
              if (!sessionId) return { isLoading: false, loadingSessionId: null };
              const currentMessages = s.sessionMessages[sessionId] ?? s.messages;
              const nextMessages = currentMessages.map((message) =>
                message.isStreaming
                  ? { ...message, isStreaming: false, statusText: undefined }
                  : message
              );
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
          turnSessionId = optimisticSid;
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
            const updatedSessions = touchSession(
              maybeApplySessionTitle(
                s.sessions, optimisticSid!, effectiveDisplay ?? effectiveInput,
                currentMsgs
              ),
              optimisticSid!,
              userMsg!.timestamp
            );
            return {
              sessions: updatedSessions,
              messages: next,
              sessionMessages: { ...s.sessionMessages, [optimisticSid!]: next },
              isLoading: true,
              loadingSessionId: optimisticSid,
            };
          });
          saveCurrentProjectState(get());
          armStoreIdle();

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
          const taskText = effectiveDisplay ?? effectiveInput;
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
          const runtimeSystemPrompt = buildAgentRuntimeSystemPrompt(
            normalizedSettings,
            mode,
            workspacePath,
            rulesSection,
            {
              agentDefinitions: get()._agentDefinitions,
              model: route.model,
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
            turnSessionId,
            bootstrapSignature,
            () =>
              buildAgentSessionBootstrapPrompt(
                normalizedSettings,
                workspacePath,
                skillDefinitions,
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
            todoDigest: currentTodoDigest(optimisticSid),
          });
          let { _agent: agent } = get();
          // 本回合归属会话以 optimistic 阶段捕获的 turnSessionId 为准。上方多个
          // await（project-graph / memory / MCP 发现）期间用户可能已切换会话，
          // 此处若重读 get().activeSessionId 会把回合执行到新会话：用户消息留在
          // 旧会话、助手回复却写进新会话，且 agent 上下文不含本条输入。
          let activeSessionId: string | null = turnSessionId;
          const { _agentModel: agentModel, _agentPromptKey: agentPromptKey } = get();
          let accumulatedStats: ICacheStatistics | undefined;
          let accumulatedSubagentFast: ICacheStatistics | undefined;
          let accumulatedSubagentPrimary: ICacheStatistics | undefined;
          let accumulatedSubagentMentor: ICacheStatistics | undefined;
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
          // 已崩溃的 agent（worker 死亡）绝不复用：直接重建，避免向死 worker 发消息。
          // agent 与创建它的会话绑定（logStore/上下文），切换会话后绝不复用，
          // 否则会把新会话的消息写进旧会话的上下文。
          const agentSessionId = get()._agentSessionId;
          if (!agent || agent.isCrashed() || (agentSessionId !== null && agentSessionId !== activeSessionId) || agentModel !== route.model || (agentPromptKey !== null && agentPromptKey !== runtimePromptKey)) {
            if (agent) {
              try {
                // 单执行模型下此刻 agent 对聊天必然空闲（执行中禁止发送），
                // 但它可能还在跑 app-agent（papr.agent.run，不占 isLoading）：
                // 那种情况立即 destroy 会杀掉在飞的 app 执行，改为 detach 后
                // 等 app-agent 结算完自我销毁。
                if (agent.hasActiveAppAgentRequests?.()) {
                  agent.detachAndCleanupWhenIdle?.();
                } else {
                  agent.destroy();
                }
              } catch {
                // already torn down
              }
            }
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
              set({ _agent: agent, _agentModel: route.model, _agentPromptKey: runtimePromptKey, _agentSessionId: activeSessionId });
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
                set({ _agent: agent, _agentModel: route.model, _agentPromptKey: runtimePromptKey, _agentSessionId: activeSessionId });
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
                messages: s.activeSessionId === activeSessionId ? updated : s.messages,
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
                    messages: s.activeSessionId === activeSessionId ? nextMessages : s.messages,
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

          // 本回合是否已降级到主线程 Agent（回合结束后清空 _agent，下条消息重建 Worker）。
          let mainThreadFallbackUsed = false;

          const resetStreamingForRetry = () => {
            if (!assistantMessageId) return;
            updateAssistantMessage(set, activeSessionId, assistantMessageId, (message) => ({
              ...message,
              content: '',
              reasoningContent: '',
              displayReasoningContent: undefined,
              toolInvocations: undefined,
              isStreaming: true,
              statusText: getTranslation(normalizedSettings.lang).streamingStatus,
            }));
          };

          const rebuildAgentForRetry = (useMainThread: boolean) => {
            agent = useMainThread
              ? createMainThreadAgent(
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
                )
              : createAgent(
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
            set({ _agent: agent, _agentModel: route.model, _agentPromptKey: runtimePromptKey, _agentSessionId: activeSessionId });
          };

          /**
           * 崩溃恢复执行器：Worker 崩溃绝不向用户表现为「报错停止」。
           * 链：重建 Worker 重试（≤3 次，每次先等页面可见 + 递增延迟）→
           * 仍崩则降级主线程 Agent 跑完本回合 → 仅当主线程也失败才向上抛
           * （此时已是常规错误，非 Worker 崩溃）。AbortError（用户取消）立即终止。
           * 崩溃发生前主日志未收到本轮 delta（result 才落日志），重试无损。
           */
          const runWithCrashRecovery = async (
            passInput: string,
            passImages?: import('@codepapr/types').IImageContent[],
            onPassStart?: (logLength: number) => void,
          ): Promise<IAgentResponse> => {
            // 崩溃恢复可能已重建 agent（新 log 长度与旧 agent 不同）：每次
            // 真正执行前上报「即将执行」agent 的 log 坐标，调用方（Goal 循环
            // 的转录切片）必须用它，而不是重建前的旧坐标。
            const runPass = async (): Promise<IAgentResponse> => {
              if (onPassStart && typeof agent?.getSession === 'function') {
                onPassStart(agent.getSession().logStore.length());
              }
              return runAgentPass(passInput, passImages);
            };

            try {
              return await runPass();
            } catch (error) {
              if (!(error instanceof WorkerCrashError)) throw error;
            }

            for (let attempt = 1; attempt <= CRASH_RECOVERY_MAX_WORKER_RETRIES; attempt++) {
              await waitForPageVisible(CRASH_RECOVERY_VISIBLE_WAIT_MS);
              await delay(CRASH_RECOVERY_RETRY_DELAYS_MS[attempt - 1] ?? 1000);
              rebuildAgentForRetry(false);
              resetStreamingForRetry();
              await yieldToMainThread();
              try {
                return await runPass();
              } catch (retryError) {
                if (!(retryError instanceof WorkerCrashError)) throw retryError;
              }
            }

            // Worker 重建反复崩溃：降级主线程 Agent 兜底（无 Worker 即无
            // 「Worker 被杀」失败模式），保证本回合有结果。
            await waitForPageVisible(CRASH_RECOVERY_VISIBLE_WAIT_MS);
            rebuildAgentForRetry(true);
            mainThreadFallbackUsed = true;
            resetStreamingForRetry();
            await yieldToMainThread();
            return await runPass();
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
                        messages: s.activeSessionId === activeSessionId ? next : s.messages,
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

                  let turnStartIndex = sessionLogStartIndex;
                  // Goal 回合同样接入崩溃恢复链：Worker 崩溃透明重建/降级，
                  // 不再让 Goal 循环因崩溃中断。onPassStart 回调保证崩溃重建后
                  // 用新 agent 的 log 坐标切片转录（旧坐标会切出错误内容）。
                  const response = await runWithCrashRecovery(turnPrompt, undefined, (logLength) => {
                    turnStartIndex = logLength;
                  });
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
                        messages: s.activeSessionId === activeSessionId ? next : s.messages,
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
            resp = await runWithCrashRecovery(runtimeUserPrompt, images);
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              throw error;
            }
            if (!shouldFallbackToPrimaryModel(error, route, normalizedSettings)) {
              throw error;
            }

            // fast 模型提供方错误降级主模型（与崩溃恢复正交：崩溃已在
            // runWithCrashRecovery 内重建/降级处理，不会走到这里）。
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
            set({ _agent: agent, _agentModel: route.model, _agentPromptKey: runtimePromptKey, _agentSessionId: activeSessionId });

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
            resp = await runWithCrashRecovery(runtimeUserPrompt, images);
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
            // 回合进行中会话可能已不存在（关闭工作区/删除会话）：此时不再写
            // 消息，避免在 sessionMessages 里复活一个 sessions 中已没有的孤儿
            // 条目；只复位 loading 状态。
            if (!s.sessions.some((x) => x.id === activeSessionId)) {
              return { isLoading: false, loadingSessionId: null };
            }
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
              messages: s.activeSessionId === activeSessionId ? persistedMessages : s.messages,
              sessionMessages: {
                ...s.sessionMessages,
                [activeSessionId!]: persistedMessages,
              },
              isLoading: false,
              loadingSessionId: null,
              // conversationStats 是「当前查看会话」的视图：回合归属会话已不是
              // 当前会话时只更新 per-session 账本，不污染当前视图。
              conversationStats:
                s.activeSessionId === activeSessionId
                  ? applyTierDeltas(s.conversationStats)
                  : s.conversationStats,
              sessionConversationStats: {
                ...s.sessionConversationStats,
                [activeSessionId!]: applyTierDeltas(
                  getSessionConversationStats(s.sessionConversationStats, activeSessionId!)
                ),
              },
            };
          });
          if (mainThreadFallbackUsed) {
            // 主线程 Agent 只是崩溃兜底的应急替代：清空它，让下一条消息重建
            // Worker 运行时回到常态（若随后产生检查点，下面会以 Worker 重建）。
            set({ _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null });
          }
          const checkpointResult = await maybeGenerateContextCheckpoint(
            normalizedSettings,
            get().sessionMessages[activeSessionId] ?? [],
            undefined,
            currentTodoDigest(activeSessionId)
          );
          if (checkpointResult && (get().isLoading || get().loadingSessionId !== null)) {
            // 检查点模型调用 await 期间 isLoading 已置 false，用户可能已发出新
            // 回合（T2），T2 正运行在同一个 agent 上。此时应用检查点会换掉并
            // destroy T2 正在使用的 agent（destroy 会让 T2 的 chat() 被拒）。
            // 整个检查点直接丢弃（T2 回合结束时会重新评估），绝不触碰运行中
            // 的 agent。
          } else if (checkpointResult) {
            const prevAgent = get()._agent;
            const prevAgentOwner = get()._agentSessionId;
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
                // 检查点压缩了上下文：旧 agent 的 logStore 已失效。用户仍在查看
                // 则就地重建；否则置空（下次发送按 sessionMessages 重建），
                // 绝不保留带旧上下文的 agent。
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
                    : null,
                _agentModel: isCurrentSession ? route.model : null,
                _agentPromptKey: isCurrentSession ? runtimePromptKey : null,
                _agentSessionId: isCurrentSession ? activeSessionId : null,
                conversationStats:
                  checkpointResult.cacheStats && isCurrentSession
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
            // 被替换/失效的旧 agent 已空闲（回合结束），销毁以回收 worker；
            // 仅当它仍属于本回合会话时才销毁，避免误伤竞态下新建的 agent。
            if (prevAgent && prevAgentOwner === activeSessionId && get()._agent !== prevAgent) {
              try {
                prevAgent.destroy();
              } catch {
                // already torn down
              }
            }
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
          // 以本回合捕获的会话为准收尾（用户可能已切换到别的会话）。
          const sid = turnSessionId ?? get().activeSessionId;
          if (err instanceof DOMException && err.name === 'AbortError') {
            // 取消若源于 worker 已死（cancel 超时判崩），必须同时清空 agent，
            // 否则下一条消息会复用死 agent，抛出笼统的「worker has crashed」。
            if (get()._agent?.isCrashed()) {
              set({ _agent: null, _agentSessionId: null, isLoading: false, loadingSessionId: null });
            } else {
              set({ isLoading: false, loadingSessionId: null });
            }
            if (assistantMessageId && sid) {
              cleanupStreamingAssistantMessage(set, sid, assistantMessageId);
            }
            saveCurrentProjectState(get());
            return;
          }

          // Worker crash: null out the agent so a fresh one is created on retry.
          const isWorkerCrash = err instanceof WorkerCrashError;
          if (isWorkerCrash) {
            set({ _agent: null, _agentSessionId: null, isLoading: false, loadingSessionId: null });
          } else {
            set({ isLoading: false, loadingSessionId: null });
          }

          if (assistantMessageId && sid) {
            cleanupStreamingAssistantMessage(set, sid, assistantMessageId);
          }
          const crashPrefix = isWorkerCrash
            ? (normalizedSettings.lang === 'en'
              ? 'Agent worker crashed. '
              : normalizedSettings.lang === 'zh-TW'
                ? 'Agent Worker 崩潰。'
                : 'Agent Worker 崩溃。')
            : '';
          appendErrorMessage(set, crashPrefix + formatAgentError(err, normalizedSettings.lang ?? 'zh-CN'), sid);
          saveCurrentProjectState(get());
        } finally {
          clearStoreIdle();
          void (async () => {
            try {
              await invoke('close_browser_page', { workspacePath: get().workspacePath });
            } catch {
              // no-op: browser may not have been opened this turn
            }
          })();
        }
  };
}
