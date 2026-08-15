import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { validateCustomTheme } from '../../theme/themeEngine';
import { BUILTIN_THEMES } from '../../theme/themes';
import type { CustomThemeRecord, ThemeMode } from '../../theme/types';
import { toast } from '../../store/toastStore';
import { FieldCard, FieldLabel } from '../forms';
import type { SettingsTabProps } from './types';

const ACCENT_PRESETS = [
  '#6366F1',
  '#d9673e',
  '#4f8cff',
  '#88c0d0',
  '#268bd2',
  '#0ea5e9',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#d946ef',
  '#f472b6',
  '#14b8a6',
];

function jsonPlaceholder(lang: string): string {
  const sample = {
    'bg-deep': '#002b36',
    'bg-base': '#002b36',
    'bg-raised': '#073642',
    'foreground': '#93a1a1',
  };
  const note =
    lang === 'en'
      ? 'full example: paste a token map with all core tokens'
      : lang === 'zh-TW'
        ? '完整範例：貼上包含全部核心 token 的映射'
        : '完整示例：粘贴包含全部核心 token 的映射';
  return `${note} — ${JSON.stringify(sample, null, 2)}`;
}

function parseImportedJson(raw: string, lang: string): { ok: true; tokens: Record<string, string> } | { ok: false; error: string } {
  const invalid = lang === 'en' ? 'Invalid JSON' : lang === 'zh-TW' ? 'JSON 無效' : 'JSON 无效';
  const notObject =
    lang === 'en'
      ? 'Expected a flat token map object'
      : lang === 'zh-TW'
        ? '需要扁平的 token 映射對象'
        : '需要扁平的 token 映射对象';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: notObject };
    }
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        return {
          ok: false,
          error: `${key}: ${lang === 'en' ? 'value must be a string' : lang === 'zh-TW' ? '值必須是字符串' : '值必须是字符串'}`,
        };
      }
      tokens[key] = value;
    }
    return { ok: true, tokens };
  } catch {
    return { ok: false, error: invalid };
  }
}

export function SettingsAppearanceTab({ local, update, t, currentLang }: SettingsTabProps) {
  const [importName, setImportName] = useState('');
  const [importMode, setImportMode] = useState<ThemeMode>('dark');
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState('');
  const [importSuccess, setImportSuccess] = useState('');

  const selectAccent = (accent: string | null) => {
    update({ accent });
  };

  const importCustomTheme = () => {
    setImportError('');
    setImportSuccess('');
    // 支持两种格式：扁平 token 映射；或导出产生的完整包 {name, mode, tokens}。
    let tokensJson = importJson;
    let envelopeName: string | null = null;
    let envelopeMode: ThemeMode | null = null;
    try {
      const raw = JSON.parse(importJson) as Record<string, unknown>;
      if (
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        raw.tokens &&
        typeof raw.tokens === 'object' &&
        !Array.isArray(raw.tokens)
      ) {
        envelopeName = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
        envelopeMode = raw.mode === 'light' || raw.mode === 'dark' ? raw.mode : null;
        tokensJson = JSON.stringify(raw.tokens);
      }
    } catch {
      // 非法 JSON 交给 parseImportedJson 统一报错
    }
    const name = envelopeName ?? importName.trim();
    const mode = envelopeMode ?? importMode;
    const missingName =
      currentLang === 'en'
        ? 'Name is required'
        : currentLang === 'zh-TW'
          ? '需要名稱'
          : '需要名称';
    if (!name) {
      setImportError(missingName);
      return;
    }
    const parsed = parseImportedJson(tokensJson, currentLang);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    const id = `custom-${Math.random().toString(36).slice(2, 8)}`;
    const record: CustomThemeRecord = { name, mode, tokens: parsed.tokens };
    const validation = validateCustomTheme(id, record);
    if (!validation.ok) {
      setImportError(
        `${t.themeCustomImportInvalid}${
          validation.missingTokens
            ? `missing tokens: ${validation.missingTokens.join(', ')}`
            : validation.error ?? ''
        }`,
      );
      return;
    }
    // 导入即接入对应深浅槽位，主题在 设置 → 通用 中随时可换。
    update({
      customThemes: { ...local.customThemes, [id]: record },
      ...(mode === 'light' ? { lightTheme: id } : { darkTheme: id }),
    });
    setImportName('');
    setImportJson('');
    setImportSuccess(t.themeCustomImportSuccess);
  };

  const exportThemeRecord = async (record: CustomThemeRecord) => {
    try {
      const safeName = record.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '-') || 'theme';
      const filePath = await save({
        title: t.themeCustomExport,
        defaultPath: `${safeName}.codepapr-theme.json`,
        filters: [{ name: 'CodePapr Theme', extensions: ['json'] }],
      });
      if (!filePath) return;
      const payload: CustomThemeRecord = {
        name: record.name,
        mode: record.mode,
        tokens: record.tokens,
      };
      await invoke('export_text_file', {
        savePath: filePath,
        content: JSON.stringify(payload, null, 2),
      });
      toast.success(t.themeCustomExportSuccess);
    } catch (e) {
      toast.error(`${t.themeCustomExportError}: ${e}`);
    }
  };

  const exportCustomTheme = async (id: string) => {
    const record = local.customThemes[id];
    if (!record) return;
    await exportThemeRecord(record);
  };

  const deleteCustomTheme = (id: string) => {
    const next = { ...local.customThemes };
    delete next[id];
    update({
      customThemes: next,
      ...(local.lightTheme === id ? { lightTheme: 'paper-light' } : {}),
      ...(local.darkTheme === id ? { darkTheme: 'paper-dark' } : {}),
    });
  };

  const customIds = Object.keys(local.customThemes);

  return (
    <div className="space-y-5">
      <FieldCard>
        <FieldLabel className="mb-1">{t.themeAccent}</FieldLabel>
        <p className="mb-3 text-xs text-fg-muted">{t.themeAccentDesc}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => selectAccent(null)}
            title={t.themeAccentReset}
            className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
              local.accent === null
                ? 'border-accent-soft bg-accent-soft text-fg'
                : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
            }`}
          >
            {t.themeAccentReset}
          </button>
          {ACCENT_PRESETS.map((hex) => (
            <button
              key={hex}
              type="button"
              onClick={() => selectAccent(hex)}
              title={hex}
              className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${
                local.accent === hex ? 'border-white' : 'border-transparent'
              }`}
              style={{ background: hex }}
            />
          ))}
          <label className="ml-1 flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted hover:text-fg">
            <input
              type="color"
              value={local.accent ?? '#6366f1'}
              onChange={(e) => selectAccent(e.target.value)}
              className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0"
              title={t.themeAccent}
            />
            {local.accent ?? t.themeAccentReset}
          </label>
        </div>
      </FieldCard>

      <FieldCard>
        <FieldLabel className="mb-1">{t.themeBuiltinExportSection}</FieldLabel>
        <p className="mb-3 text-xs text-fg-muted">{t.themeBuiltinExportDesc}</p>
        <div className="flex flex-wrap gap-2">
          {BUILTIN_THEMES.map((theme) => (
            <div
              key={theme.id}
              className="flex items-center gap-2 rounded-lg border border-line bg-base px-3 py-1.5"
            >
              <span
                className="inline-block h-3 w-3 rounded-full border border-white/20"
                style={{ background: theme.preview.accent }}
              />
              <span className="text-xs text-fg-soft">
                {theme.mode === 'dark' ? '🌙' : '☀️'} {theme.name}
              </span>
              <button
                type="button"
                onClick={() =>
                  void exportThemeRecord({ name: theme.name, mode: theme.mode, tokens: theme.tokens })
                }
                title={t.themeCustomExport}
                className="rounded-md border border-line px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
              >
                {t.themeCustomExport}
              </button>
            </div>
          ))}
        </div>
      </FieldCard>

      <FieldCard padding="loose">
        <FieldLabel className="mb-1">{t.themeCustomThemes}</FieldLabel>
        <p className="mb-3 text-xs text-fg-muted">
          {t.themeCustomThemesDesc}
          {currentLang === 'en'
            ? ' Imported themes appear in Settings → General.'
            : currentLang === 'zh-TW'
              ? ' 導入後可在 設置 → 通用 中選擇。'
              : ' 导入后可在 设置 → 通用 中选择。'}
        </p>

        {customIds.length === 0 && <p className="mb-3 text-xs text-fg-muted">{t.themeCustomNone}</p>}
        <div className="mb-4 space-y-2">
          {customIds.map((id) => {
            const record = local.customThemes[id];
            const inUse = local.lightTheme === id || local.darkTheme === id;
            return (
              <div
                key={id}
                className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 ${
                  inUse ? 'border-accent-soft bg-accent-soft' : 'border-line bg-base'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-4 w-4 rounded-full border border-white/20"
                    style={{ background: record.tokens['accent'] ?? '#888' }}
                  />
                  <span className="text-sm font-medium text-fg">{record.name}</span>
                </div>
                <span className="rounded bg-control px-1.5 py-0.5 text-[10px] text-fg-muted">
                  {record.mode === 'dark' ? '🌙 dark' : '☀️ light'}
                </span>
                {inUse && <span className="text-xs text-accent-text">✓</span>}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => void exportCustomTheme(id)}
                  title={t.themeCustomExport}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  {t.themeCustomExport}
                </button>
                <button
                  type="button"
                  onClick={() => deleteCustomTheme(id)}
                  title={t.themeCustomDelete}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
                >
                  {t.themeCustomDelete}
                </button>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <input
            value={importName}
            onChange={(e) => setImportName(e.target.value)}
            placeholder={t.themeCustomName}
            className="w-full rounded-xl border border-line bg-base px-4 py-2.5 text-sm text-fg focus:border-accent-soft focus:outline-none"
          />
          <select
            value={importMode}
            onChange={(e) => setImportMode(e.target.value as ThemeMode)}
            className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-2.5 text-sm text-fg focus:border-accent-soft focus:outline-none"
          >
            <option value="dark">{t.themeCustomMode}: dark</option>
            <option value="light">{t.themeCustomMode}: light</option>
          </select>
        </div>
        <textarea
          value={importJson}
          onChange={(e) => setImportJson(e.target.value)}
          placeholder={jsonPlaceholder(currentLang)}
          rows={6}
          spellCheck={false}
          className="mt-3 w-full resize-y rounded-xl border border-line bg-base px-4 py-2.5 font-mono text-xs text-fg focus:border-accent-soft focus:outline-none"
        />
        {importError && (
          <p className="mt-2 break-all text-xs text-danger">{importError}</p>
        )}
        {importSuccess && (
          <p className="mt-2 text-xs text-ok">{importSuccess}</p>
        )}
        <button
          type="button"
          onClick={importCustomTheme}
          className="mt-3 rounded-xl bg-accent px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
        >
          {t.themeCustomImportBtn}
        </button>
      </FieldCard>
    </div>
  );
}
