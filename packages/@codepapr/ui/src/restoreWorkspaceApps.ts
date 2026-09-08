import { invoke } from '@tauri-apps/api/core';
import { useAgentStore } from './store/agentStore';
import { useAppRuntimeStore } from './store/appRuntimeStore';
import { isPluginApp, pluginIsEnabled, readAppManifest } from './papr/pluginSurface';
import { loadPluginUi } from './papr/pluginUiStorage';
import { findPreviewProcessForPort, processPreviewUrl } from './utils/loopbackPreview';

type DiscoveredApp = {
  app_id: string;
  title: string;
  html: string;
  manifest_json: string | null;
  command: string | null;
  args: string[] | null;
  port: number | null;
  icon: string | null;
  scope?: 'workspace' | 'global';
};

type MountApp = (app: {
  appId: string;
  title: string;
  icon?: string;
  html: string;
  filePath: string;
  manifestJson?: string;
  command?: string;
  args?: string[];
  port?: number;
  scope?: 'workspace' | 'global';
}) => void;

export async function restoreWorkspaceApps(
  workspacePath: string,
  mountApp: MountApp,
): Promise<void> {
  try {
    const discovered = await invoke<DiscoveredApp[]>(
      'scan_workspace_apps',
      { workspacePath },
    );
    if (useAgentStore.getState().workspacePath !== workspacePath) return;
    const pluginUi = await loadPluginUi(workspacePath);
    if (useAgentStore.getState().workspacePath !== workspacePath) return;
    useAppRuntimeStore.getState().hydratePluginUi(pluginUi);
    for (const app of discovered) {
      if (useAgentStore.getState().workspacePath !== workspacePath) return;
      await invoke('register_app_workspace', {
        appId: app.app_id,
        workspacePath,
      }).catch(() => {});
      // #15：入口文件尊重 manifest.entry（与 Rust scan_workspace_apps 一致），
      // 旧实现硬编码 index.html。
      let appEntryFile = 'index.html';
      let appIcon: string | undefined;
      if (app.icon && app.icon.trim().length > 0) {
        appIcon = app.icon.trim();
      }
      if (app.manifest_json) {
        try {
          const parsedManifest = JSON.parse(app.manifest_json) as { entry?: string; icon?: string };
          const rawEntry = parsedManifest.entry?.trim();
          if (rawEntry && !rawEntry.includes('..') && !rawEntry.includes('\\')) {
            appEntryFile = rawEntry;
          }
          if (!appIcon) {
            const rawIcon = parsedManifest.icon?.trim();
            if (rawIcon) appIcon = rawIcon;
          }
        } catch {
          // keep default
        }
      }
      const appScope = app.scope === 'global' ? 'global' : 'workspace';
      const baseDir = appScope === 'global' ? '~/.codepapr/apps' : '.CodePapr/apps';
      mountApp({
        appId: app.app_id,
        title: app.title || app.app_id,
        icon: appIcon,
        html: '',
        filePath: `${baseDir}/${app.app_id}/${appEntryFile}`,
        manifestJson: app.manifest_json ?? undefined,
        command: app.command ?? undefined,
        args: app.args ?? undefined,
        port: app.port ?? undefined,
        scope: appScope,
      });
      if (isPluginApp({ manifestJson: app.manifest_json ?? undefined })) {
        const manifest = readAppManifest({ manifestJson: app.manifest_json ?? undefined });
        const runtime = useAppRuntimeStore.getState();
        const chrome = runtime.pluginChrome[app.app_id];
        if (pluginIsEnabled(manifest, chrome)) {
          runtime.enablePlugin(app.app_id);
          // 只有该项目已明确记录 visible=true 才恢复 overlay；
          // 新项目（无 chrome 记录）不自动弹出，即开即用一次后由 pinPlugin 持久化。
          if (chrome?.visible === true) {
            runtime.pinPlugin(app.app_id);
          }
        }
      }
    }

    // The Rust background-process registry survives webview reloads even
    // though the in-memory JS store does not. Re-associate any surviving
    // backend (matched by its preview URL / port) so start/stop/delete and
    // running-state stay accurate after a reload.
    try {
      const procs = await invoke<Array<{ pid: number; previewUrl?: string; preview_url?: string }>>(
        'list_background_processes',
        { workspacePath },
      );
      for (const app of discovered) {
        if (useAgentStore.getState().workspacePath !== workspacePath) return;
        const match = findPreviewProcessForPort(procs, app.port);
        if (!match) continue;
        const url = processPreviewUrl(match) ?? `http://127.0.0.1:${app.port}/`;
        useAppRuntimeStore.getState().setAppRunning(app.app_id, match.pid, url);
      }
    } catch {
      // 对账失败不影响应用列表恢复
    }
  } catch {
    // 扫描失败不影响正常使用
  }
}
