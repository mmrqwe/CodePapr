import {
  Agent,
  AppendOnlyLog,
  ImmutablePrefix,
  Session,
  ToolRegistry,
  FilteringToolRegistry,
  MUTATING_TOOL_NAMES,
  isReadOnlyMode,
  renderTodoListDigest,
  generateToolOutputFilename,
  type AgentDefinition,
  type EditHistory,
  type SkillDefinition,
  type ToolOutputTruncationOptions,
} from '@codepapr/core';
import type { PromptMode } from '@codepapr/core';
import { CacheValidator, RequestBuilder } from '@codepapr/api';
import type { ICacheStatistics, IAgentResponse, IImageContent, IMessage, IToolDefinition } from '@codepapr/types';
import {
  WorkerBackedAgent,
  type AgentRuntimeHandle,
  type AgentRuntimeStreamEvent,
} from '../../agent/WorkerBackedAgent';
import { createContextCompactionHandler } from '../../agent/compactionHandler';
import { registerWorkspaceTools } from '../../tools/workspaceTools';
import { registerUiTaskTool, type UiTaskToolContext } from '../../tools/uiTaskTool';
import { getTodoListContext, registerTodoListTools } from '../../tools/todoListTool';
import { registerMcpTools } from '../../tools/mcpTools';
import { hasEnabledMcpSearch } from '../../utils/mcpTypes';
import {
  buildProviderInstance,
  shouldUseWorkerAgentRuntime,
  toWorkerAgentSettings,
} from './providerFactory';
import { resolveProviderName } from './settingsNormalizer';
import { getActiveCharacterPrompt } from '../charactersStore';
import {
  buildAgentSessionBootstrapPrompt,
  createLogFromMessages,
  toCoreMessages,
} from './promptBuilders';
import type { ApiFormat, Lang, Settings, UIMessage } from './types';

function resolveMultimodalEnabled(settings: Settings, currentModel: string): boolean {
  if (!settings.multimodalEnabled) return false;
  if (settings.multimodalModelTier === 'all') return true;
  const fastModel = settings.fastModel.trim();
  const isFastModel = settings.fastModelEnabled && fastModel.length > 0 && currentModel === fastModel;
  if (settings.multimodalModelTier === 'primary' && !isFastModel) return true;
  if (settings.multimodalModelTier === 'fast' && isFastModel) return true;
  return false;
}

function subagentMultimodalAllowed(settings: Settings, agentTier: 'primary' | 'fast'): boolean {
  if (!settings.multimodalEnabled) return false;
  if (settings.multimodalModelTier === 'all') return true;
  return settings.multimodalModelTier === agentTier;
}

function buildToolOutputTruncation(
  settings: Settings,
  workspacePath: string
): ToolOutputTruncationOptions {
  return {
    interceptChars: settings.toolOutputInterceptChars,
    offloadChars: settings.toolOutputOffloadChars,
    offloadPreviewChars: settings.toolOutputPreviewChars,
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

export interface AgentRuntimeConfig {
  editHistory?: EditHistory;
  rulesSection?: string;
  customPrompt?: string;
  memorySection?: string;
  projectGraphSummary?: string;
  /** 已按 session 记忆化（冻结）的会话引导，含 skills/memory/project-graph/custom。
   *  优先用它注入 log[0]，兑现 memory.md「每次会话自动加载」；缺省时回退到仅 skills+custom。 */
  sessionBootstrapPrompt?: string;
  lang?: Lang;
  /** 当前工作模式：ask/plan 会在注册层屏蔽变更类工具。缺省 agent。 */
  mode?: PromptMode;
  skillDefinitions?: SkillDefinition[];
  agentDefinitions?: AgentDefinition[];
  mcpToolDefinitions?: IToolDefinition[];
  mcpToolMappings?: Array<{ serverId: string; toolName: string; displayName: string }>;
  onWorkspaceMutated?: (paths?: string[]) => void;
  onStreamSnapshot?: () => void;
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
    images?: IImageContent[]
  ): Promise<IAgentResponse> {
    this.abortController = new AbortController();
    try {
      const response = await this.agent.chat(userInput, onStreamEvent, images, this.abortController.signal);
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

function _createLocalAgent(
  settings: Settings,
  sessionId: string,
  workspacePath: string,
  messages: UIMessage[] = [],
  overrides: Partial<
    Pick<Settings, 'model' | 'thinkingEnabled' | 'thinkingEffort' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  > = {},
  runtime: AgentRuntimeConfig = {}
): AgentRuntimeHandle {
  const mode: PromptMode = runtime.mode ?? 'agent';
  const toolRegistry = isReadOnlyMode(mode)
    ? new FilteringToolRegistry((tool) => !MUTATING_TOOL_NAMES.has(tool.name))
    : new ToolRegistry();
  const onWorkspaceMutated = runtime.onWorkspaceMutated ?? defaultOnWorkspaceMutatedResolver();
  const sessionBootstrapPrompt =
    runtime.sessionBootstrapPrompt ??
    buildAgentSessionBootstrapPrompt(settings, workspacePath, runtime.skillDefinitions ?? []);
  const characterPrompt = getActiveCharacterPrompt();
  const customPromptWithCharacter = [
    runtime.customPrompt ?? settings.systemPrompt,
    characterPrompt,
  ]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join('\n\n');
  const composedSystemPrompt = [
    (overrides.systemPrompt ?? settings.systemPrompt).trim(),
    characterPrompt,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
  registerWorkspaceTools(toolRegistry, workspacePath, runtime.editHistory, (paths) => {
    onWorkspaceMutated(paths);
  }, {
    disableWebSearchTools: hasEnabledMcpSearch(settings.mcp),
    multimodalEnabled: resolveMultimodalEnabled(settings, overrides.model ?? settings.model),
  });

  // TodoList 工具：主 Agent 的"短期工作记忆"，与 task 工具正交协作
  registerTodoListTools(toolRegistry, sessionId, '', settings.todoMaxRetries);

  registerMcpTools(toolRegistry, settings.mcp, runtime.mcpToolDefinitions ?? [], runtime.mcpToolMappings);

  let uiTaskToolContext: UiTaskToolContext | undefined;

  const baseModel = (overrides.model ?? settings.model).trim();
  const provider = buildProviderInstance(settings);
  const providerName = resolveProviderName(settings);

  if (runtime.agentDefinitions && runtime.agentDefinitions.length > 0) {
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
    if (availableAgents.length > 0) {
      uiTaskToolContext = {
        workspacePath,
        provider,
        providerName,
        baseModel,
        fastModelEnabled: settings.fastModelEnabled,
        fastModel: settings.fastModel,
        maxToolRounds: settings.maxToolRounds,
        rulesSection: runtime.rulesSection ?? '',
        customPrompt: runtime.customPrompt ? runtime.customPrompt : customPromptWithCharacter,
        memorySection: runtime.memorySection,
        projectGraphSummary: runtime.projectGraphSummary,
        lang: runtime.lang ?? settings.lang,
        skillDefinitions: runtime.skillDefinitions ?? [],
        agents: availableAgents,
      mentor: { enabled: settings.mentorEnabled, model: settings.mentorModel, baseURL: settings.mentorBaseURL, apiKey: settings.mentorApiKey, apiFormat: settings.mentorApiFormat as ApiFormat, maxTokens: settings.mentorMaxTokens, maxConsultations: settings.maxMentorConsultations, thinkingEnabled: settings.mentorThinkingEnabled },
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      multimodalEnabled: resolveMultimodalEnabled(settings, baseModel),
      toolOutputTruncation: buildToolOutputTruncation(settings, workspacePath),
      thinkingEnabled: settings.thinkingEnabled,
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
      };
      registerUiTaskTool(toolRegistry, uiTaskToolContext);
    }
  }

  const prefix = new ImmutablePrefix({
    systemPrompt: composedSystemPrompt,
    tools: toolRegistry.getAll(),
    model: baseModel,
    parameters: {
      temperature: overrides.temperature ?? settings.temperature,
      topP: settings.topP,
      maxTokens: overrides.maxTokens ?? settings.maxTokens,
      thinkingEnabled: overrides.thinkingEnabled ?? settings.thinkingEnabled,
      reasoningEffort: overrides.thinkingEffort ?? settings.thinkingEffort,
    },
  });
  const todoListDigest = (() => {
    const ctx = getTodoListContext(sessionId);
    if (!ctx || ctx.tasks.length === 0) return undefined;
    return renderTodoListDigest(ctx);
  })();
  const session = new Session({
    sessionId,
    prefix,
    toolRegistry,
    log: createLogFromMessages(sessionId, messages, sessionBootstrapPrompt, todoListDigest),
  });
  return new _MainThreadAgentHandle(new Agent({
    session,
    provider,
    providerName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds: settings.maxToolRounds,
    toolTimeouts: { graph: settings.graphToolTimeoutMs },
    toolOutputTruncation: buildToolOutputTruncation(settings, workspacePath),
    contextCompaction: createContextCompactionHandler(settings, providerName, sessionId),
  }), () => uiTaskToolContext?.subagentCacheStats ?? []);
}

export function createAgent(
  settings: Settings,
  sessionId: string,
  workspacePath: string,
  messages: UIMessage[] = [],
  overrides: Partial<
    Pick<Settings, 'model' | 'thinkingEnabled' | 'thinkingEffort' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  > = {},
  runtime: AgentRuntimeConfig = {},
): AgentRuntimeHandle {
  const onWorkspaceMutated = runtime.onWorkspaceMutated ?? defaultOnWorkspaceMutatedResolver();
  const baseModel = (overrides.model ?? settings.model).trim();
  const characterPrompt = getActiveCharacterPrompt();
  const baseSystemPrompt = (overrides.systemPrompt ?? settings.systemPrompt).trim();
  const systemPrompt = [baseSystemPrompt, characterPrompt]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
  const customPromptWithCharacter = [
    runtime.customPrompt ?? settings.systemPrompt,
    characterPrompt,
  ]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join('\n\n');
  const sessionBootstrapPrompt =
    runtime.sessionBootstrapPrompt ??
    buildAgentSessionBootstrapPrompt(settings, workspacePath, runtime.skillDefinitions ?? []);

  try {
    if (shouldUseWorkerAgentRuntime()) {
      const provider = resolveProviderName(settings);
      return new WorkerBackedAgent({
        sessionId,
        workspacePath,
        initialMessages: toCoreMessages(messages, sessionBootstrapPrompt, (() => {
          const ctx = getTodoListContext(sessionId);
          if (!ctx || ctx.tasks.length === 0) return undefined;
          return renderTodoListDigest(ctx);
        })()),
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
        },
        runtime: {
          editHistory: runtime.editHistory,
          rulesSection: runtime.rulesSection,
          customPrompt: runtime.customPrompt ? runtime.customPrompt : customPromptWithCharacter,
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
      });
    }
  } catch (e) {
    console.warn('[Agent] Worker init failed, falling back to main-thread agent:', e);
  }

  return _createLocalAgent(settings, sessionId, workspacePath, messages, overrides, runtime);
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
