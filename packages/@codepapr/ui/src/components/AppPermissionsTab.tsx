import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { getTranslation } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import type { PaprAccess, PaprAppSettings, PaprLocalAccess } from '@codepapr/types';
import { LOCAL_ORDER, legacyLevelToAccess } from '../papr/levelGrants';

interface AppPermissionsTabProps {
  lang?: Lang;
  value: PaprAppSettings | null;
  onChange: (settings: PaprAppSettings) => void;
  loadError?: string;
}

const LOCAL_LABEL: Record<PaprLocalAccess, string> = {
  none: '无',
  read: '只读',
  write: '读写执行',
};

const LOCAL_DESC: Record<PaprLocalAccess, string> = {
  none: '不能访问项目文件，仅使用 app 自己的存储（papr.db / papr.fs）',
  read: '可读取项目文件（agent 工具：read/grep/list/lsp 等）',
  write: '可读写项目文件并执行命令（agent 工具：write/edit/patch/bash）',
};

export function AppPermissionsTab({ lang, value, onChange, loadError }: AppPermissionsTabProps) {
  const t = getTranslation(lang);
  const apps = useAppRuntimeStore((state) => state.apps);

  if (loadError) {
    return <div className="p-4 text-xs text-red-400">{t.appPermLoadFailed}: {loadError}</div>;
  }

  if (!value) {
    return <div className="p-4 text-xs text-slate-500">{t.appPermLoading}</div>;
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
      const current = overrides[appId] ?? { local: 'none', network: false };
      overrides[appId] = { ...current, ...patch };
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
        ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
        : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/30 hover:text-slate-200'
    }`;

  const networkToggle = (enabled: boolean, onChangeNetwork: (v: boolean) => void, trackColor: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChangeNetwork(!enabled)}
      className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
        enabled ? trackColor : 'bg-[#2a2d3a]'
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
        <div className="text-xs font-semibold text-slate-200">{label}</div>
        <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{hint}</div>
      </div>
      {networkToggle(enabled, onChangeNetwork, 'bg-emerald-500')}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-xs leading-relaxed text-slate-400">{t.appPermTitle}</p>
      </div>

      {/* 本地访问轴 */}
      <div className="rounded-xl border border-[#2a2d3a] bg-[#11141c] p-4">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
          {t.appPermGlobalLevel} · 本地访问
        </label>
        <div className="flex gap-2">
          {LOCAL_ORDER.map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => updateDefaultLocal(lvl)}
              className={localButton(lvl, settings.defaultLocal === lvl)}
            >
              {LOCAL_LABEL[lvl]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
          {LOCAL_DESC[settings.defaultLocal]}
        </p>
      </div>

      {/* 网络轴 */}
      <div className="rounded-xl border border-[#2a2d3a] bg-[#11141c] p-4">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
          网络
        </label>
        {networkRow(
          settings.defaultNetwork,
          updateDefaultNetwork,
          '允许访问网络',
          '开启后 app 可访问公网（papr.http / agent 联网工具），关闭则完全断网（CSP + 沙箱强制）',
        )}
      </div>

      {apps.length > 0 && (
        <div>
          <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
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
                  className="flex items-center gap-3 rounded-lg border border-[#2a2d3a] bg-[#11141c] px-3 py-2.5"
                >
                  <span className="text-sm">
                    {app.icon && app.icon.trim().length > 0 ? app.icon.trim().slice(0, 2) : '🖥️'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-slate-200">{app.title}</div>
                    <div className="text-[10px] text-slate-600">
                      声明: L{LOCAL_LABEL[declared.local]}{declared.network ? '·联网' : '·离线'} → 生效:{' '}
                      <span className={effective.local === 'write' ? 'text-amber-400' : effective.local === 'read' ? 'text-sky-400' : 'text-slate-400'}>
                        {LOCAL_LABEL[effective.local]}{effective.network ? '·联网' : '·离线'}
                      </span>
                      {hasOverride ? ' ·已覆盖' : ''}
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
                      className="rounded-md border border-[#2a2d3a] bg-[#0f1117] px-1.5 py-1 text-[10px] text-slate-300 outline-none focus:border-indigo-500/50"
                    >
                      <option value="auto">本地: 自动</option>
                      <option value="none">本地: 无</option>
                      <option value="read">本地: 只读</option>
                      <option value="write">本地: 读写执行</option>
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
                        effective.network ? 'bg-emerald-500' : 'bg-[#2a2d3a]'
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
        <div className="rounded-xl border border-[#2a2d3a] bg-[#11141c] p-6 text-center text-xs text-slate-600">
          {t.appPermNoApps}
        </div>
      )}

      <div className="rounded-xl border border-[#2a2d3a] bg-[#0f1117] p-4">
        <h4 className="mb-2 text-xs font-semibold text-slate-300">{t.appPermLevelInfo}</h4>
        <div className="flex flex-col gap-1.5 text-[10px] leading-relaxed text-slate-500">
          <div><span className="text-slate-400 font-mono">无</span> · 纯计算，仅 papr.db / papr.fs（app 自有沙箱）</div>
          <div><span className="text-slate-400 font-mono">只读</span> · + 读取项目文件（agent 只读工具）</div>
          <div><span className="text-slate-400 font-mono">读写执行</span> · + 修改项目/执行命令（agent write/edit/patch/bash）</div>
          <div><span className="text-slate-400 font-mono">网络</span> · 与本地轴正交：联网访问公网（https/wss），离线完全断网</div>
        </div>
      </div>
    </div>
  );
}
