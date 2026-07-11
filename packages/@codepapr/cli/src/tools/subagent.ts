import {
  Agent,
  AppendOnlyLog,
  buildSessionBootstrapPrompt,
  buildSkillsSection,
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  ImmutablePrefix,
  Session,
  selectSubagentExecutionRoute,
  ToolRegistry,
  filterToolsForAgent,
  buildTaskToolDefinition,
  SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS,
  SUBAGENT_MAX_DEPTH,
  sanitizeAgentPrompt,
  resolveAgentPrompt,
} from '@codepapr/core';
import { RequestBuilder, CacheValidator, OpenAIProvider, ClaudeProvider } from '@codepapr/api';
import type { ICacheStatistics, ILLMProvider, IToolDefinition, MentorConfig } from '@codepapr/types';
import type { AgentDefinition, EditHistory, SkillDefinition } from '@codepapr/core';
import type { CacheStatsRepository } from '@codepapr/db';
import { registerCliWorkspaceTools } from './registerCliWorkspaceTools';

export interface TaskToolContext {
  workspacePath: string;
  provider: ILLMProvider;
  providerKey: 'deepseek' | 'openai' | 'claude';
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
  currentDepth?: number;
  mentor?: MentorConfig;
  baseURL?: string;
  statsRepo?: CacheStatsRepository;
  parentSessionId?: string;
  subagentParameters?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    thinkingEnabled?: boolean;
    maxToolRounds?: number;
  };
}

async function runSubagent(
  context: TaskToolContext,
  definition: AgentDefinition,
  prompt: string
): Promise<{ content: string; cacheStats?: ICacheStatistics }> {
  const currentDepth = context.currentDepth ?? 0;
  if (currentDepth >= SUBAGENT_MAX_DEPTH) {
    throw new Error(`子代理嵌套深度已达上限（${SUBAGENT_MAX_DEPTH} 层），无法继续委派`);
  }

  const registry = new ToolRegistry();
  const allTools = registerCliWorkspaceTools(registry, context.workspacePath, context.editHistory);
  const tools = filterToolsForAgent(allTools, definition.tools);
  const systemPrompt = buildRuntimeSystemPrompt({
    mode: 'agent',
    workspacePath: context.workspacePath,
    lang: context.lang,
    extraSections: [sanitizeAgentPrompt(resolveAgentPrompt(definition, context.lang))],
    toolNames: tools.map((tool) => tool.name),
    subagent: true,
  });
  const log = new AppendOnlyLog(`subagent-${definition.name}-${Date.now()}`);
  const sessionBootstrapPrompt = buildSessionBootstrapPrompt({
    workspacePath: context.workspacePath,
    lang: context.lang,
    skillsSection: buildSkillsSection(context.skillDefinitions, context.lang),
    customPromptSection: context.customPrompt,
  });
  if (sessionBootstrapPrompt.trim()) {
    await log.append({
      id: 'session-bootstrap',
      role: 'assistant',
      content: sessionBootstrapPrompt.trim(),
      timestamp: Date.now(),
      metadata: { sessionBootstrap: true },
    });
  }
  const userPrompt = buildRuntimeUserPrompt({
    mode: 'agent',
    input: prompt,
    workspacePath: context.workspacePath,
    lang: context.lang,
  });

  let resolvedModel: string | undefined = definition.model;
  let subagentProvider = context.provider;
  let subagentProviderName: 'deepseek' | 'openai' | 'claude' = context.providerKey;

  if (definition.model === 'fast') {
    resolvedModel = context.fastModel || context.baseModel;
  } else if (definition.model === 'mentor' && context.mentor?.enabled) {
    resolvedModel = context.mentor.model;
    try {
      const apiKey = context.mentor.apiKey.trim();
      const baseURL = context.mentor.baseURL.trim().replace(/\/+$/, '') || (context.baseURL ?? '').trim().replace(/\/+$/, '') || undefined;
      const config = { apiKey, ...(baseURL ? { baseURL } : {}) };
      if (context.mentor.apiFormat === 'claude') {
        subagentProvider = new ClaudeProvider(config);
        subagentProviderName = 'claude';
      } else {
        subagentProvider = new OpenAIProvider(config);
        subagentProviderName = 'openai';
      }
    } catch (e) {
      console.warn('[CLI Subagent] Mentor provider build failed, falling back to main provider', e);
    }
  }

  const route = selectSubagentExecutionRoute({
    baseModel: context.baseModel,
    fastModelEnabled: context.fastModelEnabled,
    fastModel: context.fastModel,
    taskPrompt: prompt,
    explicitModel: resolvedModel,
    defaultTemperature: 0.7,
    explicitTemperature: definition.temperature,
  });
  const temperature = context.subagentParameters?.temperature ?? 0.5;
  const subagentMaxToolRounds = Math.min(
    context.maxToolRounds,
    context.subagentParameters?.maxToolRounds ?? SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS
  );

  const parameters = {
    temperature,
    topP: context.subagentParameters?.topP ?? 0.9,
    maxTokens: context.subagentParameters?.maxTokens ?? 393_216,
    thinkingEnabled: context.subagentParameters?.thinkingEnabled ?? true,
  };

  const prefix = new ImmutablePrefix({ systemPrompt, tools, model: route.model, parameters });
  const session = new Session({
    sessionId: `subagent-${definition.name}-${Date.now()}`,
    prefix,
    toolRegistry: registry,
    log,
  });
  const agent = new Agent({
    session,
    provider: subagentProvider,
    providerName: subagentProviderName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds: subagentMaxToolRounds,
  });

  let response;
  try {
    response = await agent.chat(userPrompt);
  } catch (err) {
    // 附上 subagent 上下文后重抛，避免 400 "Load fail" 等被吞成无信息短串
    const errName = err instanceof Error ? err.name : undefined;
    const errMsg = err instanceof Error ? err.message : String(err);
    const contextTag = `[CLISubagent=${definition.name} model=${route.model} tier=${route.tier}]`;
    const wrapped = new Error(`${contextTag} ${errMsg}`);
    wrapped.name = errName ?? 'SubagentError';
    if (err instanceof Error && 'provider' in err) {
      (wrapped as { provider?: string }).provider = (err as { provider?: string }).provider;
      (wrapped as { status?: number }).status = (err as { status?: number }).status;
      (wrapped as { responseBody?: string }).responseBody = (err as { responseBody?: string }).responseBody;
      (wrapped as { requestId?: string }).requestId = (err as { requestId?: string }).requestId;
    }
    throw wrapped;
  }

  if (context.statsRepo && context.parentSessionId && response.cacheStats) {
    context.statsRepo.save(context.parentSessionId, response.cacheStats);
  }

  return { content: response.content, cacheStats: response.cacheStats };
}

export function registerTaskTool(
  registry: ToolRegistry,
  context: TaskToolContext
): IToolDefinition | null {
  if (context.agents.length === 0) {
    return null;
  }

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
    const result = await runSubagent(context, target, prompt);
    return { agent: name, content: result.content };
  });

  return definition;
}
