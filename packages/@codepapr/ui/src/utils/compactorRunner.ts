/**
 * compactorRunner: 上下文压缩（Compactor）子代理的 UI 层执行器。
 *
 * Compactor 是内置的零工具内部子代理（agentConfig 的 BUILTIN_AGENTS）：
 * - internal: true → 不经 task 工具暴露给主 Agent，仅供运行时压缩管线调用
 *   （轮间压缩与 mid-loop 压缩）
 * - tools: {} → 纯推理，压缩输入（transcript）已含全部事实，无需回读工作区
 * - 输出严格 JSON 检查点（userGoal/constraints/completedWork/importantContext/
 *   todoList/pendingWork），解析与降级由 contextCheckpoint 管线负责
 *
 * 与 verifier 的差异：verifier 走 uiTaskTool.runSubagent（主线程工作区工具），
 * compactor 直接调 core 的 resolveSubagentExecution + runSubagentSession——
 * 零工具无需工作区注册与 IPC，且不产生子代理 UI 进度噪音；两条线程（主线程
 * 轮间 / Worker mid-loop）共用同一执行器，仅各自注入 provider。
 */

import {
  BUILTIN_AGENTS,
  COMPACTOR_PROMPT,
  resolveSubagentExecution,
  runSubagentSession,
  SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS,
  ToolRegistry,
  type AgentDefinition,
  type SubagentSessionResult,
} from '@codepapr/core';
import { RequestBuilder, CacheValidator } from '@codepapr/api';
import { buildProviderInstance } from '../store/internals/providerFactory';
import { resolveProviderName } from '../store/internals/settingsNormalizer';
import type { CompactionSettings } from '../store/internals/types';

export type CompactorModelTier = 'fast' | 'primary';

/** 零工具子代理的 graph 超时是死配置（compactor 无 graph 工具），仅满足
 *  runSubagentSession 依赖，取与 settings 默认一致的值（600s）。 */
const COMPACTOR_GRAPH_TOOL_TIMEOUT_MS = 600_000;

/** 墙钟预算沿用 runSubagentSession 的默认值（SUBAGENT_WALL_CLOCK_TIMEOUT_MS，
 *  20 分钟）——压缩是长 transcript 摘要任务，不额外收紧。 */

/**
 * 解析 Compactor 实际使用的模型档位（纯函数，可单测）：
 * fast 档但 fastModel 未启用时静默降级为 primary（定义 model 降为 baseModel）。
 */
export function resolveEffectiveCompactorTier(
  settings: Pick<CompactionSettings, 'compactionModel' | 'fastModelEnabled' | 'fastModel'>,
): CompactorModelTier {
  if (settings.compactionModel === 'fast' && !(settings.fastModelEnabled && settings.fastModel.trim())) {
    return 'primary';
  }
  return settings.compactionModel;
}

/**
 * 构建 Compactor 子代理的运行时定义（纯函数，可单测）：
 * - compactionModel: 'fast' → model: 'fast'（fastModel 未启用时降为 baseModel
 *   字符串 → 路由强制 primary 档）
 * - compactionModel: 'primary' → model: baseModel 字符串（显式模型 → primary 档）
 * - 温度取 settings.compactionTemperature（低温度 → 摘要更确定）
 * - thinking 关闭（thinkingFallback: false，由调用方经 runCompactorSession 注入）
 */
export function buildCompactorDefinition(params: {
  settings: Pick<
    CompactionSettings,
    'compactionModel' | 'fastModelEnabled' | 'fastModel' | 'compactionTemperature'
  >;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  baseModel: string;
}): AgentDefinition {
  const { settings, baseModel } = params;
  const builtin = BUILTIN_AGENTS.find((agent) => agent.name === 'compactor');
  const tier = resolveEffectiveCompactorTier(settings);
  const model =
    tier === 'fast'
      ? (settings.fastModelEnabled && settings.fastModel.trim() ? 'fast' : baseModel)
      : baseModel;

  return {
    name: 'compactor',
    description: builtin?.description ?? 'Context compactor (internal)',
    mode: 'subagent',
    model,
    temperature: settings.compactionTemperature,
    tools: {},
    internal: true,
    prompt: COMPACTOR_PROMPT,
  };
}

export interface RunCompactorSessionParams {
  definition: AgentDefinition;
  prompt: string;
  settings: CompactionSettings;
  baseModel: string;
  lang: 'zh-CN' | 'zh-TW' | 'en';
  /** 用户中断信号：中飞可取消（子代理 abort 抛 AbortError，调用方按约定上抛）。 */
  abortSignal?: AbortSignal;
}

/**
 * 执行一轮 Compactor 子代理会话（零工具单轮推理）：
 * - 空 ToolRegistry + 空工具列表 → 不注册任何工作区工具
 * - 不注入 skills / memory / projectGraph sections → bootstrap 隔离
 *   （压缩请求只含系统提示词 + transcript 用户提示词）
 * - 不传 maxWallClockMs → 保持默认 20 分钟墙钟预算
 * - AbortError 原样上抛（全仓取消约定）；其余错误包装后上抛，由调用方降级
 */
export async function runCompactorSession(
  params: RunCompactorSessionParams,
): Promise<SubagentSessionResult> {
  const { definition, prompt, settings, baseModel, lang, abortSignal } = params;

  const provider = buildProviderInstance(settings);
  const providerName = resolveProviderName(settings);

  const exec = resolveSubagentExecution({
    definition,
    currentDepth: 0,
    taskPrompt: prompt,
    baseModel,
    fastModel: settings.fastModel,
    fastModelEnabled: settings.fastModelEnabled,
    defaultMaxTokens: settings.compactionMaxTokens,
    globalMaxToolRounds: SUBAGENT_DEFAULT_MAX_TOOL_ROUNDS,
    thinkingFallback: false,
    fallbackApiKey: settings.apiKey,
    fallbackBaseURL: settings.baseURL,
  });

  return await runSubagentSession({
    definition,
    prompt,
    workspacePath: '',
    lang,
    exec,
    registry: new ToolRegistry(),
    tools: [],
    provider,
    providerName,
    requestBuilder: new RequestBuilder(),
    cacheValidator: new CacheValidator(),
    graphToolTimeoutMs: COMPACTOR_GRAPH_TOOL_TIMEOUT_MS,
    abortSignal,
  });
}
