import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_CODING_SYSTEM_PROMPT } from '@codepapr/core';
import {
  DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from '@codepapr/api';
import { normalizeMcpSettings } from '../../utils/mcpTypes';
import type { ConversationStats, CumulativeStats, ModelProfile, ModelTierStats, Settings } from './types';

export const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'profile-deepseek',
    name: 'DeepSeek 官方',
    apiMode: 'deepseek',
    apiFormat: 'openai',
    baseURL: '',
    apiKey: '',
    model: 'deepseek-v4-pro',
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    temperature: 0.7,
    topP: 0.9,
    multimodalEnabled: false,
    thinkingEnabled: true,
    thinkingEffort: 'max',
    thinkingBudgetTokens: 4096,
    thinkingPayload: 'thinking',
  },
  {
    id: 'profile-deepseek-fast',
    name: 'DeepSeek Flash (快速)',
    apiMode: 'deepseek',
    apiFormat: 'openai',
    baseURL: '',
    apiKey: '',
    model: 'deepseek-v4-flash',
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    temperature: 0.7,
    topP: 0.9,
    multimodalEnabled: false,
    thinkingEnabled: false,
    thinkingEffort: '',
    thinkingBudgetTokens: 0,
    thinkingPayload: 'thinking',
  },
  {
    id: 'profile-custom',
    name: '自定义 API (Custom)',
    apiMode: 'custom',
    apiFormat: 'openai',
    baseURL: '',
    apiKey: '',
    model: 'gpt-4o',
    maxTokens: DEFAULT_MAX_TOKENS,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    temperature: 0.7,
    topP: 0.9,
    multimodalEnabled: true,
    thinkingEnabled: false,
    thinkingEffort: '',
    thinkingBudgetTokens: 4096,
    thinkingPayload: 'reasoning',
  },
  {
    id: 'profile-local',
    name: '本地模型 (Local)',
    apiMode: 'local',
    apiFormat: 'openai',
    baseURL: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    model: 'local-model',
    maxTokens: DEFAULT_MAX_TOKENS,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    temperature: 0.7,
    topP: 0.9,
    multimodalEnabled: false,
    thinkingEnabled: false,
    thinkingEffort: '',
    thinkingBudgetTokens: 0,
    thinkingPayload: 'reasoning',
  },
];

export const LEGACY_SYSTEM_PROMPT_MARKERS = [
  '核心工作流：',
  'Ask 是普通聊天问答模式',
  'Agent 是完全自主执行模式',
];

/** Max number of sessions whose messages stay resident in memory. Sessions are
 *  loaded on demand (see selectSession); exceeding this limit evicts the least
 *  recently used non-active session. The SQLite store remains the source of
 *  truth, so eviction never loses data. */
export const SESSION_MESSAGE_CACHE_LIMIT = 5;

export function normalizeCustomSystemPrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  if (trimmed === DEFAULT_CODING_SYSTEM_PROMPT.trim()) {
    return '';
  }
  if (LEGACY_SYSTEM_PROMPT_MARKERS.every((marker) => trimmed.includes(marker))) {
    return '';
  }
  return trimmed;
}

export const DEFAULT_SETTINGS: Settings = {
  modelProfiles: DEFAULT_MODEL_PROFILES,
  primaryProfileId: 'profile-deepseek',
  fastProfileId: 'profile-deepseek-fast',
  mentorProfileId: 'profile-custom',

  apiMode: 'deepseek',
  apiFormat: 'openai',
  provider: 'deepseek',

  deepseek: {
    apiKey: '',
    baseURL: '',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
  },
  custom: {
    apiKey: '',
    baseURL: '',
    model: '',
    fastModel: '',
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  local: {
    apiKey: '',
    baseURL: 'http://127.0.0.1:8080/v1',
    model: 'local-model',
    fastModel: '',
    maxTokens: DEFAULT_MAX_TOKENS,
  },

  baseURL: '',
  model: 'deepseek-v4-pro',
  fastModelEnabled: true,
  fastModel: 'deepseek-v4-flash',
  apiKey: '',
  systemPrompt: '',
  thinkingEnabled: true,
  thinkingEffort: 'max',
  thinkingBudgetTokens: 4096,
  thinkingPayload: 'thinking',
  multimodalEnabled: false,
  multimodalModelTier: 'all',
  chatBordersEnabled: true,
  experimentalCharacters: false,
  experimentalVoice: false,
  agentToolProfile: 'default',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
  maxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  maxConversationRounds: 24,
  chatRenderBatchRounds: 6,
  compactionModel: 'fast',
  compactionMaxTokens: 8_000,
  compactionTemperature: 0.1,
  toolOutputInterceptChars: 60_000,
  toolOutputOffloadChars: 100_000,
  toolOutputCeilingChars: 150_000,
  toolOutputPreviewChars: 2_000,
  toolOutputMiddleKeepChars: 20_000,
  pruneOldToolResults: true,
  pruneProtectRounds: 6,
  pruneMinChars: 20_000,
  toolContextDefaultMode: 'full',
  toolContextOverrides: {},
  toolContextSummaryMaxChars: 500,
  toolContextAutoThresholdChars: 5_000,
  projectGraphMaxDepth: 0,
  projectGraphMaxFiles: 0,
  projectGraphMaxEdges: 0,
  projectGraphMaxSymbolsPerFile: 0,
  projectGraphMaxFileBytes: 0,
  projectGraphMaxTreeEntries: 0,
  lang: 'zh-CN',
  lightTheme: 'paper-light',
  darkTheme: 'paper-dark',
  followSystem: true,
  themeMode: 'light',
  accent: null,
  customThemes: {},
  recentWorkspaces: [],
  mentorEnabled: false,
  mentorModel: '',
  mentorBaseURL: '',
  mentorApiKey: '',
  mentorApiFormat: 'openai',
  mentorMaxTokens: 100_000,
  maxMentorConsultations: 2,
  mentorThinkingEnabled: false,
  mentorThinkingEffort: '',
  mentorThinkingBudgetTokens: 4096,
  mentorThinkingPayload: 'reasoning',
  explorePrompt: '',
  scoutPrompt: '',
  mentorPrompt: '',
  exploreModelTier: 'fast',
  scoutModelTier: 'fast',
  exploreTopP: 0.9,
  exploreMaxTokens: 200_000,
  exploreThinkingEnabled: true,
  exploreTemperature: 0.5,
  exploreMaxToolRounds: 200,
  exploreMaxDepth: 2,
  scoutTopP: 0.9,
  scoutMaxTokens: 200_000,
  scoutThinkingEnabled: false,
  scoutTemperature: 0.3,
  scoutMaxToolRounds: 200,
  scoutMaxDepth: 2,
  // Goal 自主循环
  goalMaxIterations: 20,
  goalMaxWallClockMs: 1_800_000,
  goalRequireGitClean: true,
  // Verifier 子代理（默认快速模型）
  verifierModelTier: 'fast',
  verifierMaxTokens: 4000,
  verifierTemperature: 0.1,
  // App 子代理（papr.agent.run，默认主模型，不开启思考，50 轮工具调用）
  appSubAgentModelTier: 'primary',
  appSubAgentThinkingEnabled: false,
  appSubAgentMaxToolRounds: 50,
  searxngEnabled: false,
  searxngBaseUrl: '',
  searxngCategories: '',
  searxngTimeRange: '',
  searxngLanguage: '',
  searxngSafeSearch: 1,
  searxngEngines: '',
  mcp: normalizeMcpSettings(),
  graphToolTimeoutMs: 600_000,
  toolIpcTimeoutMs: 120_000,
  streamIdleTimeoutMs: 300_000,
  browserEngine: 'embedded',
  folderAccessYolo: false,
  lspDisabledFamilies: [],
};

export function createEmptyStats(): CumulativeStats {
  return {
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalInput: 0,
    totalOutput: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    rounds: 0,
  };
}

export function createEmptyModelTierStats(): ModelTierStats {
  return {
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalInput: 0,
    totalOutput: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    calls: 0,
    rounds: 0,
  };
}

export function createEmptyConversationStats(): ConversationStats {
  return {
    primary: createEmptyModelTierStats(),
    fast: createEmptyModelTierStats(),
    mentor: createEmptyModelTierStats(),
  };
}
