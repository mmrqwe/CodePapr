    const resolved = await resolveAppManifest(rawAppId, workspace());
    if (!resolved) {
      throw new Error(`\u627e\u4e0d\u5230\u5e94\u7528\u3002app_publish \u53ea\u63a8\u9001\u7ed9\u5df2\u5b58\u5728\u7684\u5e94\u7528`);
    }
    let manifest = resolved.manifest;
    const inbox = manifest.inbox;
    if (inbox && typeof inbox === 'object' && !Array.isArray(inbox)) {
      if (!Object.prototype.hasOwnProperty.call(inbox, channel)) {
        const available = Object.entries(inbox).map(([name, def]) => {
          const description = def && typeof def.description === 'string' ? def.description : '';
          return `  - ${name}${description ? `\uff1a${description}` : ''}`;
        }).join('\n');
        throw new Error(`\u5e94\u7528 '${rawAppId}' \u672a\u58f0\u660e\u9891\u9053 '${channel}'\u3002\u53ef\u7528\u9891\u9053\uff1a\n${available || '  \uff08\u65e0\uff09'}`);
      }
    }
    const { seq, ts } = await invoke<{ seq: number; ts: number }>('papr_inbox_append', { appId: rawAppId, channel, payload: args.payload });
    const delivered = postAppEvent(rawAppId, { channel, seq, ts, payload: args.payload });
    if (parsePaprKind(manifest) === 'plugin') {
      const runtime = useAppRuntimeStore.getState();
      if (shouldRevealOnPublish(manifest, runtime.pluginChrome[rawAppId], runtime.pinnedPluginIds.includes(rawAppId))) {
        runtime.pinPlugin(rawAppId);
      }
    }
    return { appId: rawAppId, channel, seq, delivered, hint: delivered ? 'ok' : 'queued' };
  });
}

export interface AppLaunchTarget { appId: string; command: string; args: string[]; port: number; manifestJson?: string; }

export async function launchAppBackend(app: AppLaunchTarget, workspacePath: string): Promise<{ pid: number; url: string }> {
  const appAccess = await resolveLaunchAccess(app.appId, app.manifestJson);
  if (appAccess.local !== 'read' && appAccess.local !== 'write') {
    throw new Error(`\u5e94\u7528 '${app.appId}' \u7684 local \u8bbf\u95ee\u4e3a ${appAccess.local}\uff0c\u4e0d\u5141\u8bb8\u542f\u52a8\u540e\u7aef\u670d\u52a1`);
  }
  try { await invoke<string>('install_app_npm_deps', { workspacePath, appId: app.appId }); }
  catch (err) { throw new Error(`\u5e94\u7528 '${app.appId}' \u5b89\u88c5\u4f9d\u8d56\u5931\u8d25\uff1a${err instanceof Error ? err.message : String(err)}`); }
  const preferred = app.port;
  let port = preferred;
  try { port = await invoke<number>('allocate_app_port', { preferred }); }
  catch (err) { throw new Error(`\u5e94\u7528 '${app.appId}' \u65e0\u6cd5\u5206\u914d\u7aef\u53e3 ${preferred}\uff1a${err instanceof Error ? err.message : String(err)}`); }
  const url = `http://127.0.0.1:${port}/`;
  const result = await invoke<{ pid: number }>('start_workspace_background_command', {
    workspacePath, command: app.command, args: app.args, workdir: `.CodePapr/apps/${app.appId}`, previewUrl: url,
    sandbox: { network: appAccess.network, workspaceWrite: appAccess.local === 'write', allowBind: true },
    env: { PORT: String(port), HOST: '127.0.0.1' },
  });
  const deadline = Date.now() + 20_000;
  let portTaken = false;
  let portOwnedByUs = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const probe = await invoke<{ v4: boolean; v6: boolean }>('check_port_available_structured', { port });
    const available = !probe.v4 && !probe.v6;
    if (!available) {
      portTaken = true;
      try { portOwnedByUs = await invoke<boolean>('check_port_owned_by', { port, pid: result.pid }); }
      catch { portOwnedByUs = true; }
      break;
    }
    if (Date.now() >= deadline) break;
  }
  if (!portTaken || !portOwnedByUs) {
    try { await invoke('stop_background_process', { pid: result.pid, source: 'app_start-failure' }); } catch { /* best-effort */ }
    throw new Error(`\u5e94\u7528 '${app.appId}' \u540e\u7aef\u542f\u52a8\u5931\u8d25`);
  }
  try { await invoke('register_app_backend_port', { appId: app.appId, port }); } catch { /* ignore */ }
  return { pid: result.pid, url };
}

async function resolveLaunchAccess(appId: string, manifestJson: string | null | undefined): Promise<PaprAccess> {
  let manifest: PaprManifest | null = null;
  if (manifestJson) { try { manifest = JSON.parse(manifestJson) as PaprManifest; } catch { manifest = null; } }
  let settings: PaprAppSettings | null = usePaprPermissionStore.getState().appSettings;
  if (!settings) {
    try {
      const loaded = await invoke<PaprAppSettings>('papr_get_app_settings');
      if (loaded && typeof loaded.defaultLocal === 'string') {
        settings = loaded;
        usePaprPermissionStore.getState().setAppSettings(loaded);
      }
    } catch { settings = null; }
  }
  return resolveEffectiveAccess(manifest, settings, appId);
}

export async function syncRunningBackendsToAccess(prev: PaprAppSettings | null, next: PaprAppSettings, workspacePath: string): Promise<{ restarted: string[]; stoppedOnly: string[] }> {
  const restarted: string[] = [];
  const stoppedOnly: string[] = [];
  if (!workspacePath) return { restarted, stoppedOnly };
  const running = useAppRuntimeStore.getState().apps.filter((app) => app.pid && app.command && app.port);
  for (const app of running) {
    if (!app.command || app.port == null) continue;
    const command = app.command;
    const port = app.port;
    let manifest: PaprManifest | null = null;
    if (app.manifestJson) { try { manifest = JSON.parse(app.manifestJson) as PaprManifest; } catch { manifest = null; } }
    const before = resolveEffectiveAccess(manifest, prev, app.appId);
    const after = resolveEffectiveAccess(manifest, next, app.appId);
    if (before.local === after.local && before.network === after.network) continue;
    try { await invoke('stop_background_process', { pid: app.pid, source: 'app-permission-settings' }); } catch { /* best-effort */ }
    useAppRuntimeStore.getState().setAppStopped(app.appId);
    if (after.local !== 'read' && after.local !== 'write') { stoppedOnly.push(app.appId); continue; }
    try {
      const { pid, url } = await launchAppBackend({ appId: app.appId, command, args: app.args ?? [], port, manifestJson: app.manifestJson }, workspacePath);
      useAppRuntimeStore.getState().setAppRunning(app.appId, pid, url);
      restarted.push(app.appId);
    } catch { stoppedOnly.push(app.appId); }
  }
  return { restarted, stoppedOnly };
}
