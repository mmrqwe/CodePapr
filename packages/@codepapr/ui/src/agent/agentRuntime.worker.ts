/// <reference lib="webworker" />

import {
  Agent,
  AppendOnlyLog,
  buildSessionBootstrapPrompt,
  buildSkillsSection,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  ImmutablePrefix,
  Session,
  Serializer,
  resolveSubagentExecution,
  resolveToolContextOverrides,
  runSubagentSession,
  ToolRegistry,
  filterToolsForAgent,
  buildTaskToolDefinition,
  MERGE_TOOL_DEFINITIONS,
  type AgentDefinition,
  type SubagentSessionResult,
  type ToolOutputTruncationOptions,
  type ToolContextConfig,
  PERMISSION_WAITING_TOOL_TIMEOUTS,
  withTaskSlot,
} from '@codepapr/core';
import {
  DEFAULT_MAX_TOKENS,
  ClaudeProvider,
  DeepSeekProvider,
  LocalProvider,
  OpenAIProvider,
  ResponseProvider,
  DEFAULT_LOCAL_BASE_URL,
  RequestBuilder,
  CacheValidator,
  setGlobalFetchFn,
} from '@codepapr/api';
import type { IAgentResponse, IChatRequest, IChatResponse, ICacheStatistics, IChatStreamEvent, IMessage, ILLMProvider, IToolDefinition } from '@codepapr/types';
import {
  resolveAppAgentIdleTimeoutMs,
  type AgentWorkerChatPayload,
  type AgentWorkerToMainMessage,
  type MainToAgentWorkerMessage,
  type MidLoopCompactionCommit,
  type WorkerAgentSettings,
  type WorkerAgentRuntimeConfig,
  type WorkerApiFormat,
  type AppAgentPayload,
} from './agentWorkerProtocol';
import { buildPruneOptions, createContextCompactionHandler } from './compactionHandler';
import {
  CONTEXT_SURFACE_RENDER_VERSION,
  freezePruneParams,
} from '../utils/contextSurface';
import type { ContextCompactionIntent } from '@codepapr/types';
import type { CompactionSettings } from '../store/internals/types';
import {
  TOOL_IPC_TIMEOUT_MS,
  resolveToolIpcTimeoutMs,
  resolveGraphIpcTimeoutMs,
} from './toolIpcTimeouts';
// Shared with app_render validation (fail fast at render time instead of
// silently stripping tools the app's level does not grant).
import { agentToolsFor, legacyLevelToAccess } from '../papr/levelGrants';

declare const self: DedicatedWorkerGlobalScope;

interface ToolResponseWaiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

const toolResponseWaiters = new Map<string, ToolResponseWaiter>();

const sessionAbortControllers = new Map<string, AbortController>();
const appAgentAbortControllers = new Map<string, AbortController>();

// Per-session log cache so consecutive turns reuse the already-built history
// instead of re-cloning + re-hashing the full log every turn (incremental sync).
// Reset implicitly when the worker is recreated (new WorkerBackedAgent instance).
// Capped: each entry holds the full message history of a session, so an unbounded
// map would grow with every session ever opened in this worker.
const sessionLogs = new Map<string, AppendOnlyLog>();
const MAX_SESSION_LOGS = 8;

function setSessionLog(sessionId: string, log: AppendOnlyLog): void {
  sessionLogs.set(sessionId, log);
  while (sessionLogs.size > MAX_SESSION_LOGS) {
    const oldest = sessionLogs.keys().next().value;
    if (oldest === undefined) break;
    sessionLogs.delete(oldest);
  }
}

/** 等待主线程回传 `full-sync-response`（sync-mismatch 的应答）。按
 *  requestId 登记，随 cancel-session 的 waiter 清扫一并回收，避免取消后挂死。 */
const fullSyncWaiters = new Map<
  string,
  { resolve: (payload: { messages: IMessage[] }) => void; reject: (err: Error) => void }
>();

const chatResponseWaiters = new Map<
  string,
  {
    resolve: (value: IChatResponse) => void;
    reject: (error: Error) => void;
  }
>();

let nextChatRequestId = 0;

let nextToolRequestId = 0;

let nextFetchId = 0;

const bootstrapResponseWaiters = new Map<
  string,
  {
    resolve: (value: string | null) => void;
    reject: (error: Error) => void;
  }
>();

let nextBootstrapRequestId = 0;

const COMPACTION_COMMIT_TIMEOUT_MS = 60_000;
const compactionCommitWaiters = new Map<
  string,
  {
    resolve: (value: { success: boolean; generation?: number; compactionId?: string; error?: string }) => void;
    reject: (error: Error) => void;
  }
>();
let nextCompactionRequestId = 0;

// PR5（ADR-009 第11条）：re-recall 的回合内状态。activeChatAgent 供
// tool-response 分发时 push 新 insertion；每 chat 至多一次（第11条）。
let activeChatAgent: Agent | null = null;
let activeUserMessageId: string | null = null;
let reRecallPushedThisChat = false;

// 子代理（含 mentor）墙钟上限。流层改为无限重连后，长时间网络波动也会消耗
// 子代理预算；放宽到 20 分钟，避免「重连中」的子代理被墙钟误杀。
const SUBAGENT_WALL_CLOCK_TIMEOUT_MS = 1_200_000;
let permissionWaitActive = false;

let cachedSettings: WorkerAgentSettings | null = null;
let cachedToolDefinitions: IToolDefinition[] = [];
let cachedWorkspacePath = '';
let cachedRuntimeConfig: WorkerAgentRuntimeConfig | null = null;
const appAgentPrefixCache = new Map<string, ImmutablePrefix>();
const APP_AGENT_PREFIX_CACHE_MAX = 32;

function evictPrefixCacheIfNeeded() {
  if (appAgentPrefixCache.size <= APP_AGENT_PREFIX_CACHE_MAX) return;
  const excess = appAgentPrefixCache.size - APP_AGENT_PREFIX_CACHE_MAX;
  const keys = appAgentPrefixCache.keys();
  for (let i = 0; i < excess; i++) {
    const { value: oldest } = keys.next();
    if (!oldest) break;
    appAgentPrefixCache.delete(oldest);
  }
}

interface PendingFetch {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  bodyController: ReadableStreamDefaultController<Uint8Array> | null;
  bodyStream: ReadableStream<Uint8Array> | null;
  signal: AbortSignal | undefined;
  abortHandler: () => void;
  settled: boolean;
}

const pendingFetches = new Map<string, PendingFetch>();

function detachPendingFetch(fetchId: string): PendingFetch | undefined {
  const pending = pendingFetches.get(fetchId);
  if (!pending) {
    return undefined;
  }
  pendingFetches.delete(fetchId);
  if (pending.signal) {
    pending.signal.removeEventListener('abort', pending.abortHandler);
  }
  return pending;
}

function finalizePendingFetch(
  fetchId: string,
  action: 'close' | 'error',
  error?: Error
): void {
  const pending = detachPendingFetch(fetchId);
  if (!pending) {
    return;
  }
  if (action === 'close') {
    try {
      pending.bodyController?.close();
    } catch {
      // controller already closed or errored
    }
    if (!pending.settled) {
      // Defensive: end arrived without start; synthesize an empty 200 response.
      pending.resolve(new Response(null, { status: 200, statusText: 'OK' }));
      pending.settled = true;
    }
  } else {
    const err = error ?? new Error('fetch failed');
    try {
      pending.bodyController?.error(err);
    } catch {
      // controller already closed or errored
    }
    if (!pending.settled) {
      pending.settled = true;
      pending.reject(err);
    }
  }
}

async function encodeFetchBody(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }
  return new TextEncoder().encode(String(body));
}

async function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url: string;
  let method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  let bodyData: Uint8Array | null = null;

  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
    method = init?.method ?? input.method;
    const merged = new Headers(input.headers);
    if (init?.headers) {
      const override = new Headers(init.headers);
      for (const [k, v] of override.entries()) {
        merged.set(k, v);
      }
    }
    headers.delete('content-type');
    headers.delete('content-length');
    for (const [k, v] of merged.entries()) {
      headers.set(k, v);
    }
    if (init?.body !== undefined) {
      bodyData = await encodeFetchBody(init.body);
    } else if (input.body !== null && input.body !== undefined) {
      bodyData = await encodeFetchBody(input.body);
    }
  } else {
    url = String(input);
  }

  if (init?.body !== undefined && bodyData === null) {
    bodyData = await encodeFetchBody(init.body);
  }

  const fetchId = `fetch-${++nextFetchId}`;

  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
    },
    cancel() {
      postMessageToMain({ type: 'fetch-cancel', fetchId });
    },
  });

  const signal = init?.signal ?? undefined;
  const pending: PendingFetch = {
    resolve: () => {},
    reject: () => {},
    bodyController,
    bodyStream,
    signal,
    abortHandler: () => {
      postMessageToMain({ type: 'fetch-cancel', fetchId });
      const p = pendingFetches.get(fetchId);
      if (!p) {
        return;
      }
      if (!p.settled) {
        // fetch-response-start hasn't arrived yet; reject immediately and clean up.
        p.settled = true;
        pendingFetches.delete(fetchId);
        if (p.signal) {
          p.signal.removeEventListener('abort', p.abortHandler);
        }
        p.reject(new DOMException('The user aborted a request.', 'AbortError'));
        return;
      }
      // fetch-response-start already resolved the promise; leave the entry in
      // the map so the subsequent fetch-response-error/end can close or error
      // the bodyController and unblock the provider's body reader.
    },
    settled: false,
  };

  const promise = new Promise<Response>((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });

  pendingFetches.set(fetchId, pending);

  if (signal) {
    if (signal.aborted) {
      pending.abortHandler();
      return promise;
    }
    signal.addEventListener('abort', pending.abortHandler, { once: true });
  }

  postMessageToMain({
    type: 'fetch-request',
    fetchId,
    url,
    method,
    headers: Array.from(headers.entries()),
    body: bodyData,
  });

  return await promise;
}

setGlobalFetchFn(proxyFetch);

const subagentCacheStatsMap = new Map<
  string,
  Array<{ tier: 'primary' | 'fast' | 'mentor'; stats: ICacheStatistics }>
>();

async function withIdleTimeout<T>(
  agent: Agent,
  promiseFactory: (notifyActivity: () => void) => Promise<T>,
  timeoutMs: number,
  lang?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectFn: ((err: Error) => void) | undefined;
  let settled = false;

  const armTimer = () => {
    if (settled) return;
    if (timer !== undefined) clearTimeout(timer);
    if (permissionWaitActive) {
      timer = undefined;
      return;
    }
    timer = setTimeout(() => {
      if (settled) return;
      if (permissionWaitActive) {
        timer = undefined;
        return;
      }
      settled = true;
      agent.cancel();
      rejectFn?.(new Error(
        lang === 'zh-TW'
          ? `子代理執行超時（${timeoutMs / 1000} 秒無活動）`
          : lang === 'zh-CN'
          ? `子代理执行超时（${timeoutMs / 1000} 秒无活动）`
          : `Sub-agent execution timed out (no activity for ${timeoutMs / 1000}s)`
      ));
    }, timeoutMs);
  };

  try {
    return await new Promise<T>((resolve, reject) => {
      rejectFn = reject;
      armTimer();

      promiseFactory(armTimer).then(
        (result) => {
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          resolve(result);
        },
        (err) => {
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          reject(err);
        }
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function postMessageToMain(message: AgentWorkerToMainMessage): void {
  self.postMessage(message);
}

function buildSubagentCacheStatsByTier(
  mainStats: ICacheStatistics | undefined,
  subEntries: Array<{ tier: 'primary' | 'fast' | 'mentor'; stats: ICacheStatistics }>,
): {
  cacheStats: ICacheStatistics | undefined;
  byTier: { primary?: ICacheStatistics; fast?: ICacheStatistics; mentor?: ICacheStatistics };
} {
  if (subEntries.length === 0) {
    return { cacheStats: mainStats, byTier: {} };
  }
  const byTier: { primary?: ICacheStatistics; fast?: ICacheStatistics; mentor?: ICacheStatistics } = {};
  for (const entry of subEntries) {
    const existing = byTier[entry.tier];
    byTier[entry.tier] = existing
      ? mergeTwoCacheStats(existing, entry.stats)
      : { ...entry.stats };
  }
  // Keep `cacheStats` as the main-agent-only total so the dashboard can
  // attribute subagent usage by tier without double counting.
  return { cacheStats: mainStats, byTier };
}

function mergeTwoCacheStats(
  a: ICacheStatistics,
  b: ICacheStatistics,
): ICacheStatistics {
  const promptCacheHitTokens =
    typeof a.promptCacheHitTokens === 'number' || typeof b.promptCacheHitTokens === 'number'
      ? (a.promptCacheHitTokens ?? 0) + (b.promptCacheHitTokens ?? 0)
      : undefined;
  const promptCacheMissTokens =
    typeof a.promptCacheMissTokens === 'number' || typeof b.promptCacheMissTokens === 'number'
      ? (a.promptCacheMissTokens ?? 0) + (b.promptCacheMissTokens ?? 0)
      : undefined;
  const cacheReadTokens = a.cacheReadTokens + b.cacheReadTokens;
  const cacheCreationTokens = a.cacheCreationTokens + b.cacheCreationTokens;
  const newInputTokens = a.newInputTokens + b.newInputTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  const totalInput = newInputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    cacheReadTokens,
    cacheCreationTokens,
    newInputTokens,
    outputTokens,
    cacheHitRate: totalInput > 0 ? cacheReadTokens / totalInput : 0,
    calls: (a.calls ?? 0) + (b.calls ?? 0),
    ...(typeof promptCacheHitTokens === 'number' ? { promptCacheHitTokens } : {}),
    ...(typeof promptCacheMissTokens === 'number' ? { promptCacheMissTokens } : {}),
  };
}

function buildProvider(settings: WorkerAgentSettings) {
  if (settings.apiMode === 'local') {
    return new LocalProvider({
      apiKey: settings.apiKey.trim() || 'local',
      baseURL: settings.baseURL.trim().replace(/\/+$/, '') || DEFAULT_LOCAL_BASE_URL,
      idleTimeoutMs: settings.streamIdleTimeoutMs,
    });
  }

  const config: { apiKey: string; baseURL?: string; idleTimeoutMs?: number } = {
    apiKey: settings.apiKey.trim(),
    idleTimeoutMs: settings.streamIdleTimeoutMs,
  };
  if (settings.apiMode === 'custom') {
    config.baseURL = settings.baseURL.trim().replace(/\/+$/, '');
  }

  switch (settings.provider) {
    case 'deepseek':
      return new DeepSeekProvider(config);
    case 'claude':
      return new ClaudeProvider(config);
    case 'response':
      return new ResponseProvider(config);
    default:
      return new OpenAIProvider(config);
  }
}

function createLog(sessionId: string, messages: IMessage[]): AppendOnlyLog {
  const log = new AppendOnlyLog(sessionId);
  if (messages.length === 0) {
    return log;
  }

  log.loadFromSnapshot({
    messages,
    lastMessageIndex: messages.length - 1,
    // Use Serializer.getByteLength (sorted-key JSON) to match the byte accounting
    // AppendOnlyLog.loadFromSnapshot validates against; plain JSON.stringify only
    // happens to match by length and would spuriously throw if formatting changed.
    totalBytes: messages.reduce((sum, message) => sum + Serializer.getByteLength(message), 0),
  });
  return log;
}

/** 增量同步前缀校验失败时的全量重建：向主线程换取该会话的完整日志，
 *  原地重建缓存后返回（调用方负责继续追加本回合的新消息）。
 *  取消时由 cancel-session 的 waiter 清扫（`fullSyncWaiters`）拒绝。 */
async function requestFullSync(
  requestId: string,
  sessionId: string,
  signal: AbortSignal
): Promise<AppendOnlyLog> {
  postMessageToMain({ type: 'sync-mismatch', requestId, sessionId });
  const payload = await new Promise<{ messages: IMessage[] }>((resolve, reject) => {
    const onAbort = (): void => {
      if (fullSyncWaiters.get(requestId) === waiter) {
        fullSyncWaiters.delete(requestId);
        reject(new DOMException('Session was cancelled', 'AbortError'));
      }
    };
    const waiter = {
      // resolve 时摘除监听：回合正常结束后 abort 永不触发，滞留监听会把
      // 已结算的闭包挂在 AbortController 上。
      resolve: (value: { messages: IMessage[] }): void => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      reject,
    };
    fullSyncWaiters.set(requestId, waiter);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const log = createLog(sessionId, payload.messages);
  setSessionLog(sessionId, log);
  return log;
}

async function requestToolExecution(
  requestId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = TOOL_IPC_TIMEOUT_MS,
  toolCallId?: string,
  appAccess?: { network: boolean; workspaceWrite: boolean; allowCodepaprApps?: boolean },
  signal?: AbortSignal
): Promise<unknown> {
  const toolRequestId = `${requestId}:${++nextToolRequestId}`;

  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }

  let rejectTool!: (error: Error) => void;
  // 父级取消/工具超时：通知主线程中止正在执行的工具（杀 bash 进程等），
  // 并立即拒绝，避免主线程的工具在后台继续跑完、副作用滞后落地。
  const onAbort = (): void => {
    toolResponseWaiters.delete(toolRequestId);
    postMessageToMain({
      type: 'cancel-tool-request',
      requestId,
      toolRequestId,
    } satisfies AgentWorkerToMainMessage);
    rejectTool(new DOMException('已取消', 'AbortError'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const result = new Promise<unknown>((resolve, reject) => {
    rejectTool = reject;
    const waiter: ToolResponseWaiter = {
      resolve: (value: unknown) => {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        resolve(value);
      },
      reject: (error: Error) => {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        reject(error);
      },
      timeoutMs,
    };
    const armTimer = () => {
      if (permissionWaitActive) return;
      waiter.timer = setTimeout(() => {
        toolResponseWaiters.delete(toolRequestId);
        // IPC 超时同样通知主线程中止工具执行（杀 bash 进程等）——旧实现
        // 只 reject 本地 waiter，主线程的工具会继续跑完、副作用滞后落地。
        postMessageToMain({
          type: 'cancel-tool-request',
          requestId,
          toolRequestId,
        } satisfies AgentWorkerToMainMessage);
        reject(new Error(`工具 IPC 超时: ${toolName} (${timeoutMs / 1000}s)`));
      }, timeoutMs);
    };

    toolResponseWaiters.set(toolRequestId, waiter);
    armTimer();
  });

  try {
    postMessageToMain({
      type: 'tool-request',
      requestId,
      toolRequestId,
      toolName,
      arguments: args,
      ...(toolCallId ? { toolCallId } : {}),
      // PR5（ADR-009 第11条）：memory_search 需要 recall anchor。
      ...(toolName === 'memory_search' && activeUserMessageId
        ? { userMessageId: activeUserMessageId }
        : {}),
      ...(appAccess ? { appAccess } : {}),
    });

    // 竞态防护：signal 可能在检查与 postMessage 之间被 abort（cancel-tool-request
    // 会先于 tool-request 到达主线程而被忽略）。发出后再查一次，必要时补发取消。
    if (signal?.aborted) {
      toolResponseWaiters.delete(toolRequestId);
      postMessageToMain({
        type: 'cancel-tool-request',
        requestId,
        toolRequestId,
      } satisfies AgentWorkerToMainMessage);
      rejectTool(new DOMException('已取消', 'AbortError'));
    }

    return await result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function setPermissionWaitActive(waiting: boolean): void {
  permissionWaitActive = waiting;
  if (waiting) {
    for (const waiter of toolResponseWaiters.values()) {
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
        waiter.timer = undefined;
      }
    }
  } else {
    for (const [toolRequestId, waiter] of toolResponseWaiters) {
      if (waiter.timer !== undefined) continue;
      waiter.timer = setTimeout(() => {
        toolResponseWaiters.delete(toolRequestId);
        waiter.reject(new Error(`工具 IPC 超时 (${waiter.timeoutMs / 1000}s)`));
      }, waiter.timeoutMs);
    }
  }
}

async function _proxyChatRequest(
  requestId: string,
  config: { apiKey: string; baseURL?: string; format: WorkerApiFormat },
  chatRequest: IChatRequest,
): Promise<IChatResponse> {
  const proxyChatId = `${requestId}:chat-${++nextChatRequestId}`;

  const result = new Promise<IChatResponse>((resolve, reject) => {
    chatResponseWaiters.set(proxyChatId, { resolve, reject });
  });

  postMessageToMain({
    type: 'proxy-chat',
    requestId,
    proxyChatId,
    config,
    chatRequest,
  });

  return await result;
}

const BOOTSTRAP_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Ask the main thread to rebuild the session bootstrap with fresh disk state
 * (memory.md). Mirrors the proxy-chat request/response pattern. Resolves to the
 * fresh bootstrap string, or null when main has no refresher / empty result.
 * Times out (resolving null) so a stalled refresh never wedges compaction.
 */
async function _refreshBootstrapRequest(requestId: string): Promise<string | null> {
  const bootstrapRequestId = `${requestId}:bootstrap-${++nextBootstrapRequestId}`;

  const result = new Promise<string | null>((resolve, reject) => {
    bootstrapResponseWaiters.set(bootstrapRequestId, { resolve, reject });
  });

  const timer = setTimeout(() => {
    const waiter = bootstrapResponseWaiters.get(bootstrapRequestId);
    if (waiter) {
      bootstrapResponseWaiters.delete(bootstrapRequestId);
      waiter.resolve(null);
    }
  }, BOOTSTRAP_REFRESH_TIMEOUT_MS);

  postMessageToMain({
    type: 'refresh-bootstrap-request',
    requestId,
    bootstrapRequestId,
  });

  try {
    return await result;
  } finally {
    clearTimeout(timer);
  }
}

function intentFromCommit(
  sessionId: string,
  commit: MidLoopCompactionCommit,
  settings: WorkerAgentSettings
): ContextCompactionIntent {
  const payload = commit.checkpointMessage.contextCheckpoint;
  return {
    sessionId,
    trigger: payload?.trigger ?? 'token-limit',
    sourceGeneration: typeof payload?.parentGeneration === 'number' ? payload.parentGeneration : null,
    checkpointMessageId: commit.checkpointMessageId,
    sourceMessageIds: commit.sourceMessageIds,
    retainedMessageIds: commit.retainedMessageIds,
    renderParams: {
      pruneParams: freezePruneParams(buildPruneOptions(settings as unknown as CompactionSettings)),
      renderVersion: CONTEXT_SURFACE_RENDER_VERSION,
    },
    tokenStats: payload?.tokenStats ?? {
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      sourceTokens: 0,
      checkpointTokens: 0,
    },
    summaryInfo: payload?.summaryInfo ?? { kind: 'local-fallback' },
  };
}

/**
 * ADR-005：mid-loop 压缩提交走 CommitContextCompaction 协议。
 * 主线程校验 + 单事务持久化后应答；失败则本轮不 replaceLog。
 */
async function _commitContextCompactionRequest(
  chatRequestId: string,
  sessionId: string,
  commit: MidLoopCompactionCommit,
  settings: WorkerAgentSettings
): Promise<void> {
  const requestId = `${chatRequestId}:compaction-${++nextCompactionRequestId}`;
  const result = new Promise<{
    success: boolean;
    generation?: number;
    compactionId?: string;
    error?: string;
  }>((resolve, reject) => {
    compactionCommitWaiters.set(requestId, { resolve, reject });
  });

  const timer = setTimeout(() => {
    const waiter = compactionCommitWaiters.get(requestId);
    if (waiter) {
      compactionCommitWaiters.delete(requestId);
      waiter.reject(new Error('压缩提交超时'));
    }
  }, COMPACTION_COMMIT_TIMEOUT_MS);

  postMessageToMain({
    type: 'commit-context-compaction',
    chatRequestId,
    request: {
      requestId,
      intent: intentFromCommit(sessionId, commit, settings),
      commit,
    },
  });

  try {
    const response = await result;
    if (!response.success) {
      throw new Error(response.error || '压缩提交失败');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runSubagent(
  requestId: string,
  payload: AgentWorkerChatPayload,
  definition: AgentDefinition,
  prompt: string,
  currentDepth: number,
  abortSignal?: AbortSignal
): Promise<SubagentSessionResult> {
  const registry = createRegistry(requestId, payload, false, currentDepth);
  const tools = filterToolsForAgent(registry.getAll(), definition.tools);
  const s = payload.settings;

  const exec = resolveSubagentExecution({
    definition,
    currentDepth,
    taskPrompt: prompt,
    baseModel: payload.model,
    fastModel: s.fastModel,
    fastModelEnabled: s.fastModelEnabled,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    globalMaxToolRounds: s.maxToolRounds,
    thinkingFallback: s.thinkingEnabled ?? true,
    reasoningEffort: s.thinkingEffort ?? '',
    thinkingBudgetTokens: s.thinkingBudgetTokens ?? 0,
    thinkingPayload: s.thinkingPayload,
    explore: {
      topP: s.exploreTopP,
      maxTokens: s.exploreMaxTokens,
      thinkingEnabled: s.exploreThinkingEnabled,
      temperature: s.exploreTemperature,
      maxToolRounds: s.exploreMaxToolRounds,
      maxDepth: s.exploreMaxDepth,
    },
    scout: {
      topP: s.scoutTopP,
      maxTokens: s.scoutMaxTokens,
      thinkingEnabled: s.scoutThinkingEnabled,
      temperature: s.scoutTemperature,
      maxToolRounds: s.scoutMaxToolRounds,
      maxDepth: s.scoutMaxDepth,
    },
    mentor: {
      enabled: s.mentorEnabled,
      model: s.mentorModel,
      apiKey: s.mentorApiKey,
      baseURL: s.mentorBaseURL,
      apiFormat: s.mentorApiFormat,
      maxTokens: s.mentorMaxTokens,
      thinkingEnabled: s.mentorThinkingEnabled,
      thinkingEffort: s.mentorThinkingEffort ?? '',
      thinkingBudgetTokens: s.mentorThinkingBudgetTokens ?? 0,
      thinkingPayload: s.mentorThinkingPayload,
    },
    fallbackApiKey: s.apiKey,
    fallbackBaseURL: s.baseURL,
  });

  let subagentProvider: ILLMProvider = buildProvider(payload.settings);
  let subagentProviderName: 'deepseek' | 'openai' | 'claude' | 'response' = payload.providerName;
  if (exec.mentor) {
    const config = { apiKey: exec.mentor.apiKey, ...(exec.mentor.baseURL ? { baseURL: exec.mentor.baseURL } : {}) };
    if (exec.mentor.apiFormat === 'claude') {
      subagentProvider = new ClaudeProvider(config);
      subagentProviderName = 'claude';
    } else if (exec.mentor.apiFormat === 'response') {
      subagentProvider = new ResponseProvider(config);
      subagentProviderName = 'response';
    } else {
      subagentProvider = new OpenAIProvider(config);
      subagentProviderName = 'openai';
    }
  }

  const runId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `subagent-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  postMessageToMain({
    type: 'subagent-progress',
    requestId,
    action: 'start',
    runId,
    agent: definition.name,
    prompt,
  });

  try {
    const result = await runSubagentSession({
      definition,
      prompt,
      workspacePath: payload.workspacePath,
      lang: payload.runtime.lang,
      exec,
      registry,
      tools,
      provider: subagentProvider,
      providerName: subagentProviderName,
      requestBuilder: new RequestBuilder(),
      cacheValidator: new CacheValidator(),
      skillsSection: buildSkillsSection(payload.runtime.skillDefinitions ?? [], payload.runtime.lang),
      customPromptSection: payload.runtime.customPrompt,
      graphToolTimeoutMs: s.graphToolTimeoutMs,
      maxWallClockMs: SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
      abortSignal,
      toolOutputTruncation: buildToolOutputTruncation(payload.settings),
      toolContextConfig: buildToolContextConfig(payload.settings),
      onToolCallEnd: (event) => {
        postMessageToMain({
          type: 'subagent-progress',
          requestId,
          action: 'step',
          runId,
          step: {
            name: event.toolName,
            status: event.success ? 'success' : 'error',
            summary: event.error || event.toolName,
          },
        });
      },
    });
    postMessageToMain({
      type: 'subagent-progress',
      requestId,
      action: 'complete',
      runId,
      content: result.content,
    });
    return result;
  } catch (error) {
    postMessageToMain({
      type: 'subagent-progress',
      requestId,
      action: 'complete',
      runId,
      content: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function createRegistry(
  requestId: string,
  payload: AgentWorkerChatPayload,
  includeTaskTool: boolean,
  currentDepth: number = 0,
  onToolActivity?: (phase: 'start' | 'end') => void
): ToolRegistry {
  const registry = new ToolRegistry();
  const toolIpcTimeoutMs = payload.settings.toolIpcTimeoutMs ?? TOOL_IPC_TIMEOUT_MS;
  // graph 构建可远超默认 IPC 120s：其 Agent 级超时已配置 graphToolTimeoutMs，
  // IPC 层必须同步放宽（否则 120s 定时器先于 Agent 级 600s 开火误杀大仓库构建）。
  const graphIpcTimeoutMs = resolveGraphIpcTimeoutMs(
    toolIpcTimeoutMs,
    payload.settings.graphToolTimeoutMs
  );

  // 工具执行期间通知外层（聊天回合的空闲兜底以此暂停/恢复，避免长 bash/子代理
  // 在合法运行中被 "Agent idle timeout" 误杀；工具自身超时由 IPC 定时器保证）。
  const runWithActivity = <T>(run: () => Promise<T>): Promise<T> => {
    onToolActivity?.('start');
    return run().finally(() => onToolActivity?.('end'));
  };

  for (const tool of payload.toolDefinitions) {
    registry.register(tool, async (args, context) => {
      const timeout =
        tool.name === 'graph'
          ? graphIpcTimeoutMs
          : resolveToolIpcTimeoutMs(tool.name, args, toolIpcTimeoutMs);
      return await runWithActivity(() =>
        requestToolExecution(
          requestId,
          tool.name,
          args,
          timeout,
          context?.toolCallId,
          context?.appAccess,
          context?.signal
        )
      );
    });
  }

  // graph 对主代理软隐藏（不在 payload.toolDefinitions 的主代理 LLM 工具集中），但子代理（如 Explore）
  // 可能经白名单选取它。这里补注册一个代理 handler，使子代理过滤（getAll）与执行可用；主代理前缀用 getLlmTools() 排除。
  if (!registry.has('graph')) {
    const graphDef = MERGE_TOOL_DEFINITIONS.find((t) => t.name === 'graph');
    if (graphDef) {
      registry.register(graphDef, async (args, context) => {
        return await runWithActivity(() =>
          requestToolExecution(
            requestId,
            'graph',
            args,
            graphIpcTimeoutMs,
            context?.toolCallId,
            context?.appAccess,
            context?.signal
          )
        );
      });
      // Soft-hide so the main agent's getLlmTools() excludes graph (matching the
      // main thread's exposeGraphToLlm:false default). Subagents still select it
      // via getAll()+whitelist (filterToolsForAgent), which includes soft-hidden
      // tools.
      registry.softHideFromLlm('graph');
    }
  }

  if (includeTaskTool && (payload.runtime.agentDefinitions?.length ?? 0) > 0) {
    const definition = buildTaskToolDefinition(payload.runtime.agentDefinitions ?? [], payload.runtime.lang);
    if (!definition) {
      return registry;
    }

    registry.register(definition, async (args, context) => {
      const name = typeof args.agent === 'string' ? args.agent.trim() : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!name) {
        throw new Error('task.agent 必须是子代理名称');
      }
      if (!prompt) {
        throw new Error('task.prompt 不能为空');
      }
      const target = (payload.runtime.agentDefinitions ?? []).find((agent) => agent.name === name);
      if (!target) {
        throw new Error(`未找到子代理: ${name}`);
      }
      if (target.internal) {
        throw new Error(`子代理 "${name}" 是内部代理，不能直接委派`);
      }

      const result = await runWithActivity(() =>
        withTaskSlot(() =>
          runSubagent(requestId, payload, target, prompt, currentDepth + 1, context?.signal)
        )
      );
      if (result.cacheStats) {
        const existing = subagentCacheStatsMap.get(requestId);
        const entry = { tier: result.tier, stats: result.cacheStats };
        if (existing) {
          existing.push(entry);
        } else {
          subagentCacheStatsMap.set(requestId, [entry]);
        }
      }
      return {
        agent: name,
        content: result.content,
        steps: result.steps,
        __subagentToolInvocations: result.toolInvocations,
      };
    });
  }

  return registry;
}

function buildToolOutputTruncation(s: WorkerAgentSettings): ToolOutputTruncationOptions {
  return {
    interceptChars: s.toolOutputInterceptChars,
    offloadChars: s.toolOutputOffloadChars,
    offloadPreviewChars: s.toolOutputPreviewChars,
    middleKeepChars: s.toolOutputMiddleKeepChars,
    ceilingChars: s.toolOutputCeilingChars,
  };
}

function buildToolContextConfig(s: WorkerAgentSettings): ToolContextConfig {
  return {
    defaultMode: s.toolContextDefaultMode,
    overrides: resolveToolContextOverrides(s.toolContextOverrides),
    summaryMaxChars: s.toolContextSummaryMaxChars,
    autoThresholdChars: s.toolContextAutoThresholdChars,
  };
}

async function handleRunAppAgent(
  payload: AppAgentPayload,
  requestId: string
): Promise<void> {
  if (!cachedSettings) {
    postMessageToMain({
      type: 'app-agent-error',
      requestId,
      error: 'No LLM settings available. Open a chat session first.',
    });
    return;
  }

  const BLOCKED = new Set(['task', 'app_render']);
  const requestedTools = payload.tools ?? [];

  // 两轴访问：local（无/只读/读写执行）× network（关/开）；旧 level 迁移
  const access = {
    local: (payload.local ?? (payload.level !== undefined ? legacyLevelToAccess(payload.level).local : 'none')) as 'none' | 'read' | 'write',
    network: payload.network ?? (payload.level !== undefined ? legacyLevelToAccess(payload.level).network : false),
  };
  const allowedTools = agentToolsFor(access.local, access.network);
  /** app 沙箱访问档：主线程执行 bash 等工具时按此构建沙箱（网络/写按轴收窄）。
   *  write/edit/patch 在 local=write 时直接写项目文件（与主 agent 同权，主线程自带路径校验），
   *  不再重定向到 app sandbox 目录。 */
  const appAccess = { network: access.network, workspaceWrite: access.local === 'write', allowCodepaprApps: true };

  const toolIpcTimeoutMs = cachedSettings.toolIpcTimeoutMs ?? TOOL_IPC_TIMEOUT_MS;

  // A running tool counts as activity for the idle watchdog. notifyActivity
  // only exists once agent.chat starts, so bridge it through a mutable ref.
  let toolActivity: (() => void) | null = null;

  const registry = new ToolRegistry();
  for (const tool of cachedToolDefinitions) {
    if (BLOCKED.has(tool.name)) continue;
    if (tool.name.startsWith('mcp__')) {
      if (!access.network) continue;
      if (requestedTools.length > 0 && !requestedTools.includes(tool.name)) continue;
    } else {
      if (!allowedTools.has(tool.name)) continue;
      if (requestedTools.length > 0 && !requestedTools.includes(tool.name)) continue;
    }

    registry.register(tool, async (args, context) => {
      toolActivity?.();
      try {
        return await requestToolExecution(
          requestId,
          tool.name,
          args,
          resolveToolIpcTimeoutMs(tool.name, args, toolIpcTimeoutMs),
          context?.toolCallId,
          appAccess,
          context?.signal
        );
      } finally {
        toolActivity?.();
      }
    });
  }

  let systemPrompt = payload.systemPrompt || 'You are a helpful assistant.';
  const workspacePath = payload.workspacePath || cachedWorkspacePath;

  const extraSections: string[] = [systemPrompt];
  const ctx = payload.inheritContext;
  if (ctx?.projectRules && cachedRuntimeConfig?.rulesSection) {
    extraSections.push(cachedRuntimeConfig.rulesSection);
  }

  if (workspacePath) {
    const enrichedPrompt = buildRuntimeSystemPrompt({
      mode: 'agent',
      workspacePath,
      lang: cachedSettings.lang,
      extraSections,
      toolNames: registry.getAll().map(t => t.name),
      subagent: true,
    });
    if (enrichedPrompt.trim()) {
      systemPrompt = enrichedPrompt;
    }
  }

  let model: string = payload.model || 'main';
  const ALLOWED_MODEL_TIERS = new Set(['main', 'fast', 'mentor']);
  if (!ALLOWED_MODEL_TIERS.has(model)) {
    model = 'main';
  }
  if (model === 'main') {
    model = cachedSettings.appSubAgentModelTier === 'fast'
      ? (cachedSettings.fastModel || cachedSettings.model)
      : cachedSettings.model;
  } else if (model === 'fast') {
    model = cachedSettings.fastModel || cachedSettings.model;
  } else if (model === 'mentor') {
    // mentorEnabled 关闭时不允许借用 mentor 模型名，回落到主模型。
    model = cachedSettings.mentorEnabled
      ? (cachedSettings.mentorModel || cachedSettings.model)
      : cachedSettings.model;
  }

  let agentProvider: ILLMProvider = buildProvider(cachedSettings);
  let agentProviderName: 'deepseek' | 'openai' | 'claude' | 'response' = cachedSettings.provider;

  const isMentor = payload.model === 'mentor' && cachedSettings.mentorEnabled;
  if (isMentor) {
    const s = cachedSettings;
    if (s.mentorModel.trim()) {
      model = s.mentorModel.trim();
      const apiKey = s.mentorApiKey.trim() || s.apiKey.trim();
      const mentorBaseURL = s.mentorBaseURL.trim().replace(/\/+$/, '');
      const baseURL = mentorBaseURL || s.baseURL.trim().replace(/\/+$/, '') || undefined;
      const config = { apiKey, ...(baseURL ? { baseURL } : {}) };
      if (s.mentorApiFormat === 'claude') {
        agentProvider = new ClaudeProvider(config);
        agentProviderName = 'claude';
      } else if (s.mentorApiFormat === 'response') {
        agentProvider = new ResponseProvider(config);
        agentProviderName = 'response';
      } else {
        agentProvider = new OpenAIProvider(config);
        agentProviderName = 'openai';
      }
    } else {
      console.warn('[App Agent] Mentor model not set, falling back to main provider');
      model = cachedSettings.model;
    }
  }

  const maxToolRounds = Math.min(
    payload.maxToolRounds ?? cachedSettings.appSubAgentMaxToolRounds,
    cachedSettings.appSubAgentMaxToolRounds,
    cachedSettings.maxToolRounds
  );
  const parameters = {
    temperature: 0.5,
    topP: 0.9,
    maxTokens: isMentor ? (cachedSettings.mentorMaxTokens ?? 10000) : cachedSettings.maxTokens,
    thinkingEnabled: isMentor ? (cachedSettings.mentorThinkingEnabled ?? false) : cachedSettings.appSubAgentThinkingEnabled,
    // 强度继承：mentor 模型用 mentor 强度，否则跟随主模型强度
    ...(isMentor
      ? { reasoningEffort: cachedSettings.mentorThinkingEffort ?? '' }
      : { reasoningEffort: cachedSettings.thinkingEffort ?? '' }),
    ...(isMentor
      ? { thinkingBudgetTokens: cachedSettings.mentorThinkingBudgetTokens ?? 0 }
      : { thinkingBudgetTokens: cachedSettings.thinkingBudgetTokens ?? 0 }),
    thinkingPayload: isMentor
      ? cachedSettings.mentorThinkingPayload
      : cachedSettings.thinkingPayload,
  };

  const log = new AppendOnlyLog(`app-agent-${payload.appId}-${Date.now()}`);

  if (ctx && (ctx.skills || ctx.customPrompt || ctx.projectMemory) && cachedRuntimeConfig) {
    const skillsSection = ctx.skills
      ? buildSkillsSection(cachedRuntimeConfig.skillDefinitions ?? [], cachedSettings.lang)
      : undefined;
    const customPromptSection = ctx.customPrompt
      ? ((cachedRuntimeConfig.customPrompt ?? '').trim() || undefined)
      : undefined;
    const memorySection = ctx.projectMemory
      ? ((cachedRuntimeConfig.memorySection ?? '').trim() || undefined)
      : undefined;
    if (skillsSection || customPromptSection || memorySection) {
      const bootstrapPrompt = buildSessionBootstrapPrompt({
        workspacePath,
        lang: cachedSettings.lang,
        skillsSection,
        customPromptSection,
        memorySection,
      });
      if (bootstrapPrompt.trim()) {
        await log.append({
          id: `app-agent-bootstrap-${Date.now()}`,
          role: 'assistant',
          content: bootstrapPrompt.trim(),
          timestamp: Date.now(),
          metadata: { sessionBootstrap: true, isPrefixSystem: true },
        });
      }
    }
  }

  const userPrompt = buildRuntimeUserPrompt({
    mode: 'agent',
    input: payload.task,
    workspacePath,
    lang: cachedSettings.lang,
  });

  const prefixKey = [payload.appId, model, ...registry.getAll().map(t => t.name).sort(), JSON.stringify(parameters), systemPrompt].join('|');
  let prefix = appAgentPrefixCache.get(prefixKey);
  if (!prefix) {
    prefix = new ImmutablePrefix({
      systemPrompt,
      tools: registry.getAll(),
      model,
      parameters,
    });
    appAgentPrefixCache.set(prefixKey, prefix);
    evictPrefixCacheIfNeeded();
  }

  const session = new Session({
    sessionId: `app-agent-${payload.appId}-${Date.now()}`,
    prefix,
    toolRegistry: registry,
    log,
  });

  const agent = new Agent({
    session,
    provider: agentProvider,
    providerName: agentProviderName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds,
    toolTimeouts: { ...PERMISSION_WAITING_TOOL_TIMEOUTS },
    toolOutputTruncation: buildToolOutputTruncation(cachedSettings),
    toolContextConfig: buildToolContextConfig(cachedSettings),
  });

  const steps: Array<{ name: string; status: string; summary?: string }> = [];
  const abortController = new AbortController();
  appAgentAbortControllers.set(requestId, abortController);

  const STREAM_FLUSH_INTERVAL_MS = 80;
  const STREAM_BUFFER_CHARS = 4096;
  let bufferedContent = '';
  let bufferedReasoning = '';
  let flushTimerId: ReturnType<typeof setTimeout> | null = null;

  function flushStreamBuffer() {
    if (flushTimerId !== null) {
      clearTimeout(flushTimerId);
      flushTimerId = null;
    }
    const events: IChatStreamEvent[] = [];
    if (bufferedContent) {
      events.push({ type: 'content-delta', delta: bufferedContent } as IChatStreamEvent);
      bufferedContent = '';
    }
    if (bufferedReasoning) {
      events.push({ type: 'reasoning-delta', delta: bufferedReasoning } as IChatStreamEvent);
      bufferedReasoning = '';
    }
    for (const evt of events) {
      postMessageToMain({ type: 'app-agent-stream', requestId, event: evt });
    }
  }

  function scheduleStreamFlush() {
    if (flushTimerId !== null) return;
    flushTimerId = setTimeout(flushStreamBuffer, STREAM_FLUSH_INTERVAL_MS);
  }

  try {
    const response = await withIdleTimeout(
      agent,
      (notifyActivity) => {
        toolActivity = notifyActivity;
        return agent.chat(userPrompt, (event) => {
          notifyActivity();
          if (event.type === 'content-delta') {
            bufferedContent += event.delta;
            if (bufferedContent.length >= STREAM_BUFFER_CHARS) {
              flushStreamBuffer();
            } else {
              scheduleStreamFlush();
            }
            return;
          }
          if (event.type === 'reasoning-delta') {
            bufferedReasoning += event.delta;
            if (bufferedReasoning.length >= STREAM_BUFFER_CHARS) {
              flushStreamBuffer();
            } else {
              scheduleStreamFlush();
            }
            return;
          }
          flushStreamBuffer();
          postMessageToMain({
            type: 'app-agent-stream',
            requestId,
            event,
          });
          if (event.type === 'tool-call-end') {
            steps.push({
              name: event.toolName,
              status: event.success ? 'success' : 'error',
              summary: event.error || event.toolName,
            });
          }
        }, undefined, abortController.signal);
      },
      resolveAppAgentIdleTimeoutMs(cachedSettings.toolIpcTimeoutMs),
      cachedSettings.lang
    );
    flushStreamBuffer();

    postMessageToMain({
      type: 'app-agent-result',
      requestId,
      content: response.content,
      reasoningContent: response.reasoningContent,
      steps,
    });
  } catch (error) {
    if (flushTimerId !== null) {
      clearTimeout(flushTimerId);
      flushTimerId = null;
    }
    // 把已缓冲的流式 delta 先冲刷出去，错误路径不再静默丢弃最后一段内容。
    flushStreamBuffer();
    postMessageToMain({
      type: 'app-agent-error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    });
  } finally {
    appAgentAbortControllers.delete(requestId);
  }
}

async function handleChat(payload: AgentWorkerChatPayload): Promise<void> {
  cachedSettings = payload.settings;
  cachedToolDefinitions = payload.toolDefinitions;
  cachedWorkspacePath = payload.workspacePath;
  cachedRuntimeConfig = payload.runtime;
  appAgentPrefixCache.clear();
  const abortController = new AbortController();
  sessionAbortControllers.set(payload.requestId, abortController);

  try {
    // 工具执行（含子代理/长 bash）期间暂停聊天空闲兜底：工具自身的 IPC 超时
    // 负责兜底，空闲计时器只针对 LLM 流/工具请求静默挂死。
    let toolActivityNotifier: ((phase: 'start' | 'end') => void) | null = null;
    const registry = createRegistry(payload.requestId, payload, true, undefined, (phase) => {
      toolActivityNotifier?.(phase);
    });

  // Reuse a per-session log across turns to avoid re-cloning + re-hashing the
  // full history each turn. Full sync rebuilds it from payload.messages;
  // incremental sync reconciles the cached log against the main-thread mirror:
  //  - 长度一致或缓存有残留尾部（回合中道取消/出错）：前缀级联哈希校验通过
  //    后裁剪尾部、追加 newMessages（主线程日志只追加，前缀必然一致）；
  //  - 哈希不一致（中途压缩/裁剪改写过 worker 日志后回合又失败）或缓存缺失：
  //    向主线程发 sync-mismatch 换取完整消息、原地重建后继续本回合。
  // 主线程负责在回合出错/取消时保留（而非清除）同步坐标，并保证下次增量
  // 携带正确的前缀哈希；校验失败永远有全量重建兜底，不会静默错位。
  let sessionLog = sessionLogs.get(payload.sessionId);
  if (payload.incrementalSync) {
    const { expectedBaseLength, newMessages, prefixHash } = payload.incrementalSync;
    const cachedLength = sessionLog?.length() ?? 0;
    const prefixVerified =
      !!sessionLog &&
      cachedLength >= expectedBaseLength &&
      sessionLog.computeHashUpTo(expectedBaseLength) === prefixHash;
    if (prefixVerified && sessionLog) {
      if (cachedLength > expectedBaseLength) {
        sessionLog.truncateTo(expectedBaseLength);
      }
      if (newMessages.length > 0) {
        await sessionLog.appendBatch(newMessages);
      }
    } else {
      // 前缀校验失败或缺缓存：换取完整日志原地重建（已是主线程全量，
      // 不得再追加 newMessages——它们已被包含在重建结果中）。
      sessionLog = await requestFullSync(payload.requestId, payload.sessionId, abortController.signal);
    }
  } else {
    sessionLog = createLog(payload.sessionId, payload.messages);
    setSessionLog(payload.sessionId, sessionLog);
  }
  const startIndex = sessionLog.length();

  const prefix = new ImmutablePrefix({
    systemPrompt: payload.systemPrompt,
    tools: registry.getLlmTools(),
    model: payload.model,
    parameters: {
      temperature: payload.parameters.temperature,
      topP: payload.parameters.topP,
      maxTokens: payload.parameters.maxTokens,
      thinkingEnabled: payload.parameters.thinkingEnabled,
      reasoningEffort: payload.parameters.reasoningEffort,
      thinkingBudgetTokens: payload.parameters.thinkingBudgetTokens,
      thinkingPayload: payload.parameters.thinkingPayload ?? payload.settings.thinkingPayload,
    },
  });
  const session = new Session({
    sessionId: payload.sessionId,
    prefix,
    toolRegistry: registry,
    log: sessionLog,
  });
  const agent = new Agent({
    session,
    provider: buildProvider(payload.settings),
    providerName: payload.providerName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds: payload.settings.maxToolRounds,
    // task 工具（子代理）对齐其内部 20 分钟墙钟预算，避免父级 270s 默认
    // 超时掐断 promise 后子代理仍在后台执行。
    // graph 工具必须显式配置 graphToolTimeoutMs：主代理路径与 subagent 路径
    // 一样走这里注册的 toolTimeouts，否则 graph 实际落到工具 IPC 120s 上限，
    // 大仓库图构建（>2min）会被误杀。默认 600s（settings.graphToolTimeoutMs）。
    toolTimeouts: {
      ...PERMISSION_WAITING_TOOL_TIMEOUTS,
      graph: payload.settings.graphToolTimeoutMs ?? TOOL_IPC_TIMEOUT_MS,
      task: SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
    },
    toolOutputTruncation: buildToolOutputTruncation(payload.settings),
    toolContextConfig: buildToolContextConfig(payload.settings),
    contextCompaction: createContextCompactionHandler(
      payload.settings,
      payload.providerName,
      payload.sessionId,
      () => _refreshBootstrapRequest(payload.requestId),
      () => sessionAbortControllers.get(payload.requestId)?.signal,
      (commit) =>
        _commitContextCompactionRequest(payload.requestId, payload.sessionId, commit, payload.settings),
      payload.userMessageId
    ),
  });

  let compacted = false;
  // Idle backstop: if the whole agent produces no stream/tool activity for this
  // long, declare it hung and abort. Permission waits explicitly suspend this
  // backstop; the timer still catches unrelated worker/tool hangs.
  const CHAT_IDLE_TIMEOUT_MS = 300_000;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle: ((err: Error) => void) | undefined;
  const clearIdle = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const armIdle = () => {
    clearIdle();
    if (permissionWaitActive) return;
    idleTimer = setTimeout(() => {
      if (permissionWaitActive) {
        idleTimer = undefined;
        return;
      }
      idleTimer = undefined;
      abortController.abort();
      rejectIdle?.(
        new Error(`Agent idle timeout: no activity for ${CHAT_IDLE_TIMEOUT_MS / 1000}s`)
      );
    }, CHAT_IDLE_TIMEOUT_MS);
  };

  // 工具执行（含子代理）期间暂停空闲兜底；结束时按正常节奏恢复。
  toolActivityNotifier = (phase) => {
    if (phase === 'start') {
      clearIdle();
    } else {
      armIdle();
    }
  };

  const chatPromise = agent.chat(
    payload.userInput,
    (event) => {
      armIdle();
      if (event.type === 'context-compacted' || event.type === 'context-pruned') {
        // prune-only replaceLog 与 compact 一样改写了 worker log：必须走
        // fullMessages 回传，否则主线程镜像仍是未裁剪工具结果，下次 full
        // sync 会把它们复活进 worker。
        compacted = true;
      }
      postMessageToMain({
        type: 'stream',
        requestId: payload.requestId,
        event,
      });
    },
    payload.images,
    abortController.signal,
    payload.userMessageId,
    payload.contextInsertions
  );

  armIdle();
  let response: IAgentResponse;
  // PR5（ADR-009 第11条）：激活 re-recall 上下文——tool-response 分发时
  // 据此 push 新 insertion；每 chat 至多一次。
  activeChatAgent = agent;
  activeUserMessageId = payload.userMessageId ?? null;
  reRecallPushedThisChat = false;
  try {
    response = await Promise.race([
      chatPromise,
      new Promise<never>((_, reject) => {
        rejectIdle = reject;
      }),
    ]);
  } finally {
    clearIdle();
    activeChatAgent = null;
    activeUserMessageId = null;
  }

  const subagentEntries = subagentCacheStatsMap.get(payload.requestId);
  if (subagentEntries && subagentEntries.length > 0) {
    const { cacheStats, byTier } = buildSubagentCacheStatsByTier(response.cacheStats, subagentEntries);
    response.cacheStats = cacheStats;
    response.subagentCacheStatsByTier = byTier;
  }
  subagentCacheStatsMap.delete(payload.requestId);

  postMessageToMain({
    type: 'result',
    requestId: payload.requestId,
    response,
    deltaMessages: session.logStore.getMessagesSince(startIndex),
    logLength: session.logStore.length(),
    // When compaction or prune-only replaceLog rewrote the log this turn,
    // getMessagesSince(startIndex) no longer maps onto the original prefix;
    // ship the whole epoch so the main thread can replace its authoritative
    // log and stay in sync (otherwise the next full sync resurrects unpruned
    // tool results from the main-thread mirror).
    ...(compacted
      ? { compacted: true, fullMessages: session.logStore.getAllMessages().slice() }
      : {}),
  });
  } finally {
    sessionAbortControllers.delete(payload.requestId);
    // 成功路径在读取后已 delete（幂等）；错误/取消路径在此兜底，避免
    // subagentCacheStatsMap 按 requestId 无限累积。
    subagentCacheStatsMap.delete(payload.requestId);
  }
}

function reportDiagnostic(message: string, detail?: string): void {
  try {
    postMessageToMain({ type: 'worker-diagnostic', message, detail });
  } catch {
    // worker already shutting down — nothing to do
  }
}

self.addEventListener('error', (event) => {
  reportDiagnostic(
    event.message || 'Worker global error',
    event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
  );
});

self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as unknown;
  reportDiagnostic(
    `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    reason instanceof Error ? reason.stack : undefined,
  );
});

function dispatchWorkerMessage(message: MainToAgentWorkerMessage): void {
  if (message.type === 'ping') {
    postMessageToMain({ type: 'pong' });
    return;
  }

  if (message.type === 'permission-wait') {
    setPermissionWaitActive(message.waiting);
    return;
  }

  if (message.type === 'cancel-session') {
    const controller = sessionAbortControllers.get(message.requestId);
    if (controller) {
      controller.abort();
    }

    for (const [id, waiter] of toolResponseWaiters) {
      if (id.startsWith(`${message.requestId}:`)) {
        toolResponseWaiters.delete(id);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(new DOMException('Session was cancelled', 'AbortError'));
      }
    }

    for (const [id, waiter] of chatResponseWaiters) {
      if (id.startsWith(`${message.requestId}:`)) {
        chatResponseWaiters.delete(id);
        waiter.reject(new DOMException('Session was cancelled', 'AbortError'));
      }
    }

    for (const [id, waiter] of bootstrapResponseWaiters) {
      if (id.startsWith(`${message.requestId}:`)) {
        bootstrapResponseWaiters.delete(id);
        waiter.resolve(null);
      }
    }

    for (const [id, waiter] of compactionCommitWaiters) {
      if (id.startsWith(`${message.requestId}:`)) {
        compactionCommitWaiters.delete(id);
        waiter.reject(new DOMException('Session was cancelled', 'AbortError'));
      }
    }

    {
      const fullSyncWaiter = fullSyncWaiters.get(message.requestId);
      if (fullSyncWaiter) {
        fullSyncWaiters.delete(message.requestId);
        fullSyncWaiter.reject(new DOMException('Session was cancelled', 'AbortError'));
      }
    }

    subagentCacheStatsMap.delete(message.requestId);

    postMessageToMain({
      type: 'cancelled',
      requestId: message.requestId,
    });
    return;
  }

  if (message.type === 'cancel-app-agent') {
    const controller = appAgentAbortControllers.get(message.requestId);
    if (controller) {
      controller.abort();
    }
    return;
  }

  if (message.type === 'full-sync-response') {
    const waiter = fullSyncWaiters.get(message.requestId);
    if (waiter) {
      fullSyncWaiters.delete(message.requestId);
      waiter.resolve({ messages: message.messages });
    }
    return;
  }

  if (message.type === 'tool-response') {
    const waiter = toolResponseWaiters.get(message.payload.toolRequestId);
    if (!waiter) {
      return;
    }

    // PR5（ADR-009 第11条）：memory_search 的 re-recall insertion —— push
    // 进本回合 Agent（request-only，追加在旧 insertion 之后），每 chat ≤1。
    if (
      message.payload.reRecallInsertion &&
      activeChatAgent &&
      !reRecallPushedThisChat
    ) {
      reRecallPushedThisChat = true;
      activeChatAgent.pushContextInsertions([message.payload.reRecallInsertion]);
    }

    toolResponseWaiters.delete(message.payload.toolRequestId);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (message.payload.success) {
      waiter.resolve(message.payload.result);
    } else {
      waiter.reject(new Error(message.payload.error || '工具执行失败'));
    }
    return;
  }

  if (message.type === 'proxy-chat-response') {
    const waiter = chatResponseWaiters.get(message.proxyChatId);
    if (!waiter) {
      return;
    }
    chatResponseWaiters.delete(message.proxyChatId);
    if (message.success && message.result) {
      waiter.resolve(message.result);
    } else {
      waiter.reject(new Error(message.error || 'Chat proxy failed'));
    }
    return;
  }

  if (message.type === 'refresh-bootstrap-response') {
    const waiter = bootstrapResponseWaiters.get(message.bootstrapRequestId);
    if (!waiter) {
      return;
    }
    bootstrapResponseWaiters.delete(message.bootstrapRequestId);
    if (message.success) {
      waiter.resolve(message.bootstrap ?? null);
    } else {
      waiter.reject(new Error(message.error || 'Bootstrap refresh failed'));
    }
    return;
  }

  if (message.type === 'commit-context-compaction-response') {
    const waiter = compactionCommitWaiters.get(message.requestId);
    if (!waiter) {
      return;
    }
    compactionCommitWaiters.delete(message.requestId);
    waiter.resolve({
      success: message.success,
      generation: message.generation,
      compactionId: message.compactionId,
      error: message.error,
    });
    return;
  }

  if (message.type === 'fetch-response-start') {
    const pending = pendingFetches.get(message.fetchId);
    if (!pending || pending.settled) {
      return;
    }
    // Constructing Headers/Response can throw on unusual values; fail just this
    // fetch instead of letting the exception escape and kill the worker.
    try {
      const noBodyStatus = [101, 103, 204, 205, 304].includes(message.status);
      const responseInit: ResponseInit = {
        status: message.status,
        statusText: message.statusText,
        headers: new Headers(message.headers),
      };
      const response = new Response(
        noBodyStatus ? null : pending.bodyStream,
        responseInit
      );
      pending.settled = true;
      pending.resolve(response);
    } catch (err) {
      finalizePendingFetch(
        message.fetchId,
        'error',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    return;
  }

  if (message.type === 'fetch-response-chunk') {
    const pending = pendingFetches.get(message.fetchId);
    if (!pending || !pending.bodyController) {
      return;
    }
    try {
      pending.bodyController.enqueue(message.chunk);
    } catch {
      // controller already closed or errored
    }
    return;
  }

  if (message.type === 'fetch-response-end') {
    finalizePendingFetch(message.fetchId, 'close');
    return;
  }

  if (message.type === 'fetch-response-error') {
    finalizePendingFetch(message.fetchId, 'error', new Error(message.error));
    return;
  }

  if (message.type === 'init') {
    cachedSettings = message.payload.settings;
    cachedToolDefinitions = message.payload.toolDefinitions;
    cachedWorkspacePath = message.payload.workspacePath;
    cachedRuntimeConfig = message.payload.runtime;
    return;
  }

  if (message.type === 'run-app-agent') {
    void handleRunAppAgent(message.payload, message.requestId).catch((error) => {
      postMessageToMain({
        type: 'app-agent-error',
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      });
    });
    return;
  }

  void handleChat(message.payload).catch((error) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    const errorName = error instanceof Error ? error.name : undefined;
    const errorDetails = error && typeof error === 'object' && error.constructor?.name === 'ProviderRequestError'
      ? {
          provider: (error as { provider?: string }).provider,
          status: (error as { status?: number }).status,
          requestId: (error as { requestId?: string }).requestId,
          responseBody: (error as { responseBody?: string }).responseBody,
          retriable: (error as { retriable?: boolean }).retriable,
        }
      : undefined;
    postMessageToMain({
      type: 'error',
      requestId: message.payload.requestId,
      error: error instanceof Error ? error.message : String(error),
      errorName,
      errorDetails,
    });
  });
}

self.onmessage = (event: MessageEvent<MainToAgentWorkerMessage>) => {
  const message = event.data;
  try {
    dispatchWorkerMessage(message);
  } catch (error) {
    // Unexpected synchronous failure in a message handler: report it and fail
    // only the affected request instead of letting the exception escape and kill
    // the whole worker (which would surface as an opaque "worker crashed").
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    reportDiagnostic(`onmessage handler failed: ${errorMessage}`, errorStack);
    try {
      if (message.type === 'chat') {
        postMessageToMain({
          type: 'error',
          requestId: message.payload.requestId,
          error: `Worker message handler failed: ${errorMessage}`,
          errorName: error instanceof Error ? error.name : undefined,
        });
      } else if (message.type === 'run-app-agent') {
        postMessageToMain({
          type: 'app-agent-error',
          requestId: message.requestId,
          error: `Worker message handler failed: ${errorMessage}`,
          errorName: error instanceof Error ? error.name : undefined,
        });
      }
    } catch {
      // posting failed too — the diagnostic above is the last record
    }
  }
};

export {};
