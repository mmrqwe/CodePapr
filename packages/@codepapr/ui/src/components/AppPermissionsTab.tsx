import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import type { PaprAppSettings, PaprLevel } from '@codepapr/types';

const LEVEL_LABELS: Record<number, string> = {
  0: 'Level 0 · 纯计算',
  1: 'Level 1 · Runtime',
  2: 'Level 2 · 联网',
  3: 'Level 3 · 系统',
};

const LEVEL_DESC: Record<number, string> = {
  0: '无外部访问，仅 HTML/CSS/JS 渲染',
  1: '存储 + LLM + 只读工作区（默认）',
  2: '+ HTTP + 搜索 + MCP 工具',
  3: '+ 文件写入 + 终端 + Git（需全局开关）',
};

export function AppPermissionsTab() {
  const apps = useAppRuntimeStore((state) => state.apps);
  const [settings, setSettings] = useState<PaprAppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<PaprAppSettings>('papr_get_app_settings')
      .then(setSettings)
      .catch(() => {});
  }, []);

  const save = useCallback((updated: PaprAppSettings) => {
    setSaving(true);
    invoke('papr_set_app_settings', { settings: updated })
      .then(() => setSettings(updated))
      .catch(() => {})
      .finally(() => setSaving(false));
  }, []);

  if (!settings) {
    return <div className="p-4 text-xs text-slate-500">Loading...</div>;
  }

  const updateDefaultLevel = (level: PaprLevel) => {
    save({ ...settings, defaultLevel: level });
  };

  const toggleAllowLevel3 = () => {
    save({ ...settings, allowLevel3: !settings.allowLevel3 });
  };

  const updateAppOverride = (appId: string, level: PaprLevel | 'auto') => {
    const overrides = { ...settings.appOverrides };
    if (level === 'auto') {
      delete overrides[appId];
    } else {
      overrides[appId] = level;
    }
    save({ ...settings, appOverrides: overrides });
  };

  const getAppManifestLevel = (appId: string): PaprLevel => {
    const app = apps.find((a) => a.appId === appId);
    if (!app?.manifestJson) return settings.defaultLevel;
    try {
      const manifest = JSON.parse(app.manifestJson);
      return (manifest.level ?? settings.defaultLevel) as PaprLevel;
    } catch {
      return settings.defaultLevel;
    }
  };

  const getAppEffectiveLevel = (appId: string): PaprLevel => {
    const manifestLevel = getAppManifestLevel(appId);
    const override = settings.appOverrides[appId];
    let effective = override !== undefined
      ? Math.min(override, manifestLevel) as PaprLevel
      : manifestLevel;
    if (effective >= 3 && !settings.allowLevel3) {
      effective = 2 as PaprLevel;
    }
    return effective;
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-xs leading-relaxed text-slate-400">
          管理 .papr 应用的权限级别。Level 越高，能力越强，风险也越大。
        </p>
      </div>

      <div className="rounded-xl border border-[#2a2d3a] bg-[#11141c] p-4">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
          全局默认级别
        </label>
        <div className="flex gap-2">
          {([0, 1, 2, 3] as PaprLevel[]).map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => updateDefaultLevel(lvl)}
              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                settings.defaultLevel === lvl
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
                  : 'border-[#2a2d3a] text-slate-400 hover:border-indigo-500/30 hover:text-slate-200'
              }`}
            >
              {LEVEL_LABELS[lvl]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
          {LEVEL_DESC[settings.defaultLevel]}
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-xs font-semibold text-amber-200">
              ⚠️ 允许 Level 3 应用
            </label>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              开启后，应用可申请文件写入/终端/Git 权限。默认关闭。
            </p>
          </div>
          <button
            type="button"
            onClick={toggleAllowLevel3}
            className={`relative h-6 w-11 rounded-full transition-colors ${
              settings.allowLevel3 ? 'bg-amber-500' : 'bg-[#2a2d3a]'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                settings.allowLevel3 ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {apps.length > 0 && (
        <div>
          <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
            应用列表
          </label>
          <div className="flex flex-col gap-2">
            {apps.map((app) => {
              const manifestLevel = getAppManifestLevel(app.appId);
              const effectiveLevel = getAppEffectiveLevel(app.appId);
              const override = settings.appOverrides[app.appId];
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
                      manifest: L{manifestLevel} → effective: <span className={effectiveLevel >= 3 ? 'text-amber-400' : effectiveLevel >= 2 ? 'text-sky-400' : 'text-slate-400'}>L{effectiveLevel}</span>
                    </div>
                  </div>
                  <select
                    value={override !== undefined ? String(override) : 'auto'}
                    onChange={(e) => {
                      const val = e.target.value;
                      updateAppOverride(app.appId, val === 'auto' ? 'auto' : Number(val) as PaprLevel);
                    }}
                    className="rounded-md border border-[#2a2d3a] bg-[#0f1117] px-2 py-1 text-[10px] text-slate-300 outline-none focus:border-indigo-500/50"
                  >
                    <option value="auto">Auto (L{manifestLevel})</option>
                    {[0, 1, 2, 3].filter((l) => l <= manifestLevel).map((l) => (
                      <option key={l} value={l} disabled={l === 3 && !settings.allowLevel3}>
                        L{l}{l === 3 && !settings.allowLevel3 ? ' (需全局开关)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {apps.length === 0 && (
        <div className="rounded-xl border border-[#2a2d3a] bg-[#11141c] p-6 text-center text-xs text-slate-600">
          暂无已注册的应用。在 App 模式下生成应用后会出现在这里。
        </div>
      )}

      {saving && (
        <div className="text-[10px] text-slate-600">Saving...</div>
      )}

      <div className="rounded-xl border border-[#2a2d3a] bg-[#0f1117] p-4">
        <h4 className="mb-2 text-xs font-semibold text-slate-300">权限级别说明</h4>
        <div className="flex flex-col gap-1.5 text-[10px] leading-relaxed text-slate-500">
          <div><span className="text-slate-400 font-mono">L0</span> · 纯计算：无外部访问</div>
          <div><span className="text-slate-400 font-mono">L1</span> · Runtime：papr.db 存储 + papr.fs 文件 + AI Agent（只读工具）</div>
          <div><span className="text-slate-400 font-mono">L2</span> · 联网：+ papr.http + Agent 联网搜索 + MCP 工具</div>
          <div><span className="text-amber-400 font-mono">L3</span> · 系统：+ 文件写入 + 终端 + Git（需全局开关）</div>
        </div>
      </div>
    </div>
  );
}
