import type { PaprAppSettings } from '@codepapr/types';
import { AppPermissionsTab } from '../AppPermissionsTab';
import { SettingsPluginsSection } from './SettingsPluginsSection';
import { getTranslation, type Lang } from '../../utils/i18n';

interface SettingsAppTabProps {
  currentLang: Lang;
  value: PaprAppSettings | null;
  onChange: (settings: PaprAppSettings) => void;
  loadError: string;
  onOpenAppMarket?: () => void;
}

export function SettingsAppTab({
  currentLang,
  value,
  onChange,
  loadError,
  onOpenAppMarket,
}: SettingsAppTabProps) {
  const t = getTranslation(currentLang);

  return (
    <div className="flex flex-col gap-4">
      {/* App & Plugin Market Card */}
      <div className="flex items-center justify-between rounded-xl border border-line bg-raised/30 p-4 transition-colors hover:border-purple-500/30">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-xl text-purple-400">
            ▦
          </div>
          <div>
            <div className="text-xs font-semibold text-fg">{t.settingsAppMarketTitle}</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
              {t.settingsAppMarketDesc}
            </p>
          </div>
        </div>
        {onOpenAppMarket && (
          <button
            type="button"
            onClick={onOpenAppMarket}
            className="ml-4 shrink-0 rounded-lg border border-purple-500/30 bg-purple-500/10 px-3.5 py-1.5 text-xs font-medium text-purple-300 transition-colors hover:bg-purple-500/20 hover:text-purple-200"
          >
            {t.settingsAppBrowseMarket}
          </button>
        )}
      </div>

      <SettingsPluginsSection lang={currentLang} />
      <AppPermissionsTab
        lang={currentLang}
        value={value}
        onChange={onChange}
        loadError={loadError}
      />
    </div>
  );
}
