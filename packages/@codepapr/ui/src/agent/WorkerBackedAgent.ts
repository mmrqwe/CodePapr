import {
  AppendOnlyLog,
  ToolRegistry,
  FilteringToolRegistry,
  MUTATING_TOOL_NAMES,
  isReadOnlyMode,
  Serializer,
  type EditHistory,
  type PromptMode,
} from '@codepapr/core';
import type { IAgentResponse, IChatRequest, IChatStreamEvent, IImageContent, IMessage, IToolDefinition } from '@codepapr/types';
import { OpenAIProvider, ClaudeProvider, ProviderRequestError, getGlobalFetchFn } from '@codepapr/api';
import { createId } from '../utils/createId';
import {
  cancelExternalAccessRequests,
  isPermissionWaitActive,
  subscribePermissionWait,
} from '../store/permissionStore';
import { registerWorkspaceTools, type WorkspaceMutationListener } from '../tools/workspaceTools';
import { registerTodoListTools } from '../tools/todoListTool';
import { registerMcpTools } from '../tools/mcpTools';
import { hasEnabledMcpSearch } from '../utils/mcpTypes';
import {
  resolveAppAgentIdleTimeoutMs,
  type AgentWorkerChatPayload,
  type AgentWorkerToMainMessage,
  type MainToAgentWorkerMessage,
  type WorkerAgentParameters,
  type WorkerAgentRuntimeConfig,
  type WorkerAgentSettings,
  type AppAgentPayload,
  type AppAgentResult,
} from './agentWorkerProtocol';

function resolveWorkerMultimodalEnabled(settings: WorkerAgentSettings, currentModel: string): boolean {
  if (!settings.multimodalEnabled) return false;
  if (settings.multimodalModelTier === 'all') return true;
  const fastModel = settings.fastModel.trim();
  const isFastModel = settings.fastModelEnabled && fastModel.length > 0 && currentModel === fastModel;
  if (settings.multimodalModelTier === 'primary' && !isFastModel) return true;
  if (settings.multimodalModelTier === 'fast' && isFastModel) return true;
  return false;
}

interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  argumentsKey: string;
}

export interface ToolProgressStreamEvent {
  type: 'tool-call-progress';
  toolCallId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  statusText?: string;
  output?: string;
}

export type AgentRuntimeStreamEvent = IChatStreamEvent | ToolProgressStreamEvent;

interface ToolExecutionContext {
  toolCallId?: string;
  onProgress?: (event: ToolProgressStreamEvent) => void;
  /** 取消通道：cancel-tool-request / 会话取消 / agent 销毁时 abort。bash 等
   *  长耗时工具必须监听并停止执行，否则取消后仍在后台跑完。 */
  signal?: AbortSignal;
  /** app agent 专属：该 app 的两轴访问档（bash 沙箱构建用） */
  appAccess?: { network: boolean; workspaceWrite: boolean };
}

type WorkerToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<unknown>;

interface PendingWorkerRequest {
  pendingToolCalls: PendingToolCall[];
  streamListener?: (event: AgentRuntimeStreamEvent) => void;
  resolve: (value: IAgentResponse) => void;
  reject: (error: Error) => void;
  bufferedContentDelta: string;
  bufferedReasoningDelta: string;
  flushTimerId: ReturnType<typeof setTimeout> | null;
}

const STREAM_DELTA_FLUSH_INTERVAL_MS = 240;
const MAX_BUFFERED_STREAM_DELTA_CHARS = 4096;
const STREAM_SNAPSHOT_INTERVAL_MS = 2000;
// Heartbeat: while requests are in flight, ping the worker periodically. A
// silently dead worker (e.g. killed by WebKit on display sleep) never fires
// an 'error' event and would otherwise leave the chat promise hanging until
// the much slower store-level idle watchdog. Missing pongs for longer than
// the timeout declares the worker crashed, triggering recovery.
const WORKER_HEARTBEAT_INTERVAL_MS = 5000;
const WORKER_HEARTBEAT_TIMEOUT_MS = 15000;
// A worker that has never answered a pong gets a longer grace window: its
// first turn pays the full-sync cost (cloning + hashing the whole log),
// which blocks pong replies — especially right after a page thaw, when
// WebKit still throttles the process. Declaring it dead after only 15s
// produces false crashes that cascade through the recovery retries.
const WORKER_HEARTBEAT_INITIAL_GRACE_MS = 60000;
const MAX_WORKER_DIAGNOSTICS = 20;
// 取消 ACK 宽限：用户点停止后，worker 必须在该窗口内回 canceller ACK，
// 否则被硬 terminate。固定 2s 会误杀"慢但健康"的 worker——大上下文同步
// （全量日志 clone + getByteLength 逐条哈希）会阻塞 worker 事件循环数秒，
// cancel-session 处理与 ACK 都排在其后。10s 覆盖同步开销；
// 期间 worker 每响应一条消息（含心跳 pong）就重新武装整个窗口，
// 只有彻底无响应的 worker 才会被终止。
const CANCEL_ACK_GRACE_MS = 10_000;

/** Error thrown when the agent worker crashes (OOM, uncaught exception, etc.).
 *  The `chat()` promise rejects with this so the store's catch block can
 *  reset `isLoading` and offer recovery. */
export class WorkerCrashError extends Error {
  readonly isWorkerCrash = true;
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'WorkerCrashError';
  }
}

/** Error thrown when the agent was deliberately destroyed mid-turn (session
 *  switch / new session / settings change). 与 WorkerCrashError 严格区分：
 *  崩溃恢复链（runWithCrashRecovery）只对真实崩溃重建并重跑回合——销毁意味着
 *  用户主动中断，绝不能再执行一遍回合（bash/git commit 等非幂等副作用会
 *  重复执行且用户不可见）。上层应把它当作取消处理。 */
export class AgentDestroyedError extends Error {
  readonly isAgentDestroyed = true;
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'AgentDestroyedError';
  }
}

export interface AgentRuntimeHandle {
  chat(
    userInput: string,
    onStreamEvent?: (event: AgentRuntimeStreamEvent) => void,
    images?: IImageContent[]
  ): Promise<IAgentResponse>;
  getSession(): { logStore: AppendOnlyLog };
  cancel(): void;
  /** 仅取消当前聊天回合（会话），不影响在飞的 papr app-agent 执行。
   *  停止按钮走此路径；destroy() 仍走 cancel()（连带 app-agent）。 */
  cancelSession(): void;
  destroy(): void;
  /** Returns true if the worker has crashed and can no longer process messages. */
  isCrashed(): boolean;
  runAppAgent(
    payload: AppAgentPayload,
    onStream?: (event: IChatStreamEvent) => void,
    requestId?: string,
  ): Promise<AppAgentResult>;
  cancelAppAgent(requestId: string): void;
  /** 是否仍有在飞的 app-agent（papr.agent.run）请求。 */
  hasActiveAppAgentRequests?(): boolean;
  /** 标记已被替换：在飞的 app-agent 请求全部结算后再销毁，避免杀掉运行中的执行。 */
  detachAndCleanupWhenIdle?(): void;
  /** 是否仍有主线程在飞的工具执行（含静默长工具）。空闲看门狗据此
   *  暂停：工具自身的 IPC 超时负责兜底，不能被 5.5 分钟的看门狗误杀（N6）。 */
  hasInflightToolExecutions?(): boolean;
}

export interface WorkerBackedAgentConfig {
  sessionId: string;
  workspacePath: string;
  initialMessages: IMessage[];
  settings: WorkerAgentSettings;
  providerName: WorkerAgentSettings['provider'];
  model: string;
  systemPrompt: string;
  parameters: WorkerAgentParameters;
  runtime: WorkerAgentRuntimeConfig & {
    editHistory?: EditHistory;
    onWorkspaceMutated?: WorkspaceMutationListener;
  };
  /** Called periodically during streaming so the store can persist a
    *  debounced snapshot of in-flight content for crash recovery. */
  onStreamSnapshot?: () => void;
  /** Re-reads volatile disk state (memory.md) and rebuilds the session
    *  bootstrap. Invoked when the worker's mid-loop compaction resets the epoch
    *  so memory stays fresh across long sessions. Returns null/empty to skip. */
  onRefreshBootstrap?: () => Promise<string | null>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
}

function createWorkerToolExecutor(config: WorkerBackedAgentConfig): {
  toolDefinitions: IToolDefinition[];
  execute: WorkerToolExecutor;
} {
  const mode: PromptMode = config.runtime.mode ?? 'agent';
  const registry = isReadOnlyMode(mode)
    ? new FilteringToolRegistry((tool) => !MUTATING_TOOL_NAMES.has(tool.name))
    : new ToolRegistry();
  registerWorkspaceTools(
    registry,
    config.workspacePath,
    config.runtime.editHistory,
    config.runtime.onWorkspaceMutated,
    {
      disableWebSearchTools: hasEnabledMcpSearch(config.settings.mcp),
      multimodalEnabled: resolveWorkerMultimodalEnabled(config.settings, config.model),
      mode,
    },
  );

  // TodoList 工具：handler 改主线程的 store，由 Worker 通过 tool-request 桥回执行
  registerTodoListTools(registry, config.sessionId, '');

  registerMcpTools(registry, config.settings.mcp, config.runtime.mcpToolDefinitions ?? [], config.runtime.mcpToolMappings);

  // Send only the LLM-visible tools to the worker. getAll() would also include
  // hideFromLlm/softHideFromLlm tools (e.g. read_image when multimodal is off,
  // graph, deprecated aliases); the worker re-registers everything it receives
  // as normal tools, so any hidden tool sent over would leak back into the main
  // agent's getLlmTools() prefix. Subagents still reach graph via the worker's
  // re-registration + getAll()/whitelist selection.
  const definitions = [...registry.getLlmTools()];

  return {
    toolDefinitions: definitions,
    execute: async (toolName, args, context) => {
      return await registry.execute(toolName, args, context ? { ...context } : undefined);
    },
  };
}

function reconstructWorkerError(message: {
  error: string;
  errorName?: string;
  errorDetails?: {
    provider?: string;
    status?: number;
    requestId?: string;
    responseBody?: string;
    retriable?: boolean;
  };
}): Error {
  if (message.errorName === 'ProviderRequestError' && message.errorDetails) {
    return new ProviderRequestError({
      provider: message.errorDetails.provider ?? 'unknown',
      message: message.error,
      status: message.errorDetails.status,
      requestId: message.errorDetails.requestId,
      responseBody: message.errorDetails.responseBody,
      retriable: message.errorDetails.retriable,
    });
  }
  const error = new Error(message.error);
  if (message.errorName) {
    error.name = message.errorName;
  }
  return error;
}

let activeInstance: WorkerBackedAgent | null = null;

export function getActiveAgent(): WorkerBackedAgent | null {
  return activeInstance;
}

export class WorkerBackedAgent implements AgentRuntimeHandle {
  private readonly worker: Worker;
  private readonly logStore: AppendOnlyLog;
  private readonly toolDefinitions: IToolDefinition[];
  private readonly toolExecutor: WorkerToolExecutor;
  private readonly pendingRequests = new Map<string, PendingWorkerRequest>();
  private readonly appAgentRequests = new Map<string, {
    resolve: (result: AppAgentResult) => void;
    reject: (error: Error) => void;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
    onStream?: (event: IChatStreamEvent) => void;
    bufferedContentDelta: string;
    bufferedReasoningDelta: string;
    flushTimerId: ReturnType<typeof setTimeout> | null;
  }>();
  private readonly pendingFetchControllers = new Map<string, AbortController>();
  /** Worker 发起、正在主线程执行的工具：key = toolRequestId（`${requestId}:${n}`）。
   *  cancel-tool-request / 会话取消 / agent 销毁时 abort 其 controller，
   *  使工具实现（bash 等）收到 signal 后停止执行——否则工具会在取消后
   *  继续在后台跑完并滞后落地副作用。 */
  private readonly inflightToolExecutions = new Map<string, AbortController>();
  private unsubscribePermissionWait: (() => void) | null = null;
  private permissionWaitActive = false;
  private activeRequestId: string | null = null;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private crashed = false;
  /** Original crash cause, kept so errors thrown after the crash (chat() on a
   *  dead agent) can report why the worker died instead of a generic message. */
  private crashInfo: { message: string; detail?: string } | null = null;
  private heartbeatTimerId: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  /** False until the first pong arrives; switches the heartbeat from the
   *  initial grace window to the normal timeout. */
  private hasReceivedPong = false;
  /** Recent worker-side diagnostics (global errors, unhandled rejections,
   *  handler failures) included in the crash log for post-mortem analysis. */
  private readonly workerDiagnostics: string[] = [];
  private snapshotTimerId: ReturnType<typeof setTimeout> | null = null;
  // Tracks the log length the worker's per-session cache should currently hold.
  // When it matches this.logStore.length() the next chat syncs incrementally
  // (no full-log clone); a mismatch (first turn, resetToMessage, clear, pop,
  // compaction) falls back to a full sync. Fresh per WorkerBackedAgent instance,
  // so a recreated worker always starts with a full sync.
  private readonly workerSyncedLength = new Map<string, number>();
  /** Must match the worker's withIdleTimeout window for the same run, so a
    *  run is never killed on one side while the other still considers it
    *  active. Derived from the tool IPC timeout (resolveAppAgentIdleTimeoutMs). */
  private readonly appAgentIdleTimeoutMs: number;
  /** 已被 store 替换（detach）：在飞的 app-agent 请求全部结束后自我销毁。 */
  private detached = false;
  private destroyed = false;

  constructor(private readonly config: WorkerBackedAgentConfig) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeInstance = this;
    this.appAgentIdleTimeoutMs = resolveAppAgentIdleTimeoutMs(config.settings.toolIpcTimeoutMs);
    this.logStore = new AppendOnlyLog(config.sessionId);
    if (config.initialMessages.length > 0) {
      this.logStore.loadFromSnapshot({
        messages: config.initialMessages,
        lastMessageIndex: config.initialMessages.length - 1,
        // Serializer.getByteLength (sorted-key JSON) matches the byte accounting
        // loadFromSnapshot validates against (see createLog in the worker).
        totalBytes: config.initialMessages.reduce(
          (sum, message) => sum + Serializer.getByteLength(message),
          0
        ),
      });
    }

    const toolBridge = createWorkerToolExecutor(config);
    this.toolDefinitions = toolBridge.toolDefinitions;
    this.toolExecutor = toolBridge.execute;
    this.worker = new Worker(new URL('./agentRuntime.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.unsubscribePermissionWait = subscribePermissionWait((waiting) => {
      this.permissionWaitActive = waiting;
      for (const requestId of this.appAgentRequests.keys()) {
        if (waiting) {
          const entry = this.appAgentRequests.get(requestId);
          if (entry?.timeoutTimer !== null && entry?.timeoutTimer !== undefined) {
            clearTimeout(entry.timeoutTimer);
            entry.timeoutTimer = null;
          }
        } else {
          this.armAppAgentIdleTimer(requestId);
        }
      }
      this.postToWorker({ type: 'permission-wait', waiting } satisfies MainToAgentWorkerMessage);
    });
    this.worker.addEventListener('message', this.handleWorkerMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleWorkerMessageError);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.startHeartbeat();
    // Warm the worker's caches up front so app agents can run before any chat
    // turn (messages are processed in order, so this lands before any request).
    this.worker.postMessage({
      type: 'init',
      payload: {
        settings: config.settings,
        toolDefinitions: this.toolDefinitions,
        workspacePath: config.workspacePath,
        runtime: {
          rulesSection: config.runtime.rulesSection,
          customPrompt: config.runtime.customPrompt,
          memorySection: config.runtime.memorySection,
          lang: config.runtime.lang,
          skillDefinitions: config.runtime.skillDefinitions,
          agentDefinitions: config.runtime.agentDefinitions,
        },
      },
    } satisfies MainToAgentWorkerMessage);
    if (isPermissionWaitActive()) {
      this.permissionWaitActive = true;
      this.postToWorker({ type: 'permission-wait', waiting: true } satisfies MainToAgentWorkerMessage);
    }
  }

  /** Detects a silently dead worker (no 'error' event, e.g. OS memory kill):
   *  while requests are pending, a ping must be answered within the timeout. */
  private startHeartbeat(): void {
    if (this.heartbeatTimerId !== null) return;
    this.lastPongAt = Date.now();
    this.heartbeatTimerId = setInterval(() => {
      if (this.crashed) return;
      if (this.pendingRequests.size === 0 && this.appAgentRequests.size === 0) {
        // Idle: nothing to protect; keep the baseline fresh so a request that
        // starts right after doesn't trip on a stale timestamp.
        this.lastPongAt = Date.now();
        return;
      }
      const timeout = this.hasReceivedPong
        ? WORKER_HEARTBEAT_TIMEOUT_MS
        : WORKER_HEARTBEAT_INITIAL_GRACE_MS;
      if (Date.now() - this.lastPongAt > timeout) {
        this.handleCrash(
          `Agent worker unresponsive (no heartbeat for ${Math.round(timeout / 1000)}s)`,
        );
        return;
      }
      try {
        this.worker.postMessage({ type: 'ping' } satisfies MainToAgentWorkerMessage);
      } catch {
        // posting to a dead worker can throw in some engines — treat as crash
        this.handleCrash('Agent worker unresponsive (heartbeat post failed)');
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimerId !== null) {
      clearInterval(this.heartbeatTimerId);
      this.heartbeatTimerId = null;
    }
  }

  /** Page thaw (display back on / window visible again): timers were skewed
   *  while the page was frozen, so refresh the heartbeat baseline instead of
   *  declaring a healthy worker dead on stale arithmetic. A genuinely dead
   *  worker is still caught one timeout window later. */
  private readonly handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.lastPongAt = Date.now();
    }
  };

  isCrashed(): boolean {
    return this.crashed;
  }

  /** postMessage 统一出口：crashed/destroyed 后 worker 已被 terminate，直接
   *  跳过投递（部分引擎向已终止 worker postMessage 会抛异常，异步回调里
   *  抛出还会变成 unhandledrejection）。所有无守卫的裸调用都必须走这里。 */
  private postToWorker(
    message: MainToAgentWorkerMessage,
    transfer?: Transferable[]
  ): void {
    if (this.crashed || this.destroyed) return;
    try {
      if (transfer) {
        this.worker.postMessage(message, transfer);
      } else {
        this.worker.postMessage(message);
      }
    } catch {
      // worker may already be terminated
    }
  }

  private crashCause(): string {
    if (!this.crashInfo) return 'unknown cause';
    return this.crashInfo.detail
      ? `${this.crashInfo.message} (${this.crashInfo.detail})`
      : this.crashInfo.message;
  }

  getSession(): { logStore: AppendOnlyLog } {
    return {
      logStore: this.logStore,
    };
  }

  /** 完整取消：会话 + 全部在飞的 app-agent。destroy() 使用；停止按钮请用 cancelSession()。 */
  cancel(): void {
    cancelExternalAccessRequests();
    const requestId = this.activeRequestId;
    if (!requestId) return;

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.activeRequestId = null;
      return;
    }

    this.cancelSessionCore(requestId, pending);

    this.cancelAllAppAgents();
  }

  /** 仅取消当前会话回合：停止按钮不能连带杀掉 papr app-agent 的独立运行。 */
  cancelSession(): void {
    cancelExternalAccessRequests();
    const requestId = this.activeRequestId;
    if (!requestId) return;

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.activeRequestId = null;
      return;
    }

    this.cancelSessionCore(requestId, pending);
  }

  private cancelSessionCore(
    requestId: string,
    pending: PendingWorkerRequest,
  ): void {
    this.clearCancelTimer();
    this.clearSnapshotTimer();

    // 会话取消同样中止主线程在飞的工具执行（bash 等），旧实现只 cancel
    // worker 侧的 chat promise，工具继续在后台跑完。
    this.abortInflightTools();

    this.postToWorker({
      type: 'cancel-session',
      requestId,
    } satisfies MainToAgentWorkerMessage);

    this.scheduleCancelTermination(requestId, pending, CANCEL_ACK_GRACE_MS);
  }

  /** 硬终止兜底：worker 未在宽限窗口内回 ACK（卡死/已死）时 terminate。 */
  private scheduleCancelTermination(
    requestId: string,
    pending: PendingWorkerRequest,
    graceMs: number
  ): void {
    this.cancelTimer = setTimeout(() => {
      // Worker did not acknowledge the cancel in time — it is stuck or dead.
      // Record the cause so the store can drop this agent and the next crash
      // report explains why.
      if (!this.crashed) {
        this.crashed = true;
        this.crashInfo = {
          message: `Agent worker did not acknowledge cancel within ${Math.round(graceMs / 1000)}s (terminated)`,
        };
        this.clearHeartbeat();
      }
      this.worker.terminate();
      pending.reject(new DOMException('Agent was terminated', 'AbortError'));
      this.pendingRequests.delete(requestId);
      this.activeRequestId = null;
      this.cancelTimer = null;
    }, graceMs);
  }

  hasActiveAppAgentRequests(): boolean {
    return this.appAgentRequests.size > 0;
  }

  hasInflightToolExecutions(): boolean {
    return this.inflightToolExecutions.size > 0;
  }

  /** 标记该 agent 已被 store 替换：仍有 app-agent（papr.agent.run）在飞时
   *  立即 destroy 会杀掉运行中的 app 执行，改为等全部结算后自我销毁。 */
  detachAndCleanupWhenIdle(): void {
    this.detached = true;
    this.maybeCleanupDetached();
  }

  private maybeCleanupDetached(): void {
    if (this.detached && !this.destroyed && this.appAgentRequests.size === 0) {
      this.destroy();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    this.clearCancelTimer();
    this.clearHeartbeat();
    this.clearSnapshotTimer();
    this.abortAllPendingFetches();
    this.unsubscribePermissionWait?.();
    this.unsubscribePermissionWait = null;
    this.rejectAllAppAgentRequests(new Error('Agent was destroyed'));
    // worker 被直接 terminate 后 cancel ACK 永远不会到达（cancel() 的兜底
    // 定时器也已被清除）：必须主动 reject 所有 pending chat 请求，否则调用
    // 方 await 永久挂起。旧实现复用 WorkerCrashError 让崩溃恢复链「重建并
    // 重跑整个回合」——销毁是用户主动中断（切会话/新建/改设置），重跑会
    // 重复执行 bash/git commit 等非幂等副作用且用户不可见，必须用独立的
    // AgentDestroyedError 区分开。
    const destroyError = new AgentDestroyedError('Agent was destroyed');
    for (const [requestId, pending] of this.pendingRequests) {
      this.flushDeltas(pending);
      pending.reject(destroyError);
      this.pendingRequests.delete(requestId);
    }
    this.activeRequestId = null;
    this.crashed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    if (activeInstance === this) {
      activeInstance = null;
    }
    try {
      this.worker.terminate();
    } catch {
      // worker may already be terminated
    }
  }

  async chat(
    userInput: string,
    onStreamEvent?: (event: AgentRuntimeStreamEvent) => void,
    images?: IImageContent[]
  ): Promise<IAgentResponse> {
    if (this.destroyed) {
      // 已被销毁的 agent 拒绝新回合：用 AgentDestroyedError（而非
      // WorkerCrashError），避免崩溃恢复链对已销毁的 agent 重建重跑。
      throw new AgentDestroyedError('Agent was destroyed');
    }
    if (this.crashed) {
      throw new WorkerCrashError(
        `Agent worker has crashed and cannot process messages (${this.crashCause()}). Create a new agent to retry.`,
        this.crashInfo?.detail,
      );
    }
    const requestId = createId();
    this.activeRequestId = requestId;

    const sessionId = this.config.sessionId;
    const mainLength = this.logStore.length();
    const syncedLength = this.workerSyncedLength.get(sessionId);
    let chatMessages: IMessage[];
    let incrementalSync: AgentWorkerChatPayload['incrementalSync'];
    if (syncedLength === mainLength) {
      // Worker cache is in sync: send only messages appended since (normally
      // none) and let the worker reuse its cached log — no full-log clone.
      chatMessages = [];
      incrementalSync = {
        expectedBaseLength: syncedLength,
        newMessages: this.logStore.getMessagesSince(syncedLength),
      };
    } else {
      chatMessages = [...this.logStore.getAllMessages()];
    }

    const payload: AgentWorkerChatPayload = {
      requestId,
      sessionId,
      workspacePath: this.config.workspacePath,
      messages: chatMessages,
      ...(incrementalSync ? { incrementalSync } : {}),
      userInput,
      images,
      settings: this.config.settings,
      providerName: this.config.providerName,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      parameters: this.config.parameters,
      toolDefinitions: this.toolDefinitions,
      runtime: {
        rulesSection: this.config.runtime.rulesSection,
        customPrompt: this.config.runtime.customPrompt,
        memorySection: this.config.runtime.memorySection,
        lang: this.config.runtime.lang,
        skillDefinitions: this.config.runtime.skillDefinitions,
        agentDefinitions: this.config.runtime.agentDefinitions,
      },
    };

    const response = await new Promise<IAgentResponse>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        pendingToolCalls: [],
        streamListener: onStreamEvent,
        resolve,
        reject,
        bufferedContentDelta: '',
        bufferedReasoningDelta: '',
        flushTimerId: null,
      });
      this.postToWorker({ type: 'chat', payload } satisfies MainToAgentWorkerMessage);
    });

    return response;
  }

  async runAppAgent(
    payload: AppAgentPayload,
    onStream?: (event: IChatStreamEvent) => void,
    requestId: string = createId(),
  ): Promise<AppAgentResult> {
    if (this.crashed) {
      throw new WorkerCrashError(
        `Agent worker has crashed (${this.crashCause()}). Create a new agent to retry.`,
        this.crashInfo?.detail,
      );
    }

    const result = await new Promise<AppAgentResult>((resolve, reject) => {
      this.appAgentRequests.set(requestId, {
        resolve,
        reject,
        timeoutTimer: null,
        onStream,
        bufferedContentDelta: '',
        bufferedReasoningDelta: '',
        flushTimerId: null,
      });
      this.armAppAgentIdleTimer(requestId);

      this.postToWorker({
        type: 'run-app-agent',
        requestId,
        payload,
      } satisfies MainToAgentWorkerMessage);
    });

    return result;
  }

  private armAppAgentIdleTimer(requestId: string): void {
    const entry = this.appAgentRequests.get(requestId);
    if (!entry) return;
    if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer);
    if (this.permissionWaitActive) {
      entry.timeoutTimer = null;
      return;
    }
    const idleTimeoutMs = this.appAgentIdleTimeoutMs;
    entry.timeoutTimer = setTimeout(() => {
      entry.timeoutTimer = null;
      // 必须同时取消 worker 侧的执行：旧实现只 reject 主线程 promise，worker
      // 会继续烧 token 跑完无人监听的 app agent（其 abort 控制器也滞留）。
      try {
        this.worker.postMessage({
          type: 'cancel-app-agent',
          requestId,
        } satisfies MainToAgentWorkerMessage);
      } catch {
        // worker 可能已终止
      }
      this.flushAppAgentDeltas(entry);
      this.appAgentRequests.delete(requestId);
      entry.reject(new Error(
        `App agent request timed out (no activity for ${idleTimeoutMs / 1000}s)`,
      ));
      this.maybeCleanupDetached();
    }, idleTimeoutMs);
  }

  cancelAppAgent(requestId: string): void {
    cancelExternalAccessRequests();
    this.abortInflightTools(requestId);
    this.postToWorker({
      type: 'cancel-app-agent',
      requestId,
    } satisfies MainToAgentWorkerMessage);
    const entry = this.appAgentRequests.get(requestId);
    if (entry) {
      this.flushAppAgentDeltas(entry);
      if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer);
      this.appAgentRequests.delete(requestId);
      entry.reject(new DOMException('App agent was cancelled', 'AbortError'));
      this.maybeCleanupDetached();
    }
  }

  /** 中止主线程在飞的工具执行。appAgentRequestId 提供时只中止该 app-agent
   *  run 发起的工具（toolRequestId 以 `${requestId}:` 开头）。 */
  private abortInflightTools(appAgentRequestId?: string): void {
    for (const [toolRequestId, controller] of this.inflightToolExecutions) {
      if (appAgentRequestId && !toolRequestId.startsWith(`${appAgentRequestId}:`)) {
        continue;
      }
      try {
        controller.abort();
      } catch {
        // already aborted
      }
      this.inflightToolExecutions.delete(toolRequestId);
    }
  }

  private cancelAllAppAgents(): void {
    this.abortInflightTools();
    for (const [reqId] of this.appAgentRequests) {
      this.postToWorker({
        type: 'cancel-app-agent',
        requestId: reqId,
      } satisfies MainToAgentWorkerMessage);
    }
    this.rejectAllAppAgentRequests(new DOMException('Session was cancelled', 'AbortError'));
  }

  private rejectAllAppAgentRequests(error: Error): void {
    for (const [, entry] of this.appAgentRequests) {
      if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer);
      entry.reject(error);
    }
    this.appAgentRequests.clear();
    this.maybeCleanupDetached();
  }

  private readonly handleWorkerMessage = (event: MessageEvent<AgentWorkerToMainMessage>) => {
    const message = event.data;

    // 取消 ACK 等待期间 worker 仍在响应（任何消息都算活着）：重新武装
    // 终止宽限窗口。大上下文同步会阻塞事件循环，worker 只是"慢"而非死。
    if (message.type !== 'cancelled' && this.cancelTimer !== null && this.activeRequestId) {
      const pending = this.pendingRequests.get(this.activeRequestId);
      if (pending) {
        clearTimeout(this.cancelTimer);
        this.cancelTimer = null;
        this.scheduleCancelTermination(this.activeRequestId, pending, CANCEL_ACK_GRACE_MS);
      }
    }

    if (message.type === 'pong') {
      this.hasReceivedPong = true;
      this.lastPongAt = Date.now();
      return;
    }

    if (message.type === 'worker-diagnostic') {
      const entry = message.detail
        ? `${message.message} (${message.detail})`
        : message.message;
      this.workerDiagnostics.push(entry);
      if (this.workerDiagnostics.length > MAX_WORKER_DIAGNOSTICS) {
        this.workerDiagnostics.shift();
      }
      console.warn('[AgentWorker] diagnostic:', entry);
      return;
    }

    if (message.type === 'cancelled') {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.clearCancelTimer();
        this.clearSnapshotTimer();
        this.pendingRequests.delete(message.requestId);
        // 仅当被取消的仍是当前活跃请求时才清空 activeRequestId：取消 ACK 到达
        // 前用户可能已开启新回合（新 requestId），无差别置空会让新回合的
        // cancel() 找不到 requestId 而失效。
        if (this.activeRequestId === message.requestId) {
          this.activeRequestId = null;
        }
        this.flushDeltas(pending);
        this.workerSyncedLength.delete(this.config.sessionId);
        pending.reject(new DOMException('Session was cancelled', 'AbortError'));
      }
      return;
    }

    if (message.type === 'fetch-request') {
      void this.handleFetchRequest(message);
      return;
    }

    if (message.type === 'fetch-cancel') {
      const controller = this.pendingFetchControllers.get(message.fetchId);
      if (controller) {
        try {
          controller.abort();
        } catch {
          // already aborted
        }
      }
      return;
    }

    if (message.type === 'cancel-tool-request') {
      const controller = this.inflightToolExecutions.get(message.toolRequestId);
      if (controller) {
        try {
          controller.abort();
        } catch {
          // already aborted
        }
        this.inflightToolExecutions.delete(message.toolRequestId);
      }
      return;
    }

    if (message.type === 'refresh-bootstrap-request') {
      void this.handleRefreshBootstrapRequest(message.bootstrapRequestId);
      return;
    }

    if (message.type === 'app-agent-stream') {
      const entry = this.appAgentRequests.get(message.requestId);
      if (!entry) return;
      this.armAppAgentIdleTimer(message.requestId);
      if (!entry.onStream) return;

      if (message.event.type === 'content-delta') {
        entry.bufferedContentDelta += message.event.delta;
        if (entry.bufferedContentDelta.length >= MAX_BUFFERED_STREAM_DELTA_CHARS) {
          this.flushAppAgentDeltas(entry);
          return;
        }
        this.scheduleAppAgentFlush(entry);
        return;
      }

      if (message.event.type === 'reasoning-delta') {
        entry.bufferedReasoningDelta += message.event.delta;
        if (entry.bufferedReasoningDelta.length >= MAX_BUFFERED_STREAM_DELTA_CHARS) {
          this.flushAppAgentDeltas(entry);
          return;
        }
        this.scheduleAppAgentFlush(entry);
        return;
      }

      this.flushAppAgentDeltas(entry);
      entry.onStream(message.event);
      return;
    }

    if (message.type === 'app-agent-result') {
      const entry = this.appAgentRequests.get(message.requestId);
      if (entry) {
        this.flushAppAgentDeltas(entry);
        if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer);
        this.appAgentRequests.delete(message.requestId);
        entry.resolve({
          content: message.content,
          reasoningContent: message.reasoningContent,
          steps: message.steps,
        });
        this.maybeCleanupDetached();
      }
      return;
    }

    if (message.type === 'app-agent-error') {
      const entry = this.appAgentRequests.get(message.requestId);
      if (entry) {
        this.flushAppAgentDeltas(entry);
        if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer);
        this.appAgentRequests.delete(message.requestId);
        entry.reject(new Error(message.error));
        this.maybeCleanupDetached();
      }
      return;
    }

    if (message.type === 'tool-request') {
      // App-agent runs (papr.agent.run) are tracked in appAgentRequests, not
      // pendingRequests, but their tool calls cross the same bridge. Requests
      // belonging to cancelled/unknown runs (in neither map) are still dropped.
      const pending = this.pendingRequests.get(message.requestId);
      const appAgentEntry = this.appAgentRequests.get(message.requestId);
      if (!pending && !appAgentEntry) {
        return;
      }
      // A tool executing on the main thread is activity: keep the app-agent
      // idle timer from firing mid-run (e.g. slow bash/websearch calls).
      if (appAgentEntry) {
        this.armAppAgentIdleTimer(message.requestId);
      }

      const toolController = new AbortController();
      this.inflightToolExecutions.set(message.toolRequestId, toolController);

      // Prefer matching by tool-call id (robust even for concurrent identical
      // calls); fall back to name+arguments for older paths without an id.
      const match = pending
        ? ((message.toolCallId
            ? pending.pendingToolCalls.find((item) => item.toolCallId === message.toolCallId)
            : undefined) ??
          pending.pendingToolCalls.find(
            (item) =>
              item.toolName === message.toolName &&
              item.argumentsKey === stableStringify(message.arguments)
          ))
        : undefined;

      void this.toolExecutor(message.toolName, message.arguments, {
        toolCallId: match?.toolCallId,
        appAccess: message.appAccess,
        signal: toolController.signal,
        onProgress: pending?.streamListener
          ? (progressEvent) => {
              pending.streamListener?.(progressEvent);
            }
          : undefined,
      })
        .then((result) => {
          if (appAgentEntry) {
            this.armAppAgentIdleTimer(message.requestId);
          }
          this.postToWorker({
            type: 'tool-response',
            payload: {
              requestId: message.requestId,
              toolRequestId: message.toolRequestId,
              success: true,
              result,
            },
          } satisfies MainToAgentWorkerMessage);
        })
        .catch((error) => {
          if (appAgentEntry) {
            this.armAppAgentIdleTimer(message.requestId);
          }
          this.postToWorker({
            type: 'tool-response',
            payload: {
              requestId: message.requestId,
              toolRequestId: message.toolRequestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          } satisfies MainToAgentWorkerMessage);
        })
        .finally(() => {
          this.inflightToolExecutions.delete(message.toolRequestId);
        });
      return;
    }

    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    if (message.type === 'stream') {
      this.scheduleStreamSnapshot();
      if (message.event.type === 'tool-call-start') {
        pending.pendingToolCalls.push({
          toolCallId: message.event.toolCallId,
          toolName: message.event.toolName,
          argumentsKey: stableStringify(message.event.arguments),
        });
      } else if (message.event.type === 'tool-call-end') {
        const finishedToolCallId = message.event.toolCallId;
        if (finishedToolCallId) {
          pending.pendingToolCalls = pending.pendingToolCalls.filter(
            (item) => item.toolCallId !== finishedToolCallId
          );
        } else {
          // end 事件缺 toolCallId（旧/兜底路径）时按工具名移除最早一条：
          // 否则列表整回合膨胀，name+arguments 兜底匹配可能把新请求配对到
          // 早已结束的调用条目。
          const finishedToolName = message.event.toolName;
          const oldestIndex = pending.pendingToolCalls.findIndex(
            (item) => item.toolName === finishedToolName
          );
          if (oldestIndex >= 0) {
            pending.pendingToolCalls.splice(oldestIndex, 1);
          }
        }
      }

      if (message.event.type === 'content-delta') {
        pending.bufferedContentDelta += message.event.delta;
        if (pending.bufferedContentDelta.length >= MAX_BUFFERED_STREAM_DELTA_CHARS) {
          this.flushDeltas(pending);
          return;
        }
        this.scheduleFlush(pending);
        return;
      }

      if (message.event.type === 'reasoning-delta') {
        pending.bufferedReasoningDelta += message.event.delta;
        if (pending.bufferedReasoningDelta.length >= MAX_BUFFERED_STREAM_DELTA_CHARS) {
          this.flushDeltas(pending);
          return;
        }
        this.scheduleFlush(pending);
        return;
      }

      this.flushDeltas(pending);
      pending.streamListener?.(message.event);
      return;
    }

    if (message.type === 'proxy-chat') {
      const ProviderClass = message.config.format === 'claude' ? ClaudeProvider : OpenAIProvider;
      const provider = new ProviderClass({
        apiKey: message.config.apiKey,
        ...(message.config.baseURL ? { baseURL: message.config.baseURL } : {}),
      });
      provider.chat(message.chatRequest as IChatRequest)
        .then((resp) => {
          this.postToWorker({
            type: 'proxy-chat-response',
            proxyChatId: message.proxyChatId,
            success: true,
            result: resp,
          } satisfies MainToAgentWorkerMessage);
        })
        .catch((error) => {
          this.postToWorker({
            type: 'proxy-chat-response',
            proxyChatId: message.proxyChatId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies MainToAgentWorkerMessage);
        });
      return;
    }

    if (message.type === 'result') {
      this.clearCancelTimer();
      this.clearSnapshotTimer();
      this.flushDeltas(pending);
      this.pendingRequests.delete(message.requestId);
      this.activeRequestId = null;
      let apply: Promise<unknown>;
      if (message.compacted && message.fullMessages) {
        // Mid-loop compaction replaced the worker log this turn: adopt the
        // compacted epoch wholesale instead of appending deltas, whose indices no
        // longer align after the worker reset its log.
        this.logStore.reset();
        apply = this.logStore.appendBatch(message.fullMessages);
      } else {
        apply = this.logStore.appendBatch(message.deltaMessages);
      }
      void apply.then(() => {
        // Record the worker's authoritative log length so the next chat can sync
        // incrementally (only when it matches this.logStore.length()).
        this.workerSyncedLength.set(this.config.sessionId, message.logLength);
        pending.resolve(message.response);
      }, (error) => {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    this.clearCancelTimer();
    this.clearSnapshotTimer();
    this.flushDeltas(pending);
    this.pendingRequests.delete(message.requestId);
    this.activeRequestId = null;
    this.workerSyncedLength.delete(this.config.sessionId);
    pending.reject(reconstructWorkerError(message));
  };

  private readonly handleWorkerError = (event: ErrorEvent) => {
    this.handleCrash(
      `Agent worker crashed: ${event.message || 'unknown error'}`,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    );
  };

  private readonly handleWorkerMessageError = (_event: MessageEvent) => {
    this.handleCrash(
      'Agent worker message could not be deserialized (structured clone failure)',
    );
  };

  private handleCrash(message: string, detail?: string): void {
    if (this.crashed) return;
    this.crashed = true;
    this.crashInfo = { message, detail };
    this.clearHeartbeat();
    this.clearSnapshotTimer();
    // Capture live state synchronously: writeCrashLog awaits a dynamic import,
    // by which time the rejection loops below have already drained the maps.
    const crashReport = {
      message,
      detail,
      pendingChatRequests: this.pendingRequests.size,
      pendingAppAgentRequests: this.appAgentRequests.size,
      msSinceLastPong: this.lastPongAt > 0 ? Date.now() - this.lastPongAt : -1,
      visibilityState:
        typeof document !== 'undefined' ? document.visibilityState : 'unavailable',
    };
    console.error('[AgentWorker] crashed:', message, detail ?? '');
    void this.writeCrashLog(crashReport);
    this.rejectAllAppAgentRequests(new WorkerCrashError(message, detail));

    const error = new WorkerCrashError(message, detail);
    for (const [requestId, pending] of this.pendingRequests) {
      this.flushDeltas(pending);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
    this.activeRequestId = null;

    this.abortAllPendingFetches();

    // 崩溃后 worker 已 terminate：解除订阅，避免后续 permission-wait 回调
    // 再向已终止的 worker 投递（postToWorker 也会拦截，但解除更干净）。
    this.unsubscribePermissionWait?.();
    this.unsubscribePermissionWait = null;

    try {
      this.worker.terminate();
    } catch {
      // already terminated
    }
  }

  private abortAllPendingFetches(): void {
    for (const [, controller] of this.pendingFetchControllers) {
      try {
        controller.abort();
      } catch {
        // already aborted
      }
    }
    this.pendingFetchControllers.clear();
  }

  /** Best-effort crash report on disk so release builds (no devtools) can be
   *  post-mortemed: .CodePapr/logs/agent-worker-crash-<timestamp>.log */
  private async writeCrashLog(report: {
    message: string;
    detail?: string;
    pendingChatRequests: number;
    pendingAppAgentRequests: number;
    msSinceLastPong: number;
    visibilityState: string;
  }): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const now = new Date();
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const lines = [
        `time: ${now.toISOString()}`,
        `message: ${report.message}`,
        `detail: ${report.detail ?? 'n/a'}`,
        `sessionId: ${this.config.sessionId}`,
        `pendingChatRequests: ${report.pendingChatRequests}`,
        `pendingAppAgentRequests: ${report.pendingAppAgentRequests}`,
        `msSinceLastPong: ${report.msSinceLastPong}`,
        `visibilityState: ${report.visibilityState}`,
        `userAgent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`,
      ];
      if (this.workerDiagnostics.length > 0) {
        lines.push('workerDiagnostics:');
        for (const entry of this.workerDiagnostics) {
          lines.push(`  - ${entry}`);
        }
      }
      await invoke('write_text_file', {
        workspacePath: this.config.workspacePath,
        relativePath: `.CodePapr/logs/agent-worker-crash-${stamp}.log`,
        content: `${lines.join('\n')}\n`,
      });
    } catch {
      // best-effort only — never disrupt crash recovery
    }
  }

  private async handleRefreshBootstrapRequest(bootstrapRequestId: string): Promise<void> {
    if (!this.config.onRefreshBootstrap) {
      this.postToWorker({
        type: 'refresh-bootstrap-response',
        bootstrapRequestId,
        success: true,
        bootstrap: null,
      } satisfies MainToAgentWorkerMessage);
      return;
    }
    try {
      const bootstrap = await this.config.onRefreshBootstrap();
      this.postToWorker({
        type: 'refresh-bootstrap-response',
        bootstrapRequestId,
        success: true,
        bootstrap: bootstrap ?? null,
      } satisfies MainToAgentWorkerMessage);
    } catch (err) {
      this.postToWorker({
        type: 'refresh-bootstrap-response',
        bootstrapRequestId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies MainToAgentWorkerMessage);
    }
  }

  private async handleFetchRequest(message: {
    fetchId: string;
    url: string;
    method: string;
    headers: Array<[string, string]>;
    body: Uint8Array | null;
  }): Promise<void> {
    const { fetchId, url, method, headers, body } = message;
    const fetchFn = getGlobalFetchFn();
    const controller = new AbortController();
    this.pendingFetchControllers.set(fetchId, controller);

    const requestHeaders = new Headers();
    for (const [name, value] of headers) {
      try {
        requestHeaders.set(name, value);
      } catch {
        // invalid header name/value - skip
      }
    }

    try {
      const response = await fetchFn(url, {
        method,
        headers: requestHeaders,
        body: body ? (body as unknown as BodyInit) : undefined,
        signal: controller.signal,
      });

      this.postToWorker({
        type: 'fetch-response-start',
        fetchId,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
      } satisfies MainToAgentWorkerMessage);

      if (!this.pendingFetchControllers.has(fetchId)) {
        // Cancelled while waiting for response headers; stop reading.
        return;
      }

      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (!value) {
              continue;
            }
            // Copy into a fresh buffer so we can safely transfer it without
            // detaching a shared backing buffer (some fetch implementations
            // return sub-views).
            const chunk = (value instanceof Uint8Array ? value : new Uint8Array(value)).slice();
            this.postToWorker(
              {
                type: 'fetch-response-chunk',
                fetchId,
                chunk,
              } satisfies MainToAgentWorkerMessage,
              [chunk.buffer]
            );
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // reader already released
          }
        }
      }

      if (this.pendingFetchControllers.has(fetchId)) {
        this.postToWorker({
          type: 'fetch-response-end',
          fetchId,
        } satisfies MainToAgentWorkerMessage);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (this.pendingFetchControllers.has(fetchId)) {
        this.postToWorker({
          type: 'fetch-response-error',
          fetchId,
          error: errorMessage,
        } satisfies MainToAgentWorkerMessage);
      }
    } finally {
      this.pendingFetchControllers.delete(fetchId);
    }
  }

  private scheduleStreamSnapshot(): void {
    if (!this.config.onStreamSnapshot) return;
    if (this.snapshotTimerId !== null) return;
    this.snapshotTimerId = setTimeout(() => {
      this.snapshotTimerId = null;
      this.config.onStreamSnapshot?.();
    }, STREAM_SNAPSHOT_INTERVAL_MS);
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimerId !== null) {
      clearTimeout(this.snapshotTimerId);
      this.snapshotTimerId = null;
    }
  }

  private clearCancelTimer(): void {
    if (this.cancelTimer !== null) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
  }

  private flushDeltas(pending: PendingWorkerRequest): void {
    if (pending.flushTimerId !== null) {
      clearTimeout(pending.flushTimerId);
      pending.flushTimerId = null;
    }
    if (pending.bufferedContentDelta) {
      pending.streamListener?.({ type: 'content-delta', delta: pending.bufferedContentDelta });
      pending.bufferedContentDelta = '';
    }
    if (pending.bufferedReasoningDelta) {
      pending.streamListener?.({ type: 'reasoning-delta', delta: pending.bufferedReasoningDelta });
      pending.bufferedReasoningDelta = '';
    }
  }

  private scheduleFlush(pending: PendingWorkerRequest): void {
    if (pending.flushTimerId !== null) return;
    pending.flushTimerId = setTimeout(() => {
      pending.flushTimerId = null;
      this.flushDeltas(pending);
    }, STREAM_DELTA_FLUSH_INTERVAL_MS);
  }

  private flushAppAgentDeltas(entry: {
    onStream?: (event: IChatStreamEvent) => void;
    bufferedContentDelta: string;
    bufferedReasoningDelta: string;
    flushTimerId: ReturnType<typeof setTimeout> | null;
  }): void {
    if (entry.flushTimerId !== null) {
      clearTimeout(entry.flushTimerId);
      entry.flushTimerId = null;
    }
    if (entry.bufferedContentDelta) {
      entry.onStream?.({ type: 'content-delta', delta: entry.bufferedContentDelta });
      entry.bufferedContentDelta = '';
    }
    if (entry.bufferedReasoningDelta) {
      entry.onStream?.({ type: 'reasoning-delta', delta: entry.bufferedReasoningDelta });
      entry.bufferedReasoningDelta = '';
    }
  }

  private scheduleAppAgentFlush(entry: {
    flushTimerId: ReturnType<typeof setTimeout> | null;
  } & Parameters<typeof this.flushAppAgentDeltas>[0]): void {
    if (entry.flushTimerId !== null) return;
    entry.flushTimerId = setTimeout(() => {
      entry.flushTimerId = null;
      this.flushAppAgentDeltas(entry);
    }, STREAM_DELTA_FLUSH_INTERVAL_MS);
  }
}
