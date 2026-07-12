/**
 * uiTaskTool: 在 Tauri UI 中注册声明式子代理（task 工具）。
 *
 * 主代理可把一个子任务委派给某个在 .CodePapr/agents 中声明的子代理。
 * 子代理拥有独立的 Session、ToolRegistry 与（按声明过滤的）工具集，
 * 复用主代理的 Provider，执行结束后把最终回答返回给主代理。
 */

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
  type AgentDefinition,
  type EditHistory,
  type SkillDefinition,
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
  subagentCacheStats?: Array<{ tier: 'primary' | 'fast'; stats: ICacheStatistics }>;
  graphToolTimeoutMs: number;
}

interface SubagentStep {
  name: string;
  status: 'success' | 'error';
  summary: string;
}

const SUBAGENT_WALL_CLOCK_TIMEOUT_MS = 600_000;

async function withWallClockTimeout<T>(
  agent: Agent,
  promiseFactory: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        agent.cancel();
        reject(new Error(`子代理执行超时 (${timeoutMs / 1000}s)`));
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

async function runSubagent(
  context: UiTaskToolContext,
  definition: AgentDefinition,
  prompt: string
): Promise<{ content: string; steps: SubagentStep[]; cacheStats?: ICacheStatistics; tier: 'primary' | 'fast' }> {
  const currentDepth = context.currentDepth ?? 0;
  const agentMaxDepth = definition.name === 'explore'
    ? context.exploreMaxDepth
    : definition.name === 'scout'
    ? context.scoutMaxDepth
    : SUBAGENT_MAX_DEPTH;
  const maxDepth = agentMaxDepth ?? SUBAGENT_MAX_DEPTH;
  if (currentDepth >= maxDepth) {
    throw new Error(`子代理嵌套深度已达上限（${maxDepth} 层），无法继续委派`);
  }

  const steps: SubagentStep[] = [];
  startSubagentProgress(definition.name, prompt);
  const registry = new ToolRegistry();
  registerWorkspaceTools(
    registry,
    context.workspacePath,
    context.editHistory,
    context.onWorkspaceMutated
  );
  const allTools = registry.getAll();
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
  await log.append({
    id: `subagent-${definition.name}-user`,
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  });

  let resolvedModel: string | undefined = definition.model;
  let provider = context.provider;
  let providerName: 'deepseek' | 'openai' | 'claude' = context.providerName;

  if (definition.model === 'fast') {
    resolvedModel = context.fastModel || context.baseModel;
  } else if (definition.model === 'mentor' && context.mentor?.enabled) {
    resolvedModel = context.mentor.model;
    try {
      const apiKey = context.mentor.apiKey.trim() || context.mentor.apiKey.trim();
      const baseURL = context.mentor.baseURL.trim().replace(/\/+$/, '') || (context.baseURL ?? '').trim().replace(/\/+$/, '') || undefined;
      const config = { apiKey, ...(baseURL ? { baseURL } : {}) };
      if (context.mentor.apiFormat === 'claude') {
        provider = new ClaudeProvider(config);
        providerName = 'claude';
      } else {
        provider = new OpenAIProvider(config);
        providerName = 'openai';
      }
    } catch (e) {
      console.warn('[UI Subagent] Mentor provider build failed, falling back to main provider', e);
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
  const isExplore = definition.name === 'explore';
  const isScout = definition.name === 'scout';
  const parameters = {
    temperature: isExplore ? (context.exploreTemperature ?? 0.5) : isScout ? (context.scoutTemperature ?? 0.3) : 0.5,
    topP: isExplore ? (context.exploreTopP ?? 0.9) : isScout ? (context.scoutTopP ?? 0.9) : 0.9,
    maxTokens: isExplore ? (context.exploreMaxTokens ?? DEFAULT_MAX_TOKENS) : isScout ? (context.scoutMaxTokens ?? DEFAULT_MAX_TOKENS) : DEFAULT_MAX_TOKENS,
    thinkingEnabled: definition.model === 'mentor'
      ? (context.mentor?.thinkingEnabled ?? false)
      : isExplore
      ? (context.exploreThinkingEnabled ?? true)
      : isScout
      ? (context.scoutThinkingEnabled ?? false)
      : context.thinkingEnabled ?? true,
  };
  const agentMaxToolRounds = isExplore
    ? context.exploreMaxToolRounds
    : isScout
    ? context.scoutMaxToolRounds
    : SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS;
  const subagentMaxToolRounds = Math.min(
    context.maxToolRounds,
    agentMaxToolRounds ?? SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS
  );

  const prefix = new ImmutablePrefix({ systemPrompt, tools, model: route.model, parameters });
  const session = new Session({
    sessionId: `subagent-${definition.name}-${Date.now()}`,
    prefix,
    toolRegistry: registry,
    log,
  });

  const agent = new Agent({
    session,
    provider,
    providerName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    maxToolRounds: subagentMaxToolRounds,
    toolTimeouts: { graph: context.graphToolTimeoutMs },
  });

  let response;
  try {
    response = await withWallClockTimeout(
      agent,
      () =>
        agent.chat(userPrompt, (event) => {
          if (event.type === 'tool-call-end') {
            const step: SubagentStep = {
              name: event.toolName,
              status: event.success ? 'success' : 'error',
              summary: event.error || event.toolName,
            };
            steps.push(step);
            pushSubagentStep(step);
          }
        }),
      SUBAGENT_WALL_CLOCK_TIMEOUT_MS
    );
  } catch (err) {
    // 子代理 LLM 调用失败时，附上 agent/model/tier 上下文以便主代理能看清
    // 真实原因（例：DeepSeek 400 "Load fail" 由于历史 assistant 未回传
    // reasoning_content）。否则错误会被 task 工具的 try/catch 吞成简短 message。
    const errName = err instanceof Error ? err.name : undefined;
    const errMsg = err instanceof Error ? err.message : String(err);
    const contextTag = `[Subagent=${definition.name} model=${route.model} tier=${route.tier}]`;
    const wrapped = new Error(`${contextTag} ${errMsg}`);
    wrapped.name = errName ?? 'SubagentError';
    if (err instanceof Error && 'provider' in err) {
      // 透传 ProviderRequestError 的诊断字段，便于上层 worker 透出结构化信息
      (wrapped as { provider?: string }).provider = (err as { provider?: string }).provider;
      (wrapped as { status?: number }).status = (err as { status?: number }).status;
      (wrapped as { responseBody?: string }).responseBody = (err as { responseBody?: string }).responseBody;
      (wrapped as { requestId?: string }).requestId = (err as { requestId?: string }).requestId;
    }
    throw wrapped;
  }
  completeSubagentProgress(response.content);
  return { content: response.content, steps, cacheStats: response.cacheStats, tier: route.tier };
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
