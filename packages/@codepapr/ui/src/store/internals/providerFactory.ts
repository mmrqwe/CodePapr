import {
  ClaudeProvider,
  DEFAULT_LOCAL_BASE_URL,
  DeepSeekProvider,
  LocalProvider,
  OpenAIProvider,
} from '@codepapr/api';
import type { WorkerAgentSettings } from '../../agent/agentWorkerProtocol';
import { resolveProviderName } from './settingsNormalizer';
import type { Settings } from './types';

export function buildProviderInstance(s: Settings) {
  if (s.apiMode === 'local') {
    return new LocalProvider({
      apiKey: s.apiKey.trim() || 'local',
      baseURL: s.baseURL.trim().replace(/\/+$/, '') || DEFAULT_LOCAL_BASE_URL,
    });
  }

  const cfg: { apiKey: string; baseURL?: string } = { apiKey: s.apiKey.trim() };
  if (s.apiMode === 'custom') {
    cfg.baseURL = s.baseURL.trim().replace(/\/+$/, '');
  }

  switch (resolveProviderName(s)) {
    case 'deepseek': return new DeepSeekProvider(cfg);
    case 'openai': return new OpenAIProvider(cfg);
    case 'claude': return new ClaudeProvider(cfg);
  }
}

export function toWorkerAgentSettings(settings: Settings): WorkerAgentSettings {
  return {
    apiMode: settings.apiMode,
    apiFormat: settings.apiFormat,
    provider: resolveProviderName(settings),
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    maxToolRounds: settings.maxToolRounds,
    thinkingEnabled: settings.thinkingEnabled,
    thinkingEffort: settings.thinkingEffort,
    lang: settings.lang,
    fastModelEnabled: settings.fastModelEnabled,
    fastModel: settings.fastModel,
    mentorEnabled: settings.mentorEnabled,
    mentorModel: settings.mentorModel,
    mentorBaseURL: settings.mentorBaseURL,
    mentorApiKey: settings.mentorApiKey,
    mentorApiFormat: settings.mentorApiFormat,
    mentorMaxTokens: settings.mentorMaxTokens,
    mentorThinkingEnabled: settings.mentorThinkingEnabled,
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
  multimodalEnabled: settings.multimodalEnabled,
  multimodalModelTier: settings.multimodalModelTier,
  toolOutputMaxBytes: settings.toolOutputMaxBytes,
  toolOutputPreviewChars: settings.toolOutputPreviewChars,
  pruneOldToolResults: settings.pruneOldToolResults,
  pruneProtectRounds: settings.pruneProtectRounds,
  pruneMinChars: settings.pruneMinChars,
  maxContextTokens: settings.maxContextTokens,
  maxConversationRounds: settings.maxConversationRounds,
  compactionModel: settings.compactionModel,
  compactionMaxTokens: settings.compactionMaxTokens,
  compactionTemperature: settings.compactionTemperature,
};
}

export function shouldUseWorkerAgentRuntime(): boolean {
  if (typeof Worker === 'undefined') {
    return false;
  }

  if (import.meta.env?.MODE === 'test') {
    return false;
  }

  if (typeof navigator !== 'undefined' && /jsdom|happy-dom/i.test(navigator.userAgent)) {
    return false;
  }

  return true;
}
