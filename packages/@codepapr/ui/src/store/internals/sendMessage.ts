import { errorMessage } from '@codepapr/common';
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
import { isLegacyReasoningPlaceholder } from '@codepapr/api';
import {
  listCommandDefinitions,
  loadCommandDefinition,
  readWorkspaceTextFile,
  runWorkspaceInlineCommand,
} from '../../utils/projectConfigLoader';
import { AgentDestroyedError, WorkerCrashError, type AgentRuntimeHandle } from '../../agent/WorkerBackedAgent';
import { isPermissionWaitActive } from '../permissionStore';
import { delay, waitForPageVisible } from '../../utils/crashRecovery';
import { insertCheckpointAtRetainedBoundary } from '../../utils/contextCompaction';
import { loadSessionMessages, waitForPendingProjectStateSave } from '../../utils/projectStorage';
import { runVerifier } from '../../utils/verifierRunner';
import { useGoalStore } from '../goalStore';
import type { CommandResult } from '../../tools/streamingWorkspaceCommand';

import { normalizeSettings, getSettingsError, resolveProviderName } from './settingsNormalizer';
import { addConversationRuntime, addConversationStats, getSessionConversationStats } from './stats';
import { maybeApplySessionTitle, touchSession } from './persistence';
import { saveCurrentProjectState } from './projectSnapshot';
import {
  appendErrorMessage,
  appendInfoMessage,
  appendStreamingAssistantMessage,
  applyToolStreamEvent,
  cleanupStreamingAssistantMessage,
  finalizeCancelledToolInvocations,
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

/** 重试状态里的次数展示：流层默认无限重试时 maxRetries 缺省，只显示已试次数。 */
function formatRetryCounter(attempt: number, maxRetries?: number): string {
  return maxRetries === undefined ? `${attempt}` : `${attempt}/${maxRetries}`;
}

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

/** 读取 .CodePapr/memory.md 内容（trim 后）；不存在/读取失败返回 undefined。
 *  供 bootstrap/consolidation 写前重读：它们的读-改-写窗口横跨整个模型调用，
 *  期间 agent 的写入必须通过「写前比对」保护，不能被整文件覆盖（#14）。 */
async function readMemoryFile(workspacePath: string): Promise<string | undefined> {
  try {
    const memResult = await invoke<{ content: string }>('read_text_file', {
      workspacePath,
      relativePath: '.CodePapr/memory.md',
      maxBytes: 50_000,
    });
    return memResult.content?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** checkpoint 计划基于 base 消息数组计算（压缩模型调用期间 isLoading=false，
 *  用户可能 reset/清空/追加消息）。应用前校验当前数组是否仍是安全的插入基座：
 *  允许追加（长度增长且 insertIndex 之前的内容一致）；禁止删除/重排——旧
 *  insertIndex 落到末尾会让已删除内容以摘要形式复活（#15）。 */
export function isSafeCheckpointInsert(
  base: readonly UIMessage[] | undefined,
  current: readonly UIMessage[] | undefined,
  insertIndex: number
): boolean {
  if (base === current) return true;
  if (!base || !current) return false;
  if (current.length < base.length) return false;
  const checkLen = Math.min(Math.max(insertIndex, 0), base.length);
  for (let i = 0; i < checkLen; i += 1) {
    if (current[i] !== base[i]) return false;
  }
  return true;
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
// 有界缓存：每个条目是一整份 bootstrap 字符串（memory.md + skills + prompts），
// 随会话数无限增长会长期占用内存。超过上限时按最旧（Map 插入序）逐出；
// 被逐出的会话下次需要时只是重算一次，无正确性影响。
const SESSION_BOOTSTRAP_CACHE_MAX = 64;

function evictSessionBootstrapCache(): void {
  while (sessionBootstrapCache.size > SESSION_BOOTSTRAP_CACHE_MAX) {
    const oldest = sessionBootstrapCache.keys().next().value;
    if (oldest === undefined) break;
    sessionBootstrapCache.delete(oldest);
  }
}

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
  evictSessionBootstrapCache();
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

/** N6：空闲看门狗不得误杀两类合法等待：
 *  1. 权限确认弹窗——permissionStore 设计为无限期等待用户决策（与 worker 层
 *     的「权限等待不限时」一致），弹窗停留超过看门狗阈值时必须推迟触发；
 *  2. 静默长工具执行——无流事件输出的工具由工具自身的 IPC 超时兜底
 *     （toolIpcTimeoutMs / graph / task），看门狗在工具在飞时必须推迟触发。
 *  两者在飞时返回 true，调用方应重新武装看门狗而不是强制恢复。 */
export function shouldDeferIdleWatchdog(
  agent: Pick<AgentRuntimeHandle, 'hasInflightToolExecutions'> | null | undefined,
): boolean {
  if (isPermissionWaitActive()) return true;
  if (agent?.hasInflightToolExecutions?.()) return true;
  return false;
}

/** 失效并回收当前 agent（app-agent 在飞时改为结算后自毁，不连带杀掉）。
 *  同步置空 _agent 等字段：取消/出错的回合不会进入 agent 的 logStore
 *  （worker 取消/出错不提交 delta），复用旧实例会让下一条消息的上下文
 *  缺少被取消/失败的回合——UI 显示但模型看不到（N3 失忆）。置空后下一条
 *  消息按 sessionMessages 全量重建，上下文与 UI 一致。 */
export function invalidateAgentHandle(get: StoreGet, set: StoreSet): void {
  const stale = get()._agent;
  if (!stale) return;
  set({ _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null });
  try {
    if (stale.hasActiveAppAgentRequests?.()) {
      stale.detachAndCleanupWhenIdle?.();
    } else {
      stale.destroy();
    }
  } catch {
    // already torn down
  }
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
        // 本回合的序号（catch 中判断是否仍是当前回合，同 turnSessionId 需在 try 外声明）。
        let turnSeq = 0;
        // 回合启动时的工作区路径（finally 中关闭浏览器页面用：切工作区后
        // 页面仍属于回合启动时的工作区）。
        let turnWorkspacePath = '';
        // N11：捕获启动时的停止请求序号。cancelMessage 在前置 await 阶段
        // （agent 创建前）无法取消任何在飞请求，只能递增该序号；本回合在
        // 每个前置 await 之后检查序号变化即终止。
        const stopSeqAtStart = get()._stopRequestedSeq;

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
                let compactApplied = false;
                set((s) => {
                  // 必须在 updater 内读最新消息：/compact 不置 isLoading，压缩
                  // 模型调用期间用户可继续发消息，用 await 前捕获的 sessionMsgs
                  // 写回会把 await 期间产生的消息整个覆盖丢失。insertIndex 由
                  // insertCheckpointAtRetainedBoundary 内部做 clamp。
                  const liveMessages = s.sessionMessages[compactSessionId] ?? [];
                  // #15：压缩模型调用期间用户可能 reset/清空——校验插入基座，
                  // 已删除内容不得以摘要形式复活（此时整个 checkpoint 丢弃，
                  // 也不失效 agent）。
                  if (!isSafeCheckpointInsert(sessionMsgs, liveMessages, checkpointResult.insertIndex)) {
                    return {};
                  }
                  compactApplied = true;
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

                // ⚠️ 修复：压缩后必须让下一回合真正使用压缩后的上下文。
                // 旧实现只往视图插入 checkpoint 消息，_agent 原样复用（全量历史
                // 照发），"已节省 X KB" 是假提示。无回合在飞时销毁/失效旧 agent，
                // 下一条消息按压缩后的 sessionMessages 重建（与回合后 checkpoint
                // 路径一致）；回合在飞时留给回合后的自动压缩处理，绝不触碰运行中
                // 的 agent（destroy 会让在飞回合的 chat() 被拒）。
                if (compactApplied) {
                  const compactAgent = get()._agent;
                  const compactAgentOwner = get()._agentSessionId;
                  const compactTurnInFlight =
                    get().isLoading && get().loadingSessionId === compactSessionId;
                  if (compactAgent && compactAgentOwner === compactSessionId && !compactTurnInFlight) {
                    try {
                      // 可能在跑 app-agent（papr.agent.run，不占 isLoading）：
                      // 有在飞 app 执行时 detach 等其结算完自我销毁。
                      if (compactAgent.hasActiveAppAgentRequests?.()) {
                        compactAgent.detachAndCleanupWhenIdle?.();
                      } else {
                        compactAgent.destroy();
                      }
                    } catch {
                      // already torn down
                    }
                    set({ _agent: null, _agentModel: null, _agentPromptKey: null, _agentSessionId: null });
                  }
                }
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
                : `Goal 条件解析失败: ${errorMessage(err)}`;
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
            // N6：权限确认弹窗等待不限时 + 静默长工具由工具自身 IPC 超时
            // 兜底——两者在飞时看门狗必须推迟触发（重新武装），不能强制
            // 恢复误杀回合（与 worker 层 idle backstop 的暂停语义对齐）。
            if (shouldDeferIdleWatchdog(get()._agent)) {
              console.warn(
                '[sendMessage] idle watchdog: legitimate wait in flight (permission dialog or tool execution); deferring'
              );
              armStoreIdle();
              return;
            }
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
            // 与 cancelMessage 同口径：看门狗取消的回合同样不会进入 logStore，
            // 必须同步失效 agent，避免下一条消息复用缺上下文的旧实例（N3）。
            if (get()._agent) {
              invalidateAgentHandle(get, set);
            }
            set((s) => {
              // 以实际执行回合的会话为准（用户可能已切换到别的会话查看）。
              const sessionId = s.loadingSessionId ?? s.activeSessionId;
              if (!sessionId) return { isLoading: false, loadingSessionId: null };
              const currentMessages = s.sessionMessages[sessionId] ?? s.messages;
              const nextMessages = currentMessages.map((message) =>
                // N10：与 cancelMessage 同口径，收尾时清理"执行中"的工具调用
                finalizeCancelledToolInvocations(
                  message.isStreaming
                    ? { ...message, isStreaming: false, statusText: undefined }
                    : message
                )
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

        // 累计本回合 Agent 实际执行时长（墙钟）：用户发送时刻 → 回合收尾时刻。
        // 正常结束在 finalize 的 set() 中与 tier 统计一并累加；取消/出错/Goal
        // 循环异常等提前收尾路径走这里。
        const accumulateTurnRuntime = (sessionId: string | null): void => {
          if (!sessionId || !userMsg) return;
          const runtimeMs = Date.now() - userMsg.timestamp;
          if (!Number.isFinite(runtimeMs) || runtimeMs <= 0) return;
          set((s) => {
            if (!s.sessions.some((x) => x.id === sessionId)) return {};
            const next = addConversationRuntime(
              getSessionConversationStats(s.sessionConversationStats, sessionId),
              runtimeMs
            );
            return {
              conversationStats:
                s.activeSessionId === sessionId ? next : s.conversationStats,
              sessionConversationStats: {
                ...s.sessionConversationStats,
                [sessionId]: next,
              },
            };
          });
        };

        try {
          const { workspacePath, sessionMessages } = get();
          turnWorkspacePath = workspacePath;

          // 回合序号：异步收尾（取消/崩溃 catch）用它判断自己是否仍是当前回合，
          // 避免旧回合的收尾踩掉新回合的 isLoading（单执行模型）。
          turnSeq = get()._turnSeq + 1;
          set({ _turnSeq: turnSeq });

          // N11：前置 await 阶段（agent 创建前）的停止检查器——cancelMessage
          // 在此阶段没有在飞的 agent 请求可取消，只能递增 _stopRequestedSeq；
          // 本回合在每次前置 await 之后检查序号变化即抛 AbortError 终止。
          const ensureNotStopped = () => {
            if (get()._stopRequestedSeq !== stopSeqAtStart) {
              throw new DOMException('Turn was cancelled before the agent started', 'AbortError');
            }
          };
          ensureNotStopped();

          // ── 消息加载失败守卫 ──
          // 该会话的消息此前从 DB 读取失败（内存中是空视图）。若直接在空视图上
          // 追加并保存，全量替换语义会把 DB 里该会话的历史消息全部抹掉。
          // 先尝试重载：成功则恢复视图，仍失败则拒绝发送并提示用户。
          const guardSid = get().activeSessionId;
          if (guardSid && workspacePath && get()._messageLoadFailedSessions?.[guardSid]) {
            try {
              // 读前排空挂起保存队列，避免重载读到旧数据（与 openWorkspace 对齐）。
              await waitForPendingProjectStateSave(workspacePath);
              ensureNotStopped();
              const reloaded = (await loadSessionMessages(
                workspacePath,
                guardSid
              )) as unknown as UIMessage[];
              set((s) => ({
                messages: s.activeSessionId === guardSid ? reloaded : s.messages,
                sessionMessages: { ...s.sessionMessages, [guardSid]: reloaded },
                _messageLoadFailedSessions: {
                  ...s._messageLoadFailedSessions,
                  [guardSid]: false,
                },
              }));
            } catch (reloadErr) {
              // N11：停止请求（前置 await 阶段）必须原样向上传播，不得被当作
              // 重载失败吞掉（否则停止无效且弹错误提示）。
              if (reloadErr instanceof DOMException && reloadErr.name === 'AbortError') {
                throw reloadErr;
              }
              console.error('[CodePapr] 会话消息重载失败，拒绝发送以防覆盖历史:', reloadErr);
              appendInfoMessage(
                set,
                '会话历史加载失败，为避免覆盖已有消息已暂停发送。请重新打开项目或切换会话后重试。'
              );
              return;
            }
          }

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
            ensureNotStopped();
            if (cachedRaw) {
              const cacheData = JSON.parse(cachedRaw);
              if (cacheData?.projectGraph) {
                projectGraphBootstrapSummary = buildProjectGraphBootstrapSummary(cacheData.projectGraph);
              }
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') throw err;
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
            ensureNotStopped();
            memorySection = memoryResult.content?.trim();
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') throw err;
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
                    // #14：生成（读-改-写）窗口横跨整个模型调用，期间 agent
                    // 可能已通过 write 工具写入 memory.md（原为空/缺失才触发
                    // bootstrap）。写前重读：已有内容则放弃本次覆盖，绝不
                    // 整文件覆盖丢失 agent 写入。
                    const current = await readMemoryFile(workspacePath);
                    if (current) {
                      console.warn('[memory] bootstrap skipped: memory.md was written during generation');
                      return;
                    }
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
              ensureNotStopped();
              mcpToolDefinitions = loadedMcpTools.definitions;
              mcpToolMappings = loadedMcpTools.toolMappings;
              if (loadedMcpTools.errors.length > 0) {
                console.warn('[MCP] Some MCP servers failed during tool discovery:', loadedMcpTools.errors);
                const names = loadedMcpTools.errors.map((e) => e.serverId).join(', ');
                toast.warning(`MCP 初始化失败 (${loadedMcpTools.errors.length}): ${names}`, { durationMs: 8000 });
              }
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') throw err;
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
              ensureNotStopped();
              if (cp) {
                set((s) => ({
                  _messageCheckpoints: {
                    ...s._messageCheckpoints,
                    [userMsg!.id]: { sha: cp.sha, sessionId: activeSessionId! },
                  },
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
                ).catch((err) => {
                  // 快照已落库但 checkpoint 锚点记录失败：内存 map 仍持有锚点，
                  // 但重启后 timeline 会丢失该回滚点——不可静默。
                  const msg = `checkpoint 记录保存失败：${err instanceof Error ? err.message : String(err)}`;
                  console.warn('[CodePapr]', msg);
                  set({ _persistenceError: msg });
                  toast.warning(msg);
                });
              } else {
                // Empty/new workspace (or all files ignored): nothing to snapshot.
                // Benign skip — do not surface a "snapshot failed" banner. (The
                // Rust side still logs "0 files to snapshot" to stderr for debug.)
              }
            } catch (err) {
              // N11：停止请求必须向上传播，不得被当作 checkpoint 失败吞掉。
              if (err instanceof DOMException && err.name === 'AbortError') {
                throw err;
              }
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
                  // provider 已把旧占位符回声从 event.reasoningContent 过滤为
                  // undefined，但流式 reasoning-delta 可能已把同一段文本累积进
                  // 消息；合并结果若恰为旧占位符则整体丢弃，避免渲染/持久化。
                  const mergedReasoning = mergeMessageText(
                    message.reasoningContent,
                    event.reasoningContent
                  );
                  return {
                    ...message,
                    content: mergeMessageText(message.content, event.content) ?? '',
                    reasoningContent: isLegacyReasoningPlaceholder(mergedReasoning)
                      ? undefined
                      : mergedReasoning,
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

                if (event.type === 'stream-restart') {
                  // 流中断后整段重试：上一轮已推送的增量作废，必须先清空，
                  // 否则新一轮增量会与之重复拼接（LLM 流无法断点续传）。
                  // maxRetries 缺省 = 无限重试，状态只显示已重试次数。
                  return {
                    ...message,
                    content: '',
                    reasoningContent: undefined,
                    displayReasoningContent: undefined,
                    isStreaming: true,
                    statusText: `${getTranslation(normalizedSettings.lang).reconnectingStatus} (${formatRetryCounter(event.attempt, event.maxRetries)})…`,
                  };
                }

                if (event.type === 'request-retry') {
                  // 连接层失败重试：请求尚未建立流，无任何输出可作废，
                  // 仅更新状态提示让重试过程可见。
                  return {
                    ...message,
                    isStreaming: true,
                    statusText: `${getTranslation(normalizedSettings.lang).reconnectingStatus} (${formatRetryCounter(event.attempt, event.maxRetries)})…`,
                  };
                }

                if (event.type === 'round-retry') {
                  // 回合级重试（输出截断续写 / 空完成重试）：已输出内容保留，
                  // 仅更新状态提示让自动恢复过程可见。
                  const translation = getTranslation(normalizedSettings.lang);
                  const base =
                    event.reason === 'length-continue'
                      ? translation.continuingOutputStatus
                      : translation.emptyResponseRetryStatus;
                  return {
                    ...message,
                    isStreaming: true,
                    statusText: `${base} (${event.attempt})…`,
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
                  let response: IAgentResponse;
                  try {
                    response = await runWithCrashRecovery(turnPrompt, undefined, (logLength) => {
                      turnStartIndex = logLength;
                    });
                  } catch (err) {
                    // agent 被销毁（切会话/新建/改设置）：GoalRunner 把它当
                    // 用户中断静默停止（AbortError → interrupted），绝不在
                    // 循环里重建重跑整个回合。
                    if (err instanceof AgentDestroyedError) {
                      throw new DOMException('已取消', 'AbortError');
                    }
                    throw err;
                  }
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
                  // N5：验证命令结束后用户可能已点停止——跳过 verifier LLM
                  // 调用（不可中止），GoalRunner 收到 AbortError 立即中断。
                  if (useGoalStore.getState().isAborted()) {
                    throw new DOMException('Goal aborted', 'AbortError');
                  }
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
                    } else if (verifierResult.tier === 'mentor') {
                      accumulatedSubagentMentor = accumulateCacheStats(
                        accumulatedSubagentMentor,
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
                      // N5：验证命令（最长 120s）不可中止，但命令之间必须
                      // 检查 aborted 标志——用户在验证阶段点停止后，剩余的
                      // 验证子句不再执行，GoalRunner 收到 AbortError 立即中断。
                      if (useGoalStore.getState().isAborted()) {
                        throw new DOMException('Goal aborted', 'AbortError');
                      }
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
                  const compactionBaseMessages =
                    get().sessionMessages[activeSessionId!] ?? [];
                  const cp = await maybeGenerateContextCheckpoint(
                    normalizedSettings,
                    compactionBaseMessages,
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
                      // #15：压缩模型调用期间消息可能已被 reset/清空——校验
                      // 插入基座，已删除内容不得以摘要形式复活。
                      if (!isSafeCheckpointInsert(compactionBaseMessages, s.sessionMessages[activeSessionId!] ?? [], cp.insertIndex)) {
                        return {};
                      }
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
              accumulateTurnRuntime(activeSessionId);
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

          // 本回合 Agent 实际执行时长（墙钟）：与 finalize 时间戳同一时刻取值，
          // 保证与消息时间戳推算口径一致。
          const turnRuntimeMs = userMsg ? Date.now() - userMsg.timestamp : 0;

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
              addConversationRuntime(
                tierDeltas.reduce(
                  (acc, delta) =>
                    addConversationStats(acc, delta.tier, delta.stats, delta.incrementRounds ? { incrementRounds: true } : undefined),
                  base,
                ),
                turnRuntimeMs,
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
          // #15：checkpoint 计划基于该数组计算；压缩模型调用期间用户可能
          // reset/清空/追加消息，应用前必须校验（见 isSafeCheckpointInsert）。
          const checkpointBaseMessages = get().sessionMessages[activeSessionId] ?? [];
          const checkpointResult = await maybeGenerateContextCheckpoint(
            normalizedSettings,
            checkpointBaseMessages,
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
            let checkpointApplied = false;
            set((s) => {
              const currentSessionMessages = s.sessionMessages[activeSessionId!] ?? [];
              // 校验插入基座：reset/清空后旧 insertIndex 会把已删除内容以
              // 摘要形式插回末尾（复活）——整个 checkpoint 丢弃。
              if (!isSafeCheckpointInsert(checkpointBaseMessages, currentSessionMessages, checkpointResult.insertIndex)) {
                return {};
              }
              checkpointApplied = true;
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
            // 但回合结束 ≠ 无在飞执行：papr.agent.run（app-agent）不占 isLoading，
            // 立即 destroy 会经由 cancel() → cancelAllAppAgents() 杀掉正在运行的
            // app 执行（/compact 与回合前重建分支均用 hasActiveAppAgentRequests
            // → detachAndCleanupWhenIdle 规避，此分支必须同样处理）。
            if (
              checkpointApplied &&
              prevAgent &&
              prevAgentOwner === activeSessionId &&
              get()._agent !== prevAgent
            ) {
              try {
                if (prevAgent.hasActiveAppAgentRequests?.()) {
                  prevAgent.detachAndCleanupWhenIdle?.();
                } else {
                  prevAgent.destroy();
                }
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
                  const content = await readMemoryFile(ws);
                  if (!content || !planMemoryConsolidation(content, MEMORY_CONSOLIDATION_MAX_LINES)) return;
                  const consolidated = await consolidateMemoryContent(content, normalizedSettings);
                  if (consolidated && consolidated !== content) {
                    // #14：consolidation 的读-改-写窗口横跨整个模型调用，期间
                    // agent 可能已通过 write 工具写入 memory.md。写前重读：
                    // 内容变了就放弃本次覆盖（下一回合会重新评估 consolidation），
                    // 绝不整文件覆盖丢失 agent 写入。
                    const current = await readMemoryFile(ws);
                    if (current !== content) {
                      console.warn('[memory] consolidation skipped: memory.md changed during generation');
                      return;
                    }
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
          // 销毁（AgentDestroyedError）与取消等价：用户切会话/新建/改设置导致
          // agent 被销毁时，回合必须安静停止——既不重跑（旧实现把销毁误当
          // WorkerCrashError 重建重跑，bash/git commit 等副作用重复执行），
          // 也不弹出错误提示。
          if (
            (err instanceof DOMException && err.name === 'AbortError') ||
            err instanceof AgentDestroyedError
          ) {
            // 取消 ACK 可能晚于新回合启动到达：仅当本回合仍是当前回合时才复位
            // isLoading，否则会踩掉新回合的 loading 态、破坏单执行模型。
            const stillCurrentTurn = get()._turnSeq === turnSeq;
            // 取消若源于 worker 已死（cancel 超时判崩），必须同时清空 agent，
            // 否则下一条消息会复用死 agent，抛出笼统的「worker has crashed」。
            if (get()._agent?.isCrashed()) {
              set({
                _agent: null,
                _agentSessionId: null,
                ...(stillCurrentTurn ? { isLoading: false, loadingSessionId: null } : {}),
              });
            } else if (stillCurrentTurn) {
              set({ isLoading: false, loadingSessionId: null });
              // N3：取消/销毁的回合不会进入 agent 的 logStore。外部动作
              // （切会话/改设置）销毁 agent 时 store 已同步置空 _agent；
              // 此处 _agent 非空即本回合仍在使用的实例（含崩溃恢复重建的），
              // 失效它，下一条消息按 sessionMessages 全量重建。
              if (get()._agent) {
                invalidateAgentHandle(get, set);
              }
            }
            if (assistantMessageId && sid) {
              cleanupStreamingAssistantMessage(set, sid, assistantMessageId);
            }
            // 取消也算已消耗的执行时长（墙钟口径：发送 → 取消）。
            accumulateTurnRuntime(sid);
            saveCurrentProjectState(get());
            return;
          }

          // Worker crash: null out the agent so a fresh one is created on retry.
          const isWorkerCrash = err instanceof WorkerCrashError;
          const stillCurrentTurn = get()._turnSeq === turnSeq;
          if (isWorkerCrash) {
            set({
              _agent: null,
              _agentSessionId: null,
              ...(stillCurrentTurn ? { isLoading: false, loadingSessionId: null } : {}),
            });
          } else if (stillCurrentTurn) {
            set({ isLoading: false, loadingSessionId: null });
            // N3：出错的回合不会进入 agent 的 logStore（worker 出错不提交
            // delta），复用旧实例会让下一条消息丢失本次失败的用户消息。
            // 失效后按 sessionMessages（含错误提示消息）全量重建。
            if (get()._agent) {
              invalidateAgentHandle(get, set);
            }
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
          accumulateTurnRuntime(sid);
          saveCurrentProjectState(get());
        } finally {
          clearStoreIdle();
          void (async () => {
            try {
              // 用回合开始时的捕获路径而非实时路径：回合中途切换工作区时，
              // 浏览器页面属于回合启动时的工作区，按实时路径关闭会 miss，
              // 导致旧工作区的浏览器会话泄漏（close_browser_page 按键查找）。
              await invoke('close_browser_page', { workspacePath: turnWorkspacePath });
            } catch {
              // no-op: browser may not have been opened this turn
            }
          })();
        }
  };
}
