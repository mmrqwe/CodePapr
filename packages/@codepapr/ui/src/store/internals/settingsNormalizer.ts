import { sanitizeMaxTokens } from '@codepapr/api';
import { normalizeMcpSettings } from '../../utils/mcpTypes';
import { DEFAULT_SETTINGS, normalizeCustomSystemPrompt } from './defaults';
import type { ApiFormat, ApiMode, Lang, ModeConfig, ProviderName, Settings, WorkspaceEntry } from './types';

function normalizeModeConfig(
  input: unknown,
  defaults: ModeConfig,
): ModeConfig {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    return {
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : defaults.apiKey,
      baseURL: typeof obj.baseURL === 'string' ? obj.baseURL : defaults.baseURL,
      model: typeof obj.model === 'string' ? obj.model.trim() : defaults.model,
      fastModel: typeof obj.fastModel === 'string' ? obj.fastModel.trim() : defaults.fastModel,
      maxTokens: typeof obj.maxTokens === 'number' && Number.isFinite(obj.maxTokens) ? Math.floor(obj.maxTokens) : defaults.maxTokens,
    };
  }
  return { ...defaults };
}

function migrateLegacySettings(
  input: Partial<Settings>,
  apiMode: ApiMode,
  existingDeepseek?: ModeConfig,
  existingCustom?: ModeConfig,
  existingLocal?: ModeConfig,
): { deepseek: ModeConfig; custom: ModeConfig; local: ModeConfig } {
  const legacyModel = typeof input.model === 'string' ? input.model.trim() : '';
  const legacyApiKey = typeof input.apiKey === 'string' ? input.apiKey : '';
  const legacyBaseURL = typeof input.baseURL === 'string' ? input.baseURL : '';
  const legacyFastModel = typeof input.fastModel === 'string' ? input.fastModel.trim() : '';
  const legacyMaxTokens = typeof input.maxTokens === 'number' ? input.maxTokens : 0;

  const deepseek = existingDeepseek ?? { ...DEFAULT_SETTINGS.deepseek };
  const custom = existingCustom ?? { ...DEFAULT_SETTINGS.custom };
  const local = existingLocal ?? { ...DEFAULT_SETTINGS.local };

  // If per-mode configs already exist, no migration needed
  if (existingDeepseek || existingCustom || existingLocal) {
    return { deepseek, custom, local };
  }

  // Only migrate if legacy flat fields are present
  if (!legacyModel && !legacyApiKey && !legacyBaseURL && !legacyFastModel) {
    return { deepseek, custom, local };
  }

  // Populate the active mode's config from legacy flat fields
  const active = { apiKey: legacyApiKey, baseURL: legacyBaseURL, model: legacyModel || deepseek.model, fastModel: legacyFastModel || deepseek.fastModel, maxTokens: legacyMaxTokens || deepseek.maxTokens };
  if (apiMode === 'deepseek') return { deepseek: active, custom, local };
  if (apiMode === 'custom') return { deepseek, custom: active, local };
  return { deepseek, custom, local: active };
}

function normalizeRecentWorkspaces(
  input: unknown,
): WorkspaceEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const result: WorkspaceEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!path) {
      continue;
    }
    const name = typeof entry.name === 'string'
      ? entry.name.trim()
      : path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const lastOpenedAt = typeof entry.lastOpenedAt === 'number' ? entry.lastOpenedAt : 0;
    const pinned = entry.pinned === true;
    result.push({ path, name, lastOpenedAt, pinned });
    if (result.length >= 10) {
      break;
    }
  }
  return result;
}

export function normalizeSettings(input: Partial<Settings> = {}): Settings {
  const apiMode: ApiMode =
    input.apiMode ?? (input.provider && input.provider !== 'deepseek' ? 'custom' : 'deepseek');
  const apiFormat: ApiFormat =
    input.apiFormat ?? (input.provider === 'claude' ? 'claude' : 'openai');
  const provider: ProviderName =
    apiMode === 'deepseek' ? 'deepseek' : apiMode === 'local' ? 'openai' : apiFormat;

  // Per-mode configs with migration
  const migrated = migrateLegacySettings(
    input,
    apiMode,
    input.deepseek ? normalizeModeConfig(input.deepseek, DEFAULT_SETTINGS.deepseek) : undefined,
    input.custom ? normalizeModeConfig(input.custom, DEFAULT_SETTINGS.custom) : undefined,
    input.local ? normalizeModeConfig(input.local, DEFAULT_SETTINGS.local) : undefined,
  );
  const deepseek = migrated.deepseek;
  const custom = migrated.custom;
  const local = migrated.local;

  // Active mode config (source of truth for flat fields)
  const activeConfig = apiMode === 'deepseek' ? deepseek : apiMode === 'custom' ? custom : local;
  const model = activeConfig.model;
  const fastModel = activeConfig.fastModel;
  const apiKey = activeConfig.apiKey;
  const baseURL = activeConfig.baseURL;
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.max(0, Math.min(2, input.temperature))
      : DEFAULT_SETTINGS.temperature;
  const topP =
    typeof input.topP === 'number' && Number.isFinite(input.topP)
      ? Math.max(0, Math.min(1, input.topP))
      : DEFAULT_SETTINGS.topP;
  const systemPrompt = normalizeCustomSystemPrompt(input.systemPrompt);
  const multimodalEnabled =
    typeof input.multimodalEnabled === 'boolean'
      ? input.multimodalEnabled
      : DEFAULT_SETTINGS.multimodalEnabled;
  const multimodalModelTier: 'primary' | 'fast' | 'all' =
    input.multimodalModelTier === 'primary' || input.multimodalModelTier === 'fast'
      ? input.multimodalModelTier
      : 'all';
  const thinkingEnabled =
    typeof input.thinkingEnabled === 'boolean'
      ? input.thinkingEnabled
      : DEFAULT_SETTINGS.thinkingEnabled;
  const thinkingEffort: 'high' | 'max' =
    input.thinkingEffort === 'high' ? 'high' : 'max';
  const debugEnabled =
    typeof input.debugEnabled === 'boolean'
      ? input.debugEnabled
      : DEFAULT_SETTINGS.debugEnabled;
  const chatBordersEnabled =
    typeof input.chatBordersEnabled === 'boolean'
      ? input.chatBordersEnabled
      : DEFAULT_SETTINGS.chatBordersEnabled;
  const lang: Lang =
    input.lang === 'zh-CN' || input.lang === 'zh-TW' || input.lang === 'en'
      ? input.lang
      : DEFAULT_SETTINGS.lang ?? 'zh-CN';
  const maxTokens = sanitizeMaxTokens(
    activeConfig.maxTokens,
    provider,
    DEFAULT_SETTINGS.maxTokens
  );
  const maxToolRounds =
    typeof input.maxToolRounds === 'number' && Number.isFinite(input.maxToolRounds)
      ? Math.max(1, Math.floor(input.maxToolRounds))
      : DEFAULT_SETTINGS.maxToolRounds;
  const maxContextTokens =
    typeof input.maxContextTokens === 'number' && Number.isFinite(input.maxContextTokens)
      ? Math.max(1000, Math.floor(input.maxContextTokens))
      : DEFAULT_SETTINGS.maxContextTokens;
  const maxConversationRounds =
    typeof input.maxConversationRounds === 'number' && Number.isFinite(input.maxConversationRounds)
      ? Math.max(2, Math.floor(input.maxConversationRounds))
      : DEFAULT_SETTINGS.maxConversationRounds;
  const compactionModel: 'fast' | 'primary' =
    input.compactionModel === 'primary' ? 'primary' : 'fast';
  const compactionMaxTokens =
    typeof input.compactionMaxTokens === 'number' && Number.isFinite(input.compactionMaxTokens)
      ? Math.max(100, Math.floor(input.compactionMaxTokens))
      : DEFAULT_SETTINGS.compactionMaxTokens;
  const compactionTemperature =
    typeof input.compactionTemperature === 'number' && Number.isFinite(input.compactionTemperature)
      ? Math.max(0, Math.min(2, input.compactionTemperature))
      : DEFAULT_SETTINGS.compactionTemperature;
  const toolOutputCeilingChars =
    typeof input.toolOutputCeilingChars === 'number' && Number.isFinite(input.toolOutputCeilingChars)
      ? Math.max(1000, Math.floor(input.toolOutputCeilingChars))
      : DEFAULT_SETTINGS.toolOutputCeilingChars;
  const toolOutputInterceptChars =
    typeof input.toolOutputInterceptChars === 'number' && Number.isFinite(input.toolOutputInterceptChars)
      ? Math.max(1000, Math.min(toolOutputCeilingChars, Math.floor(input.toolOutputInterceptChars)))
      : DEFAULT_SETTINGS.toolOutputInterceptChars;
  const toolOutputOffloadChars =
    typeof input.toolOutputOffloadChars === 'number' && Number.isFinite(input.toolOutputOffloadChars)
      ? Math.max(toolOutputInterceptChars, Math.min(toolOutputCeilingChars, Math.floor(input.toolOutputOffloadChars)))
      : Math.max(toolOutputInterceptChars, DEFAULT_SETTINGS.toolOutputOffloadChars);
  const toolOutputPreviewChars =
    typeof input.toolOutputPreviewChars === 'number' && Number.isFinite(input.toolOutputPreviewChars)
      ? Math.max(100, Math.floor(input.toolOutputPreviewChars))
      : DEFAULT_SETTINGS.toolOutputPreviewChars;
  const toolOutputMiddleKeepChars =
    typeof input.toolOutputMiddleKeepChars === 'number' && Number.isFinite(input.toolOutputMiddleKeepChars)
      ? Math.max(1000, Math.min(toolOutputInterceptChars, Math.floor(input.toolOutputMiddleKeepChars)))
      : Math.min(toolOutputInterceptChars, DEFAULT_SETTINGS.toolOutputMiddleKeepChars);
  const pruneOldToolResults =
    typeof input.pruneOldToolResults === 'boolean'
      ? input.pruneOldToolResults
      : DEFAULT_SETTINGS.pruneOldToolResults;
  const pruneProtectRounds =
    typeof input.pruneProtectRounds === 'number' && Number.isFinite(input.pruneProtectRounds)
      ? Math.max(1, Math.floor(input.pruneProtectRounds))
      : DEFAULT_SETTINGS.pruneProtectRounds;
  const pruneMinChars =
    typeof input.pruneMinChars === 'number' && Number.isFinite(input.pruneMinChars)
      ? Math.max(0, Math.floor(input.pruneMinChars))
      : DEFAULT_SETTINGS.pruneMinChars;
  const toolContextDefaultMode: 'full' | 'summary' | 'auto' =
    input.toolContextDefaultMode === 'full' ||
    input.toolContextDefaultMode === 'summary' ||
    input.toolContextDefaultMode === 'auto'
      ? input.toolContextDefaultMode
      : DEFAULT_SETTINGS.toolContextDefaultMode;
  const toolContextOverrides: Record<string, 'full' | 'summary' | 'auto'> =
    input.toolContextOverrides && typeof input.toolContextOverrides === 'object'
      ? Object.fromEntries(
          Object.entries(input.toolContextOverrides).filter(
            ([, v]) => v === 'full' || v === 'summary' || v === 'auto'
          )
        )
      : {};
  const toolContextSummaryMaxChars =
    typeof input.toolContextSummaryMaxChars === 'number' && Number.isFinite(input.toolContextSummaryMaxChars)
      ? Math.max(100, Math.floor(input.toolContextSummaryMaxChars))
      : DEFAULT_SETTINGS.toolContextSummaryMaxChars;
  const toolContextAutoThresholdChars =
    typeof input.toolContextAutoThresholdChars === 'number' && Number.isFinite(input.toolContextAutoThresholdChars)
      ? Math.max(500, Math.floor(input.toolContextAutoThresholdChars))
      : DEFAULT_SETTINGS.toolContextAutoThresholdChars;
  const projectGraphMaxDepth =
    typeof input.projectGraphMaxDepth === 'number' && Number.isFinite(input.projectGraphMaxDepth)
      ? Math.max(0, Math.floor(input.projectGraphMaxDepth))
      : DEFAULT_SETTINGS.projectGraphMaxDepth;
  const projectGraphMaxFiles =
    typeof input.projectGraphMaxFiles === 'number' && Number.isFinite(input.projectGraphMaxFiles)
      ? Math.max(0, Math.floor(input.projectGraphMaxFiles))
      : DEFAULT_SETTINGS.projectGraphMaxFiles;
  const projectGraphMaxEdges =
    typeof input.projectGraphMaxEdges === 'number' && Number.isFinite(input.projectGraphMaxEdges)
      ? Math.max(0, Math.floor(input.projectGraphMaxEdges))
      : DEFAULT_SETTINGS.projectGraphMaxEdges;
  const projectGraphMaxSymbolsPerFile =
    typeof input.projectGraphMaxSymbolsPerFile === 'number' && Number.isFinite(input.projectGraphMaxSymbolsPerFile)
      ? Math.max(0, Math.floor(input.projectGraphMaxSymbolsPerFile))
      : DEFAULT_SETTINGS.projectGraphMaxSymbolsPerFile;
  const projectGraphMaxFileBytes =
    typeof input.projectGraphMaxFileBytes === 'number' && Number.isFinite(input.projectGraphMaxFileBytes)
      ? Math.max(0, Math.floor(input.projectGraphMaxFileBytes))
      : DEFAULT_SETTINGS.projectGraphMaxFileBytes;
  const projectGraphMaxTreeEntries =
    typeof input.projectGraphMaxTreeEntries === 'number' && Number.isFinite(input.projectGraphMaxTreeEntries)
      ? Math.max(0, Math.floor(input.projectGraphMaxTreeEntries))
      : DEFAULT_SETTINGS.projectGraphMaxTreeEntries;

  const mentorApiFormat: ApiFormat =
    input.mentorApiFormat === 'claude' ? 'claude' : 'openai';
  const mentorMaxTokens =
    typeof input.mentorMaxTokens === 'number' && Number.isFinite(input.mentorMaxTokens)
      ? Math.max(100, Math.floor(input.mentorMaxTokens))
      : DEFAULT_SETTINGS.mentorMaxTokens;
  const maxMentorConsultations =
    typeof input.maxMentorConsultations === 'number' && Number.isFinite(input.maxMentorConsultations)
      ? Math.max(0, Math.floor(input.maxMentorConsultations))
      : DEFAULT_SETTINGS.maxMentorConsultations;
  const mentorThinkingEnabled =
    typeof input.mentorThinkingEnabled === 'boolean'
      ? input.mentorThinkingEnabled
      : DEFAULT_SETTINGS.mentorThinkingEnabled;

  const exploreTopP =
    typeof input.exploreTopP === 'number' && Number.isFinite(input.exploreTopP)
      ? Math.max(0, Math.min(1, input.exploreTopP))
      : DEFAULT_SETTINGS.exploreTopP;
  const exploreMaxTokens =
    typeof input.exploreMaxTokens === 'number' && Number.isFinite(input.exploreMaxTokens)
      ? Math.max(100, Math.floor(input.exploreMaxTokens))
      : DEFAULT_SETTINGS.exploreMaxTokens;
  const exploreThinkingEnabled =
    typeof input.exploreThinkingEnabled === 'boolean'
      ? input.exploreThinkingEnabled
      : DEFAULT_SETTINGS.exploreThinkingEnabled;
  const exploreTemperature =
    typeof input.exploreTemperature === 'number' && Number.isFinite(input.exploreTemperature)
      ? Math.max(0, Math.min(2, input.exploreTemperature))
      : DEFAULT_SETTINGS.exploreTemperature;
  const exploreMaxToolRounds =
    typeof input.exploreMaxToolRounds === 'number' && Number.isFinite(input.exploreMaxToolRounds)
      ? Math.max(1, Math.floor(input.exploreMaxToolRounds))
      : DEFAULT_SETTINGS.exploreMaxToolRounds;
  const exploreMaxDepth =
    typeof input.exploreMaxDepth === 'number' && Number.isFinite(input.exploreMaxDepth)
      ? Math.max(1, Math.min(5, Math.floor(input.exploreMaxDepth)))
      : DEFAULT_SETTINGS.exploreMaxDepth;
  const scoutTopP =
    typeof input.scoutTopP === 'number' && Number.isFinite(input.scoutTopP)
      ? Math.max(0, Math.min(1, input.scoutTopP))
      : DEFAULT_SETTINGS.scoutTopP;
  const scoutMaxTokens =
    typeof input.scoutMaxTokens === 'number' && Number.isFinite(input.scoutMaxTokens)
      ? Math.max(100, Math.floor(input.scoutMaxTokens))
      : DEFAULT_SETTINGS.scoutMaxTokens;
  const scoutThinkingEnabled =
    typeof input.scoutThinkingEnabled === 'boolean'
      ? input.scoutThinkingEnabled
      : DEFAULT_SETTINGS.scoutThinkingEnabled;
  const scoutTemperature =
    typeof input.scoutTemperature === 'number' && Number.isFinite(input.scoutTemperature)
      ? Math.max(0, Math.min(2, input.scoutTemperature))
      : DEFAULT_SETTINGS.scoutTemperature;
  const scoutMaxToolRounds =
    typeof input.scoutMaxToolRounds === 'number' && Number.isFinite(input.scoutMaxToolRounds)
      ? Math.max(1, Math.floor(input.scoutMaxToolRounds))
      : DEFAULT_SETTINGS.scoutMaxToolRounds;
  const scoutMaxDepth =
    typeof input.scoutMaxDepth === 'number' && Number.isFinite(input.scoutMaxDepth)
      ? Math.max(1, Math.min(5, Math.floor(input.scoutMaxDepth)))
      : DEFAULT_SETTINGS.scoutMaxDepth;
  const todoMaxRetries =
    typeof input.todoMaxRetries === 'number' && Number.isFinite(input.todoMaxRetries)
      ? Math.max(0, Math.min(10, Math.floor(input.todoMaxRetries)))
      : DEFAULT_SETTINGS.todoMaxRetries;
  const goalMaxIterations =
    typeof input.goalMaxIterations === 'number' && Number.isFinite(input.goalMaxIterations)
      ? Math.max(1, Math.min(100, Math.floor(input.goalMaxIterations)))
      : DEFAULT_SETTINGS.goalMaxIterations;
  const goalMaxWallClockMs =
    typeof input.goalMaxWallClockMs === 'number' && Number.isFinite(input.goalMaxWallClockMs)
      ? Math.max(60_000, Math.floor(input.goalMaxWallClockMs))
      : DEFAULT_SETTINGS.goalMaxWallClockMs;
  const goalRequireGitClean =
    typeof input.goalRequireGitClean === 'boolean'
      ? input.goalRequireGitClean
      : DEFAULT_SETTINGS.goalRequireGitClean;
  const verifierModelTier: 'fast' | 'primary' =
    input.verifierModelTier === 'primary' ? 'primary' : 'fast';
  const verifierMaxTokens =
    typeof input.verifierMaxTokens === 'number' && Number.isFinite(input.verifierMaxTokens)
      ? Math.max(100, Math.floor(input.verifierMaxTokens))
      : DEFAULT_SETTINGS.verifierMaxTokens;
  const verifierTemperature =
    typeof input.verifierTemperature === 'number' && Number.isFinite(input.verifierTemperature)
      ? Math.max(0, Math.min(2, input.verifierTemperature))
      : DEFAULT_SETTINGS.verifierTemperature;
  const appSubAgentModelTier: 'primary' | 'fast' =
    input.appSubAgentModelTier === 'fast' ? 'fast' : 'primary';
  const appSubAgentThinkingEnabled =
    typeof input.appSubAgentThinkingEnabled === 'boolean'
      ? input.appSubAgentThinkingEnabled
      : DEFAULT_SETTINGS.appSubAgentThinkingEnabled;
  const appSubAgentMaxToolRounds =
    typeof input.appSubAgentMaxToolRounds === 'number' && Number.isFinite(input.appSubAgentMaxToolRounds)
      ? Math.max(1, Math.min(200, Math.floor(input.appSubAgentMaxToolRounds)))
      : DEFAULT_SETTINGS.appSubAgentMaxToolRounds;
  const searxngEnabled =
    typeof input.searxngEnabled === 'boolean'
      ? input.searxngEnabled
      : DEFAULT_SETTINGS.searxngEnabled;
  const searxngBaseUrl =
    typeof input.searxngBaseUrl === 'string'
      ? input.searxngBaseUrl.trim().replace(/\/+$/, '')
      : DEFAULT_SETTINGS.searxngBaseUrl;
  const searxngCategories =
    typeof input.searxngCategories === 'string' && input.searxngCategories.trim()
      ? input.searxngCategories.trim()
      : DEFAULT_SETTINGS.searxngCategories;
  const searxngTimeRange =
    typeof input.searxngTimeRange === 'string'
      ? (['', 'day', 'week', 'month', 'year'].includes(input.searxngTimeRange.trim())
          ? input.searxngTimeRange.trim()
          : DEFAULT_SETTINGS.searxngTimeRange)
      : DEFAULT_SETTINGS.searxngTimeRange;
  const searxngLanguage =
    typeof input.searxngLanguage === 'string'
      ? input.searxngLanguage.trim()
      : DEFAULT_SETTINGS.searxngLanguage;
  const searxngSafeSearch =
    typeof input.searxngSafeSearch === 'number' && [0, 1, 2].includes(input.searxngSafeSearch)
      ? input.searxngSafeSearch
      : DEFAULT_SETTINGS.searxngSafeSearch;
  const searxngEngines =
    typeof input.searxngEngines === 'string'
      ? input.searxngEngines.trim()
      : DEFAULT_SETTINGS.searxngEngines;
  const graphToolTimeoutMs =
    typeof input.graphToolTimeoutMs === 'number' && Number.isFinite(input.graphToolTimeoutMs)
      ? Math.max(30_000, Math.floor(input.graphToolTimeoutMs))
      : DEFAULT_SETTINGS.graphToolTimeoutMs;
  const toolIpcTimeoutMs =
    typeof input.toolIpcTimeoutMs === 'number' && Number.isFinite(input.toolIpcTimeoutMs)
      ? Math.max(30_000, Math.floor(input.toolIpcTimeoutMs))
      : DEFAULT_SETTINGS.toolIpcTimeoutMs;
  const streamIdleTimeoutMs =
    typeof input.streamIdleTimeoutMs === 'number' && Number.isFinite(input.streamIdleTimeoutMs)
      ? Math.max(10_000, Math.floor(input.streamIdleTimeoutMs))
      : DEFAULT_SETTINGS.streamIdleTimeoutMs;
  const mcp = normalizeMcpSettings(input.mcp);

  return {
    ...DEFAULT_SETTINGS,
    ...input,
    apiMode,
    apiFormat,
    provider,
    deepseek,
    custom,
    local,
    model,
    fastModelEnabled:
      typeof input.fastModelEnabled === 'boolean'
        ? input.fastModelEnabled
        : DEFAULT_SETTINGS.fastModelEnabled,
    fastModel,
    apiKey,
    baseURL,
    systemPrompt,
    thinkingEnabled,
    thinkingEffort,
    debugEnabled,
    chatBordersEnabled,
    temperature,
    topP,
    multimodalEnabled,
    multimodalModelTier,
    maxTokens,
    maxToolRounds,
    maxContextTokens,
    maxConversationRounds,
    compactionModel,
    compactionMaxTokens,
    compactionTemperature,
    toolOutputInterceptChars,
    toolOutputOffloadChars,
    toolOutputCeilingChars,
    toolOutputPreviewChars,
    toolOutputMiddleKeepChars,
    pruneOldToolResults,
    pruneProtectRounds,
    pruneMinChars,
    toolContextDefaultMode,
    toolContextOverrides,
    toolContextSummaryMaxChars,
    toolContextAutoThresholdChars,
    projectGraphMaxDepth,
    projectGraphMaxFiles,
    projectGraphMaxEdges,
    projectGraphMaxSymbolsPerFile,
    projectGraphMaxFileBytes,
    projectGraphMaxTreeEntries,
    lang,
    recentWorkspaces: normalizeRecentWorkspaces(input.recentWorkspaces),
    mentorEnabled:
      typeof input.mentorEnabled === 'boolean'
        ? input.mentorEnabled
        : DEFAULT_SETTINGS.mentorEnabled,
    mentorModel: (input.mentorModel ?? DEFAULT_SETTINGS.mentorModel).trim(),
    mentorBaseURL: (input.mentorBaseURL ?? DEFAULT_SETTINGS.mentorBaseURL).trim(),
    mentorApiKey: (input.mentorApiKey ?? DEFAULT_SETTINGS.mentorApiKey).trim(),
    mentorApiFormat,
    mentorMaxTokens,
    maxMentorConsultations,
    mentorThinkingEnabled,
    explorePrompt: (input.explorePrompt ?? '').trim(),
    scoutPrompt: (input.scoutPrompt ?? '').trim(),
    mentorPrompt: (input.mentorPrompt ?? '').trim(),
    exploreModelTier: input.exploreModelTier === 'primary' ? 'primary' : 'fast',
    scoutModelTier: input.scoutModelTier === 'primary' ? 'primary' : 'fast',
    exploreTopP,
    exploreMaxTokens,
    exploreThinkingEnabled,
    exploreTemperature,
    exploreMaxToolRounds,
    exploreMaxDepth,
    scoutTopP,
    scoutMaxTokens,
    scoutThinkingEnabled,
    scoutTemperature,
    scoutMaxToolRounds,
    scoutMaxDepth,
    todoMaxRetries,
    goalMaxIterations,
    goalMaxWallClockMs,
    goalRequireGitClean,
    verifierModelTier,
    verifierMaxTokens,
    verifierTemperature,
    appSubAgentModelTier,
    appSubAgentThinkingEnabled,
    appSubAgentMaxToolRounds,
    searxngEnabled,
    searxngBaseUrl,
    searxngCategories,
    searxngTimeRange,
    searxngLanguage,
    searxngSafeSearch,
    searxngEngines,
    graphToolTimeoutMs,
    toolIpcTimeoutMs,
    streamIdleTimeoutMs,
    mcp,
  };
}

export function resolveProviderName(settings: Settings): ProviderName {
  if (settings.apiMode === 'deepseek') return 'deepseek';
  if (settings.apiMode === 'local') return 'openai';
  return settings.apiFormat;
}

export function resolveMultimodalEnabled(settings: Settings, currentModel: string): boolean {
  if (!settings.multimodalEnabled) return false;
  if (settings.multimodalModelTier === 'all') return true;
  const fastModel = settings.fastModel.trim();
  const isFastModel = settings.fastModelEnabled && fastModel.length > 0 && currentModel === fastModel;
  if (settings.multimodalModelTier === 'primary' && !isFastModel) return true;
  if (settings.multimodalModelTier === 'fast' && isFastModel) return true;
  return false;
}

export function getActiveModeConfig(settings: Settings): ModeConfig & { apiFormat: ApiFormat } {
  const cfg = settings.apiMode === 'deepseek' ? settings.deepseek
    : settings.apiMode === 'custom' ? settings.custom
    : settings.local;
  return { ...cfg, apiFormat: settings.apiFormat };
}

export function getProviderLabel(settings: Settings): string {
  const lang = settings.lang || 'zh-CN';
  if (settings.apiMode === 'deepseek') return lang === 'en' ? 'DeepSeek Official' : lang === 'zh-TW' ? 'DeepSeek 官方' : 'DeepSeek 官方';
  if (settings.apiMode === 'local') return lang === 'en' ? 'Local Model' : lang === 'zh-TW' ? '本地模型' : '本地模型';
  return settings.apiFormat === 'openai'
    ? (lang === 'en' ? 'Custom OpenAI' : lang === 'zh-TW' ? '自定義 OpenAI' : '自定义 OpenAI 格式')
    : (lang === 'en' ? 'Custom Claude' : lang === 'zh-TW' ? '自定義 Claude' : '自定义 Claude 格式');
}

export function getSettingsError(settings: Settings): string | null {
  const lang = settings.lang || 'zh-CN';
  const apiKey = settings.apiKey.trim();
  const model = settings.model.trim();
  if (settings.apiMode !== 'local' && !apiKey) {
    return lang === 'en'
      ? 'Please enter API Key in settings first'
      : lang === 'zh-TW'
      ? '請先在設置中填寫 API Key'
      : '请先在设置中填写 API Key';
  }
  if (settings.apiMode === 'custom' && !settings.baseURL.trim()) {
    return lang === 'en'
      ? 'This mode requires an API address'
      : lang === 'zh-TW'
      ? '該模式需要填寫 API 地址'
      : '该模式需要填写 API 地址';
  }
  if (!model) {
    return lang === 'en'
      ? 'Please fill in the model name'
      : lang === 'zh-TW'
      ? '請先填寫模型名稱'
      : '请先填写模型名称';
  }
  return null;
}

export function isApiConfigured(settings: Settings): boolean {
  return getSettingsError(settings) === null;
}
