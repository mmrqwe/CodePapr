/**
 * subagentConfig: 子代理执行的单一逻辑来源（纯逻辑 + 编排，传输无关）。
 *
 * 主线程（uiTaskTool）与 Worker（agentRuntime.worker）两条子代理路径共享此处逻辑，
 * 各自仅注入差异部分：ToolRegistry（直接执行 vs IPC）与 Provider（含 mentor 构建）。
 *
 * - resolveSubagentExecution: 解析模型路由 / 参数 / 深度 / 轮数 / mentor 配置（纯函数）。
 * - runSubagentSession: 构建 Session + Agent 并执行，收集 steps、包装错误、超时控制。
 */

import type {
  ICacheStatistics,
  IChatStreamEvent,
  ILLMProvider,
  IToolDefinition,
} from '@codepapr/types';
import { Agent, type IRequestBuilder, type ICacheValidator } from './Agent';
import { Session } from './Session';
import { AppendOnlyLog } from '../cache/AppendOnlyLog';
import { ImmutablePrefix } from '../cache/ImmutablePrefix';
import type { ToolRegistry } from '../tool/ToolRegistry';
import type { ToolOutputTruncationOptions } from '../tool/toolOutputTruncation';
import {
  buildRuntimeSystemPrompt,
  buildRuntimeUserPrompt,
  buildSessionBootstrapPrompt,
  type PromptLang,
} from './promptSystem';
import {
  sanitizeAgentPrompt,
  resolveAgentPrompt,
  SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS,
  SUBAGENT_MAX_DEPTH,
  type AgentDefinition,
} from './agentConfig';
import { selectSubagentExecutionRoute, type SubagentExecutionRoute } from './subagentRoute';

export const SUBAGENT_WALL_CLOCK_TIMEOUT_MS = 600_000;

const EXPLORE_DEFAULT_TEMPERATURE = 0.5;
const SCOUT_DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_SUBAGENT_TOP_P = 0.9;
const DEFAULT_ROUTE_TEMPERATURE = 0.7;

export interface SubagentTierSettings {
  topP?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  temperature?: number;
  maxToolRounds?: number;
  maxDepth?: number;
}

export interface SubagentMentorSettings {
  enabled: boolean;
  model: string;
  apiKey: string;
  baseURL: string;
  apiFormat: 'openai' | 'claude';
  maxTokens: number;
  thinkingEnabled: boolean;
}

export interface SubagentExecutionInput {
  definition: AgentDefinition;
  currentDepth: number;
  taskPrompt: string;
  baseModel: string;
  fastModel: string;
  fastModelEnabled: boolean;
  /** 非 mentor/explore/scout 子代理的 maxTokens 兜底（调用方传 DEFAULT_MAX_TOKENS）。 */
  defaultMaxTokens: number;
  globalMaxToolRounds: number;
  /** 非 mentor/explore/scout 子代理的 thinking 兜底（通常为主代理 thinkingEnabled）。 */
  thinkingFallback: boolean;
  explore?: SubagentTierSettings;
  scout?: SubagentTierSettings;
  mentor?: SubagentMentorSettings;
  /** mentor 未单独配置 apiKey 时的回退（主 apiKey）。 */
  fallbackApiKey: string;
  /** mentor 未单独配置 baseURL 时的回退（主 baseURL）。 */
  fallbackBaseURL: string;
}

export interface ResolvedSubagentParameters {
  temperature: number;
  topP: number;
  maxTokens: number;
  thinkingEnabled: boolean;
}

export interface ResolvedSubagentMentor {
  model: string;
  apiKey: string;
  baseURL?: string;
  apiFormat: 'openai' | 'claude';
}

export interface ResolvedSubagentExecution {
  route: SubagentExecutionRoute;
  parameters: ResolvedSubagentParameters;
  maxToolRounds: number;
  mentor: ResolvedSubagentMentor | null;
  usingMentor: boolean;
  tier: 'primary' | 'fast' | 'mentor';
}

export function resolveSubagentExecution(
  input: SubagentExecutionInput
): ResolvedSubagentExecution {
  const { definition } = input;
  const isExplore = definition.name === 'explore';
  const isScout = definition.name === 'scout';
  const tierSettings = isExplore ? input.explore : isScout ? input.scout : undefined;

  const maxDepth = tierSettings?.maxDepth ?? SUBAGENT_MAX_DEPTH;
  if (input.currentDepth >= maxDepth) {
    throw new Error(`子代理嵌套深度已达上限（${maxDepth} 层），无法继续委派`);
  }

  let resolvedModel: string | undefined = definition.model;
  let usingMentor = false;
  let mentor: ResolvedSubagentMentor | null = null;

  if (definition.model === 'fast') {
    resolvedModel = input.fastModel || input.baseModel;
  } else if (definition.model === 'mentor') {
    const m = input.mentor;
    if (m?.enabled && m.model.trim()) {
      resolvedModel = m.model.trim();
      const apiKey = m.apiKey.trim() || input.fallbackApiKey.trim();
      const baseURL =
        m.baseURL.trim().replace(/\/+$/, '') ||
        input.fallbackBaseURL.trim().replace(/\/+$/, '') ||
        undefined;
      mentor = { model: resolvedModel, apiKey, baseURL, apiFormat: m.apiFormat };
      usingMentor = true;
    } else {
      resolvedModel = input.baseModel;
    }
  }

  const route = selectSubagentExecutionRoute({
    baseModel: input.baseModel,
    fastModelEnabled: input.fastModelEnabled,
    fastModel: input.fastModel,
    taskPrompt: input.taskPrompt,
    explicitModel: resolvedModel,
    defaultTemperature: DEFAULT_ROUTE_TEMPERATURE,
    explicitTemperature: definition.temperature,
  });

  const temperature = isExplore
    ? (tierSettings?.temperature ?? EXPLORE_DEFAULT_TEMPERATURE)
    : isScout
    ? (tierSettings?.temperature ?? SCOUT_DEFAULT_TEMPERATURE)
    : route.temperature;
  const topP = tierSettings?.topP ?? DEFAULT_SUBAGENT_TOP_P;
  const maxTokens = usingMentor
    ? (input.mentor?.maxTokens ?? input.defaultMaxTokens)
    : (tierSettings?.maxTokens ?? input.defaultMaxTokens);
  const thinkingEnabled = usingMentor
    ? (input.mentor?.thinkingEnabled ?? false)
    : isExplore
    ? (tierSettings?.thinkingEnabled ?? true)
    : isScout
    ? (tierSettings?.thinkingEnabled ?? false)
    : input.thinkingFallback;

  const agentMaxToolRounds = tierSettings?.maxToolRounds ?? SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS;
  const maxToolRounds = Math.min(input.globalMaxToolRounds, agentMaxToolRounds);

  return {
    route,
    parameters: { temperature, topP, maxTokens, thinkingEnabled },
    maxToolRounds,
    mentor,
    usingMentor,
    tier: usingMentor ? 'mentor' : route.tier,
  };
}

export interface SubagentStep {
  name: string;
  status: 'success' | 'error';
  summary: string;
}

export interface SubagentSessionDeps {
  definition: AgentDefinition;
  prompt: string;
  workspacePath: string;
  lang?: string;
  exec: ResolvedSubagentExecution;
  registry: ToolRegistry;
  /** 暴露给模型的工具子集（如子代理白名单过滤后）；缺省取 registry.getAll()。 */
  tools?: IToolDefinition[];
  provider: ILLMProvider;
  providerName: 'deepseek' | 'openai' | 'claude';
  requestBuilder: IRequestBuilder;
  cacheValidator: ICacheValidator;
  skillsSection?: string;
  customPromptSection?: string;
  memorySection?: string;
  projectGraphSummary?: string;
  graphToolTimeoutMs: number;
  maxWallClockMs?: number;
  toolOutputTruncation?: ToolOutputTruncationOptions;
  onToolCallEnd?: (event: Extract<IChatStreamEvent, { type: 'tool-call-end' }>) => void;
}

export interface SubagentSessionResult {
  content: string;
  steps: SubagentStep[];
  cacheStats?: ICacheStatistics;
  tier: 'primary' | 'fast' | 'mentor';
}

function timeoutMessage(lang: string | undefined, seconds: number): string {
  if (lang === 'zh-TW') return `子代理執行超時 (${seconds}秒)`;
  if (lang === 'en') return `Sub-agent execution timed out (${seconds}s)`;
  return `子代理执行超时 (${seconds}s)`;
}

async function withSubagentWallClockTimeout<T>(
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
        reject(new Error(timeoutMessage(lang, timeoutMs / 1000)));
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

export async function runSubagentSession(
  deps: SubagentSessionDeps
): Promise<SubagentSessionResult> {
  const { definition, exec } = deps;
  const lang = (deps.lang ?? 'zh-CN') as PromptLang;
  const steps: SubagentStep[] = [];

  const tools = deps.tools ?? deps.registry.getAll();
  const systemPrompt = buildRuntimeSystemPrompt({
    mode: 'agent',
    workspacePath: deps.workspacePath,
    lang,
    extraSections: [sanitizeAgentPrompt(resolveAgentPrompt(definition, deps.lang))],
    toolNames: tools.map((tool) => tool.name),
    subagent: true,
  });

  const log = new AppendOnlyLog(`subagent-${definition.name}-${Date.now()}`);
  const sessionBootstrapPrompt = buildSessionBootstrapPrompt({
    workspacePath: deps.workspacePath,
    lang,
    skillsSection: deps.skillsSection,
    customPromptSection: deps.customPromptSection,
    memorySection: deps.memorySection,
    projectGraphSummary: deps.projectGraphSummary,
  });
  if (sessionBootstrapPrompt.trim()) {
    await log.append({
      id: 'session-bootstrap',
      role: 'assistant',
      content: sessionBootstrapPrompt.trim(),
      timestamp: Date.now(),
      metadata: { sessionBootstrap: true, isPrefixSystem: true },
    });
  }

  const userPrompt = buildRuntimeUserPrompt({
    mode: 'agent',
    input: deps.prompt,
    workspacePath: deps.workspacePath,
    lang,
  });

  const prefix = new ImmutablePrefix({
    systemPrompt,
    tools,
    model: exec.route.model,
    parameters: { ...exec.parameters },
  });
  const session = new Session({
    sessionId: `subagent-${definition.name}-${Date.now()}`,
    prefix,
    toolRegistry: deps.registry,
    log,
  });

  const agent = new Agent({
    session,
    provider: deps.provider,
    providerName: deps.providerName,
    requestBuilder: deps.requestBuilder,
    cacheValidator: deps.cacheValidator,
    maxToolRounds: exec.maxToolRounds,
    toolTimeouts: { graph: deps.graphToolTimeoutMs },
    toolOutputTruncation: deps.toolOutputTruncation,
  });

  let response;
  try {
    response = await withSubagentWallClockTimeout(
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
            deps.onToolCallEnd?.(event);
          }
        }),
      deps.maxWallClockMs ?? SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
      deps.lang
    );
  } catch (err) {
    const errName = err instanceof Error ? err.name : undefined;
    const errMsg = err instanceof Error ? err.message : String(err);
    const contextTag = `[Subagent=${definition.name} model=${exec.route.model} tier=${exec.tier}]`;
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

  return {
    content: response.content,
    steps,
    cacheStats: response.cacheStats,
    tier: exec.tier,
  };
}
