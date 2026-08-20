import { sanitizeMaxTokens } from '@codepapr/api';
import { normalizeMcpSettings } from '../../utils/mcpTypes';
import { isBuiltinThemeId } from '../../theme/themes';
import { resolveTheme, validateCustomTheme } from '../../theme/themeEngine';
import type { CustomThemeRecord } from '../../theme/types';
import { ACCENT_PATTERN } from '../../theme/types';
import { DEFAULT_SETTINGS, normalizeCustomSystemPrompt } from './defaults';
import type { ApiFormat, ApiMode, Lang, ModeConfig, ModelProfile, ProviderName, Settings, WorkspaceEntry } from './types';

function normalizeModelProfile(input: unknown, fallbackId: string): ModelProfile | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : fallbackId;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : 'Unnamed Profile';
  const apiMode: ApiMode =
    obj.apiMode === 'deepseek' || obj.apiMode === 'custom' || obj.apiMode === 'local'
      ? obj.apiMode
      : 'custom';
  const apiFormat: ApiFormat =
    obj.apiFormat === 'claude' ? 'claude' : obj.apiFormat === 'response' ? 'response' : 'openai';
  const baseURL = typeof obj.baseURL === 'string' ? obj.baseURL.trim() : '';
  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey.trim() : '';
  const model = typeof obj.model === 'string' ? obj.model.trim() : '';
  const maxTokens =
    typeof obj.maxTokens === 'number' && Number.isFinite(obj.maxTokens)
      ? Math.max(100, Math.floor(obj.maxTokens))
      : DEFAULT_SETTINGS.maxTokens;
  const maxContextTokens =
    typeof obj.maxContextTokens === 'number' && Number.isFinite(obj.maxContextTokens)
      ? Math.max(1000, Math.floor(obj.maxContextTokens))
      : undefined;
  const thinkingEnabled = typeof obj.thinkingEnabled === 'boolean' ? obj.thinkingEnabled : false;
  const thinkingEffort = typeof obj.thinkingEffort === 'string' ? obj.thinkingEffort.trim() : '';
  const thinkingBudgetTokens =
    typeof obj.thinkingBudgetTokens === 'number' && Number.isFinite(obj.thinkingBudgetTokens)
      ? Math.max(0, Math.floor(obj.thinkingBudgetTokens))
      : 4096;
  const temperature =
    typeof obj.temperature === 'number' && Number.isFinite(obj.temperature)
      ? Math.max(0, Math.min(2, obj.temperature))
      : undefined;
  const topP =
    typeof obj.topP === 'number' && Number.isFinite(obj.topP)
      ? Math.max(0, Math.min(1, obj.topP))
      : undefined;
  const topK =
    typeof obj.topK === 'number' && Number.isFinite(obj.topK)
      ? Math.max(0, Math.floor(obj.topK))
      : undefined;
  const multimodalEnabled =
    typeof obj.multimodalEnabled === 'boolean'
      ? obj.multimodalEnabled
      : undefined;

  return {
    id,
    name,
    apiMode,
    apiFormat,
    baseURL,
    apiKey,
    model,
    maxTokens,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    thinkingEnabled,
    thinkingEffort,
    thinkingBudgetTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(multimodalEnabled !== undefined ? { multimodalEnabled } : {}),
  };
}

export function createDefaultProfile(
  name: string = '新建模型配置',
  apiMode: ApiMode = 'custom'
): ModelProfile {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (apiMode === 'deepseek') {
    return {
      id,
      name: name || 'DeepSeek 官方',
      apiMode: 'deepseek',
      apiFormat: 'openai',
      baseURL: '',
      apiKey: '',
      model: 'deepseek-v4-pro',
      maxTokens: DEFAULT_SETTINGS.maxTokens,
      maxContextTokens: 1048565,
      temperature: 0.7,
      topP: 0.9,
      multimodalEnabled: false,
      thinkingEnabled: true,
      thinkingEffort: 'max',
      thinkingBudgetTokens: 4096,
    };
  }
  if (apiMode === 'local') {
    return {
      id,
      name: name || '本地模型',
      apiMode: 'local',
      apiFormat: 'openai',
      baseURL: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'local-model',
      maxTokens: DEFAULT_SETTINGS.maxTokens,
      maxContextTokens: 128000,
      temperature: 0.7,
      topP: 0.9,
      multimodalEnabled: false,
      thinkingEnabled: false,
      thinkingEffort: '',
      thinkingBudgetTokens: 0,
    };
  }
  return {
    id,
    name: name || '自定义模型',
    apiMode: 'custom',
    apiFormat: 'openai',
    baseURL: '',
    apiKey: '',
    model: 'gpt-4o',
    maxTokens: DEFAULT_SETTINGS.maxTokens,
    maxContextTokens: 128000,
    temperature: 0.7,
    topP: 0.9,
    multimodalEnabled: true,
    thinkingEnabled: false,
    thinkingEffort: '',
    thinkingBudgetTokens: 4096,
  };
}

function buildSynthesizedProfiles(
  input: Partial<Settings>,
  apiMode: ApiMode,
  deepseek: ModeConfig,
  custom: ModeConfig,
  local: ModeConfig,
  apiFormat: ApiFormat,
  thinkingEnabled: boolean,
  thinkingEffort: string,
  thinkingBudgetTokens: number,
  mentorModel: string,
  mentorBaseURL: string,
  mentorApiKey: string,
  mentorApiFormat: ApiFormat,
  mentorMaxTokens: number,
  mentorThinkingEnabled: boolean,
  mentorThinkingEffort: string,
  mentorThinkingBudgetTokens: number,
): ModelProfile[] {
  const profiles: ModelProfile[] = [
    {
      id: 'profile-deepseek',
      name: 'DeepSeek 官方',
      apiMode: 'deepseek',
      apiFormat: 'openai',
      baseURL: deepseek.baseURL,
      apiKey: deepseek.apiKey,
      model: deepseek.model || 'deepseek-v4-pro',
      maxTokens: deepseek.maxTokens || DEFAULT_SETTINGS.maxTokens,
      maxContextTokens: 1048565,
      temperature: 0.7,
      topP: 0.9,
      multimodalEnabled: false,
      thinkingEnabled: apiMode === 'deepseek' ? thinkingEnabled : true,
      thinkingEffort: apiMode === 'deepseek' ? thinkingEffort : 'max',
      thinkingBudgetTokens: apiMode === 'deepseek' ? thinkingBudgetTokens : 4096,
    },
    {
      id: 'profile-deepseek-fast',
      name: 'DeepSeek Flash (快速)',
      apiMode: 'deepseek',
      apiFormat: 'openai',
      baseURL: deepseek.baseURL,
      apiKey: deepseek.apiKey,
      model: deepseek.fastModel || 'deepseek-v4-flash',
      maxTokens: deepseek.maxTokens || DEFAULT_SETTINGS.maxTokens,
      maxContextTokens: 1048565,
      temperature: 0.7,
      topP: 0.9,
      multimodalEnabled: false,
      thinkingEnabled: false,
      thinkingEffort: '',
      thinkingBudgetTokens: 0,
    },
    {
      id: 'profile-custom',
      name: '自定义 API (Custom)',
      apiMode: 'custom',
      apiFormat,
      baseURL: custom.baseURL,
      apiKey: custom.apiKey,
      model: custom.model || 'gpt-4o',
      maxTokens: custom.maxTokens || DEFAULT_SETTINGS.maxTokens,
      maxContextTokens: typeof input.maxContextTokens === 'number' ? input.maxContextTokens : 128000,
      temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
      topP: typeof input.topP === 'number' ? input.topP : 0.9,
      multimodalEnabled: typeof input.multimodalEnabled === 'boolean' ? input.multimodalEnabled : true,
      thinkingEnabled: apiMode === 'custom' ? thinkingEnabled : false,
      thinkingEffort: apiMode === 'custom' ? thinkingEffort : '',
      thinkingBudgetTokens: apiMode === 'custom' ? thinkingBudgetTokens : 4096,
    },
    {
      id: 'profile-local',
      name: '本地模型 (Local)',
      apiMode: 'local',
      apiFormat: 'openai',
      baseURL: local.baseURL || 'http://127.0.0.1:8080/v1',
      apiKey: local.apiKey,
      model: local.model || 'local-model',
      maxTokens: local.maxTokens || DEFAULT_SETTINGS.maxTokens,
      maxContextTokens: 128000,
      temperature: 0.7,
      topP: 0.9,
      multimodalEnabled: false,
      thinkingEnabled: false,
      thinkingEffort: '',
      thinkingBudgetTokens: 0,
    },
  ];

  if (mentorModel || mentorApiKey || mentorBaseURL) {
    profiles.push({
      id: 'profile-mentor',
      name: '导师模型 (Mentor)',
      apiMode: 'custom',
      apiFormat: mentorApiFormat,
      baseURL: mentorBaseURL,
      apiKey: mentorApiKey,
      model: mentorModel || 'claude-sonnet-4-20250514',
      maxTokens: mentorMaxTokens,
      maxContextTokens: 200000,
      temperature: 0.7,
      topP: 0.9,
      multimodalEnabled: true,
      thinkingEnabled: mentorThinkingEnabled,
      thinkingEffort: mentorThinkingEffort,
      thinkingBudgetTokens: mentorThinkingBudgetTokens,
    });
  }

  return profiles;
}

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

/** 自定义主题清洗：逐条校验，非法记录直接丢弃（不阻塞设置加载）。 */
function normalizeCustomThemes(input: unknown): Record<string, CustomThemeRecord> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const result: Record<string, CustomThemeRecord> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    const record = raw as CustomThemeRecord;
    if (validateCustomTheme(id, record).ok) {
      result[id] = record;
    }
  }
  return result;
}

export function normalizeSettings(
  input: Partial<Settings> & { theme?: string | null } = {},
): Settings {
  // 旧版单一 theme 字段不进入输出对象（避免把废弃字段持久化回去）。
  const { theme: __legacyTheme, ...cleanInput } = input;
  const apiMode: ApiMode =
    input.apiMode ?? (input.provider && input.provider !== 'deepseek' ? 'custom' : 'deepseek');
  const apiFormat: ApiFormat =
    input.apiFormat === 'claude' || input.apiFormat === 'response' || input.apiFormat === 'openai'
      ? input.apiFormat
      : input.provider === 'claude'
      ? 'claude'
      : input.provider === 'response'
      ? 'response'
      : 'openai';
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
  // 推理强度为任意字符串（OpenAI 兼容 reasoning_effort，第三方端点取值各异）：
  // 非空字符串原样透传，空/非法值回退默认。旧持久化值 high/max 依然有效。
  const thinkingEffort: string =
    typeof input.thinkingEffort === 'string' && input.thinkingEffort.trim()
      ? input.thinkingEffort.trim()
      : DEFAULT_SETTINGS.thinkingEffort;
  const thinkingBudgetTokens =
    typeof input.thinkingBudgetTokens === 'number' && Number.isFinite(input.thinkingBudgetTokens)
      ? Math.max(0, Math.floor(input.thinkingBudgetTokens))
      : DEFAULT_SETTINGS.thinkingBudgetTokens;
  const debugEnabled =
    typeof input.debugEnabled === 'boolean'
      ? input.debugEnabled
      : DEFAULT_SETTINGS.debugEnabled;
  const chatBordersEnabled =
    typeof input.chatBordersEnabled === 'boolean'
      ? input.chatBordersEnabled
      : DEFAULT_SETTINGS.chatBordersEnabled;
  const experimentalCharacters =
    typeof input.experimentalCharacters === 'boolean'
      ? input.experimentalCharacters
      : DEFAULT_SETTINGS.experimentalCharacters;
  const experimentalVoice =
    typeof input.experimentalVoice === 'boolean'
      ? input.experimentalVoice
      : DEFAULT_SETTINGS.experimentalVoice;
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
  const chatRenderBatchRounds =
    typeof input.chatRenderBatchRounds === 'number' && Number.isFinite(input.chatRenderBatchRounds)
      ? Math.max(1, Math.min(50, Math.floor(input.chatRenderBatchRounds)))
      : DEFAULT_SETTINGS.chatRenderBatchRounds;
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
    input.mentorApiFormat === 'claude'
      ? 'claude'
      : input.mentorApiFormat === 'response'
      ? 'response'
      : 'openai';
  // 迁移：旧默认值为 10000，过小会导致 mentor 思考/长回复被 max_tokens 截断。
  // 持久化值恰为旧默认时升级到新默认（100k）；用户显式设置的其他值保持不变。
  const LEGACY_MENTOR_MAX_TOKENS = 10000;
  const rawMentorMaxTokens =
    typeof input.mentorMaxTokens === 'number' && Number.isFinite(input.mentorMaxTokens)
      ? Math.floor(input.mentorMaxTokens)
      : undefined;
  const mentorMaxTokens =
    rawMentorMaxTokens === undefined
      ? DEFAULT_SETTINGS.mentorMaxTokens
      : rawMentorMaxTokens === LEGACY_MENTOR_MAX_TOKENS
        ? DEFAULT_SETTINGS.mentorMaxTokens
        : Math.max(100, rawMentorMaxTokens);
  const maxMentorConsultations =
    typeof input.maxMentorConsultations === 'number' && Number.isFinite(input.maxMentorConsultations)
      ? Math.max(0, Math.floor(input.maxMentorConsultations))
      : DEFAULT_SETTINGS.maxMentorConsultations;
  const mentorThinkingEnabled =
    typeof input.mentorThinkingEnabled === 'boolean'
      ? input.mentorThinkingEnabled
      : DEFAULT_SETTINGS.mentorThinkingEnabled;
  const mentorThinkingEffort: string =
    typeof input.mentorThinkingEffort === 'string' && input.mentorThinkingEffort.trim()
      ? input.mentorThinkingEffort.trim()
      : DEFAULT_SETTINGS.mentorThinkingEffort;
  const mentorThinkingBudgetTokens =
    typeof input.mentorThinkingBudgetTokens === 'number' && Number.isFinite(input.mentorThinkingBudgetTokens)
      ? Math.max(0, Math.floor(input.mentorThinkingBudgetTokens))
      : DEFAULT_SETTINGS.mentorThinkingBudgetTokens;

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
  const verifierModelTier: 'fast' | 'primary' | 'mentor' =
    input.verifierModelTier === 'primary'
      ? 'primary'
      : input.verifierModelTier === 'mentor'
      ? 'mentor'
      : 'fast';
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
  const browserEngine: 'embedded' | 'headless' =
    input.browserEngine === 'headless' ? 'headless' : 'embedded';
  const folderAccessYolo =
    typeof input.folderAccessYolo === 'boolean'
      ? input.folderAccessYolo
      : DEFAULT_SETTINGS.folderAccessYolo;
  const mcp = normalizeMcpSettings(input.mcp);

  const customThemes = normalizeCustomThemes(input.customThemes);
  const isValidThemeId = (id: unknown): id is string =>
    typeof id === 'string' && (isBuiltinThemeId(id) || customThemes[id] !== undefined);

  // 旧版单一 theme 字段（可空 = 跟随系统）→ 新浅/深双主题模型：
  // 按其 mode 落入对应槽位，并转为手动模式。
  const legacyTheme = isValidThemeId(input.theme) ? input.theme : null;
  const legacyMode = legacyTheme ? resolveTheme(legacyTheme, customThemes)?.mode ?? null : null;
  const lightTheme = isValidThemeId(input.lightTheme)
    ? input.lightTheme
    : legacyMode === 'light' && legacyTheme
      ? legacyTheme
      : DEFAULT_SETTINGS.lightTheme;
  const darkTheme = isValidThemeId(input.darkTheme)
    ? input.darkTheme
    : legacyMode === 'dark' && legacyTheme
      ? legacyTheme
      : DEFAULT_SETTINGS.darkTheme;
  // 旧字段为 null 表示"跟随系统"；未迁移过（无 theme 字段）时保持默认。
  const followSystem =
    typeof input.followSystem === 'boolean'
      ? input.followSystem
      : legacyTheme !== null || Object.prototype.hasOwnProperty.call(input, 'theme')
        ? legacyTheme === null
        : DEFAULT_SETTINGS.followSystem;
  const themeMode: 'light' | 'dark' =
    input.themeMode === 'light' || input.themeMode === 'dark'
      ? input.themeMode
      : legacyMode ?? DEFAULT_SETTINGS.themeMode;
  const accent =
    typeof input.accent === 'string' && ACCENT_PATTERN.test(input.accent.trim())
      ? input.accent.trim()
      : null;

  // Model profiles handling
  const hasExplicitProfiles = Array.isArray(input.modelProfiles) && input.modelProfiles.length > 0;
  let modelProfiles: ModelProfile[];
  if (hasExplicitProfiles) {
    const normalized: ModelProfile[] = [];
    input.modelProfiles!.forEach((item, index) => {
      const prof = normalizeModelProfile(item, `profile-${index + 1}`);
      if (prof) normalized.push(prof);
    });
    modelProfiles = normalized.length > 0 ? normalized : DEFAULT_SETTINGS.modelProfiles;
  } else {
    modelProfiles = buildSynthesizedProfiles(
      input,
      apiMode,
      deepseek,
      custom,
      local,
      apiFormat,
      thinkingEnabled,
      thinkingEffort,
      thinkingBudgetTokens,
      typeof input.mentorModel === 'string' ? input.mentorModel.trim() : '',
      typeof input.mentorBaseURL === 'string' ? input.mentorBaseURL.trim() : '',
      typeof input.mentorApiKey === 'string' ? input.mentorApiKey.trim() : '',
      mentorApiFormat,
      mentorMaxTokens,
      mentorThinkingEnabled,
      mentorThinkingEffort,
      mentorThinkingBudgetTokens,
    );
  }

  // Slot ID resolution
  let primaryProfileId =
    typeof input.primaryProfileId === 'string' && input.primaryProfileId.trim()
      ? input.primaryProfileId.trim()
      : '';
  if (!modelProfiles.some((p) => p.id === primaryProfileId)) {
    const byMode = modelProfiles.find((p) => p.apiMode === apiMode);
    primaryProfileId = byMode ? byMode.id : modelProfiles[0].id;
  }

  let fastProfileId =
    typeof input.fastProfileId === 'string' && input.fastProfileId.trim()
      ? input.fastProfileId.trim()
      : '';
  if (!modelProfiles.some((p) => p.id === fastProfileId)) {
    const fastCandidate =
      modelProfiles.find((p) => p.id === 'profile-deepseek-fast') ||
      modelProfiles.find(
        (p) =>
          p.name.toLowerCase().includes('fast') ||
          p.name.includes('快速') ||
          p.model.toLowerCase().includes('flash')
      ) ||
      modelProfiles[0];
    fastProfileId = fastCandidate ? fastCandidate.id : primaryProfileId;
  }

  let mentorProfileId =
    typeof input.mentorProfileId === 'string' && input.mentorProfileId.trim()
      ? input.mentorProfileId.trim()
      : '';
  if (!modelProfiles.some((p) => p.id === mentorProfileId)) {
    const mentorCandidate =
      modelProfiles.find((p) => p.id === 'profile-mentor') ||
      modelProfiles.find(
        (p) =>
          p.name.toLowerCase().includes('mentor') ||
          p.name.includes('导师') ||
          p.name.includes('導師') ||
          p.id === 'profile-custom'
      ) ||
      modelProfiles[0];
    mentorProfileId = mentorCandidate ? mentorCandidate.id : primaryProfileId;
  }

  // Active profiles lookup
  const activePrimaryProfile = modelProfiles.find((p) => p.id === primaryProfileId) || modelProfiles[0];
  const activeFastProfile = modelProfiles.find((p) => p.id === fastProfileId) || activePrimaryProfile;
  const activeMentorProfile = modelProfiles.find((p) => p.id === mentorProfileId) || activePrimaryProfile;

  // If per-mode configs were provided in input, sync them into the corresponding profiles
  if (input.deepseek) {
    const dsProfile = modelProfiles.find((p) => p.id === 'profile-deepseek' || p.apiMode === 'deepseek');
    if (dsProfile) {
      if (typeof input.deepseek.apiKey === 'string') dsProfile.apiKey = input.deepseek.apiKey.trim();
      if (typeof input.deepseek.baseURL === 'string') dsProfile.baseURL = input.deepseek.baseURL.trim();
      if (typeof input.deepseek.model === 'string') dsProfile.model = input.deepseek.model.trim();
      if (typeof input.deepseek.fastModel === 'string') {
        const dsFast = modelProfiles.find((p) => p.id === 'profile-deepseek-fast');
        if (dsFast) dsFast.model = input.deepseek.fastModel.trim();
      }
    }
  }
  if (input.custom) {
    const customProfile = modelProfiles.find((p) => p.id === 'profile-custom' || (p.apiMode === 'custom' && p.id !== 'profile-mentor'));
    if (customProfile) {
      if (typeof input.custom.apiKey === 'string') customProfile.apiKey = input.custom.apiKey.trim();
      if (typeof input.custom.baseURL === 'string') customProfile.baseURL = input.custom.baseURL.trim();
      if (typeof input.custom.model === 'string') customProfile.model = input.custom.model.trim();
    }
  }
  if (input.local) {
    const localProfile = modelProfiles.find((p) => p.id === 'profile-local' || p.apiMode === 'local');
    if (localProfile) {
      if (typeof input.local.apiKey === 'string') localProfile.apiKey = input.local.apiKey.trim();
      if (typeof input.local.baseURL === 'string') localProfile.baseURL = input.local.baseURL.trim();
      if (typeof input.local.model === 'string') localProfile.model = input.local.model.trim();
    }
  }

  // If explicit flat fields were provided in input, sync into active slot profiles
  if (typeof input.apiKey === 'string') {
    activePrimaryProfile.apiKey = input.apiKey.trim();
  }
  if (typeof input.model === 'string') {
    activePrimaryProfile.model = input.model.trim();
  }
  if (typeof input.baseURL === 'string') {
    activePrimaryProfile.baseURL = input.baseURL.trim();
  }
  if (typeof input.fastModel === 'string') {
    activeFastProfile.model = input.fastModel.trim();
  }
  if (typeof input.mentorModel === 'string') {
    activeMentorProfile.model = input.mentorModel.trim();
  }
  if (typeof input.mentorApiKey === 'string') {
    activeMentorProfile.apiKey = input.mentorApiKey.trim();
  }
  if (typeof input.mentorBaseURL === 'string') {
    activeMentorProfile.baseURL = input.mentorBaseURL.trim();
  }

  const effectiveApiMode = hasExplicitProfiles ? activePrimaryProfile.apiMode : apiMode;
  const effectiveApiFormat = hasExplicitProfiles ? activePrimaryProfile.apiFormat : apiFormat;
  const effectiveProvider = hasExplicitProfiles ? resolveProviderName(activePrimaryProfile) : provider;
  const effectiveModel = hasExplicitProfiles ? activePrimaryProfile.model : model;
  const effectiveFastModel = hasExplicitProfiles ? activeFastProfile.model : fastModel;
  const effectiveApiKey = hasExplicitProfiles ? activePrimaryProfile.apiKey : apiKey;
  const effectiveBaseURL = hasExplicitProfiles ? activePrimaryProfile.baseURL : baseURL;
  const effectiveThinkingEnabled = hasExplicitProfiles
    ? (activePrimaryProfile.thinkingEnabled ?? false)
    : thinkingEnabled;
  const effectiveThinkingEffort = hasExplicitProfiles
    ? (activePrimaryProfile.thinkingEffort ?? '')
    : thinkingEffort;
  const effectiveThinkingBudgetTokens = hasExplicitProfiles
    ? (activePrimaryProfile.thinkingBudgetTokens ?? 4096)
    : thinkingBudgetTokens;

  const effectiveMentorModel = hasExplicitProfiles
    ? activeMentorProfile.model
    : (typeof input.mentorModel === 'string' ? input.mentorModel.trim() : DEFAULT_SETTINGS.mentorModel);
  const effectiveMentorBaseURL = hasExplicitProfiles
    ? activeMentorProfile.baseURL
    : (typeof input.mentorBaseURL === 'string' ? input.mentorBaseURL.trim() : DEFAULT_SETTINGS.mentorBaseURL);
  const effectiveMentorApiKey = hasExplicitProfiles
    ? activeMentorProfile.apiKey
    : (typeof input.mentorApiKey === 'string' ? input.mentorApiKey.trim() : DEFAULT_SETTINGS.mentorApiKey);
  const effectiveMentorApiFormat = hasExplicitProfiles ? activeMentorProfile.apiFormat : mentorApiFormat;
  const effectiveMentorThinkingEnabled = hasExplicitProfiles
    ? (activeMentorProfile.thinkingEnabled ?? false)
    : mentorThinkingEnabled;
  const effectiveMentorThinkingEffort = hasExplicitProfiles
    ? (activeMentorProfile.thinkingEffort ?? '')
    : mentorThinkingEffort;
  const effectiveMentorThinkingBudgetTokens = hasExplicitProfiles
    ? (activeMentorProfile.thinkingBudgetTokens ?? 4096)
    : mentorThinkingBudgetTokens;
  const effectiveMentorMaxTokens = hasExplicitProfiles
    ? activeMentorProfile.maxTokens
    : mentorMaxTokens;

  const effectiveTemperature =
    hasExplicitProfiles && activePrimaryProfile.temperature !== undefined
      ? activePrimaryProfile.temperature
      : temperature;
  const effectiveTopP =
    hasExplicitProfiles && activePrimaryProfile.topP !== undefined
      ? activePrimaryProfile.topP
      : topP;
  const effectiveMaxContextTokens =
    hasExplicitProfiles && activePrimaryProfile.maxContextTokens !== undefined
      ? activePrimaryProfile.maxContextTokens
      : maxContextTokens;
  const effectiveMultimodalEnabled =
    hasExplicitProfiles && activePrimaryProfile.multimodalEnabled !== undefined
      ? activePrimaryProfile.multimodalEnabled
      : multimodalEnabled;

  // Keep per-mode configs up-to-date with active configurations
  if (effectiveApiMode === 'deepseek') {
    deepseek.apiKey = effectiveApiKey;
    deepseek.baseURL = effectiveBaseURL;
    deepseek.model = effectiveModel;
    deepseek.fastModel = effectiveFastModel;
  } else if (effectiveApiMode === 'custom') {
    custom.apiKey = effectiveApiKey;
    custom.baseURL = effectiveBaseURL;
    custom.model = effectiveModel;
    custom.fastModel = effectiveFastModel;
  } else if (effectiveApiMode === 'local') {
    local.apiKey = effectiveApiKey;
    local.baseURL = effectiveBaseURL;
    local.model = effectiveModel;
    local.fastModel = effectiveFastModel;
  }

  return {
    ...DEFAULT_SETTINGS,
    ...cleanInput,
    modelProfiles,
    primaryProfileId,
    fastProfileId,
    mentorProfileId,
    apiMode: effectiveApiMode,
    apiFormat: effectiveApiFormat,
    provider: effectiveProvider,
    deepseek,
    custom,
    local,
    model: effectiveModel,
    fastModelEnabled:
      typeof input.fastModelEnabled === 'boolean'
        ? input.fastModelEnabled
        : DEFAULT_SETTINGS.fastModelEnabled,
    fastModel: effectiveFastModel,
    apiKey: effectiveApiKey,
    baseURL: effectiveBaseURL,
    systemPrompt,
    thinkingEnabled: effectiveThinkingEnabled,
    thinkingEffort: effectiveThinkingEffort,
    thinkingBudgetTokens: effectiveThinkingBudgetTokens,
    debugEnabled,
    chatBordersEnabled,
    experimentalCharacters,
    experimentalVoice,
    temperature: effectiveTemperature,
    topP: effectiveTopP,
    multimodalEnabled: effectiveMultimodalEnabled,
    multimodalModelTier,
    maxTokens,
    maxToolRounds,
    maxContextTokens: effectiveMaxContextTokens,
    maxConversationRounds,
    chatRenderBatchRounds,
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
    lightTheme,
    darkTheme,
    followSystem,
    themeMode,
    accent,
    customThemes,
    recentWorkspaces: normalizeRecentWorkspaces(input.recentWorkspaces),
    mentorEnabled:
      typeof input.mentorEnabled === 'boolean'
        ? input.mentorEnabled
        : DEFAULT_SETTINGS.mentorEnabled,
    mentorModel: effectiveMentorModel,
    mentorBaseURL: effectiveMentorBaseURL,
    mentorApiKey: effectiveMentorApiKey,
    mentorApiFormat: effectiveMentorApiFormat,
    mentorMaxTokens: effectiveMentorMaxTokens,
    maxMentorConsultations,
    mentorThinkingEnabled: effectiveMentorThinkingEnabled,
    mentorThinkingEffort: effectiveMentorThinkingEffort,
    mentorThinkingBudgetTokens: effectiveMentorThinkingBudgetTokens,
    explorePrompt:
      typeof input.explorePrompt === 'string' ? input.explorePrompt.trim() : '',
    scoutPrompt:
      typeof input.scoutPrompt === 'string' ? input.scoutPrompt.trim() : '',
    mentorPrompt:
      typeof input.mentorPrompt === 'string' ? input.mentorPrompt.trim() : '',
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
    browserEngine,
    folderAccessYolo,
    mcp,
  };
}

export function resolveProviderName(settings: { apiMode: ApiMode; apiFormat: ApiFormat }): ProviderName {
  if (settings.apiMode === 'deepseek') return 'deepseek';
  if (settings.apiMode === 'local') return 'openai';
  return settings.apiFormat;
}

export function resolveMultimodalEnabled(settings: Settings, currentModel: string): boolean {
  if (Array.isArray(settings.modelProfiles) && settings.modelProfiles.length > 0) {
    if (settings.primaryProfileId) {
      const primary = settings.modelProfiles.find((p) => p.id === settings.primaryProfileId);
      if (primary && primary.model === currentModel && typeof primary.multimodalEnabled === 'boolean') {
        return primary.multimodalEnabled;
      }
    }
    if (settings.fastProfileId) {
      const fast = settings.modelProfiles.find((p) => p.id === settings.fastProfileId);
      if (fast && fast.model === currentModel && typeof fast.multimodalEnabled === 'boolean') {
        return fast.multimodalEnabled;
      }
    }
    if (settings.mentorProfileId) {
      const mentor = settings.modelProfiles.find((p) => p.id === settings.mentorProfileId);
      if (mentor && mentor.model === currentModel && typeof mentor.multimodalEnabled === 'boolean') {
        return mentor.multimodalEnabled;
      }
    }
    const matched = settings.modelProfiles.find((p) => p.model === currentModel);
    if (matched && typeof matched.multimodalEnabled === 'boolean') {
      return matched.multimodalEnabled;
    }
  }
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
  if (settings.apiFormat === 'openai') {
    return lang === 'en' ? 'Custom OpenAI' : lang === 'zh-TW' ? '自定義 OpenAI' : '自定义 OpenAI 格式';
  }
  if (settings.apiFormat === 'response') {
    return lang === 'en' ? 'Custom Responses API' : lang === 'zh-TW' ? '自定義 Responses API' : '自定义 Responses API 格式';
  }
  return lang === 'en' ? 'Custom Claude' : lang === 'zh-TW' ? '自定義 Claude' : '自定义 Claude 格式';
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

export function findProfileById(
  settings: { modelProfiles?: ModelProfile[] },
  profileId: string
): ModelProfile | undefined {
  return settings.modelProfiles?.find((p) => p.id === profileId);
}

export function resolvePrimaryProfile(settings: Settings): ModelProfile {
  return (
    findProfileById(settings, settings.primaryProfileId) ||
    settings.modelProfiles?.[0] ||
    DEFAULT_SETTINGS.modelProfiles[0]
  );
}

export function resolveFastProfile(settings: Settings): ModelProfile {
  return (
    findProfileById(settings, settings.fastProfileId) ||
    resolvePrimaryProfile(settings)
  );
}

export function resolveMentorProfile(settings: Settings): ModelProfile {
  return (
    findProfileById(settings, settings.mentorProfileId) ||
    resolvePrimaryProfile(settings)
  );
}

