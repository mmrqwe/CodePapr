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
} from '@codepapr/core';
import {
  DEFAULT_MAX_TOKENS,
  ClaudeProvider,
  DeepSeekProvider,
  LocalProvider,
  OpenAIProvider,
  DEFAULT_LOCAL_BASE_URL,
  RequestBuilder,
  CacheValidator,
  setGlobalFetchFn,
} from '@codepapr/api';
import type { IAgentResponse, IChatRequest, IChatResponse, ICacheStatistics, IChatStreamEvent, IMessage, ILLMProvider, IToolDefinition } from '@codepapr/types';
import type {
  AgentWorkerChatPayload,
  AgentWorkerToMainMessage,
  MainToAgentWorkerMessage,
  WorkerAgentSettings,
  WorkerAgentRuntimeConfig,
  WorkerApiFormat,
  AppAgentPayload,
} from './agentWorkerProtocol';
import { createContextCompactionHandler } from './compactionHandler';
import type { Settings } from '../store/internals/types';

declare const self: DedicatedWorkerGlobalScope;

const toolResponseWaiters = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

const sessionAbortControllers = new Map<string, AbortController>();
const appAgentAbortControllers = new Map<string, AbortController>();

// Per-session log cache so consecutive turns reuse the already-built history
// instead of re-cloning + re-hashing the full log every turn (incremental sync).
// Reset implicitly when the worker is recreated (new WorkerBackedAgent instance).
const sessionLogs = new Map<string, AppendOnlyLog>();

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

const TOOL_IPC_TIMEOUT_MS = 120_000;
const SUBAGENT_WALL_CLOCK_TIMEOUT_MS = 300_000;

const APP_AGENT_LEVEL_TOOLS: Record<number, ReadonlySet<string>> = {
  0: new Set(),
  1: new Set(['read', 'grep', 'list', 'lsp', 'diagnostics', 'read_image', 'skill_load', 'todo', 'local_time_now']),
  2: new Set(['read', 'grep', 'list', 'lsp', 'diagnostics', 'read_image', 'skill_load', 'todo', 'local_time_now', 'websearch', 'webfetch']),
  3: new Set(['read', 'grep', 'list', 'lsp', 'diagnostics', 'read_image', 'skill_load', 'todo', 'local_time_now', 'websearch', 'webfetch', 'write', 'edit', 'patch', 'bash']),
};

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

async function withWallClockTimeout<T>(
  agent: Agent,
  promiseFactory: () => Promise<T>,
  timeoutMs: number,
  lang?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        agent.cancel();
        reject(new Error(
          lang === 'zh-TW'
            ? `子代理執行超時 (${timeoutMs / 1000}秒)`
            : lang === 'zh-CN'
            ? `子代理执行超时 (${timeoutMs / 1000}秒)`
            : `Sub-agent execution timed out (${timeoutMs / 1000}s)`
        ));
      }, timeoutMs);

      promiseFactory().then(
        (result) => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          resolve(result);
        },
        (err) => {
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

async function requestToolExecution(
  requestId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = TOOL_IPC_TIMEOUT_MS,
  toolCallId?: string
): Promise<unknown> {
  const toolRequestId = `${requestId}:${++nextToolRequestId}`;

  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      toolResponseWaiters.delete(toolRequestId);
      reject(new Error(`工具 IPC 超时: ${toolName} (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    toolResponseWaiters.set(toolRequestId, {
      resolve: (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });

  postMessageToMain({
    type: 'tool-request',
    requestId,
    toolRequestId,
    toolName,
    arguments: args,
    ...(toolCallId ? { toolCallId } : {}),
  });

  return await result;
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

async function runSubagent(
  requestId: string,
  payload: AgentWorkerChatPayload,
  definition: AgentDefinition,
  prompt: string,
  currentDepth: number
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
    },
    fallbackApiKey: s.apiKey,
    fallbackBaseURL: s.baseURL,
  });

  let subagentProvider: ILLMProvider = buildProvider(payload.settings);
  let subagentProviderName: 'deepseek' | 'openai' | 'claude' = payload.providerName;
  if (exec.mentor) {
    const config = { apiKey: exec.mentor.apiKey, ...(exec.mentor.baseURL ? { baseURL: exec.mentor.baseURL } : {}) };
    if (exec.mentor.apiFormat === 'claude') {
      subagentProvider = new ClaudeProvider(config);
      subagentProviderName = 'claude';
    } else {
      subagentProvider = new OpenAIProvider(config);
      subagentProviderName = 'openai';
    }
  }

  return await runSubagentSession({
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
    toolOutputTruncation: buildToolOutputTruncation(payload.settings),
    toolContextConfig: buildToolContextConfig(payload.settings),
  });
}

function createRegistry(
  requestId: string,
  payload: AgentWorkerChatPayload,
  includeTaskTool: boolean,
  currentDepth: number = 0
): ToolRegistry {
  const registry = new ToolRegistry();
  const toolIpcTimeoutMs = payload.settings.toolIpcTimeoutMs ?? TOOL_IPC_TIMEOUT_MS;

  for (const tool of payload.toolDefinitions) {
    registry.register(tool, async (args, context) => {
      const timeout = tool.name === 'graph' ? toolIpcTimeoutMs : TOOL_IPC_TIMEOUT_MS;
      return await requestToolExecution(requestId, tool.name, args, timeout, context?.toolCallId);
    });
  }

  // graph 对主代理软隐藏（不在 payload.toolDefinitions 的主代理 LLM 工具集中），但子代理（如 Explore）
  // 可能经白名单选取它。这里补注册一个代理 handler，使子代理过滤（getAll）与执行可用；主代理前缀用 getLlmTools() 排除。
  if (!registry.has('graph')) {
    const graphDef = MERGE_TOOL_DEFINITIONS.find((t) => t.name === 'graph');
    if (graphDef) {
      registry.register(graphDef, async (args, context) => {
        return await requestToolExecution(requestId, 'graph', args, toolIpcTimeoutMs, context?.toolCallId);
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

    registry.register(definition, async (args) => {
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

      const result = await runSubagent(requestId, payload, target, prompt, currentDepth + 1);
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
  const level = payload.level ?? 1;

  const levelAllowed = APP_AGENT_LEVEL_TOOLS[level] ?? APP_AGENT_LEVEL_TOOLS[1];

  const sandboxPrefix = `.CodePapr/apps/${payload.appId}/sandbox/`;
  const SANDBOX_WRITABLE_TOOLS = new Set(['write', 'edit', 'patch']);

  function isSafeSandboxPath(p: string): boolean {
    if (!p) return false;
    if (p.startsWith('/') || p.startsWith('\\')) return false;
    if (p.includes('..')) return false;
    if (p.includes('\\')) return false;
    if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
    return true;
  }

  function sandboxWriteArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    if (!SANDBOX_WRITABLE_TOOLS.has(toolName)) return args;
    if (toolName === 'patch') {
      if (Array.isArray(args.patches)) {
        const safePatches = (args.patches as Array<Record<string, unknown>>).map((p) => {
          if (typeof p.relativePath !== 'string' || !isSafeSandboxPath(p.relativePath)) {
            throw new Error(`sandbox: invalid path in patch: ${String(p.relativePath)}`);
          }
          return { ...p, relativePath: sandboxPrefix + p.relativePath };
        });
        return { ...args, patches: safePatches };
      }
      return args;
    }
    if (typeof args.relativePath === 'string') {
      if (!isSafeSandboxPath(args.relativePath)) {
        throw new Error(`sandbox: invalid path: ${args.relativePath}`);
      }
      return { ...args, relativePath: sandboxPrefix + args.relativePath };
    }
    return args;
  }

  const registry = new ToolRegistry();
  for (const tool of cachedToolDefinitions) {
    if (BLOCKED.has(tool.name)) continue;
    if (tool.name.startsWith('mcp__')) {
      if (level < 2) continue;
      if (requestedTools.length === 0 || !requestedTools.includes(tool.name)) continue;
    } else {
      if (!levelAllowed.has(tool.name)) continue;
      if (requestedTools.length > 0 && !requestedTools.includes(tool.name)) continue;
    }

    registry.register(tool, async (args, context) => {
      const sandboxedArgs = sandboxWriteArgs(tool.name, args);
      return await requestToolExecution(
        requestId, tool.name, sandboxedArgs, TOOL_IPC_TIMEOUT_MS, context?.toolCallId
      );
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
    model = cachedSettings.mentorModel || cachedSettings.model;
  }

  let agentProvider: ILLMProvider = buildProvider(cachedSettings);
  let agentProviderName: 'deepseek' | 'openai' | 'claude' = cachedSettings.provider;

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
        } as unknown as IMessage);
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
    toolTimeouts: { graph: cachedSettings.graphToolTimeoutMs },
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
    const response = await withWallClockTimeout(
      agent,
      () => agent.chat(userPrompt, (event) => {
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
      }, undefined, abortController.signal),
      300_000,
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
    const registry = createRegistry(payload.requestId, payload, true);

  // Reuse a per-session log across turns to avoid re-cloning + re-hashing the
  // full history each turn. Full sync rebuilds it from payload.messages;
  // incremental sync appends only newMessages onto the cached log after
  // verifying the cached length matches what the main thread expects (a
  // mismatch means the cache is stale and is treated as an error — the main
  // thread only sends incremental when its tracked length agrees; it is
  // responsible for invalidating its tracked length whenever a turn errors
  // or is cancelled so the next chat falls back to a full sync).
  let sessionLog = sessionLogs.get(payload.sessionId);
  if (payload.incrementalSync && sessionLog) {
    const { expectedBaseLength, newMessages } = payload.incrementalSync;
    if (sessionLog.length() !== expectedBaseLength) {
      throw new Error(
        `Worker log cache mismatch for session ${payload.sessionId}: ` +
          `cached ${sessionLog.length()}, expected base ${expectedBaseLength}`
      );
    }
    if (newMessages.length > 0) {
      await sessionLog.appendBatch(newMessages);
    }
  } else {
    sessionLog = createLog(payload.sessionId, payload.messages);
    sessionLogs.set(payload.sessionId, sessionLog);
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
    toolTimeouts: { graph: payload.settings.graphToolTimeoutMs },
    toolOutputTruncation: buildToolOutputTruncation(payload.settings),
    toolContextConfig: buildToolContextConfig(payload.settings),
    contextCompaction: createContextCompactionHandler(
      payload.settings as unknown as Settings,
      payload.providerName,
      payload.sessionId,
      () => _refreshBootstrapRequest(payload.requestId)
    ),
  });

  let compacted = false;
  // Idle backstop: if the whole agent produces no stream/tool activity for this
  // long, declare it hung and abort. Threshold sits above the max tool timeout
  // (DEFAULT_TOOL_TIMEOUT_MS) so legitimate long tools never trip it; the timer
  // resets on every event, so a continuously streaming/working agent never times
  // out. The per-LLM-stream idle timeout (readSseStream) is the primary defense;
  // this only catches hangs that escape it.
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
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      abortController.abort();
      rejectIdle?.(
        new Error(`Agent idle timeout: no activity for ${CHAT_IDLE_TIMEOUT_MS / 1000}s`)
      );
    }, CHAT_IDLE_TIMEOUT_MS);
  };

  const chatPromise = agent.chat(
    payload.userInput,
    (event) => {
      armIdle();
      if (event.type === 'context-compacted') {
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
  );

  armIdle();
  let response: IAgentResponse;
  try {
    response = await Promise.race([
      chatPromise,
      new Promise<never>((_, reject) => {
        rejectIdle = reject;
      }),
    ]);
  } finally {
    clearIdle();
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
    // When compaction reset the log this turn, getMessagesSince(startIndex) no
    // longer maps onto the original prefix; ship the whole compacted epoch so the
    // main thread can replace its authoritative log and stay in sync.
    ...(compacted
      ? { compacted: true, fullMessages: session.logStore.getAllMessages().slice() }
      : {}),
  });
  } finally {
    sessionAbortControllers.delete(payload.requestId);
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

  if (message.type === 'cancel-session') {
    const controller = sessionAbortControllers.get(message.requestId);
    if (controller) {
      controller.abort();
    }

    for (const [id, waiter] of toolResponseWaiters) {
      if (id.startsWith(`${message.requestId}:`)) {
        toolResponseWaiters.delete(id);
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

  if (message.type === 'tool-response') {
    const waiter = toolResponseWaiters.get(message.payload.toolRequestId);
    if (!waiter) {
      return;
    }

    toolResponseWaiters.delete(message.payload.toolRequestId);
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
