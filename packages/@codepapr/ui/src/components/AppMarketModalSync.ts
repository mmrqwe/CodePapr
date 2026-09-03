import { invoke } from '@tauri-apps/api/core';
import { useAppRuntimeStore } from '../store/appRuntimeStore';

type Discovered = {
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

export async function remountDiscoveredApps(workspacePath: string, reloadAppId: string) {
  const discovered = await invoke<Discovered[]>('scan_workspace_apps', { workspacePath });
  const runtime = useAppRuntimeStore.getState();
  for (const app of discovered) {
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
        // ignore
      }
    }
    const appScope = app.scope === 'global' ? 'global' : 'workspace';
    const baseDir = appScope === 'global' ? '~/.codepapr/apps' : '.CodePapr/apps';
    runtime.mountApp({
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
  }
  runtime.reloadApp(reloadAppId);
}
