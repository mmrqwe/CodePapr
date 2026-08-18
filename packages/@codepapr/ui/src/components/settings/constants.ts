import type { ApiFormat, ApiMode, Settings } from '../../store/agentStore';
import type { SettingsTab } from './types';

export const MODEL_PRESETS: Record<ApiMode | ApiFormat, string[]> = {
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
  claude: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  custom: [],
  local: ['local-model', 'qwen2.5-coder', 'llama3.1'],
};

export const LOCAL_URL_PLACEHOLDER = 'http://127.0.0.1:8080/v1（llama.cpp / Ollama / LM Studio）';

export const CUSTOM_URL_PLACEHOLDERS: Record<ApiFormat, string> = {
  openai: 'https://api.openai.com/v1 或兼容服务 /v1',
  claude: 'https://api.anthropic.com/v1 或兼容 Claude Messages API',
};

/** 思考强度预设值（并集）：OpenAI 兼容生态（reasoning_effort）的常见取值。
 *  第三方端点（DeepSeek 中转 = high/max，Qwen = xhigh/medium/low 等）可能
 *  只接受子集，也允许自定义任意字符串（THINKING_EFFORT_CUSTOM）。 */
export const THINKING_EFFORT_PRESETS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/** 下拉里的「自定义」选项哨兵值：选中后展开手输框。 */
export const THINKING_EFFORT_CUSTOM = '__custom__';

/** Claude 思考预算默认值（token），与 @codepapr/api ClaudeProvider 的
 *  CLAUDE_THINKING_BUDGET_TOKENS 对齐。 */
export const DEFAULT_THINKING_BUDGET_TOKENS = 4096;

/// Keys reset by the "reset current tab" button. The llm tab resets only the
/// active mode's config (apiMode); the other modes' configs — and therefore
/// their API keys — are preserved. The flat fields (model/apiKey/baseURL/
/// fastModel/maxTokens) are re-derived from the active mode config by
/// `update()`, so they need not be listed here.
export function tabResetKeys(apiMode: ApiMode): Record<SettingsTab, (keyof Settings)[]> {
  return {
    general: ['lang', 'debugEnabled', 'chatBordersEnabled', 'experimentalCharacters', 'experimentalVoice'],
    appearance: ['lightTheme', 'darkTheme', 'followSystem', 'accent', 'customThemes'],
    llm: ['apiMode', 'apiFormat', 'fastModelEnabled', 'thinkingEnabled', 'thinkingEffort', 'thinkingBudgetTokens', 'temperature', 'topP', 'maxToolRounds', apiMode],
    search: ['searxngEnabled', 'searxngBaseUrl', 'searxngCategories', 'searxngTimeRange', 'searxngLanguage', 'searxngSafeSearch'],
    mentor: ['mentorEnabled', 'mentorApiFormat', 'mentorBaseURL', 'mentorApiKey', 'mentorModel', 'mentorMaxTokens', 'mentorThinkingEnabled', 'mentorThinkingEffort', 'mentorThinkingBudgetTokens', 'maxMentorConsultations', 'explorePrompt', 'scoutPrompt', 'mentorPrompt', 'exploreTemperature', 'exploreMaxToolRounds', 'exploreMaxTokens', 'exploreTopP', 'exploreMaxDepth', 'exploreThinkingEnabled', 'scoutTemperature', 'scoutMaxToolRounds', 'scoutMaxTokens', 'scoutTopP', 'scoutMaxDepth', 'scoutThinkingEnabled'],
    advanced: ['compactionModel', 'compactionMaxTokens', 'compactionTemperature', 'maxContextTokens', 'maxConversationRounds', 'chatRenderBatchRounds', 'toolContextDefaultMode', 'toolContextOverrides', 'toolContextSummaryMaxChars', 'toolContextAutoThresholdChars', 'todoMaxRetries', 'goalMaxIterations', 'goalMaxWallClockMs', 'goalRequireGitClean', 'verifierModelTier', 'verifierMaxTokens', 'verifierTemperature', 'projectGraphMaxDepth', 'projectGraphMaxFiles', 'projectGraphMaxEdges', 'projectGraphMaxSymbolsPerFile', 'projectGraphMaxFileBytes', 'projectGraphMaxTreeEntries', 'streamIdleTimeoutMs', 'toolOutputMiddleKeepChars', 'browserEngine', 'folderAccessYolo'],
    app: [],
  };
}
