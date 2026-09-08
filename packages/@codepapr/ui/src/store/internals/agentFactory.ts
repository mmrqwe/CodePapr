import {
  Agent,
  AppendOnlyLog,
  ImmutablePrefix,
  Session,
  ToolRegistry,
  FilteringToolRegistry,
  allowToolForReadOnlyMode,
  readOnlyModeBlockMessage,
  isReadOnlyMode,
  applyMinimalToolProfile,
  generateToolOutputFilename,
  resolveToolContextOverrides,
  type AgentDefinition,
  type EditHistory,
  type SkillDefinition,
  type ToolOutputTruncationOptions,
  type ToolContextConfig,
  type PruneOptions,
  SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
  PERMISSION_WAITING_TOOL_TIMEOUTS,
  hasUnsettledTodoTasks,
} from '@codepapr/core';
import type { PromptMode } from '@codepapr/core';
import { CacheValidator, RequestBuilder } from '@codepapr/api';
import type { ICacheStatistics, IAgentResponse, IImageContent, IMessage, IToolDefinition, RequestContextInsertion } from '@codepapr/types';
import {
  WorkerBackedAgent,
  type AgentRuntimeHandle,
  type AgentRuntimeStreamEvent,
} from '../../agent/WorkerBackedAgent';
import type { MidLoopCompactionCommit } from '../../agent/agentWorkerProtocol';
import { createContextCompactionHandler } from '../../agent/compactionHandler';
import { SidecarTransport } from '../../agent/sidecarTransport';
import { registerWorkspaceTools } from '../../tools/workspaceTools';
import { registerUiTaskTool, type UiTaskToolContext } from '../../tools/uiTaskTool';

import { registerMcpTools } from '../../tools/mcpTools';
import { registerMemoryTools } from '../../tools/memoryTools';
import { registerTodoListTools } from '../../tools/todoListTool';
import { getTodoListContext } from '../../tools/todoListRegistry';
import { mcpSearchHidesNativeWeb } from '../../utils/mcpTypes';
import {
  buildProviderInstance,
  shouldUseSidecarAgentRuntime,
  shouldUseWorkerAgentRuntime,
  toWorkerAgentSettings,
} from './providerFactory';
import { resolveProviderName } from './settingsNormalizer';
import { modelSupportsVision, shouldExposeReadImage } from '../../utils/visionRouting';
import { replaceImagesInToolResult } from '../../utils/visionOffload';
import { loadMemoryBootstrapSection } from './memoryLedgerStore';
import { primeSessionBootstrap } from './sessionBootstrapCache';
import {
  buildAgentSessionBootstrapPrompt,
  createLogFromMessages,
  toCoreMessages,
} from './promptBuilders';
import type { ApiFormat, Lang, Settings, UIMessage } from './types';

function subagentMultimodalAllowed(settings: Settings, agentTier: 'primary' | 'fast'): boolean {
  const model = agentTier === 'fast' ? settings.fastModel : settings.model;
  return shouldExposeReadImage(settings, model);
}

function buildToolOutputTruncation(
  settings: Settings,
  workspacePath: string
): ToolOutputTruncationOptions {
  return {
    interceptChars: settings.toolOutputInterceptChars,
    offloadChars: settings.toolOutputOffloadChars,
    offloadPreviewChars: settings.toolOutputPreviewChars,
    middleKeepChars: settings.toolOutputMiddleKeepChars,
    ceilingChars: settings.toolOutputCeilingChars,
    spillToDisk: async (content: string, toolName: string): Promise<string | null> => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const filename = generateToolOutputFilename(toolName);
        const relativePath = `.CodePapr/tool-output/${filename}`;
        await invoke('write_text_file', {
          workspacePath,
          relativePath,
          content,
        });
        return relativePath;
      } catch {
        return null;
      }
    },
  };
}

function buildToolContextConfig(settings: Settings): ToolContextConfig {
  return {
    defaultMode: settings.toolContextDefaultMode,
    overrides: resolveToolContextOverrides(settings.toolContextOverrides),
    summaryMaxChars: settings.toolContextSummaryMaxChars,
    autoThresholdChars: settings.toolContextAutoThresholdChars,
  };
}

/**
 * Build a callback that re-renders session bootstrap from the memory ledger.
 * Used by mid-loop context compaction to refresh memory at epoch boundaries
 * (the epoch resets anyway, so no extra cache break). The fresh bootstrap is
 * also written back to the session bootstrap cache under the turn's signature,
 * so later rebuilds (crash recovery / model switch) re-inject the REFRESHED
 * snapshot instead of the one frozen at session start.
 * Returns null when no bootstrap can be produced.
 */
function buildBootstrapRefresher(
  settings: Settings,
  workspacePath: string,
  runtime: AgentRuntimeConfig,
  sessionId: string | null
): () => Promise<string | null> {
  return async () => {
    const memorySection = await loadMemoryBootstrapSection(workspacePath);
    const bootstrap = buildAgentSessionBootstrapPrompt(
      settings,
      workspacePath,
      runtime.skillDefinitions ?? [],
      memorySection,
      undefined,
      runtime.mode ?? 'agent'
    ).trim();
    if (!bootstrap) return null;
    if (runtime.sessionBootstrapSignature) {
      primeSessionBootstrap(sessionId, runtime.sessionBootstrapSignature, bootstrap);
    }
    return bootstrap;
  };
}

export interface AgentRuntimeConfig {
  editHistory?: EditHistory;
  rulesSection?: string;
  customPrompt?: string;
  memorySection?: string;
  /** 仅供 explore/scout 子代理注入（主会话 Bootstrap 已不含 project-graph）。 */
  projectGraphSummary?: string;
  /** 已按 session 记忆化（冻结）的会话引导，含 skills/memory/character/custom。
   *  优先用它注入 log[0]，兑现账本记忆每次会话自动加载；缺省时回退到仅 skills+custom。 */
  sessionBootstrapPrompt?: string;
  /** 本回合 Bootstrap 缓存签名；mid-loop 刷新后据此把新 Bootstrap 写回缓存。 */
  sessionBootstrapSignature?: string;
  lang?: Lang;
  /** 当前工作模式：ask/plan 会在注册层屏蔽变更类工具。缺省 agent。 */
  mode?: PromptMode;
  skillDefinitions?: SkillDefinition[];
  agentDefinitions?: AgentDefinition[];
  mcpToolDefinitions?: IToolDefinition[];
  mcpToolMappings?: Array<{ serverId: string; toolName: string; displayName: string }>;
  onWorkspaceMutated?: (paths?: string[]) => void;
  onStreamSnapshot?: () => void;
  /** PR1（ADR-005）：mid-loop 压缩提交回调，主线程 Store 单事务持久化。 */
  onMidLoopCompactionCommit?: (commit: MidLoopCompactionCommit) => Promise<void> | void;
}

class _MainThreadAgentHandle implements AgentRuntimeHandle {
  private abortController: AbortController | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly subagentCacheStatsRef?: () => Array<{ tier: 'primary' | 'fast' | 'mentor'; stats: ICacheStatistics }>,
  ) {}

  isCrashed(): boolean {
    return false;
  }

  async chat(
    userInput: string,
    onStreamEvent?: (event: AgentRuntimeStreamEvent) => void,
    images?: IImageContent[],
    userMessageId?: string,
    contextInsertions?: RequestContextInsertion[]
  ): Promise<IAgentResponse> {
    this.abortController = new AbortController();
    try {
      const response = await this.agent.chat(
        userInput,
        onStreamEvent,
        images,
        this.abortController.signal,
        userMessageId,
        contextInsertions
      );
      if (this.subagentCacheStatsRef) {
        const subStats = this.subagentCacheStatsRef();
        if (subStats.length > 0) {
          response.subagentCacheStatsByTier = buildSubagentCacheStatsByTier(subStats);
        }
      }
      return response;
    } finally {
      this.abortController = null;
    }
  }

  getSession(): { logStore: AppendOnlyLog } {
    return this.agent.getSession();
  }

  cancel(): void {
    this.abortController?.abort();
  }

  /** 主线程 agent 无 app-agent 概念：与 cancel() 等价。 */
  cancelSession(): void {
    this.cancel();
  }

  destroy(): void {
    this.cancel();
  }

  runAppAgent(): Promise<never> {
    return Promise.reject(new Error('App Agent is only available in Worker mode'));
  }

  cancelAppAgent(): void {
    // Main-thread agent doesn't support app agents
  }
}

function buildSubagentCacheStatsByTier(
  subStats: Array<{ tier: 'primary' | 'fast' | 'mentor'; stats: ICacheStatistics }>,
): { primary?: ICacheStatistics; fast?: ICacheStatistics; mentor?: ICacheStatistics } {
  const byTier: { primary?: ICacheStatistics; fast?: ICacheStatistics; mentor?: ICacheStatistics } = {};
  for (const entry of subStats) {
    const existing = byTier[entry.tier];
    byTier[entry.tier] = existing ? mergeTwoCacheStats(existing, entry.stats) : { ...entry.stats };
  }
  return byTier;
}

function mergeTwoCacheStats(
  a: ICacheStatistics,
  b: ICacheStatistics,
): ICacheStatistics {
  const cacheReadTokens = a.cacheReadTokens + b.cacheReadTokens;
  const cacheCreationTokens = a.cacheCreationTokens + b.cacheCreationTokens;
  const newInputTokens = a.newInputTokens + b.newInputTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  const totalInput = newInputTokens + cacheReadTokens + cacheCreationTokens;
  const promptCacheHitTokens =
    typeof a.promptCacheHitTokens === 'number' || typeof b.promptCacheHitTokens === 'number'
      ? (a.promptCacheHitTokens ?? 0) + (b.promptCacheHitTokens ?? 0)
      : undefined;
  const promptCacheMissTokens =
    typeof a.promptCacheMissTokens === 'number' || typeof b.promptCacheMissTokens === 'number'
      ? (a.promptCacheMissTokens ?? 0) + (b.promptCacheMissTokens ?? 0)
      : undefined;
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

/**
 * Lazy resolver to break the circular dependency between agentFactory and the
 * main store: the store registers its `noteWorkspaceMutation` here at module
 * init, so factory code can fall back to it when callers omit `onWorkspaceMutated`.
 */
let defaultOnWorkspaceMutatedResolver: () => (paths?: string[]) => void = () => () => {};

export function setDefaultOnWorkspaceMutatedResolver(
  resolver: () => (paths?: string[]) => void
): void {
  defaultOnWorkspaceMutatedResolver = resolver;
}

export interface AgentSessionParts {
  prefix: ImmutablePrefix;
  log: AppendOnlyLog;
  model: string;
  toolRegistry: ToolRegistry;
  provider: ReturnType<typeof buildProviderInstance>;
  providerName: ReturnType<typeof resolveProviderName>;
  uiTaskToolContext?: UiTaskToolContext;
}

/**
 * 构建主线程子代理执行上下文（UiTaskToolContext），供 task 工具与内部子代理
 * （如 Goal 验收器 verifier）共用。无可用子代理定义时返回 undefined。
 */
export function buildUiTaskToolContext(
  settings: Settings,
  workspacePath: string,
  runtime: AgentRuntimeConfig,
  overrides: Partial<
    Pick<Settings, 'model' | 'thinkingEnabled' | 'thinkingEffort' | 'thinkingBudgetTokens' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  > = {},
  sessionId?: string,
): UiTaskToolContext | undefined {
  if (!runtime.agentDefinitions || runtime.agentDefinitions.length === 0) {
    return undefined;
  }
  const mode: PromptMode = runtime.mode ?? 'agent';
  const onWorkspaceMutated = runtime.onWorkspaceMutated ?? defaultOnWorkspaceMutatedResolver();

  const baseModel = (overrides.model ?? settings.model).trim();
  const provider = buildProviderInstance(settings, sessionId);
  const providerName = resolveProviderName(settings);

  // Filter out mentor agent when mentor is not enabled
  const availableAgents = runtime.agentDefinitions.filter(
    (agent) => agent.model !== 'mentor' || settings.mentorEnabled
  ).map((agent) => {
    // Override model based on tier selection for explore/scout
    if (agent.name === 'explore') {
      const tier = settings.exploreModelTier;
      const agentDef = { ...agent, model: tier === 'primary' ? undefined : 'fast' };
      if (!subagentMultimodalAllowed(settings, tier) && agentDef.tools) {
        agentDef.tools = { ...agentDef.tools };
        delete (agentDef.tools as Record<string, boolean>)['read_image'];
      }
      return agentDef;
    }
    if (agent.name === 'scout') {
      const tier = settings.scoutModelTier;
      const agentDef = { ...agent, model: tier === 'primary' ? undefined : 'fast' };
      if (!subagentMultimodalAllowed(settings, tier) && agentDef.tools) {
        agentDef.tools = { ...agentDef.tools };
        delete (agentDef.tools as Record<string, boolean>)['read_image'];
      }
      return agentDef;
    }
    return agent;
  });
  if (availableAgents.length === 0) {
    return undefined;
  }

  return {
    workspacePath,
    sessionId,
    provider,
    providerName,
    baseModel,
    fastModelEnabled: settings.fastModelEnabled,
    fastModel: settings.fastModel,
    maxToolRounds: settings.maxToolRounds,
    rulesSection: runtime.rulesSection ?? '',
    // Character persona is for the primary agent talking to the user.
    // Explore/scout must stay neutral workers; the main agent can still
    // present their results in character.
    customPrompt: runtime.customPrompt ?? settings.systemPrompt,
    memorySection: runtime.memorySection,
    projectGraphSummary: runtime.projectGraphSummary,
    lang: runtime.lang ?? settings.lang,
    skillDefinitions: runtime.skillDefinitions ?? [],
    agents: availableAgents,
    mentor: { enabled: settings.mentorEnabled, model: settings.mentorModel, baseURL: settings.mentorBaseURL, apiKey: settings.mentorApiKey, apiFormat: settings.mentorApiFormat as ApiFormat, maxTokens: settings.mentorMaxTokens, maxConsultations: settings.maxMentorConsultations, thinkingEnabled: settings.mentorThinkingEnabled, thinkingEffort: settings.mentorThinkingEffort, thinkingBudgetTokens: settings.mentorThinkingBudgetTokens, thinkingPayload: settings.mentorThinkingPayload },
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    multimodalEnabled: shouldExposeReadImage(settings, baseModel),
    readImageEnabledForModel: (model) => shouldExposeReadImage(settings, model),
    transformToolResultForModel: (result, model) => replaceImagesInToolResult(result, settings, model),
    toolOutputTruncation: buildToolOutputTruncation(settings, workspacePath),
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.thinkingEffort,
    thinkingBudgetTokens: settings.thinkingBudgetTokens,
    thinkingPayload: settings.thinkingPayload,
    editHistory: runtime.editHistory,
    onWorkspaceMutated,
    exploreTopP: settings.exploreTopP,
    exploreMaxTokens: settings.exploreMaxTokens,
    exploreThinkingEnabled: settings.exploreThinkingEnabled,
    exploreTemperature: settings.exploreTemperature,
    exploreMaxToolRounds: settings.exploreMaxToolRounds,
    exploreMaxDepth: settings.exploreMaxDepth,
    scoutTopP: settings.scoutTopP,
    scoutMaxTokens: settings.scoutMaxTokens,
    scoutThinkingEnabled: settings.scoutThinkingEnabled,
    scoutTemperature: settings.scoutTemperature,
    scoutMaxToolRounds: settings.scoutMaxToolRounds,
    scoutMaxDepth: settings.scoutMaxDepth,
    graphToolTimeoutMs: settings.graphToolTimeoutMs,
    mode,
  };
}

/**
 * 组装会话的「前缀 + 日志 + 工具」（系统提示词、工具定义、会话引导、历史消息），
 * 与真实发送共用同一份逻辑。既用于创建主线程 Agent，也用于按需重建上下文快照
 * （computeContextSnapshot），保证两者组装结果一致。
 */
export function buildAgentSessionParts(
  settings: Settings,
  sessionId: string,
  workspacePath: string,
  messages: UIMessage[] = [],
  overrides: Partial<
    Pick<Settings, 'model' | 'thinkingEnabled' | 'thinkingEffort' | 'thinkingBudgetTokens' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  > = {},
  runtime: AgentRuntimeConfig = {},
  /** PR1（ADR-006）：重建用的 prune 参数（surface 冻结参数优先）。 */
  pruneOptions?: PruneOptions
): AgentSessionParts {
  const mode: PromptMode = runtime.mode ?? 'agent';
  const toolRegistry = isReadOnlyMode(mode)
    ? new FilteringToolRegistry(allowToolForReadOnlyMode, readOnlyModeBlockMessage)
    : new ToolRegistry();
  const onWorkspaceMutated = runtime.onWorkspaceMutated ?? defaultOnWorkspaceMutatedResolver();
  const sessionBootstrapPrompt =
    runtime.sessionBootstrapPrompt ??
    buildAgentSessionBootstrapPrompt(
      settings,
      workspacePath,
      runtime.skillDefinitions ?? [],
      undefined,
      undefined,
      runtime.mode ?? 'agent'
    );
  const composedSystemPrompt = (overrides.systemPrompt ?? settings.systemPrompt).trim();
  const currentModel = (overrides.model ?? settings.model).trim();
  registerWorkspaceTools(toolRegistry, workspacePath, runtime.editHistory, (paths) => {
    onWorkspaceMutated(paths);
  }, {
    disableWebSearchTools: mcpSearchHidesNativeWeb(settings.mcp, settings.agentToolProfile),
    multimodalEnabled: shouldExposeReadImage(settings, currentModel),
    mode,
    sessionId,
  });
  const originalExecute = toolRegistry.execute.bind(toolRegistry);
  toolRegistry.execute = async (name, args, execContext) => {
    const result = await originalExecute(name, args, execContext);
    return replaceImagesInToolResult(result, settings, currentModel);
  };

  // TodoList 工具：主 Agent 的"短期工作记忆"，与 task 工具正交协作
  // 极简工具面：todo/memory/MCP 不在 allowlist，直接不注册（handler 物理缺失，
  // 幻觉调用报 unknown tool；prompt 层由 buildMinimalToolSurfaceSection 说明）。
  const minimalSurface = settings.agentToolProfile === 'minimal';
  if (!minimalSurface) {
    registerTodoListTools(toolRegistry, sessionId, '', settings.todoMaxRetries);

    // Memory 工具（ADR-008 PR4）：memory_write/search/forget/list。
    registerMemoryTools(toolRegistry, workspacePath, sessionId);

    registerMcpTools(toolRegistry, settings.mcp, runtime.mcpToolDefinitions ?? [], runtime.mcpToolMappings);
  }

  const uiTaskToolContext = buildUiTaskToolContext(settings, workspacePath, runtime, overrides, sessionId);
  if (uiTaskToolContext && !minimalSurface) {
    registerUiTaskTool(toolRegistry, uiTaskToolContext);
  }

  // mode 过滤（registerWorkspaceTools 内 hideFromLlm + ask 的 FilteringToolRegistry）
  // 已生效；此处叠加 profile → 最终 mode ∩ profile（顺序：先 mode 再 profile）。
  applyMinimalToolProfile(toolRegistry, settings.agentToolProfile);

  const baseModel = currentModel;
  const provider = buildProviderInstance(settings, sessionId);
  const providerName = resolveProviderName(settings);

  const prefix = new ImmutablePrefix({
    systemPrompt: composedSystemPrompt,
    tools: toolRegistry.getLlmTools(),
    model: baseModel,
    parameters: {
      temperature: overrides.temperature ?? settings.temperature,
      topP: settings.topP,
      maxTokens: overrides.maxTokens ?? settings.maxTokens,
      thinkingEnabled: overrides.thinkingEnabled ?? settings.thinkingEnabled,
      reasoningEffort: overrides.thinkingEffort ?? settings.thinkingEffort,
      thinkingBudgetTokens: overrides.thinkingBudgetTokens ?? settings.thinkingBudgetTokens,
      thinkingPayload: settings.thinkingPayload,
    },
  });
  const log = createLogFromMessages(sessionId, messages, sessionBootstrapPrompt, pruneOptions, {
    omitImages: !modelSupportsVision(settings, baseModel),
  });
  return { prefix, log, model: baseModel, toolRegistry, provider, providerName, uiTaskToolContext };
}

/**
 * 显式创建主线程 Agent（无 Worker / sidecar）。用作隔离运行时反复崩溃后的
 * 降级兜底。代价是重活会阻塞 UI 线程，仅作应急路径。
 */
export function createMainThreadAgent(
  settings: Settings,
  sessionId: string,
  workspacePath: string,
  messages: UIMessage[] = [],
  overrides: Partial<
    Pick<Settings, 'model' | 'thinkingEnabled' | 'thinkingEffort' | 'thinkingBudgetTokens' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  > = {},
  runtime: AgentRuntimeConfig = {},
  pruneOptions?: PruneOptions
): AgentRuntimeHandle {
  return _createLocalAgent(settings, sessionId, workspacePath, messages, overrides, runtime, pruneOptions);
}

function _createLocalAgent(
  settings: Settings,
  sessionId: string,
  workspacePath: string,
  messages: UIMessage[] = [],
  overrides: Partial<
    Pick<Settings, 'model' | 'thinkingEnabled' | 'thinkingEffort' | 'thinkingBudgetTokens' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  > = {},
  runtime: AgentRuntimeConfig = {},
  pruneOptions?: PruneOptions
): AgentRuntimeHandle {
  const parts = buildAgentSessionParts(settings, sessionId, workspacePath, messages, overrides, runtime, pruneOptions);
  const session = new Session({
    sessionId,
    prefix: parts.prefix,
    toolRegistry: parts.toolRegistry,
    log: parts.log,
  });
  return new _MainThreadAgentHandle(new Agent({
    session,
    provider: parts.provider,
    providerName: parts.providerName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds: settings.maxToolRounds,
    // task 工具（子代理）内部有自己的 20 分钟墙钟预算（SUBAGENT_WALL_CLOCK_TIMEOUT_MS）：
    // 父级默认 270s 超时会在子代理预算到期前掐断 promise（且不取消子代理），
    // 必须把 task 的超时对齐到子代理预算。其余读写/命令类工具同样用
    // PERMISSION_WAITING_TOOL_TIMEOUTS（bash 等为无限等待 + 由 IPC/命令侧
    // 各自超时控制），否则主线程兜底路径上 bash 命令 >270s 会被父级超时掐断。
    toolTimeouts: {
      ...PERMISSION_WAITING_TOOL_TIMEOUTS,
      graph: settings.graphToolTimeoutMs,
      task: SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
    },
    toolOutputTruncation: buildToolOutputTruncation(settings, workspacePath),
    toolContextConfig: buildToolContextConfig(settings),
    todoListGuard: () => hasUnsettledTodoTasks(getTodoListContext(sessionId)),
    contextCompaction: createContextCompactionHandler(
      settings,
      parts.providerName,
      sessionId,
      buildBootstrapRefresher(settings, workspacePath, runtime, sessionId),
      undefined,
      runtime.onMidLoopCompactionCommit
    ),
  }), () => parts.uiTaskToolContext?.subagentCacheStats ?? []);
}

export function createAgent(
  settings: Settings,
  sessionId: string,
  workspacePath: string,
  messages: UIMessage[] = [],
  overrides: Partial<
    Pick<Settings, 'model' | 'thinkingEnabled' | 'thinkingEffort' | 'thinkingBudgetTokens' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  > = {},
  runtime: AgentRuntimeConfig = {},
  /** PR1（ADR-006）：重建用的 prune 参数（surface 冻结参数优先；缺省沿用
   *  现有行为——不 prune）。 */
  pruneOptions?: PruneOptions,
): AgentRuntimeHandle {
  const onWorkspaceMutated = runtime.onWorkspaceMutated ?? defaultOnWorkspaceMutatedResolver();
  const baseModel = (overrides.model ?? settings.model).trim();
  const systemPrompt = (overrides.systemPrompt ?? settings.systemPrompt).trim();
  const sessionBootstrapPrompt =
    runtime.sessionBootstrapPrompt ??
    buildAgentSessionBootstrapPrompt(
      settings,
      workspacePath,
      runtime.skillDefinitions ?? [],
      undefined,
      undefined,
      runtime.mode ?? 'agent'
    );

  try {
    if (shouldUseSidecarAgentRuntime() || shouldUseWorkerAgentRuntime()) {
      const provider = resolveProviderName(settings);
      return new WorkerBackedAgent({
        sessionId,
        workspacePath,
        initialMessages: toCoreMessages(messages, sessionBootstrapPrompt, pruneOptions, {
          omitImages: !modelSupportsVision(settings, baseModel),
        }),
        settings: toWorkerAgentSettings(settings),
        providerName: provider,
        model: baseModel,
        systemPrompt,
        parameters: {
          temperature: overrides.temperature ?? settings.temperature,
          topP: settings.topP,
          maxTokens: overrides.maxTokens ?? settings.maxTokens,
          thinkingEnabled: overrides.thinkingEnabled ?? settings.thinkingEnabled,
          reasoningEffort: overrides.thinkingEffort ?? settings.thinkingEffort,
          thinkingBudgetTokens: overrides.thinkingBudgetTokens ?? settings.thinkingBudgetTokens,
          thinkingPayload: settings.thinkingPayload,
        },
        exposeReadImage: shouldExposeReadImage(settings, baseModel),
        transformToolResult: (result) => replaceImagesInToolResult(result, settings, baseModel),
        runtime: {
          editHistory: runtime.editHistory,
          rulesSection: runtime.rulesSection,
          customPrompt: runtime.customPrompt ?? settings.systemPrompt,
          memorySection: runtime.memorySection,
          lang: runtime.lang ?? settings.lang,
          mode: runtime.mode,
          skillDefinitions: runtime.skillDefinitions,
          mcpToolDefinitions: runtime.mcpToolDefinitions,
          mcpToolMappings: runtime.mcpToolMappings,
          agentDefinitions: runtime.agentDefinitions?.filter(
            (agent) => agent.model !== 'mentor' || settings.mentorEnabled
          ).map((agent) => {
            // Override model based on tier selection for explore/scout
            if (agent.name === 'explore') {
              const tier = settings.exploreModelTier;
              const agentDef = { ...agent, model: tier === 'primary' ? undefined : 'fast' };
              if (!subagentMultimodalAllowed(settings, tier) && agentDef.tools) {
                agentDef.tools = { ...agentDef.tools };
                delete (agentDef.tools as Record<string, boolean>)['read_image'];
              }
              return agentDef;
            }
            if (agent.name === 'scout') {
              const tier = settings.scoutModelTier;
              const agentDef = { ...agent, model: tier === 'primary' ? undefined : 'fast' };
              if (!subagentMultimodalAllowed(settings, tier) && agentDef.tools) {
                agentDef.tools = { ...agentDef.tools };
                delete (agentDef.tools as Record<string, boolean>)['read_image'];
              }
              return agentDef;
            }
            return agent;
          }),
          onWorkspaceMutated,
        },
        onStreamSnapshot: runtime.onStreamSnapshot,
        onRefreshBootstrap: buildBootstrapRefresher(settings, workspacePath, runtime, sessionId),
        onMidLoopCompactionCommit: runtime.onMidLoopCompactionCommit,
        ...(shouldUseSidecarAgentRuntime()
          ? { transport: new SidecarTransport({ onWorkspaceMutated }) }
          : {}),
      });
    }
  } catch (e) {
    console.warn('[Agent] Isolated runtime init failed, falling back to main-thread agent:', e);
  }

  // D-8：主线程兜底必须透传 pruneOptions——否则同一会话在 worker/sidecar 路径
  // 带 ADR-006 渲染参数冻结、兜底路径不带，两条运行时的上下文裁剪行为不一致。
  return _createLocalAgent(settings, sessionId, workspacePath, messages, overrides, runtime, pruneOptions);
}

export function getAgentMessagesSince(
  agent: AgentRuntimeHandle | null,
  startIndex: number | null
): IMessage[] {
  if (startIndex === null || !agent || typeof agent.getSession !== 'function') {
    return [];
  }

  const session = agent.getSession?.();
  const logStore = session?.logStore;
  if (!logStore || typeof logStore.getMessagesSince !== 'function') {
    return [];
  }

  return logStore.getMessagesSince(startIndex);
}
