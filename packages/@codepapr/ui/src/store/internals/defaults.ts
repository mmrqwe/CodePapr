import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_CODING_SYSTEM_PROMPT } from '@codepapr/core';
import { DEFAULT_MAX_TOKENS } from '@codepapr/api';
import { normalizeMcpSettings } from '../../utils/mcpTypes';
import type { ConversationStats, CumulativeStats, ModelTierStats, Settings } from './types';

export const LEGACY_SYSTEM_PROMPT_MARKERS = [
  '核心工作流：',
  'Ask 是普通聊天问答模式',
  'Agent 是完全自主执行模式',
];

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
  apiMode: 'deepseek',
  apiFormat: 'openai',
  provider: 'deepseek',

  deepseek: {
    apiKey: '',
    baseURL: '',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
    maxTokens: DEFAULT_MAX_TOKENS,
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
  multimodalEnabled: false,
  multimodalModelTier: 'all',
  debugEnabled: false,
  chatBordersEnabled: true,
  temperature: 0.7,
  topP: 0.9,
  maxTokens: DEFAULT_MAX_TOKENS,
  maxToolRounds: DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  maxContextTokens: 500_000,
  maxConversationRounds: 24,
  compactionModel: 'fast',
  compactionMaxTokens: 8_000,
  compactionTemperature: 0.1,
  toolOutputInterceptChars: 30_000,
  toolOutputOffloadChars: 50_000,
  toolOutputCeilingChars: 150_000,
  toolOutputPreviewChars: 2_000,
  pruneOldToolResults: true,
  pruneProtectRounds: 6,
  pruneMinChars: 20_000,
  projectGraphMaxDepth: 0,
  projectGraphMaxFiles: 0,
  projectGraphMaxEdges: 0,
  projectGraphMaxSymbolsPerFile: 0,
  projectGraphMaxFileBytes: 0,
  projectGraphMaxTreeEntries: 0,
  lang: 'zh-CN',
  recentWorkspaces: [],
  mentorEnabled: false,
  mentorModel: '',
  mentorBaseURL: '',
  mentorApiKey: '',
  mentorApiFormat: 'openai',
  mentorMaxTokens: 10000,
  maxMentorConsultations: 2,
  mentorThinkingEnabled: false,
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
  todoMaxRetries: 3,
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
