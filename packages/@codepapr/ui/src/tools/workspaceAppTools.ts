import { invoke } from '@tauri-apps/api/core';
import { asString } from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import { type ReadFileResult } from './workspaceToolHelpers';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import type { PaprAppSettings, PaprManifest } from '@codepapr/types';
import {
  LOCAL_ORDER,
  accessMeetsTool,
  legacyLevelToAccess,
  type PaprAccess,
  type PaprLocalAccess,
} from '../papr/levelGrants';
import { parsePaprKind, parsePluginSurfaceArg, resolvePaprEntryFile } from '../papr/pluginSurface';
import { postAppEvent } from '../papr/appChannelHub';
import { type WorkspaceToolContext } from './workspaceToolContext';

const APP_RENDER_WRITE_ARG_KEYS = ['html','files','title','kind','surface','agents','local','network','command','args','port','icon','permissions','level'] as const;
const APP_PUBLISH_CHANNEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function normalizeAppIcon(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 16 || /[\n\r\\/]/.test(trimmed)) {
    throw new Error(`icon 必须是不超过 16 个字符的 emoji 或短标签，收到: ${JSON.stringify(raw)}`);
  }
  return trimmed;
}

export interface PaprInboxSummary { channel: string; description?: string; example?: unknown; }

export function validateManifestInbox(manifest: PaprManifest): void {
  const inbox = manifest.inbox;
  if (inbox === undefined) return;
  if (typeof inbox !== 'object' || inbox === null || Array.isArray(inbox)) {
    throw new Error('manifest inbox 必须是对象');
  }
  for (const [channel, def] of Object.entries(inbox)) {
    if (!APP_PUBLISH_CHANNEL_RE.test(channel)) throw new Error(`inbox 频道名 '${channel}' 非法`);
    if (typeof def !== 'object' || def === null || Array.isArray(def)) throw new Error(`inbox.${channel} 必须是对象`);
  }
}

export function summarizeManifestInbox(manifest: PaprManifest | null | undefined): PaprInboxSummary[] | undefined {
  const inbox = manifest?.inbox;
  if (!inbox || typeof inbox !== 'object' || Array.isArray(inbox)) return undefined;
  const entries = Object.entries(inbox);
  if (entries.length === 0) return undefined;
  return entries.map(([channel, def]) => ({ channel, ...(typeof def?.description === 'string' && def.description.trim().length > 0 ? { description: def.description } : {}), ...(def && 'example' in def && def.example !== undefined ? { example: def.example } : {}) }));
}

function parseAccess(args: Record<string, unknown>): PaprAccess {
  const rawLocal = args.local;
  const rawNetwork = args.network;
  if (rawLocal !== undefined || rawNetwork !== undefined) {
    if (rawLocal !== undefined && !LOCAL_ORDER.includes(rawLocal as PaprLocalAccess)) throw new Error(`local 必须是 none/read/write`);
    if (rawNetwork !== undefined && typeof rawNetwork !== 'boolean') throw new Error(`network 必须是布尔值`);
    return { local: (rawLocal as PaprLocalAccess) ?? 'none', network: rawNetwork === true };
  }
  const level = typeof args.level === 'number' ? args.level : 1;
  return legacyLevelToAccess(level);
}

function validateAgentTools(params: { agents: Array<{ name: string; tools?: string[] }>; access: PaprAccess; disableWebSearchTools: boolean; }): void {
  const { agents, access, disableWebSearchTools } = params;
  for (const agent of agents) {
    if (!agent.tools) continue;
    for (const toolName of agent.tools) {
      if (toolName === 'task' || toolName === 'app_render') throw new Error(`不能声明 ${toolName}`);
      if (toolName.startsWith('mcp__')) { if (!access.network) throw new Error('MCP 需要 network: true'); continue; }
      if (!accessMeetsTool(access, toolName)) throw new Error(`${toolName} 不在当前访问档允许范围内`);
      if ((toolName === 'websearch' || toolName === 'webfetch') && disableWebSearchTools) throw new Error('MCP 搜索已启用');
    }
  }
}

function validateManifestAgents(raw: unknown): Array<{ name: string; tools?: string[] }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('manifest.agents 必须是数组');
  const agents: Array<{ name: string; tools?: string[] }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('agents 每个元素必须是对象');
    const a = item as { name?: unknown; tools?: string[] };
    if (!a.name || typeof a.name !== 'string' || a.name.trim().length === 0) throw new Error('agents 需要 name');
    agents.push({ name: a.name, tools: a.tools });
  }
  return agents;
}

async function readAppTextFile(workspacePath: string, relativePath: string): Promise<string | null> {
  try {
    const file = await invoke<ReadFileResult>('read_text_file', { workspacePath, relativePath, maxBytes: 2_000_000 });
    return typeof file?.content === 'string' ? file.content : null;
  } catch { return null; }
}

export async function resolveAppManifest(appId: string, workspacePath: string): Promise<{ manifest: PaprManifest; scope: 'global' | 'workspace' } | null> {
  const inStore = useAppRuntimeStore.getState().apps.find((a) => a.appId === appId);
  if (inStore?.manifestJson) {
    try { return { manifest: JSON.parse(inStore.manifestJson) as PaprManifest, scope: inStore.scope ?? 'workspace' }; } catch { /* ignore */ }
  }
  if (workspacePath) {
    const wsManifestRaw = await readAppTextFile(workspacePath, `.CodePapr/apps/${appId}/manifest.json`);
    if (wsManifestRaw) {
      try { return { manifest: JSON.parse(wsManifestRaw) as PaprManifest, scope: 'workspace' }; } catch { /* ignore */ }
    }
  }
  try {
    const scanned = await invoke<Array<{ app_id: string; manifest_json: string | null; scope?: 'workspace' | 'global' }>>('scan_workspace_apps', { workspacePath: workspacePath || '' });
    const match = scanned.find((d) => d.app_id === appId);
    if (match?.manifest_json) return { manifest: JSON.parse(match.manifest_json) as PaprManifest, scope: match.scope ?? 'workspace' };
  } catch { /* best-effort */ }
  return null;
}

export function registerWorkspaceAppTools(ctx: WorkspaceToolContext): void {
  const { registry, workspace } = ctx;
  registry.register(toolByName('app_render'), async (args: Record<string, unknown>) => {
    const writeKeys = APP_RENDER_WRITE_ARG_KEYS.filter((key) => args[key] !== undefined && args[key] !== null);
    if (writeKeys.length > 0) throw new Error(`app_render 只打开已落盘的应用，不能写入 ${writeKeys.join(', ')}`);
    const rawAppId = asString(args.appId, 'appId');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) throw new Error(`appId 非法: ${rawAppId}`);
    let appDir = `.CodePapr/apps/${rawAppId}`;
    const manifestPath = `${appDir}/manifest.json`;
    let manifestRaw = await readAppTextFile(workspace(), manifestPath);
    let appScope: 'workspace' | 'global' = 'workspace';
    if (!manifestRaw) {
      const resolved = await resolveAppManifest(rawAppId, workspace());
      if (!resolved) throw new Error(`找不到 ${manifestPath}`);
      manifestRaw = JSON.stringify(resolved.manifest);
      appScope = resolved.scope;
      appDir = appScope === 'global' ? `~/.codepapr/apps/${rawAppId}` : appDir;
    }
    const manifest = JSON.parse(manifestRaw) as PaprManifest;
    const title = typeof manifest.name === 'string' ? manifest.name.trim() : '';
    if (!title) throw new Error(`${manifestPath} 缺少 name`);
    const agents = validateManifestAgents(manifest.agents);
    const access = parseAccess(manifest as unknown as Record<string, unknown>);
    const kind = parsePaprKind(manifest);
    const command = typeof manifest.command === 'string' && manifest.command.trim() ? manifest.command.trim() : undefined;
    const cmdArgs = Array.isArray(manifest.args) ? manifest.args.filter((item): item is string => typeof item === 'string') : undefined;
    const port = typeof manifest.port === 'number' ? manifest.port : undefined;
    const normalizedIcon = normalizeAppIcon(typeof manifest.icon === 'string' ? manifest.icon : undefined);
    if (kind === 'plugin') parsePluginSurfaceArg(manifest.surface);
    validateManifestInbox(manifest);
    validateAgentTools({ agents, access, disableWebSearchTools: ctx.options.disableWebSearchTools ?? false });
    const entryFile = resolvePaprEntryFile(manifest);
    const indexRelativePath = `${appDir}/${entryFile}`;
    if (appScope !== 'global') {
      const entryHtml = await readAppTextFile(workspace(), indexRelativePath);
      if (entryHtml == null) throw new Error(`找不到入口文件 ${indexRelativePath}`);
    }
    await invoke('register_app_workspace', { appId: rawAppId, workspacePath: workspace() });
    useAppRuntimeStore.getState().mountApp({ appId: rawAppId, title, icon: normalizedIcon, html: '', filePath: indexRelativePath, command, args: cmdArgs, port, manifestJson: JSON.stringify(manifest), scope: appScope });
    const runtime = useAppRuntimeStore.getState();
    if (kind === 'plugin') { if (runtime.openedAppId === rawAppId) runtime.closeAppModal(); runtime.pinPlugin(rawAppId); }
    else runtime.unpinPlugin(rawAppId);
    return { appId: rawAppId, title, mounted: true, kind, scope: appScope };
  });
  registry.register(toolByName('app_list'), async () => {
    return useAppRuntimeStore.getState().apps.map((app) => ({ appId: app.appId, title: app.title, scope: app.scope }));
  });
  registry.register(toolByName('app_start'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);
    if (!app.command || !app.port) throw new Error(`应用 '${appId}' 没有后端服务`);
    const { pid, url } = await launchAppBackend({ appId, command: app.command, args: app.args ?? [], port: app.port, manifestJson: app.manifestJson }, workspace());
    useAppRuntimeStore.getState().setAppRunning(appId, pid, url);
    return { appId, pid, url, started: true };
  });
  registry.register(toolByName('app_stop'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const app = useAppRuntimeStore.getState().apps.find((a) => a.appId === appId);
    if (!app?.pid) throw new Error(`应用 '${appId}' 后端未在运行`);
    try { await invoke('stop_background_process', { pid: app.pid, source: 'app_stop-tool' }); } catch { /* best-effort */ }
    useAppRuntimeStore.getState().setAppStopped(appId);
    return { appId, stopped: true };
  });
  registry.register(toolByName('app_delete'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const app = useAppRuntimeStore.getState().apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);
    if (app.pid) { try { await invoke('stop_background_process', { pid: app.pid, source: 'app_delete-tool' }); } catch { /* best-effort */ } }
    try { await invoke('papr_delete_app', { appId }); } catch { /* best-effort */ }
    useAppRuntimeStore.getState().closeApp(appId);
    return { appId, deleted: true };
  });
  registry.register(toolByName('app_publish'), async (args: Record<string, unknown>) => {
    const rawAppId = asString(args.appId, 'appId');
    const channel = asString(args.channel, 'channel');
    if (args.payload === undefined || args.payload === null) throw new Error('payload 必填');
    const resolved = await resolveAppManifest(rawAppId, workspace());
    if (!resolved) throw new Error(`找不到应用 ${rawAppId}`);
    const { seq, ts } = await invoke<{ seq: number; ts: number }>('papr_inbox_append', { appId: rawAppId, channel, payload: args.payload });
    const delivered = postAppEvent(rawAppId, { channel, seq, ts, payload: args.payload });
    return { appId: rawAppId, channel, seq, delivered };
  });
}

export interface AppLaunchTarget { appId: string; command: string; args: string[]; port: number; manifestJson?: string; }

export async function launchAppBackend(app: AppLaunchTarget, workspacePath: string): Promise<{ pid: number; url: string }> {
  const preferred = app.port;
  const port = await invoke<number>('allocate_app_port', { preferred });
  const url = `http://127.0.0.1:${port}/`;
  const result = await invoke<{ pid: number }>('start_workspace_background_command', {
    workspacePath, command: app.command, args: app.args, workdir: `.CodePapr/apps/${app.appId}`, previewUrl: url,
    sandbox: { network: true, workspaceWrite: true, allowBind: true },
    env: { PORT: String(port), HOST: '127.0.0.1' },
  });
  return { pid: result.pid, url };
}

export async function syncRunningBackendsToAccess(_prev: PaprAppSettings | null, _next: PaprAppSettings, _workspacePath: string): Promise<{ restarted: string[]; stoppedOnly: string[] }> {
  return { restarted: [], stoppedOnly: [] };
}
