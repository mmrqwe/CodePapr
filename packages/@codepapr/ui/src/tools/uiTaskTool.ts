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
  type SkillDefinition,
  type SubagentStep,
  type ToolOutputTruncationOptions,
} from '@codepapr/core';
import { DEFAULT_MAX_TOKENS, RequestBuilder, CacheValidator, OpenAIProvider, ClaudeProvider } from '@codepapr/api';
import type { ICacheStatistics, ILLMProvider, IToolDefinition, MentorConfig } from '@codepapr/types';
import { registerWorkspaceTools } from '../tools/workspaceTools';
import { startSubagentProgress, pushSubagentStep, completeSubagentProgress } from '../utils/subagentProgress';

export interface UiTaskToolContext {
  workspacePath: string;
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude';
  baseModel: string;
  fastModelEnabled: boolean;
  fastModel: string;
  maxToolRounds: number;
  rulesSection: string;
  customPrompt?: string;
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
  toolOutputTruncation?: ToolOutputTruncationOptions;
}

async function runSubagent(
  context: UiTaskToolContext,
  definition: AgentDefinition,
  prompt: string
): Promise<{ content: string; steps: SubagentStep[]; cacheStats?: ICacheStatistics; tier: 'primary' | 'fast' | 'mentor' }> {
  startSubagentProgress(definition.name, prompt);

  const registry = new ToolRegistry();
  registerWorkspaceTools(
    registry,
    context.workspacePath,
    context.editHistory,
    context.onWorkspaceMutated,
    { multimodalEnabled: context.multimodalEnabled }
  );
  const tools = filterToolsForAgent(registry.getAll(), definition.tools);

  const exec = resolveSubagentExecution({
    definition,
    currentDepth: context.currentDepth ?? 0,
    taskPrompt: prompt,
    baseModel: context.baseModel,
    fastModel: context.fastModel,
    fastModelEnabled: context.fastModelEnabled,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    globalMaxToolRounds: context.maxToolRounds,
    thinkingFallback: context.thinkingEnabled ?? true,
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

  let provider = context.provider;
  let providerName: 'deepseek' | 'openai' | 'claude' = context.providerName;
  if (exec.mentor) {
    const config = { apiKey: exec.mentor.apiKey, ...(exec.mentor.baseURL ? { baseURL: exec.mentor.baseURL } : {}) };
    if (exec.mentor.apiFormat === 'claude') {
      provider = new ClaudeProvider(config);
      providerName = 'claude';
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
    graphToolTimeoutMs: context.graphToolTimeoutMs,
    toolOutputTruncation: context.toolOutputTruncation,
    onToolCallEnd: (event) => {
      pushSubagentStep({
        name: event.toolName,
        status: event.success ? 'success' : 'error',
        summary: event.error || event.toolName,
      });
    },
  });
  completeSubagentProgress(result.content);
  return result;
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

  registry.register(definition, async (args) => {
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
    const result = await runSubagent(context, target, prompt);
    if (result.cacheStats) {
      if (!context.subagentCacheStats) {
        context.subagentCacheStats = [];
      }
      context.subagentCacheStats.push({ tier: result.tier, stats: result.cacheStats });
    }
    return { agent: name, content: result.content, steps: result.steps };
  });

  return definition;
}
