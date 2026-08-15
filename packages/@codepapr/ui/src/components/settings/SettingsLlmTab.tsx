import { DEEPSEEK_MAX_TOKENS } from '@codepapr/api/tokenLimits';
import type { ApiFormat, ApiMode } from '../../store/agentStore';
import { InlineSelectRow, TextField, ToggleField } from '../forms';
import {
  CUSTOM_URL_PLACEHOLDERS,
  LOCAL_URL_PLACEHOLDER,
  MODEL_PRESETS,
  THINKING_EFFORT_CUSTOM,
  THINKING_EFFORT_PRESETS,
} from './constants';
import { ConnectionTestButton } from './ConnectionTestButton';
import { runConnectionTest } from './testConnection';
import { buildProviderInstance } from '../../store/internals/providerFactory';
import { resolveProviderName } from '../../store/internals/settingsNormalizer';
import type { SettingsTabProps } from './types';

function modeButtonClass(active: boolean): string {
  return `rounded-xl border px-4 py-3 text-left transition-colors ${
    active
      ? 'border-accent-soft bg-accent-soft text-accent-text shadow-[0_0_12px_rgba(99,102,241,0.1)]'
      : 'border-line bg-base text-fg-muted hover:border-line-strong hover:text-fg'
  }`;
}

export function SettingsLlmTab({ local, update, t, currentLang }: SettingsTabProps) {
  const setApiMode = (apiMode: ApiMode) => {
    update({ apiMode });
  };

  const setApiFormat = (apiFormat: ApiFormat) => {
    update({
      apiFormat,
      custom: { ...local.custom, model: MODEL_PRESETS[apiFormat][0] ?? local.custom.model },
    });
  };

  const activeModeConfig = local[local.apiMode];
  const modelPresets =
    local.apiMode === 'deepseek'
      ? MODEL_PRESETS.deepseek
      : local.apiMode === 'local'
      ? MODEL_PRESETS.local
      : MODEL_PRESETS[local.apiFormat];
  const maxTokensLimit = local.apiMode === 'deepseek' ? DEEPSEEK_MAX_TOKENS : 32000;
  const isLocal = local.apiMode === 'local';
  const isClaudeFormat = local.apiMode === 'custom' && local.apiFormat === 'claude';
  const localLabel = currentLang === 'en' ? 'Local Model' : '本地模型';
  const localDesc =
    currentLang === 'en'
      ? 'OpenAI-compatible local server (llama.cpp / Ollama / LM Studio)'
      : '本地 OpenAI 兼容服务（llama.cpp / Ollama / LM Studio）';

  const effortIsCustom = !(THINKING_EFFORT_PRESETS as readonly string[]).includes(
    local.thinkingEffort,
  );
  const effortSelectValue = effortIsCustom ? THINKING_EFFORT_CUSTOM : local.thinkingEffort;

  const validateModelForTest = (modelName: string) => {
    if (!modelName.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the model name first'
          : currentLang === 'zh-TW'
          ? '請先填寫模型名稱'
          : '请先填写模型名称',
      );
    }
    if (local.apiMode === 'custom' && !activeModeConfig.baseURL.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the API address first'
          : currentLang === 'zh-TW'
          ? '請先填寫 API 地址'
          : '请先填写 API 地址',
      );
    }
    if (local.apiMode !== 'local' && !activeModeConfig.apiKey.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the API Key first'
          : currentLang === 'zh-TW'
          ? '請先填寫 API Key'
          : '请先填写 API Key',
      );
    }
  };

  const runModelTest = async (modelName: string) => {
    validateModelForTest(modelName);
    const provider = buildProviderInstance(local);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      await runConnectionTest(provider, {
        model: modelName.trim(),
        providerName: resolveProviderName(local),
        thinkingEnabled: local.thinkingEnabled,
        reasoningEffort: local.thinkingEffort,
        thinkingBudgetTokens: local.thinkingBudgetTokens,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const testLabels = (idle: string) => ({
    idle,
    connecting: t.llmTestConnecting,
    success: t.llmTestSuccess,
    failedPrefix: t.llmTestFailed,
  });

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-base px-5 py-4 text-sm leading-relaxed text-fg-muted">
        {t.settingsLlmDesc}
      </div>

      <div>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.apiType}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setApiMode('deepseek')}
            title={t.deepseekOfficialDesc}
            className={modeButtonClass(local.apiMode === 'deepseek')}
          >
            <div className="text-sm font-semibold">{t.deepseekOfficial}</div>
            <div className="mt-1 text-xs opacity-70">{t.deepseekOfficialDesc}</div>
          </button>
          <button
            type="button"
            onClick={() => setApiMode('custom')}
            title={t.customApiDesc}
            className={modeButtonClass(local.apiMode === 'custom')}
          >
            <div className="text-sm font-semibold">{t.customApi}</div>
            <div className="mt-1 text-xs opacity-70">{t.customApiDesc}</div>
          </button>
          <button
            type="button"
            onClick={() => setApiMode('local')}
            title={localDesc}
            className={modeButtonClass(local.apiMode === 'local')}
          >
            <div className="text-sm font-semibold">{localLabel}</div>
            <div className="mt-1 text-xs opacity-70">{localDesc}</div>
          </button>
        </div>
      </div>

      {isLocal && (
        <TextField
          label={t.apiUrl}
          value={activeModeConfig.baseURL}
          onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, baseURL: e.target.value } })}
          title={t.apiUrl}
          placeholder={LOCAL_URL_PLACEHOLDER}
        />
      )}

      {local.apiMode === 'custom' && (
        <div className="grid gap-5 xl:grid-cols-2">
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
              {t.apiFormat}
            </label>
            <select
              value={local.apiFormat}
              onChange={(e) => setApiFormat(e.target.value as ApiFormat)}
              title={t.apiFormat}
              className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
            >
              <option value="openai">OpenAI Chat Completions</option>
              <option value="claude">Claude Messages</option>
            </select>
          </div>

          <TextField
            label={t.apiUrl}
            value={activeModeConfig.baseURL}
            onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, baseURL: e.target.value } })}
            title={t.apiUrl}
            placeholder={CUSTOM_URL_PLACEHOLDERS[local.apiFormat]}
          />
        </div>
      )}

      {local.apiMode === 'deepseek' && (
        <div className="rounded-2xl border border-ok-bg bg-ok-bg px-5 py-4 text-sm text-ok">
          {t.deepseekNotice}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <TextField
          label={t.modelName}
          value={activeModeConfig.model}
          list="model-presets"
          onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, model: e.target.value } })}
          title={t.modelName}
          placeholder={currentLang === 'en' ? 'Enter model name...' : '输入模型名称...'}
        >
          <datalist id="model-presets">
            {modelPresets.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </TextField>

        <TextField
          label={t.fastModelName}
          labelTitle={t.fastModelHint}
          value={activeModeConfig.fastModel}
          onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, fastModel: e.target.value } })}
          placeholder={local.apiMode === 'deepseek' ? 'deepseek-v4-flash' : t.fastModelPlaceholder}
          disabled={!local.fastModelEnabled}
          className="disabled:opacity-50"
        />
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <ConnectionTestButton
          labels={testLabels(t.llmTestPrimary)}
          onTest={() => runModelTest(activeModeConfig.model)}
        />
        {local.fastModelEnabled && (
          <ConnectionTestButton
            labels={testLabels(t.llmTestFast)}
            onTest={() => runModelTest(activeModeConfig.fastModel)}
          />
        )}
      </div>

      <ToggleField
        checked={local.fastModelEnabled}
        onChange={(checked) => update({ fastModelEnabled: checked })}
        label={t.fastModel}
        desc={t.fastModelDesc}
        extra={t.fastModelHint}
        title={t.fastModelDesc}
      />

      {!isLocal && (
        <>
          <ToggleField
            checked={local.thinkingEnabled}
            onChange={(checked) => update({ thinkingEnabled: checked })}
            label={t.thinkingMode}
            desc={local.apiMode === 'deepseek' ? t.thinkingModeDesc : t.thinkingModeCustomDesc}
            title={local.apiMode === 'deepseek' ? t.thinkingModeDesc : t.thinkingModeCustomDesc}
          />

          {local.thinkingEnabled && isClaudeFormat && (
            <TextField
              label={t.thinkingBudgetLabel}
              hint={t.thinkingBudgetHint}
              type="number"
              min={1024}
              max={maxTokensLimit}
              step={512}
              value={local.thinkingBudgetTokens}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                update({
                  thinkingBudgetTokens: Number.isFinite(parsed)
                    ? parsed
                    : local.thinkingBudgetTokens,
                });
              }}
              title={t.thinkingBudgetLabel}
            />
          )}

          {local.thinkingEnabled && !isClaudeFormat && (
            <>
              <InlineSelectRow
                title={t.thinkingEffort}
                desc={t.thinkingEffortDesc}
                value={effortSelectValue}
                onChange={(value) => {
                  update({
                    thinkingEffort: value === THINKING_EFFORT_CUSTOM ? '' : value,
                  });
                }}
              >
                {THINKING_EFFORT_PRESETS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
                <option value={THINKING_EFFORT_CUSTOM}>{t.thinkingEffortCustom}</option>
              </InlineSelectRow>

              {effortSelectValue === THINKING_EFFORT_CUSTOM && (
                <TextField
                  label={t.thinkingEffortCustomLabel}
                  value={effortIsCustom ? local.thinkingEffort : ''}
                  onChange={(e) => update({ thinkingEffort: e.target.value.trim() })}
                  title={t.thinkingEffortCustomLabel}
                  placeholder={t.thinkingEffortCustomPlaceholder}
                />
              )}
            </>
          )}
        </>
      )}

      <ToggleField
        checked={local.multimodalEnabled}
        onChange={(checked) => update({ multimodalEnabled: checked })}
        label={t.multimodalLabel}
        desc={t.multimodalDesc}
        title={t.multimodalDesc}
      />

      {local.multimodalEnabled && (
        <InlineSelectRow
          title={t.multimodalModelTierLabel}
          desc={t.multimodalModelTierDesc}
          value={local.multimodalModelTier}
          onChange={(value) => update({ multimodalModelTier: value as 'primary' | 'fast' | 'all' })}
        >
          <option value="primary">{t.primaryModelTag}</option>
          <option value="fast">{t.fastModelTag}</option>
          <option value="all">{currentLang === 'en' ? 'All' : '全部'}</option>
        </InlineSelectRow>
      )}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr]">
        <TextField
          label={
            <>
              {t.apiKey}
              {isLocal ? (currentLang === 'en' ? ' (optional)' : '（可选）') : ''}
            </>
          }
          type="password"
          value={activeModeConfig.apiKey}
          onChange={(e) => update({ [local.apiMode]: { ...activeModeConfig, apiKey: e.target.value } })}
          title={t.apiKey}
          placeholder={
            isLocal
              ? currentLang === 'en'
                ? 'usually not required'
                : '本地服务通常无需填写'
              : local.apiMode === 'custom' && local.apiFormat === 'claude'
              ? 'sk-ant-...'
              : 'sk-...'
          }
        />

        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
            {t.temperature}: <span className="font-mono text-accent-text">{local.temperature}</span>
          </label>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={local.temperature}
            onChange={(e) => update({ temperature: parseFloat(e.target.value) })}
            title={t.temperature}
            className="mt-3 w-full cursor-pointer accent-accent"
          />
        </div>

        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
            {t.topPLabel}: <span className="font-mono text-accent-text">{local.topP}</span>
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={local.topP}
            onChange={(e) => update({ topP: parseFloat(e.target.value) })}
            title={t.topPHint}
            className="mt-3 w-full cursor-pointer accent-accent"
          />
          <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">{t.topPHint}</p>
        </div>

        <TextField
          label={t.maxTokens}
          type="number"
          min="100"
          max={maxTokensLimit}
          step="500"
          value={activeModeConfig.maxTokens}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10);
            update({ [local.apiMode]: { ...activeModeConfig, maxTokens: Number.isFinite(parsed) ? parsed : activeModeConfig.maxTokens } });
          }}
          title={t.maxTokens}
        />

        <TextField
          label={t.maxToolRounds}
          hint={t.maxToolRoundsHint}
          type="number"
          min="1"
          max="5000"
          step="50"
          value={local.maxToolRounds}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10);
            update({
              maxToolRounds: Number.isFinite(parsed) ? parsed : local.maxToolRounds,
            });
          }}
          title={t.maxToolRounds}
        />
      </div>
    </div>
  );
}
