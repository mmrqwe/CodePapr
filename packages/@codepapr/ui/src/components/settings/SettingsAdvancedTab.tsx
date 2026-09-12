import { FieldCard, SelectField, TextField } from '../forms';
import type { SettingsTabProps } from './types';

export function SettingsAdvancedTab({ local, update, t, currentLang }: SettingsTabProps) {
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-warn-bg bg-warn-bg px-5 py-5">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={local.folderAccessYolo}
            onChange={(e) => update({ folderAccessYolo: e.target.checked })}
            className="h-4 w-4 cursor-pointer rounded border-line-strong bg-base accent-warn"
          />
          <span className="text-sm font-semibold text-warn">{t.folderAccessYoloLabel}</span>
        </label>
        <p className="mt-2 text-[11px] leading-relaxed text-fg-soft">{t.folderAccessYoloHint}</p>
      </div>

      <FieldCard padding="loose">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.contextCompactionSettings}
        </label>
        <p className="mb-4 text-[11px] leading-relaxed text-fg-soft">{t.contextCompactionDesc}</p>
        <div className="grid gap-5 md:grid-cols-3">
          <SelectField
            label={t.compactionModelLabel}
            value={local.compactionModel}
            onChange={(e) => update({ compactionModel: e.target.value as 'fast' | 'primary' })}
            title={t.compactionModelLabel}
          >
            <option value="fast">{t.compactionModelFast}</option>
            <option value="primary">{t.compactionModelPrimary}</option>
          </SelectField>
          <TextField
            label={t.compactionMaxTokensLabel}
            type="number"
            min="100"
            max="100000"
            step="100"
            value={local.compactionMaxTokens}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              update({ compactionMaxTokens: Number.isFinite(parsed) ? parsed : local.compactionMaxTokens });
            }}
            title={t.compactionMaxTokensLabel}
            hint={t.compactionMaxTokensHint}
          />
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
              {t.compactionTemperatureLabel}: <span className="font-mono text-accent-text">{local.compactionTemperature}</span>
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={local.compactionTemperature}
              onChange={(e) => update({ compactionTemperature: parseFloat(e.target.value) })}
            title={t.compactionTemperatureHint}
            className="mt-3 w-full cursor-pointer accent-accent"
          />
        </div>
        </div>
      </FieldCard>

      <FieldCard padding="loose">
        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.streamOutputSettings}
        </label>
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            label={t.streamIdleTimeoutLabel}
            type="number"
            min="10"
            max="1800"
            step="10"
            value={Math.round(local.streamIdleTimeoutMs / 1000)}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              update({ streamIdleTimeoutMs: Number.isFinite(parsed) ? parsed * 1000 : local.streamIdleTimeoutMs });
            }}
            title={t.streamIdleTimeoutLabel}
          />
        </div>
      </FieldCard>

      <FieldCard padding="loose">
        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.embeddedBrowserEngine}
        </label>
        <select
          value={local.browserEngine}
          onChange={(e) => update({ browserEngine: e.target.value as 'embedded' | 'headless' })}
          className="w-full cursor-pointer rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg focus:border-accent-soft focus:outline-none"
        >
          <option value="embedded">{t.embeddedBrowserEngineEmbedded}</option>
          <option value="headless">{t.embeddedBrowserEngineHeadless}</option>
        </select>
      </FieldCard>

      <FieldCard padding="loose">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{t.goalSettingsTitle}</h3>
        <div className="grid gap-5 md:grid-cols-2">
          <TextField
            label={t.goalMaxIterationsLabel}
            type="number"
            min="1"
            max="100"
            step="1"
            value={local.goalMaxIterations}
            onChange={(e) => { const p = parseInt(e.target.value, 10); update({ goalMaxIterations: Number.isFinite(p) ? p : local.goalMaxIterations }); }}
            title={t.goalMaxIterationsHint}
          />
          <TextField
            label={t.goalMaxWallClockLabel}
            type="number"
            min="1"
            max="180"
            step="1"
            value={Math.round((local.goalMaxWallClockMs ?? 1800000) / 60000)}
            onChange={(e) => { const p = parseInt(e.target.value, 10); update({ goalMaxWallClockMs: Number.isFinite(p) ? p * 60000 : local.goalMaxWallClockMs }); }}
            title={t.goalMaxWallClockHint}
          />
        </div>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          <SelectField
            label={t.verifierModelTierLabel}
            value={local.verifierModelTier}
            onChange={(e) => update({ verifierModelTier: e.target.value as 'fast' | 'primary' | 'mentor' })}
            title={t.verifierModelTierLabel}
          >
            <option value="fast">{t.verifierModelTierFast}</option>
            <option value="primary">{t.verifierModelTierPrimary}</option>
            <option value="mentor">{t.verifierModelTierMentor}</option>
          </SelectField>
          <TextField
            label={t.verifierMaxTokensLabel}
            type="number"
            min="100"
            max="10000"
            step="100"
            value={local.verifierMaxTokens}
            onChange={(e) => { const p = parseInt(e.target.value, 10); update({ verifierMaxTokens: Number.isFinite(p) ? p : local.verifierMaxTokens }); }}
            title={t.verifierMaxTokensHint}
          />
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{t.verifierTemperatureLabel}: <span className="font-mono text-accent-text">{local.verifierTemperature}</span></label>
            <input type="range" min="0" max="2" step="0.1" value={local.verifierTemperature}
              onChange={(e) => update({ verifierTemperature: parseFloat(e.target.value) })}
              title={t.verifierTemperatureHint}
              className="mt-3 w-full cursor-pointer accent-accent" />
          </div>
        </div>
      </FieldCard>

      <FieldCard padding="loose">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{t.workspaceProjectGraph}</h3>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <TextField
            label={t.projectGraphMaxFilesLabel}
            type="number"
            min="0"
            step="100"
            value={local.projectGraphMaxFiles}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              update({ projectGraphMaxFiles: Number.isFinite(parsed) ? parsed : local.projectGraphMaxFiles });
            }}
            title={t.projectGraphMaxFilesHint}
          />
          <TextField
            label={t.projectGraphMaxTreeEntriesLabel}
            type="number"
            min="0"
            step="100"
            value={local.projectGraphMaxTreeEntries}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              update({ projectGraphMaxTreeEntries: Number.isFinite(parsed) ? parsed : local.projectGraphMaxTreeEntries });
            }}
            title={t.projectGraphMaxTreeEntriesHint}
          />
        </div>
      </FieldCard>

      <FieldCard padding="loose">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">{t.systemPrompt}</h3>
        <textarea
          value={local.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
          rows={5}
          placeholder={currentLang === 'en' ? 'e.g. Always respond in English. Prefer functional style.' : currentLang === 'zh-TW' ? '例如：始終使用繁體中文回覆。偏好函數式風格。' : '例如：始终使用中文回复。偏好函数式风格。'}
          className="w-full resize-y rounded-xl border border-line bg-base px-4 py-3 text-sm text-fg placeholder-slate-700 focus:border-accent-soft focus:outline-none"
        />
      </FieldCard>
    </div>
  );
}
