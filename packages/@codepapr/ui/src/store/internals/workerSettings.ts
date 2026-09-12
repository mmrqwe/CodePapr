/**
 * Settings → WorkerAgentSettings 装配（纯函数，桌面 worker/sidecar 与
 * headless harness 共用）。独立成文件：headlessHarness 需要在 Node 侧
 * 复用同一映射，不能连带 import providerFactory 的 env/主题依赖。
 */
import type { WorkerAgentSettings } from '../../agent/agentWorkerProtocol';
import { resolveProviderName } from './settingsNormalizer';
import type { Settings } from './types';

export function toWorkerAgentSettings(settings: Settings): WorkerAgentSettings {
  return {
    apiMode: settings.apiMode,
    apiFormat: settings.apiFormat,
    provider: resolveProviderName(settings),
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    extraHeaders: settings.extraHeaders,
    agentToolProfile: settings.agentToolProfile,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    maxToolRounds: settings.maxToolRounds,
    thinkingEnabled: settings.thinkingEnabled,
    thinkingEffort: settings.thinkingEffort,
    thinkingBudgetTokens: settings.thinkingBudgetTokens,
    thinkingPayload: settings.thinkingPayload,
    lang: settings.lang,
    fastModelEnabled: settings.fastModelEnabled,
    fastModel: settings.fastModel,
    fastApiMode: settings.fastApiMode,
    fastApiFormat: settings.fastApiFormat,
    fastApiKey: settings.fastApiKey,
    fastBaseURL: settings.fastBaseURL,
    mentorEnabled: settings.mentorEnabled,
    mentorModel: settings.mentorModel,
    mentorBaseURL: settings.mentorBaseURL,
    mentorApiKey: settings.mentorApiKey,
    mentorApiFormat: settings.mentorApiFormat,
    mentorApiMode: settings.mentorApiMode,
    ...(settings.mentorExtraHeaders ? { mentorExtraHeaders: settings.mentorExtraHeaders } : {}),
    mentorMaxTokens: settings.mentorMaxTokens,
    mentorThinkingEnabled: settings.mentorThinkingEnabled,
    mentorThinkingEffort: settings.mentorThinkingEffort,
    mentorThinkingBudgetTokens: settings.mentorThinkingBudgetTokens,
    mentorThinkingPayload: settings.mentorThinkingPayload,
    exploreTopP: settings.exploreTopP,
    exploreMaxTokens: settings.exploreMaxTokens,
    exploreThinkingEnabled: settings.exploreThinkingEnabled,
    exploreTemperature: settings.exploreTemperature,
    exploreMaxToolRounds: settings.exploreMaxToolRounds,
    exploreMaxDepth: settings.exploreMaxDepth,
    exploreModelTier: settings.exploreModelTier,
    scoutTopP: settings.scoutTopP,
    scoutMaxTokens: settings.scoutMaxTokens,
    scoutThinkingEnabled: settings.scoutThinkingEnabled,
    scoutTemperature: settings.scoutTemperature,
    scoutMaxToolRounds: settings.scoutMaxToolRounds,
    scoutMaxDepth: settings.scoutMaxDepth,
    scoutModelTier: settings.scoutModelTier,
    appSubAgentModelTier: settings.appSubAgentModelTier,
    appSubAgentThinkingEnabled: settings.appSubAgentThinkingEnabled,
    appSubAgentMaxToolRounds: settings.appSubAgentMaxToolRounds,
    mcp: settings.mcp,
    graphToolTimeoutMs: settings.graphToolTimeoutMs,
    toolIpcTimeoutMs: settings.toolIpcTimeoutMs,
    streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
    multimodalEnabled: settings.multimodalEnabled,
    multimodalModelTier: settings.multimodalModelTier,
    toolOutputInterceptChars: settings.toolOutputInterceptChars,
    toolOutputOffloadChars: settings.toolOutputOffloadChars,
    toolOutputCeilingChars: settings.toolOutputCeilingChars,
    toolOutputPreviewChars: settings.toolOutputPreviewChars,
    toolOutputMiddleKeepChars: settings.toolOutputMiddleKeepChars,
    toolContextDefaultMode: settings.toolContextDefaultMode,
    toolContextOverrides: settings.toolContextOverrides,
    toolContextSummaryMaxChars: settings.toolContextSummaryMaxChars,
    toolContextAutoThresholdChars: settings.toolContextAutoThresholdChars,
    maxContextTokens: settings.maxContextTokens,
    compactionModel: settings.compactionModel,
    compactionMaxTokens: settings.compactionMaxTokens,
    compactionTemperature: settings.compactionTemperature,
    searxngEnabled: settings.searxngEnabled,
    searxngBaseUrl: settings.searxngBaseUrl,
    searxngCategories: settings.searxngCategories,
    searxngTimeRange: settings.searxngTimeRange,
    searxngLanguage: settings.searxngLanguage,
    searxngSafeSearch: settings.searxngSafeSearch,
    searxngEngines: settings.searxngEngines,
  };
}

/** read_image 暴露判定（WorkerBackedAgent 注册层同源）。 */
export function resolveWorkerMultimodalEnabled(
  settings: WorkerAgentSettings,
  currentModel: string
): boolean {
  if (!settings.multimodalEnabled) return false;
  if (settings.multimodalModelTier === 'all') return true;
  const fastModel = settings.fastModel.trim();
  const isFastModel = settings.fastModelEnabled && fastModel.length > 0 && currentModel === fastModel;
  if (settings.multimodalModelTier === 'primary' && !isFastModel) return true;
  if (settings.multimodalModelTier === 'fast' && isFastModel) return true;
  return false;
}
