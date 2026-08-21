import { useMemo } from 'react';
import { useAppRuntimeStore } from '../../store/appRuntimeStore';
import { isPluginApp } from '../../papr/pluginSurface';
import { getTranslation } from '../../utils/i18n';
import type { Lang } from '../../utils/i18n';

interface SettingsPluginsSectionProps {
  lang: Lang;
}

export function SettingsPluginsSection({ lang }: SettingsPluginsSectionProps) {
  const t = getTranslation(lang);
  const apps = useAppRuntimeStore((state) => state.apps);
  const pinnedPluginIds = useAppRuntimeStore((state) => state.pinnedPluginIds);
  const pinPlugin = useAppRuntimeStore((state) => state.pinPlugin);
  const unpinPlugin = useAppRuntimeStore((state) => state.unpinPlugin);
  const resetPluginLayout = useAppRuntimeStore((state) => state.resetPluginLayout);

  const plugins = useMemo(
    () => apps.filter((app) => isPluginApp(app)),
    [apps],
  );

  return (
    <div className="rounded-xl border border-line bg-base p-4">
      <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-fg-muted">
        {t.settingsPluginTitle}
      </label>
      <p className="mb-3 text-[10px] leading-relaxed text-fg-muted">{t.settingsPluginHint}</p>
      {plugins.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-fg-dim">
          {t.settingsPluginEmpty}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {plugins.map((plugin) => {
            const enabled = pinnedPluginIds.includes(plugin.appId);
            return (
              <div
                key={plugin.appId}
                className="flex items-center gap-3 rounded-lg border border-line bg-raised/40 px-3 py-2.5"
              >
                <span className="text-sm">
                  {plugin.icon && plugin.icon.trim().length > 0 ? plugin.icon.trim().slice(0, 2) : '📌'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-fg">{plugin.title}</div>
                  <div className="truncate text-[10px] text-fg-dim">{plugin.appId}</div>
                </div>
                <button
                  type="button"
                  className="rounded-md border border-line px-2 py-1 text-[10px] text-fg-muted hover:border-accent-soft hover:text-fg"
                  onClick={() => resetPluginLayout(plugin.appId)}
                >
                  {t.settingsPluginResetLayout}
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={t.settingsPluginEnable}
                  onClick={() => {
                    if (enabled) unpinPlugin(plugin.appId);
                    else pinPlugin(plugin.appId);
                  }}
                  className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
                    enabled ? 'bg-ok' : 'bg-control'
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      enabled ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
