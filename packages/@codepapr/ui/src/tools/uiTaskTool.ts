/**
 * uiTaskTool: 在 Tauri UI 中注册声明式子代理（task 工具）。
 *
 * 主代理可把一个子任务委派给某个在 .CodePapr/agents 中声明的子代理。
 * 子代理拥有独立的 Session、ToolRegistry 与（按声明过滤的）工具集，
 * 复用主代理的 Provider，执行结束后把最终回答返回给主代理。
 */

import {
  buildSkillsSection,
  resolveSubagentExecution,
  runSubagentSession,
  ToolRegistry,
  filterToolsForAgent,
  buildTaskToolDefinition,
  type AgentDefinition,
  type EditHistory,
  type PromptMode,
  type SkillDefinition,
  type SubagentSessionResult,
  type ToolOutputTruncationOptions,
  withTaskSlot,
} from '@codepapr/core';
import { DEFAULT_MAX_TOKENS, RequestBuilder, CacheValidator, OpenAIProvider, ClaudeProvider, ResponseProvider } from '@codepapr/api';
import type { ICacheStatistics, ILLMProvider, IToolDefinition, MentorConfig, ThinkingPayload } from '@codepapr/types';
import { registerWorkspaceTools } from '../tools/workspaceTools';
import { startSubagentProgress, pushSubagentStep, completeSubagentProgress } from '../utils/subagentProgress';

export interface UiTaskToolContext {
  workspacePath: string;
  /** 主会话 ID：子代理进度条按会话过滤，避免切对话/切项目后串台。 */
  sessionId?: string;
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude' | 'response';
  baseModel: string;
  fastModelEnabled: boolean;
  fastModel: string;
  maxToolRounds: number;
  rulesSection: string;
  customPrompt?: string;
  memorySection?: string;
  projectGraphSummary?: string;
  lang?: 'zh-CN' | 'zh-TW' | 'en';
  skillDefinitions: SkillDefinition[];
  agents: AgentDefinition[];
  editHistory?: EditHistory;
  onWorkspaceMutated?: (paths: string[]) => void;
  mentor?: MentorConfig;
  baseURL?: string;
  /** 主 apiKey：mentor 未单独配置 apiKey 时回退使用。 */
  apiKey?: string;
  currentDepth?: number;
  thinkingEnabled?: boolean;
  /** 主模型思考强度：explore/scout 及普通子代理继承（与主代理共用模型）。 */
  reasoningEffort?: string;
  thinkingBudgetTokens?: number;
  thinkingPayload?: ThinkingPayload;
  exploreTopP?: number;
  exploreMaxTokens?: number;
  exploreThinkingEnabled?: boolean;
  exploreTemperature?: number;
  exploreMaxToolRounds?: number;
  exploreMaxDepth?: number;
  scoutTopP?: number;
  scoutMaxTokens?: number;
  scoutThinkingEnabled?: boolean;
  scoutTemperature?: number;
  scoutMaxToolRounds?: number;
  scoutMaxDepth?: number;
  subagentCacheStats?: Array<{ tier: 'primary' | 'fast' | 'mentor'; stats: ICacheStatistics }>;
  graphToolTimeoutMs: number;
  multimodalEnabled: boolean;
  readImageEnabledForModel?: (model: string) => boolean;
  transformToolResultForModel?: (result: unknown, model: string) => Promise<unknown>;
  /** 非 mentor/explore/scout 子代理的 maxTokens 兜底（缺省 DEFAULT_MAX_TOKENS）。
   *  内部子代理（如 verifier）可用克隆上下文覆盖。 */
  defaultMaxTokens?: number;
  toolOutputTruncation?: ToolOutputTruncationOptions;
  /** 主会话工作模式：app 模式下子代理同样需要能搜索 .CodePapr/apps 应用源码。 */
  mode?: PromptMode;
}

/**
 * 在 Tauri UI 中执行一个声明式子代理会话（task 工具与内部子代理共用）。
 * 子代理拥有独立的 Session、ToolRegistry 与（按声明过滤的）工具集，
 * 复用主代理的 Provider，执行结束后把最终回答返回。
 * maxWallClockMs 可覆盖默认的 20 分钟墙钟预算（如 verifier 用更紧的预算）。
 */
export async function runSubagent(
  context: UiTaskToolContext,
  definition: AgentDefinition,
  prompt: string,
  abortSignal?: AbortSignal,
  maxWallClockMs?: number
): Promise<SubagentSessionResult> {
  const runId = startSubagentProgress(definition.name, prompt, undefined, context.sessionId);

  try {
    const exec = resolveSubagentExecution({
      definition,
      currentDepth: context.currentDepth ?? 0,
      taskPrompt: prompt,
      baseModel: context.baseModel,
      fastModel: context.fastModel,
      fastModelEnabled: context.fastModelEnabled,
      defaultMaxTokens: context.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      globalMaxToolRounds: context.maxToolRounds,
      thinkingFallback: context.thinkingEnabled ?? true,
      reasoningEffort: context.reasoningEffort ?? '',
      thinkingBudgetTokens: context.thinkingBudgetTokens ?? 0,
      thinkingPayload: context.thinkingPayload,
      explore: {
        topP: context.exploreTopP,
        maxTokens: context.exploreMaxTokens,
        thinkingEnabled: context.exploreThinkingEnabled,
        temperature: context.exploreTemperature,
        maxToolRounds: context.exploreMaxToolRounds,
        maxDepth: context.exploreMaxDepth,
      },
      scout: {
        topP: context.scoutTopP,
        maxTokens: context.scoutMaxTokens,
        thinkingEnabled: context.scoutThinkingEnabled,
        temperature: context.scoutTemperature,
        maxToolRounds: context.scoutMaxToolRounds,
        maxDepth: context.scoutMaxDepth,
      },
      mentor: context.mentor,
      fallbackApiKey: context.apiKey ?? '',
      fallbackBaseURL: context.baseURL ?? '',
    });

    const subagentModel = exec.route.model;
    const registry = new ToolRegistry();
    registerWorkspaceTools(
      registry,
      context.workspacePath,
      context.editHistory,
      context.onWorkspaceMutated,
      {
        multimodalEnabled: context.readImageEnabledForModel
          ? context.readImageEnabledForModel(subagentModel)
          : context.multimodalEnabled,
        exposeGraphToLlm: true,
        mode: context.mode,
      }
    );
    if (context.transformToolResultForModel) {
      const originalExecute = registry.execute.bind(registry);
      registry.execute = async (name, args, execContext) => {
        const result = await originalExecute(name, args, execContext);
        return context.transformToolResultForModel!(result, subagentModel);
      };
    }
    const tools = filterToolsForAgent(registry.getAll(), definition.tools);

    let provider = context.provider;
    let providerName: 'deepseek' | 'openai' | 'claude' | 'response' = context.providerName;
    if (exec.mentor) {
      const mentorSessionId = context.sessionId ? `${context.sessionId}:mentor` : undefined;
      const config = {
        apiKey: exec.mentor.apiKey,
        ...(exec.mentor.baseURL ? { baseURL: exec.mentor.baseURL } : {}),
        ...(mentorSessionId ? { sessionId: mentorSessionId } : {}),
      };
      if (exec.mentor.apiFormat === 'claude') {
        provider = new ClaudeProvider(config);
        providerName = 'claude';
      } else if (exec.mentor.apiFormat === 'response') {
        provider = new ResponseProvider(config);
        providerName = 'response';
      } else {
        provider = new OpenAIProvider(config);
        providerName = 'openai';
      }
    }

    const result = await runSubagentSession({
      definition,
      prompt,
      workspacePath: context.workspacePath,
      lang: context.lang,
      exec,
      registry,
      tools,
      provider,
      providerName,
      requestBuilder: new RequestBuilder(),
      cacheValidator: new CacheValidator(),
      skillsSection: buildSkillsSection(context.skillDefinitions, context.lang),
      customPromptSection: context.customPrompt,
      memorySection: context.memorySection,
      projectGraphSummary: context.projectGraphSummary,
      rulesSection: context.rulesSection,
      graphToolTimeoutMs: context.graphToolTimeoutMs,
      maxWallClockMs,
      abortSignal,
      toolOutputTruncation: context.toolOutputTruncation,
      onToolCallEnd: (event) => {
        pushSubagentStep(runId, {
          name: event.toolName,
          status: event.success ? 'success' : 'error',
          summary: event.error || event.toolName,
        });
      },
    });
    completeSubagentProgress(runId);
    return result;
  } catch (error) {
    // start 之后任何环节（setup/执行）抛错都必须收尾，否则面板永远「正在思考」。
    completeSubagentProgress(runId);
    throw error;
  }
}

/**
 * 把 task 工具注册到主代理的 ToolRegistry。
 * 没有任何子代理声明时返回 null（不注册，保持工具集稳定以利缓存）。
 */
export function registerUiTaskTool(
  registry: ToolRegistry,
  context: UiTaskToolContext
): IToolDefinition | null {
  const definition = buildTaskToolDefinition(context.agents, context.lang);
  if (!definition) {
    return null;
  }

  registry.register(definition, async (args, execContext) => {
    const name = typeof args.agent === 'string' ? args.agent.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!name) {
      throw new Error('task.agent 必须是子代理名称');
    }
    if (!prompt) {
      throw new Error('task.prompt 不能为空');
    }
    const target = context.agents.find((agent) => agent.name === name);
    if (!target) {
      throw new Error(`未找到子代理: ${name}`);
    }
    if (target.internal) {
      throw new Error(`子代理 "${name}" 是内部代理，不能直接委派`);
    }
    const result = await withTaskSlot(() =>
      runSubagent(context, target, prompt, execContext?.signal)
    );
    if (result.cacheStats) {
      if (!context.subagentCacheStats) {
        context.subagentCacheStats = [];
      }
      context.subagentCacheStats.push({ tier: result.tier, stats: result.cacheStats });
    }
    return {
      agent: name,
      content: result.content,
      steps: result.steps,
      __subagentToolInvocations: result.toolInvocations,
    };
  });

  return definition;
}
