import { invoke } from '@tauri-apps/api/core';
import { asString } from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  type BackgroundProcessExitInfo,
  type ReadFileResult,
} from './workspaceToolHelpers';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';
import type { PaprAppSettings, PaprManifest } from '@codepapr/types';
import {
  LOCAL_ORDER,
  accessMeetsTool,
  legacyLevelToAccess,
  resolveEffectiveAccess,
  type PaprAccess,
  type PaprLocalAccess,
} from '../papr/levelGrants';
import { isPluginApp, parsePaprKind, parsePluginSurfaceArg, pluginIsEnabled, readAppManifest, resolvePaprEntryFile, shouldRevealOnPublish } from '../papr/pluginSurface';
import { postAppEvent } from '../papr/appChannelHub';
import { type WorkspaceToolContext } from './workspaceToolContext';
import { findPreviewProcessForPort, processPreviewUrl } from '../utils/loopbackPreview';

const APP_RENDER_WRITE_ARG_KEYS = ['html','files','title','kind','surface','agents','local','network','command','args','port','icon','permissions','level'] as const;
const LOCAL_LABEL: Record<PaprLocalAccess, string> = { none: '无', read: '只读', write: '读写执行' };
const APP_PUBLISH_CHANNEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const APP_PUBLISH_MAX_PAYLOAD_BYTES = 256 * 1024;

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
    throw new Error('manifest inbox 必须是对象：{ "<channel>": { "description": "...", "example": {...} } }');
  }
  for (const [channel, def] of Object.entries(inbox)) {
    if (!APP_PUBLISH_CHANNEL_RE.test(channel)) {
      throw new Error(`inbox 频道名 '${channel}' 非法：须字母/数字开头，仅字母/数字/-/_，1-64 字符`);
    }
    if (typeof def !== 'object' || def === null || Array.isArray(def)) {
      throw new Error(`inbox.${channel} 必须是对象（{ description?, example? }）`);
    }
    if (def.description !== undefined && typeof def.description !== 'string') {
      throw new Error(`inbox.${channel}.description 必须是字符串`);
    }
  }
}

export function summarizeManifestInbox(manifest: PaprManifest | null | undefined): PaprInboxSummary[] | undefined {
  const inbox = manifest?.inbox;
  if (!inbox || typeof inbox !== 'object' || Array.isArray(inbox)) return undefined;
  const entries = Object.entries(inbox);
  if (entries.length === 0) return undefined;
  return entries.map(([channel, def]) => ({
    channel,
    ...(typeof def?.description === 'string' && def.description.trim().length > 0 ? { description: def.description } : {}),
    ...(def && 'example' in def && def.example !== undefined ? { example: def.example } : {}),
  }));
}

function parseAccess(args: Record<string, unknown>): PaprAccess {
  const rawLocal = args.local;
  const rawNetwork = args.network;
  if (rawLocal !== undefined || rawNetwork !== undefined) {
    if (rawLocal !== undefined && !LOCAL_ORDER.includes(rawLocal as PaprLocalAccess)) {
      throw new Error(`local 必须是 none/read/write，收到: ${JSON.stringify(rawLocal)}`);
    }
    if (rawNetwork !== undefined && typeof rawNetwork !== 'boolean') {
      throw new Error(`network 必须是布尔值，收到: ${JSON.stringify(rawNetwork)}`);
    }
    return { local: (rawLocal as PaprLocalAccess) ?? 'none', network: rawNetwork === true };
  }
  const level = typeof args.level === 'number' ? args.level : 1;
  if (![0, 1, 2, 3].includes(level)) throw new Error(`level 必须是 0/1/2/3，收到: ${args.level}`);
  return legacyLevelToAccess(level);
}

function validateAgentTools(params: { agents: Array<{ name: string; tools?: string[] }>; access: PaprAccess; disableWebSearchTools: boolean; }): void {
  const { agents, access, disableWebSearchTools } = params;
  for (const agent of agents) {
    if (!agent.tools) continue;
    for (const toolName of agent.tools) {
      if (typeof toolName !== 'string' || toolName.trim().length === 0) throw new Error(`agents[${agent.name}].tools 含非法工具名: ${JSON.stringify(toolName)}`);
      if (toolName === 'task' || toolName === 'app_render') throw new Error(`agents[${agent.name}].tools 不能声明 ${toolName}（App Agent 始终排除该工具）`);
      if (toolName.startsWith('mcp__')) {
        if (!access.network) throw new Error(`agents[${agent.name}].tools 声明了 MCP 工具 ${toolName}，MCP 工具需要 network: true（当前 network: ${access.network}）`);
        continue;
      }
      if (!accessMeetsTool(access, toolName)) throw new Error(`agents[${agent.name}].tools 中的 ${toolName} 不在当前访问档（local=${LOCAL_LABEL[access.local]}, network=${access.network}）允许范围内，请调整 manifest.json 的 local/network 或从 tools 中移除。`);
      if ((toolName === 'websearch' || toolName === 'webfetch') && disableWebSearchTools) throw new Error(`设置已启用 MCP 搜索，websearch/webfetch 不可用。请改为在 agents[${agent.name}].tools 中显式声明对应的 MCP 搜索工具（mcp__ 前缀名称），或在设置中关闭 MCP 搜索`);
    }
  }
}

function validateManifestAgents(raw: unknown): Array<{ name: string; tools?: string[]; }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('manifest.agents 必须是数组');
  const agents: Array<{ name: string; tools?: string[] }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('agents 每个元素必须是对象');
    const a = item as { name?: unknown; model?: unknown; maxToolRounds?: unknown; inheritContext?: unknown; tools?: string[]; };
    if (!a.name || typeof a.name !== 'string' || a.name.trim().length === 0) throw new Error('agents 每个元素必须包含非空 name 字段');
    if (a.name.length > 64) throw new Error(`agent name 超过 64 字符限制: ${a.name}`);
    if (a.model !== undefined && !['main', 'fast', 'mentor'].includes(String(a.model))) throw new Error(`agent model 必须是 main/fast/mentor，收到: ${a.model}`);
    if (a.maxToolRounds !== undefined && (typeof a.maxToolRounds !== 'number' || !Number.isInteger(a.maxToolRounds) || a.maxToolRounds < 1)) throw new Error(`agent maxToolRounds 必须是正整数: ${a.maxToolRounds}`);
    if (a.inheritContext !== undefined) {
      if (typeof a.inheritContext !== 'object' || a.inheritContext === null || Array.isArray(a.inheritContext)) throw new Error(`agent inheritContext 必须是对象: ${JSON.stringify(a.inheritContext)}`);
      const inherit = a.inheritContext as Record<string, unknown>;
      for (const field of ['skills', 'projectRules', 'projectMemory', 'customPrompt'] as const) {
        const val = inherit[field];
        if (val !== undefined && typeof val !== 'boolean') throw new Error(`agent inheritContext.${field} 必须是布尔值: ${val}`);
      }
    }
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
    const scanned = await invoke<Array<{ app_id: string; manifest_json: string | null; scope?: 'workspace' | 'global'; }>>('scan_workspace_apps', { workspacePath: workspacePath || '' });
    const match = scanned.find((d) => d.app_id === appId);
    if (match?.manifest_json) return { manifest: JSON.parse(match.manifest_json) as PaprManifest, scope: match.scope ?? 'workspace' };
  } catch { /* best-effort */ }
  return null;
}

export function registerWorkspaceAppTools(ctx: WorkspaceToolContext): void {
  const { registry, workspace } = ctx;
  registry.register(toolByName('app_render'), async (args: Record<string, unknown>) => {
    const writeKeys = APP_RENDER_WRITE_ARG_KEYS.filter((key) => args[key] !== undefined && args[key] !== null);
    if (writeKeys.length > 0) {
      throw new Error(`app_render 只打开已落盘的应用，不能写入文件。请用 write/edit/patch 把 ${writeKeys.join(', ')} 写入 .CodePapr/apps/<appId>/，然后只传 appId 调用 app_render({ appId })。`);
    }
    const rawAppId = asString(args.appId, 'appId');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) {
      throw new Error(`appId 必须是 kebab-case（仅小写字母、数字、连字符，1-63 字符），收到: ${rawAppId}`);
    }
    let appDir = `.CodePapr/apps/${rawAppId}`;
    const manifestPath = `${appDir}/manifest.json`;
    let manifestRaw = await readAppTextFile(workspace(), manifestPath);
    let appScope: 'workspace' | 'global' = 'workspace';
    if (!manifestRaw) {
      const resolved = await resolveAppManifest(rawAppId, workspace());
      if (!resolved) throw new Error(`找不到 ${manifestPath}。请先用 write 写入 manifest.json 和入口 HTML（如 index.html），再调用 app_render({ appId: "${rawAppId}" })。`);
      manifestRaw = JSON.stringify(resolved.manifest);
      appScope = resolved.scope;
      appDir = appScope === 'global' ? `~/.codepapr/apps/${rawAppId}` : appDir;
    }
    let manifest: PaprManifest;
    try { manifest = JSON.parse(manifestRaw) as PaprManifest; }
    catch { throw new Error(`${manifestPath} 不是合法 JSON。请用 write/edit 修好后再调用 app_render({ appId: "${rawAppId}" })。`); }
    const title = typeof manifest.name === 'string' ? manifest.name.trim() : '';
    if (title.length === 0) throw new Error(`${manifestPath} 缺少非空 name 字段`);
    const agents = validateManifestAgents(manifest.agents);
    const access = parseAccess(manifest as unknown as Record<string, unknown>);
    const kind = parsePaprKind(manifest);
    const command = typeof manifest.command === 'string' && manifest.command.trim().length > 0 ? manifest.command.trim() : undefined;
    const cmdArgs = Array.isArray(manifest.args) ? manifest.args.filter((item): item is string => typeof item === 'string') : undefined;
    const port = typeof manifest.port === 'number' ? manifest.port : undefined;
    const normalizedIcon = normalizeAppIcon(typeof manifest.icon === 'string' ? manifest.icon : undefined);
    if (command && (typeof port !== 'number' || port < 1024 || port > 65535)) throw new Error(`提供 command 时必须同时提供有效 port（1024-65535）`);
    if (!command && port !== undefined) throw new Error(`提供 port 时必须同时提供 command`);
    if (!command && cmdArgs && cmdArgs.length > 0) throw new Error(`提供 args 时必须同时提供 command`);
    if (command && access.local !== 'read' && access.local !== 'write') throw new Error(`后端服务（command）需要 local 至少为 read（当前 local: ${LOCAL_LABEL[access.local]}）。请在 manifest.json 中设置 local: "read" 或 local: "write"。`);
    if (kind === 'plugin' && command) throw new Error('插件不能带后端服务（command/args/port）。请改用 kind: "app"，或去掉 command。');
    if (kind === 'plugin' && access.local === 'write') throw new Error('插件不能声明 local: "write"。小组件不能改仓库；请改用 kind: "app"，或把 local 设为 none/read。');
    if (kind === 'plugin') parsePluginSurfaceArg(manifest.surface);
    validateManifestInbox(manifest);
    validateAgentTools({ agents, access, disableWebSearchTools: ctx.options.disableWebSearchTools ?? false });
    const entryFile = resolvePaprEntryFile(manifest);
    const indexRelativePath = `${appDir}/${entryFile}`;
    let entryHtml: string | null = null;
    if (appScope !== 'global') {
      entryHtml = await readAppTextFile(workspace(), indexRelativePath);
      if (entryHtml == null) throw new Error(`找不到入口文件 ${indexRelativePath}。请先用 write 写入该文件，再调用 app_render({ appId: "${rawAppId}" })。`);
    }
    await invoke('register_app_workspace', { appId: rawAppId, workspacePath: workspace() });
    useAppRuntimeStore.getState().mountApp({ appId: rawAppId, title, icon: normalizedIcon, html: '', filePath: indexRelativePath, command: command ?? undefined, args: cmdArgs ?? undefined, port: port ?? undefined, manifestJson: JSON.stringify(manifest), scope: appScope });
    const runtime = useAppRuntimeStore.getState();
    if (kind === 'plugin') {
      if (runtime.openedAppId === rawAppId) runtime.closeAppModal();
      runtime.pinPlugin(rawAppId);
    } else {
      runtime.unpinPlugin(rawAppId);
    }
    const hasBackend = !!command;
    const pluginHint = '插件已显示。有 inbox 的插件默认停靠右侧栏；可改回浮窗。收起只隐藏、不会停用；Agent 仍可 app_publish。';
    return {
      appId: rawAppId, title, icon: normalizedIcon ?? null, filePath: indexRelativePath,
      bytes: new TextEncoder().encode(entryHtml ?? '').length, mounted: true, kind, hasBackend,
      ...(kind === 'plugin' ? { pinned: true } : {}),
      ...(hasBackend ? { command, args: cmdArgs, port, hint: '应用已从磁盘打开并注册后端服务。用户点击"运行"启动后端后，可在管理面板点"打开"查看。后端进程运行在应用目录（.CodePapr/apps/<appId>/）下。修改文件后再次 app_render({ appId }) 即可刷新。' } : { hint: kind === 'plugin' ? pluginHint : '应用已从磁盘打开到应用管理面板。用户可点击"打开"查看。修改文件后再次 app_render({ appId }) 即可刷新。' }),
    };
  });

  registry.register(toolByName('app_list'), async () => {
    const storeApps = useAppRuntimeStore.getState().apps;
    const storeIds = new Set(storeApps.map((a) => a.appId));
    let diskApps: Array<{ app_id: string; title: string; command?: string; port?: number; manifest_json?: string | null }> = [];
    try {
      const discovered = await invoke<Array<{ app_id: string; title: string; command?: string; port?: number; manifest_json?: string | null }>>('scan_workspace_apps', { workspacePath: workspace() });
      diskApps = discovered.filter((d) => !storeIds.has(d.app_id));
    } catch { /* best-effort */ }
    let procs: Array<{ pid: number; previewUrl?: string; preview_url?: string }> = [];
    try { procs = await invoke('list_background_processes', { workspacePath: workspace() }); } catch { /* best-effort */ }
    const fromStore = storeApps.map((app) => {
      const match = findPreviewProcessForPort(procs, app.port);
      const regRunning = match !== undefined;
      const regUrl = match ? processPreviewUrl(match) ?? null : null;
      const plugin = isPluginApp(app);
      const chrome = useAppRuntimeStore.getState().pluginChrome[app.appId];
      return { appId: app.appId, title: app.title, kind: plugin ? 'plugin' : 'app', hasBackend: !!(app.command && app.port), isRunning: !!(app.pid && app.url) || regRunning, pinned: useAppRuntimeStore.getState().pinnedPluginIds.includes(app.appId), enabled: plugin ? pluginIsEnabled(readAppManifest(app), chrome) : undefined, port: app.port ?? null, url: app.url ?? (regRunning ? regUrl : null), inbox: summarizeManifestInbox(readAppManifest(app)) };
    });
    const fromDisk = diskApps.map((d) => {
      const match = findPreviewProcessForPort(procs, d.port);
      const regRunning = match !== undefined;
      const regUrl = match ? processPreviewUrl(match) ?? null : null;
      const diskManifest = readAppManifest({ manifestJson: d.manifest_json ?? undefined });
      const plugin = diskManifest?.kind === 'plugin';
      return { appId: d.app_id, title: d.title, kind: plugin ? 'plugin' : 'app', hasBackend: !!(d.command && d.port), isRunning: regRunning, pinned: false, enabled: plugin ? pluginIsEnabled(diskManifest, undefined) : undefined, port: d.port ?? null, url: regRunning ? regUrl : null, inbox: summarizeManifestInbox(diskManifest) };
    });
    return [...fromStore, ...fromDisk];
  });

  registry.register(toolByName('app_start'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);
    if (!app.command || !app.port) throw new Error(`应用 '${appId}' 没有后端服务`);
    if (app.pid) throw new Error(`应用 '${appId}' 后端已在运行 (pid: ${app.pid})`);
    const { pid, url } = await launchAppBackend({ appId, command: app.command, args: app.args ?? [], port: app.port, manifestJson: app.manifestJson }, workspace());
    useAppRuntimeStore.getState().setAppRunning(appId, pid, url);
    return { appId, pid, url, started: true };
  });

  registry.register(toolByName('app_stop'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);
    if (!app.pid) throw new Error(`应用 '${appId}' 后端未在运行`);
    let killFailed = false;
    try { await invoke('stop_background_process', { pid: app.pid, source: 'app_stop-tool' }); } catch { killFailed = true; }
    try { await invoke('unregister_app_backend_port', { appId }); } catch { /* best-effort */ }
    useAppRuntimeStore.getState().setAppStopped(appId);
    return { appId, stopped: true, ...(killFailed ? { warning: '进程停止命令失败，后端进程可能仍在运行并占用端口。' } : {}) };
  });

  registry.register(toolByName('app_delete'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);
    if (app.pid) { try { await invoke('stop_background_process', { pid: app.pid, source: 'app_delete-tool' }); } catch { /* best-effort */ } }
    try { await invoke('papr_delete_app', { appId }); } catch { /* best-effort */ }
    try { await invoke('unregister_app_workspace', { appId }); } catch { /* best-effort */ }
    usePaprPermissionStore.getState().clearManifest(appId);
    useAppRuntimeStore.getState().closeApp(appId);
    return { appId, deleted: true };
  });

  registry.register(toolByName('app_publish'), async (args: Record<string, unknown>) => {
    const rawAppId = asString(args.appId, 'appId');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) throw new Error(`appId 必须是 kebab-case（仅小写字母、数字、连字符，1-63 字符），收到: ${rawAppId}`);
    const channel = asString(args.channel, 'channel');
    if (!APP_PUBLISH_CHANNEL_RE.test(channel)) throw new Error(`channel 必须字母/数字开头，仅字母/数字/-/_，1-64 字符，收到: ${channel}`);
    if (args.payload === undefined || args.payload === null) throw new Error('payload 必填，且必须是 JSON 值（对象/数组/字符串等）');
    const payloadJson = JSON.stringify(args.payload);
    if (new TextEncoder().encode(payloadJson).length > APP_PUBLISH_MAX_PAYLOAD_BYTES) throw new Error('payload 超过 256KB 上限：请拆分或摘要后再推送，不要把大文件内容塞进应用存储');
