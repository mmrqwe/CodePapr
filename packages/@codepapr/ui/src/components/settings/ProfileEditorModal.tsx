import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from '@codepapr/api';
import type { ApiFormat, Lang, ModelProfile } from '../../store/agentStore';
import type { Translation } from './types';
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
import {
  filterModelCatalog,
  formatListModelsError,
  listModelsForProfile,
  profileModelsCacheKey,
} from './listProfileModels';
import { buildProviderForProfile } from '../../store/internals/providerFactory';
import { resolveProviderName, resolveThinkingPayload } from '../../store/internals/settingsNormalizer';

export interface ProfileEditorModalProps {
  profile: ModelProfile;
  isOpen: boolean;
  onSave: (updated: ModelProfile) => void;
  onClose: () => void;
  t: Translation;
  currentLang: Lang;
}

interface QuickTemplate {
  label: string;
  apply: (prev: ModelProfile) => Partial<ModelProfile>;
}

export function ProfileEditorModal({
  profile,
  isOpen,
  onSave,
  onClose,
  t,
  currentLang,
}: ProfileEditorModalProps) {
  const [draft, setDraft] = useState<ModelProfile>({ ...profile });
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'fetching'>('idle');
  const [fetchError, setFetchError] = useState('');
  const catalogCacheRef = useRef<Map<string, string[]>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  // Reset draft when modal opens for a different profile
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    catalogCacheRef.current = new Map();
    setDraft({ ...profile });
    setFetchedModels(null);
    setModelFilter('');
    setFetchStatus('idle');
    setFetchError('');
  }, [profile, isOpen]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setFetchStatus('idle');
    setFetchError('');
    setModelFilter('');
    const cached = catalogCacheRef.current.get(profileModelsCacheKey(draft));
    setFetchedModels(cached ?? null);
  }, [draft.apiMode, draft.apiFormat, draft.baseURL, draft.apiKey]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  if (!isOpen) return null;

  const update = (patch: Partial<ModelProfile>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const isLocal = draft.apiMode === 'local';
  const isClaudeFormat = draft.apiMode === 'custom' && draft.apiFormat === 'claude';

  const modelPresets =
    draft.apiMode === 'deepseek'
      ? MODEL_PRESETS.deepseek
      : draft.apiMode === 'local'
      ? MODEL_PRESETS.local
      : MODEL_PRESETS[draft.apiFormat] || [];

  const effortIsCustom =
    draft.thinkingEffort &&
    !(THINKING_EFFORT_PRESETS as readonly string[]).includes(draft.thinkingEffort);
  const effortSelectValue = effortIsCustom
    ? THINKING_EFFORT_CUSTOM
    : draft.thinkingEffort || 'max';

  const quickTemplates: QuickTemplate[] = [
    {
      label: currentLang === 'en' ? 'DeepSeek Official (Pro)' : 'DeepSeek 官方 (Pro)',
      apply: (prev) => ({
        name: prev.name || 'DeepSeek 官方',
        apiMode: 'deepseek',
        apiFormat: 'openai',
        baseURL: '',
        model: 'deepseek-v4-pro',
        maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        temperature: 0.7,
        topP: 0.9,
        multimodalEnabled: false,
        thinkingEnabled: true,
        thinkingEffort: 'max',
        thinkingPayload: 'thinking',
      }),
    },
    {
      label: currentLang === 'en' ? 'DeepSeek Flash (Fast)' : 'DeepSeek Flash (快速)',
      apply: (prev) => ({
        name: prev.name || 'DeepSeek Flash',
        apiMode: 'deepseek',
        apiFormat: 'openai',
        baseURL: '',
        model: 'deepseek-v4-flash',
        maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        temperature: 0.7,
        topP: 0.9,
        multimodalEnabled: false,
        thinkingEnabled: false,
        thinkingEffort: '',
        thinkingPayload: 'thinking',
      }),
    },
    {
      label: 'OpenRouter (Claude 3.7)',
      apply: (prev) => ({
        name: prev.name || 'OpenRouter Claude',
        apiMode: 'custom',
        apiFormat: 'claude',
        baseURL: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-3.7-sonnet',
        maxTokens: DEFAULT_MAX_TOKENS,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        temperature: 0.7,
        topP: 0.9,
        multimodalEnabled: true,
        thinkingEnabled: true,
        thinkingBudgetTokens: 4096,
      }),
    },
    {
      label: 'SiliconFlow (DeepSeek V3)',
      apply: (prev) => ({
        name: prev.name || 'SiliconFlow V3',
        apiMode: 'custom',
        apiFormat: 'openai',
        baseURL: 'https://api.siliconflow.cn/v1',
        model: 'deepseek-ai/DeepSeek-V3',
        maxTokens: DEFAULT_MAX_TOKENS,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        temperature: 0.7,
        topP: 0.9,
        multimodalEnabled: false,
        thinkingEnabled: false,
        thinkingPayload: 'reasoning',
      }),
    },
    {
      label: 'OpenAI (GPT-4o)',
      apply: (prev) => ({
        name: prev.name || 'OpenAI GPT-4o',
        apiMode: 'custom',
        apiFormat: 'openai',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: DEFAULT_MAX_TOKENS,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        temperature: 0.7,
        topP: 0.9,
        multimodalEnabled: true,
        thinkingEnabled: false,
        thinkingPayload: 'reasoning',
      }),
    },
    {
      label: currentLang === 'en' ? 'Volcengine / OpenAI (Responses API)' : '火山方舟 / OpenAI (Responses API)',
      apply: (prev) => ({
        name: prev.name || 'Responses API',
        apiMode: 'custom',
        apiFormat: 'response',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-1.5-pro-32k',
        maxTokens: DEFAULT_MAX_TOKENS,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        temperature: 0.7,
        topP: 0.9,
        multimodalEnabled: false,
        thinkingEnabled: false,
        thinkingPayload: 'both',
      }),
    },
    {
      label: currentLang === 'en' ? 'Local Model (Ollama / LM Studio)' : '本地模型 (Ollama / LM Studio)',
      apply: (prev) => ({
        name: prev.name || '本地 Ollama',
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
        thinkingPayload: 'reasoning',
      }),
    },
  ];

  const handleApplyTemplate = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const idx = parseInt(e.target.value, 10);
    if (!Number.isNaN(idx) && quickTemplates[idx]) {
      const patch = quickTemplates[idx].apply(draft);
      update(patch);
    }
  };

  const handleTestConnection = async () => {
    if (!draft.model.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the model name first'
          : currentLang === 'zh-TW'
          ? '請先填寫模型名稱'
          : '请先填写模型名称'
      );
    }
    if (draft.apiMode === 'custom' && !draft.baseURL.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the API address first'
          : currentLang === 'zh-TW'
          ? '請先填寫 API 地址'
          : '请先填写 API 地址'
      );
    }
    if (draft.apiMode !== 'local' && !draft.apiKey.trim()) {
      throw new Error(
        currentLang === 'en'
          ? 'Please fill in the API Key first'
          : currentLang === 'zh-TW'
          ? '請先填寫 API Key'
          : '请先填写 API Key'
      );
    }

    const provider = buildProviderForProfile(draft);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      await runConnectionTest(provider, {
        model: draft.model.trim(),
        providerName: resolveProviderName(draft),
        thinkingEnabled: draft.thinkingEnabled ?? false,
        reasoningEffort: draft.thinkingEffort ?? '',
        thinkingBudgetTokens: draft.thinkingBudgetTokens ?? 4096,
        thinkingPayload: resolveThinkingPayload(draft.thinkingPayload, draft.apiMode),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleFetchModels = async () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setFetchStatus('idle');
      return;
    }

    const cacheKey = profileModelsCacheKey(draft);
    const cached = catalogCacheRef.current.get(cacheKey);
    if (cached) {
      setFetchedModels(cached);
      setFetchError('');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setFetchStatus('fetching');
    setFetchError('');
    try {
      const ids = await listModelsForProfile(draft, { signal: controller.signal });
      if (abortRef.current !== controller) {
        return;
      }
      catalogCacheRef.current.set(cacheKey, ids);
      setFetchedModels(ids);
    } catch (err) {
      if (abortRef.current !== controller) {
        return;
      }
      setFetchedModels(null);
      setFetchError(formatListModelsError(err, t));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setFetchStatus('idle');
      }
    }
  };

  const catalogOptions = fetchedModels ? filterModelCatalog(fetchedModels, modelFilter) : [];
  const modelInCatalog = Boolean(fetchedModels?.includes(draft.model.trim()));
  const datalistModels = fetchedModels ?? modelPresets;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm p-4 overflow-y-auto"
    >
      <div className="relative w-full max-w-2xl rounded-2xl border border-line bg-base shadow-2xl p-6 space-y-5 my-8 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-line pb-4">
          <div>
            <h3 className="text-base font-bold text-fg">
              {draft.id.startsWith('profile-') && !draft.name
                ? t.newProfileModalTitle
                : t.editProfileModalTitle}
            </h3>
            <p className="text-xs text-fg-muted mt-0.5">
              {draft.name || t.unnamedProfile}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-fg-muted hover:bg-raised hover:text-fg transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Quick template selector */}
        <div className="rounded-xl border border-line bg-raised/50 p-3">
          <label className="block text-xs font-semibold text-fg-muted uppercase tracking-[0.15em] mb-1.5">
            {t.profilePresetTemplate}
          </label>
          <select
            defaultValue=""
            onChange={handleApplyTemplate}
            className="w-full cursor-pointer rounded-lg border border-line bg-base px-3 py-2 text-xs text-fg focus:border-accent-soft focus:outline-none"
          >
            <option value="" disabled>
              {currentLang === 'en' ? 'Select a quick template to autofill...' : '选择快速模板以自动填入...'}
            </option>
            {quickTemplates.map((tpl, i) => (
              <option key={tpl.label} value={i}>
                {tpl.label}
              </option>
            ))}
          </select>
        </div>

        {/* Profile Name */}
        <TextField
          label={t.profileName}
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder={t.profileNamePlaceholder}
        />

        {/* API Type selection */}
        <div>
          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
            {t.apiType}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(['deepseek', 'custom', 'local'] as const).map((mode) => {
              const active = draft.apiMode === mode;
              const label =
                mode === 'deepseek'
                  ? t.deepseekOfficial
                  : mode === 'custom'
                  ? t.customApi
                  : currentLang === 'en'
                  ? 'Local Model'
                  : '本地模型';
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => update({ apiMode: mode })}
                  className={`rounded-xl border px-3 py-2.5 text-left text-xs font-semibold transition-colors ${
                    active
                      ? 'border-accent-soft bg-accent-soft text-accent-text shadow-[0_0_10px_rgba(99,102,241,0.1)]'
                      : 'border-line bg-base text-fg-muted hover:border-line-strong hover:text-fg'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom API Format */}
        {draft.apiMode === 'custom' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
                {t.apiFormat}
              </label>
              <select
                value={draft.apiFormat}
                onChange={(e) => update({ apiFormat: e.target.value as ApiFormat })}
                className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-2.5 text-sm text-fg focus:border-accent-soft focus:outline-none"
              >
                <option value="openai">OpenAI Chat Completions (/chat/completions)</option>
                <option value="response">Responses API (/responses)</option>
                <option value="claude">Claude Messages (/messages)</option>
              </select>
            </div>

            <TextField
              label={t.apiUrl}
              value={draft.baseURL}
              onChange={(e) => update({ baseURL: e.target.value })}
              placeholder={CUSTOM_URL_PLACEHOLDERS[draft.apiFormat]}
            />
          </div>
        )}

        {/* Local BaseURL */}
        {isLocal && (
          <TextField
            label={t.apiUrl}
            value={draft.baseURL}
            onChange={(e) => update({ baseURL: e.target.value })}
            placeholder={LOCAL_URL_PLACEHOLDER}
          />
        )}

        <TextField
          label={
            <>
              {t.apiKey}
              {isLocal ? (currentLang === 'en' ? ' (optional)' : '（可选）') : ''}
            </>
          }
          type="password"
          value={draft.apiKey}
          onChange={(e) => update({ apiKey: e.target.value })}
          placeholder={
            isLocal
              ? currentLang === 'en'
                ? 'usually not required'
                : '本地服务通常无需填写'
              : draft.apiMode === 'custom' && draft.apiFormat === 'claude'
              ? 'sk-ant-...'
              : 'sk-...'
          }
        />

        <div>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label={t.modelName}
                value={draft.model}
                list="profile-model-presets"
                onChange={(e) => update({ model: e.target.value })}
                placeholder={currentLang === 'en' ? 'Enter model name...' : '输入模型名称...'}
              >
                <datalist id="profile-model-presets">
                  {datalistModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </TextField>
            </div>
            <button
              type="button"
              onClick={() => void handleFetchModels()}
              title={fetchStatus === 'fetching' ? t.cancel : t.fetchModels}
              className="mb-0 shrink-0 rounded-xl border border-accent-soft px-4 py-[0.7rem] text-xs font-medium text-accent-text transition-colors hover:border-accent hover:bg-accent-soft"
            >
              {fetchStatus === 'fetching' ? (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  {t.fetchingModels}
                </span>
              ) : (
                t.fetchModels
              )}
            </button>
          </div>
          {fetchError && (
            <div className="mt-2 rounded-lg border border-danger-bg bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
              {fetchError}
            </div>
          )}
          {fetchedModels && fetchedModels.length > 0 && (
            <div className="mt-2 space-y-2">
              <p className="text-[10px] leading-relaxed text-fg-dim">
                {t.fetchModelsSuccess.replace('{count}', String(fetchedModels.length))}
                {!modelInCatalog && draft.model.trim() ? ` ${t.customModelNotInList}` : ''}
              </p>
              {fetchedModels.length > 12 && (
                <input
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder={t.filterModels}
                  className="w-full rounded-xl border border-line bg-base px-4 py-2 text-xs text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
                />
              )}
              <select
                value={modelInCatalog ? draft.model.trim() : ''}
                onChange={(e) => {
                  if (e.target.value) {
                    update({ model: e.target.value });
                  }
                }}
                className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-2.5 text-sm text-fg focus:border-accent-soft focus:outline-none"
              >
                <option value="" disabled>
                  {t.selectFromModelList}
                </option>
                {catalogOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Thinking Settings */}
        <div className="rounded-xl border border-line bg-base p-4 space-y-4">
          <ToggleField
            checked={draft.thinkingEnabled ?? false}
            onChange={(checked) => update({ thinkingEnabled: checked })}
            label={t.thinkingMode}
            desc={
              draft.apiMode === 'deepseek'
                ? t.thinkingModeDesc
                : isLocal
                ? (currentLang === 'en' ? 'Enable reasoning / thinking mode for local models (e.g. DeepSeek-R1 / QwQ).' : '为支持思考的本地模型（如 DeepSeek-R1、QwQ 等）开启深度思考。')
                : t.thinkingModeCustomDesc
            }
          />

          {draft.thinkingEnabled && isClaudeFormat && (
            <TextField
              label={t.thinkingBudgetLabel}
              type="number"
              min={1024}
              max={2000000}
              step={512}
              value={draft.thinkingBudgetTokens ?? 4096}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                update({
                  thinkingBudgetTokens: Number.isFinite(parsed) ? parsed : 4096,
                });
              }}
            />
          )}

          {draft.thinkingEnabled && !isClaudeFormat && (
            <>
              <InlineSelectRow
                title={t.thinkingEffort}
                value={effortSelectValue}
                onChange={(val) => {
                  update({
                    thinkingEffort: val === THINKING_EFFORT_CUSTOM ? '' : val,
                  });
                }}
              >
                {THINKING_EFFORT_PRESETS.map((val) => (
                  <option key={val} value={val}>
                    {val}
                  </option>
                ))}
                <option value={THINKING_EFFORT_CUSTOM}>{t.thinkingEffortCustom}</option>
              </InlineSelectRow>

              {effortSelectValue === THINKING_EFFORT_CUSTOM && (
                <TextField
                  label={t.thinkingEffortCustomLabel}
                  value={effortIsCustom ? draft.thinkingEffort : ''}
                  onChange={(e) => update({ thinkingEffort: e.target.value.trim() })}
                  placeholder={t.thinkingEffortCustomPlaceholder}
                />
              )}

              <InlineSelectRow
                title={t.thinkingPayload}
                desc={t.thinkingPayloadDesc}
                value={resolveThinkingPayload(draft.thinkingPayload, draft.apiMode)}
                onChange={(val) => {
                  if (val === 'reasoning' || val === 'thinking' || val === 'both') {
                    update({ thinkingPayload: val });
                  }
                }}
              >
                <option value="reasoning">{t.thinkingPayloadReasoning}</option>
                <option value="thinking">{t.thinkingPayloadThinking}</option>
                <option value="both">{t.thinkingPayloadBoth}</option>
              </InlineSelectRow>
              <p className="text-xs text-fg-muted">{t.thinkingPayloadHint}</p>
            </>
          )}
        </div>

        {/* Multimodal Vision */}
        <div className="rounded-xl border border-line bg-base p-4">
          <ToggleField
            checked={draft.multimodalEnabled ?? false}
            onChange={(checked) => update({ multimodalEnabled: checked })}
            label={t.multimodalLabel}
            desc={
              currentLang === 'en'
                ? 'Allow this model to receive and analyze image inputs. (Model must support vision capabilities)'
                : '允许此模型接收并解析图片与视觉输入（需模型本身支持多模态）'
            }
          />
        </div>

        {/* Context & Sampling Parameters */}
        <div className="rounded-xl border border-line bg-base p-4 space-y-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            {currentLang === 'en' ? 'Context & Sampling Parameters' : '上下文与采样参数'}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t.maxContextTokens}
              type="number"
              min={1000}
              max={2000000}
              step={10000}
              value={draft.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  update({ maxContextTokens: '' as unknown as number });
                  return;
                }
                const parsed = parseInt(raw, 10);
                update({
                  maxContextTokens: Number.isFinite(parsed)
                    ? parsed
                    : DEFAULT_MAX_CONTEXT_TOKENS,
                });
              }}
              onBlur={() => {
                if (
                  typeof draft.maxContextTokens !== 'number' ||
                  !Number.isFinite(draft.maxContextTokens) ||
                  draft.maxContextTokens <= 0
                ) {
                  update({ maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS });
                }
              }}
              placeholder={String(DEFAULT_MAX_CONTEXT_TOKENS)}
            />

            <TextField
              label={t.maxTokens}
              type="number"
              min={100}
              max={2000000}
              step={500}
              value={draft.maxTokens ?? (draft.apiMode === 'deepseek' ? DEEPSEEK_DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS)}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  update({ maxTokens: '' as unknown as number });
                  return;
                }
                const parsed = parseInt(raw, 10);
                update({
                  maxTokens: Number.isFinite(parsed)
                    ? parsed
                    : (draft.apiMode === 'deepseek' ? DEEPSEEK_DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS),
                });
              }}
              onBlur={() => {
                if (
                  typeof draft.maxTokens !== 'number' ||
                  !Number.isFinite(draft.maxTokens) ||
                  draft.maxTokens <= 0
                ) {
                  update({
                    maxTokens: draft.apiMode === 'deepseek' ? DEEPSEEK_DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS,
                  });
                }
              }}
              placeholder={String(draft.apiMode === 'deepseek' ? DEEPSEEK_DEFAULT_MAX_TOKENS : DEFAULT_MAX_TOKENS)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-fg-muted">
                {t.temperature}: <span className="font-mono text-accent-text">{draft.temperature ?? 0.7}</span>
              </label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={draft.temperature ?? 0.7}
                onChange={(e) => update({ temperature: parseFloat(e.target.value) })}
                className="w-full cursor-pointer accent-accent"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-fg-muted">
                {t.topPLabel}: <span className="font-mono text-accent-text">{draft.topP ?? 0.9}</span>
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.topP ?? 0.9}
                onChange={(e) => update({ topP: parseFloat(e.target.value) })}
                className="w-full cursor-pointer accent-accent"
              />
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between border-t border-line pt-4">
          <ConnectionTestButton
            labels={{
              idle: t.testProfileConnection,
              connecting: t.llmTestConnecting,
              success: t.llmTestSuccess,
              failedPrefix: t.llmTestFailed,
            }}
            onTest={handleTestConnection}
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-line px-4 py-2 text-xs text-fg-muted hover:border-line-strong hover:text-fg transition-colors"
            >
              {t.cancel}
            </button>
            <button
              type="button"
              onClick={() => onSave(draft)}
              className="rounded-xl bg-accent px-5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition-opacity"
            >
              {t.saveProfile}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
