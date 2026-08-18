import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import type { PaprAccess, PaprAppSettings, PaprLocalAccess } from '@codepapr/types';
import { LOCAL_ORDER, legacyLevelToAccess, patchAccessOverride } from '../papr/levelGrants';

interface AppPermissionsTabProps {
  lang?: Lang;
  value: PaprAppSettings | null;
  onChange: (settings: PaprAppSettings) => void;
  loadError?: string;
}

export function AppPermissionsTab({ lang, value, onChange, loadError }: AppPermissionsTabProps) {
  const t = getTranslation(lang);
  const apps = useAppRuntimeStore((state) => state.apps);
  const localLabel: Record<PaprLocalAccess, string> = {
    none: t.appPermL0Label,
    read: t.appPermL1Label,
    write: t.appPermL3Label,
  };
  const localDesc: Record<PaprLocalAccess, string> = {
    none: t.appPermL0Desc,
    read: t.appPermL1Desc,
    write: t.appPermL3Desc,
  };
  const netOn = lang === 'en' ? 'online' : lang === 'zh-TW' ? '聯網' : '联网';
  const netOff = lang === 'en' ? 'offline' : lang === 'zh-TW' ? '離線' : '离线';
  const declaredPrefix = lang === 'en' ? 'Declared' : lang === 'zh-TW' ? '宣告' : '声明';
  const effectivePrefix = lang === 'en' ? 'Effective' : lang === 'zh-TW' ? '生效' : '生效';
  const overridden = lang === 'en' ? 'overridden' : lang === 'zh-TW' ? '已覆蓋' : '已覆盖';
  const localPrefix = lang === 'en' ? 'Local' : lang === 'zh-TW' ? '本地' : '本地';
  const autoLabel = lang === 'en' ? 'Auto' : lang === 'zh-TW' ? '自動' : '自动';

  if (loadError) {
    return <div className="p-4 text-xs text-danger">{t.appPermLoadFailed}: {loadError}</div>;
  }

  if (!value) {
    return <div className="p-4 text-xs text-fg-muted">{t.appPermLoading}</div>;
  }

  const settings = value;

  const updateDefaultLocal = (local: PaprLocalAccess) => {
    onChange({ ...settings, defaultLocal: local });
  };

  const updateDefaultNetwork = (network: boolean) => {
    onChange({ ...settings, defaultNetwork: network });
  };

  const updateAppOverride = (appId: string, patch: Partial<PaprAccess> | 'auto') => {
    const overrides = { ...settings.appOverrides };
    if (patch === 'auto') {
      delete overrides[appId];
    } else {
      overrides[appId] = patchAccessOverride(overrides[appId], getAppDeclared(appId), patch);
    }
    onChange({ ...settings, appOverrides: overrides });
  };

  const getAppDeclared = (appId: string): PaprAccess => {
    const app = apps.find((a) => a.appId === appId);
    if (!app?.manifestJson) return { local: settings.defaultLocal, network: settings.defaultNetwork };
    try {
      const manifest = JSON.parse(app.manifestJson) as {
        local?: PaprLocalAccess;
        network?: boolean;
        level?: 0 | 1 | 2 | 3;
      };
      if (manifest.local) {
        return { local: manifest.local, network: manifest.network === true };
      }
      if (typeof manifest.level === 'number') {
        return legacyLevelToAccess(manifest.level);
      }
    } catch {
      // manifest 解析失败回落默认
    }
    return { local: settings.defaultLocal, network: settings.defaultNetwork };
  };

  const getAppEffective = (appId: string): PaprAccess => {
    const declared = getAppDeclared(appId);
    const override = settings.appOverrides[appId];
    if (!override) return declared;
    const rank = (l: PaprLocalAccess) => LOCAL_ORDER.indexOf(l);
    return {
      local: rank(override.local) < rank(declared.local) ? override.local : declared.local,
      network: override.network && declared.network,
    };
  };

  const localButton = (local: PaprLocalAccess, active: boolean) =>
    `rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
      active
        ? 'border-accent-soft bg-accent-soft text-accent-text'
        : 'border-line text-fg-muted hover:border-accent-soft hover:text-fg'
    }`;

  const networkToggle = (enabled: boolean, onChangeNetwork: (v: boolean) => void, trackColor: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChangeNetwork(!enabled)}
      className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
        enabled ? trackColor : 'bg-control'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );

  const networkRow = (
    enabled: boolean,
    onChangeNetwork: (v: boolean) => void,
    label: string,
    hint: string,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold text-fg">{label}</div>
        <div className="mt-0.5 text-[10px] leading-relaxed text-fg-muted">{hint}</div>
      </div>
      {networkToggle(enabled, onChangeNetwork, 'bg-ok')}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-xs leading-relaxed text-fg-muted">{t.appPermTitle}</p>
        <p className="mt-1.5 text-[10px] leading-relaxed text-fg-dim">{t.appPermGlobalHint}</p>
      </div>

      {/* 本地访问轴 */}
      <div className="rounded-xl border border-line bg-base p-4">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.15em] text-fg-muted">
          {t.appPermGlobalLevel}
        </label>
        <div className="flex gap-2">
          {LOCAL_ORDER.map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => updateDefaultLocal(lvl)}
              className={localButton(lvl, settings.defaultLocal === lvl)}
            >
              {localLabel[lvl]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-fg-dim">
          {localDesc[settings.defaultLocal]}
        </p>
      </div>

      {/* 网络轴 */}
      <div className="rounded-xl border border-line bg-base p-4">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.15em] text-fg-muted">
          {t.appPermL2Label}
        </label>
        {networkRow(
          settings.defaultNetwork,
          updateDefaultNetwork,
          t.appPermAllowL3,
          t.appPermAllowL3Desc,
        )}
      </div>

      {apps.length > 0 && (
        <div>
          <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.15em] text-fg-muted">
            {t.appPermAppList}
          </label>
          <div className="flex flex-col gap-2">
            {apps.map((app) => {
              const declared = getAppDeclared(app.appId);
              const effective = getAppEffective(app.appId);
              const hasOverride = settings.appOverrides[app.appId] !== undefined;
              return (
                <div
                  key={app.appId}
                  className="flex items-center gap-3 rounded-lg border border-line bg-base px-3 py-2.5"
                >
                  <span className="text-sm">
                    {app.icon && app.icon.trim().length > 0 ? app.icon.trim().slice(0, 2) : '🖥️'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-fg">{app.title}</div>
                    <div className="text-[10px] text-fg-dim">
                      {declaredPrefix}: {localLabel[declared.local]}{declared.network ? `·${netOn}` : `·${netOff}`} → {effectivePrefix}:{' '}
                      <span className={effective.local === 'write' ? 'text-warn' : effective.local === 'read' ? 'text-info' : 'text-fg-muted'}>
                        {localLabel[effective.local]}{effective.network ? `·${netOn}` : `·${netOff}`}
                      </span>
                      {hasOverride ? ` ·${overridden}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      value={hasOverride ? settings.appOverrides[app.appId]!.local : 'auto'}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'auto') {
                          updateAppOverride(app.appId, 'auto');
                        } else {
                          updateAppOverride(app.appId, { local: val as PaprLocalAccess });
                        }
                      }}
                      title="本地访问覆盖"
                      className="rounded-md border border-line bg-base px-1.5 py-1 text-[10px] text-fg-soft outline-none focus:border-accent-soft"
                    >
                      <option value="auto">{localPrefix}: {autoLabel}</option>
                      <option value="none">{localPrefix}: {localLabel.none}</option>
                      <option value="read">{localPrefix}: {localLabel.read}</option>
                      <option value="write">{localPrefix}: {localLabel.write}</option>
                    </select>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={effective.network}
                      onClick={() =>
                        hasOverride
                          ? updateAppOverride(app.appId, { network: !settings.appOverrides[app.appId]!.network })
                          : updateAppOverride(app.appId, { network: !declared.network })
                      }
                      title="网络覆盖（联网/离线）"
                      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
                        effective.network ? 'bg-ok' : 'bg-control'
                      }`}
                    >
                      <span
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                          effective.network ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {apps.length === 0 && (
        <div className="rounded-xl border border-line bg-base p-6 text-center text-xs text-fg-dim">
          {t.appPermNoApps}
        </div>
      )}

      <div className="rounded-xl border border-line bg-base p-4">
        <h4 className="mb-2 text-xs font-semibold text-fg-soft">{t.appPermLevelInfo}</h4>
        <div className="flex flex-col gap-1.5 text-[10px] leading-relaxed text-fg-muted">
          <div><span className="text-fg-muted font-mono">{localLabel.none}</span> · {localDesc.none}</div>
          <div><span className="text-fg-muted font-mono">{localLabel.read}</span> · {localDesc.read}</div>
          <div><span className="text-fg-muted font-mono">{localLabel.write}</span> · {localDesc.write}</div>
          <div><span className="text-fg-muted font-mono">{t.appPermL2Label}</span> · {t.appPermL2Desc}</div>
        </div>
      </div>
    </div>
  );
}
