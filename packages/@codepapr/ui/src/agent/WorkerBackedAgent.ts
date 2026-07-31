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
import { registerWorkspaceTools, type WorkspaceMutationListener } from '../tools/workspaceTools';
import { registerTodoListTools } from '../tools/todoListTool';
import { registerMcpTools } from '../tools/mcpTools';
import { hasEnabledMcpSearch } from '../utils/mcpTypes';
import type {
  AgentWorkerChatPayload,
  AgentWorkerToMainMessage,
  MainToAgentWorkerMessage,
  WorkerAgentParameters,
  WorkerAgentRuntimeConfig,
  WorkerAgentSettings,
  AppAgentPayload,
  AppAgentResult,
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

export interface AgentRuntimeHandle {
  chat(
    userInput: string,
    onStreamEvent?: (event: AgentRuntimeStreamEvent) => void,
    images?: IImageContent[]
  ): Promise<IAgentResponse>;
  getSession(): { logStore: AppendOnlyLog };
  cancel(): void;
  destroy(): void;
  /** Returns true if the worker has crashed and can no longer process messages. */
  isCrashed(): boolean;
  runAppAgent(
    payload: AppAgentPayload,
    onStream?: (event: IChatStreamEvent) => void,
    requestId?: string,
  ): Promise<AppAgentResult>;
  cancelAppAgent(requestId: string): void;
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
    },
  );

  // TodoList 工具：handler 改主线程的 store，由 Worker 通过 tool-request 桥回执行
  registerTodoListTools(registry, config.sessionId, '');

  registerMcpTools(registry, config.settings.mcp, config.runtime.mcpToolDefinitions ?? [], config.runtime.mcpToolMappings);

  const definitions = [...registry.getAll()];

  return {
    toolDefinitions: definitions,
    execute: async (toolName, args) => {
      return await registry.execute(toolName, args);
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
  private activeRequestId: string | null = null;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private crashed = false;
  private snapshotTimerId: ReturnType<typeof setTimeout> | null = null;
  // Tracks the log length the worker's per-session cache should currently hold.
  // When it matches this.logStore.length() the next chat syncs incrementally
  // (no full-log clone); a mismatch (first turn, resetToMessage, clear, pop,
  // compaction) falls back to a full sync. Fresh per WorkerBackedAgent instance,
  // so a recreated worker always starts with a full sync.
  private readonly workerSyncedLength = new Map<string, number>();

  constructor(private readonly config: WorkerBackedAgentConfig) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeInstance = this;
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
    this.worker.addEventListener('message', this.handleWorkerMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleWorkerMessageError);
  }

  isCrashed(): boolean {
    return this.crashed;
  }

  getSession(): { logStore: AppendOnlyLog } {
    return {
      logStore: this.logStore,
    };
  }

  cancel(): void {
    const requestId = this.activeRequestId;
    if (!requestId) return;

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.activeRequestId = null;
      return;
    }

    this.clearCancelTimer();
    this.clearSnapshotTimer();

    this.worker.postMessage({
      type: 'cancel-session',
      requestId,
    } satisfies MainToAgentWorkerMessage);

    this.cancelAllAppAgents();

    this.cancelTimer = setTimeout(() => {
      this.crashed = true;
      this.worker.terminate();
      pending.reject(new DOMException('Agent was terminated', 'AbortError'));
      this.pendingRequests.delete(requestId);
      this.activeRequestId = null;
      this.cancelTimer = null;
    }, 2000);
  }

  destroy(): void {
    this.cancel();
    this.clearCancelTimer();
    this.clearSnapshotTimer();
    this.abortAllPendingFetches();
    this.rejectAllAppAgentRequests(new Error('Agent was destroyed'));
    this.crashed = true;
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
    if (this.crashed) {
      throw new WorkerCrashError('Agent worker has crashed and cannot process messages. Create a new agent to retry.');
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
      this.worker.postMessage({ type: 'chat', payload } satisfies MainToAgentWorkerMessage);
    });

    return response;
  }

  async runAppAgent(
    payload: AppAgentPayload,
    onStream?: (event: IChatStreamEvent) => void,
    requestId: string = createId(),
  ): Promise<AppAgentResult> {
    if (this.crashed) {
      throw new WorkerCrashError('Agent worker has crashed. Create a new agent to retry.');
    }

    const result = await new Promise<AppAgentResult>((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        this.appAgentRequests.delete(requestId);
        reject(new Error('App agent request timed out (300s)'));
      }, 300_000);

      this.appAgentRequests.set(requestId, {
        resolve,
        reject,
        timeoutTimer,
        onStream,
        bufferedContentDelta: '',
        bufferedReasoningDelta: '',
        flushTimerId: null,
      });

      this.worker.postMessage({
        type: 'run-app-agent',
        requestId,
        payload,
      } satisfies MainToAgentWorkerMessage);
    });

    return result;
  }

  cancelAppAgent(requestId: string): void {
    this.worker.postMessage({
      type: 'cancel-app-agent',
      requestId,
    } satisfies MainToAgentWorkerMessage);
    const entry = this.appAgentRequests.get(requestId);
    if (entry) {
      this.flushAppAgentDeltas(entry);
      if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer);
      this.appAgentRequests.delete(requestId);
      entry.reject(new DOMException('App agent was cancelled', 'AbortError'));
    }
  }

  private cancelAllAppAgents(): void {
    for (const [reqId] of this.appAgentRequests) {
      this.worker.postMessage({
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
  }

  private readonly handleWorkerMessage = (event: MessageEvent<AgentWorkerToMainMessage>) => {
    const message = event.data;

    if (message.type === 'cancelled') {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.clearCancelTimer();
        this.clearSnapshotTimer();
        this.pendingRequests.delete(message.requestId);
        this.activeRequestId = null;
        this.flushDeltas(pending);
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

    if (message.type === 'app-agent-stream') {
      const entry = this.appAgentRequests.get(message.requestId);
      if (!entry?.onStream) return;

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
      }
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
        pending.pendingToolCalls = pending.pendingToolCalls.filter(
          (item) => item.toolCallId !== finishedToolCallId
        );
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

    if (message.type === 'tool-request') {
      // Prefer matching by tool-call id (robust even for concurrent identical
      // calls); fall back to name+arguments for older paths without an id.
      const match =
        (message.toolCallId
          ? pending.pendingToolCalls.find((item) => item.toolCallId === message.toolCallId)
          : undefined) ??
        pending.pendingToolCalls.find(
          (item) =>
            item.toolName === message.toolName &&
            item.argumentsKey === stableStringify(message.arguments)
        );

      void this.toolExecutor(message.toolName, message.arguments, {
        toolCallId: match?.toolCallId,
        onProgress: pending.streamListener
          ? (progressEvent) => {
              pending.streamListener?.(progressEvent);
            }
          : undefined,
      })
        .then((result) => {
          this.worker.postMessage({
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
          this.worker.postMessage({
            type: 'tool-response',
            payload: {
              requestId: message.requestId,
              toolRequestId: message.toolRequestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          } satisfies MainToAgentWorkerMessage);
        });
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
          this.worker.postMessage({
            type: 'proxy-chat-response',
            proxyChatId: message.proxyChatId,
            success: true,
            result: resp,
          } satisfies MainToAgentWorkerMessage);
        })
        .catch((error) => {
          this.worker.postMessage({
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
    this.clearSnapshotTimer();
    this.rejectAllAppAgentRequests(new WorkerCrashError(message, detail));

    const error = new WorkerCrashError(message, detail);
    for (const [requestId, pending] of this.pendingRequests) {
      this.flushDeltas(pending);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
    this.activeRequestId = null;

    this.abortAllPendingFetches();

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

      this.worker.postMessage({
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
            this.worker.postMessage(
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
        this.worker.postMessage({
          type: 'fetch-response-end',
          fetchId,
        } satisfies MainToAgentWorkerMessage);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (this.pendingFetchControllers.has(fetchId)) {
        this.worker.postMessage({
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
