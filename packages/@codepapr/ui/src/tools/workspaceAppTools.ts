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
import { normalizeWorkspaceId } from '../papr/projectRecordScope';
import { isPluginApp, parsePaprKind, parsePluginSurfaceArg, pluginIsEnabled, readAppManifest, resolvePaprEntryFile, shouldRevealOnPublish } from '../papr/pluginSurface';
import { postAppEvent } from '../papr/appChannelHub';
import { findPreviewProcessForPort, processPreviewUrl } from '../utils/loopbackPreview';
import { pushDebugLog } from '../store/debugLogStore';
import { platformSandboxWarning } from '../utils/platformSandbox';
import { type WorkspaceToolContext } from './workspaceToolContext';

/** app_render 禁止携带的写文件/清单字段：这些必须用 write/edit/patch 落盘。 */
const APP_RENDER_WRITE_ARG_KEYS = [
  'html',
  'files',
  'title',
  'kind',
  'surface',
  'agents',
  'local',
  'network',
  'command',
  'args',
  'port',
  'icon',
  'permissions',
  'level',
] as const;

const LOCAL_LABEL: Record<PaprLocalAccess, string> = {
  none: '无',
  read: '只读',
  write: '读写执行',
};

/** app 图标：写入 manifest 以便扫描恢复。空串忽略；过长或含路径字符拒绝。 */
function normalizeAppIcon(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 16 || /[\n\r\\/]/.test(trimmed)) {
    throw new Error(`icon 必须是不超过 16 个字符的 emoji 或短标签，收到: ${JSON.stringify(raw)}`);
  }
  return trimmed;
}

/** app_publish 频道名：字母/数字开头，1-64 位（与 Rust 侧长度上限一致）。 */
const APP_PUBLISH_CHANNEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** app_publish 单条 payload 上限：防止把大文件内容塞进 app db。 */
const APP_PUBLISH_MAX_PAYLOAD_BYTES = 256 * 1024;

/** manifest inbox 频道声明（契约）：app_publish 只允许命中已声明频道。 */
export interface PaprInboxSummary {
  channel: string;
  description?: string;
  example?: unknown;
}

/**
 * 校验 manifest.inbox 声明。未声明（undefined）合法 = 不启用契约；
 * 声明则每个频道名必须合法、定义必须是对象。app_render 挂载前调用，
 * 让 agent 在创建应用时就拿到明确报错。
 */
export function validateManifestInbox(manifest: PaprManifest): void {
  const inbox = manifest.inbox;
  if (inbox === undefined) return;
  if (typeof inbox !== 'object' || inbox === null || Array.isArray(inbox)) {
    throw new Error(
      'manifest inbox 必须是对象：{ "<channel>": { "description": "...", "example": {...} } }',
    );
  }
  for (const [channel, def] of Object.entries(inbox)) {
    if (!APP_PUBLISH_CHANNEL_RE.test(channel)) {
      throw new Error(
        `inbox 频道名 '${channel}' 非法：须字母/数字开头，仅字母/数字/-/_，1-64 字符`,
      );
    }
    if (typeof def !== 'object' || def === null || Array.isArray(def)) {
      throw new Error(`inbox.${channel} 必须是对象（{ description?, example? }）`);
    }
    if (def.description !== undefined && typeof def.description !== 'string') {
      throw new Error(`inbox.${channel}.description 必须是字符串`);
    }
  }
}

/** 从 manifest 提取 inbox 摘要（app_list 输出，供 agent 发现推送契约）。 */
export function summarizeManifestInbox(manifest: PaprManifest | null | undefined): PaprInboxSummary[] | undefined {
  const inbox = manifest?.inbox;
  if (!inbox || typeof inbox !== 'object' || Array.isArray(inbox)) return undefined;
  const entries = Object.entries(inbox);
  if (entries.length === 0) return undefined;
  return entries.map(([channel, def]) => ({
    channel,
    ...(typeof def?.description === 'string' && def.description.trim().length > 0
      ? { description: def.description }
      : {}),
    ...(def && 'example' in def && def.example !== undefined ? { example: def.example } : {}),
  }));
}

/**
 * 解析 manifest 的访问参数：优先 local/network（两轴），缺省回落旧 level。
 */
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
    return {
      local: (rawLocal as PaprLocalAccess) ?? 'none',
      network: rawNetwork === true,
    };
  }
  // 旧 level 参数迁移
  const level = typeof args.level === 'number' ? args.level : 1;
  if (![0, 1, 2, 3].includes(level)) {
    throw new Error(`level 必须是 0/1/2/3，收到: ${args.level}`);
  }
  return legacyLevelToAccess(level);
}

/**
 * 校验 agents[].tools 白名单（两轴模型）：声明即契约，runtime 不再静默裁剪。
 * 在渲染时报错让模型立即修正，而不是让 app 运行时工具神秘失效。
 */
function validateAgentTools(params: {
  agents: Array<{ name: string; tools?: string[] }>;
  access: PaprAccess;
  disableWebSearchTools: boolean;
}): void {
  const { agents, access, disableWebSearchTools } = params;

  for (const agent of agents) {
    if (!agent.tools) continue;

    for (const toolName of agent.tools) {
      if (typeof toolName !== 'string' || toolName.trim().length === 0) {
        throw new Error(`agents[${agent.name}].tools 含非法工具名: ${JSON.stringify(toolName)}`);
      }
      if (toolName === 'task' || toolName === 'app_render') {
        throw new Error(`agents[${agent.name}].tools 不能声明 ${toolName}（App Agent 始终排除该工具）`);
      }
      if (toolName.startsWith('mcp__')) {
        if (!access.network) {
          throw new Error(`agents[${agent.name}].tools 声明了 MCP 工具 ${toolName}，MCP 工具需要 network: true（当前 network: ${access.network}）`);
        }
        continue;
      }
      if (!accessMeetsTool(access, toolName)) {
        throw new Error(
          `agents[${agent.name}].tools 中的 ${toolName} 不在当前访问档（local=${LOCAL_LABEL[access.local]}, network=${access.network}）允许范围内，请调整 manifest.json 的 local/network 或从 tools 中移除。`
        );
      }
      if ((toolName === 'websearch' || toolName === 'webfetch') && disableWebSearchTools) {
        throw new Error(`设置已启用 MCP 搜索，websearch/webfetch 不可用。请改为在 agents[${agent.name}].tools 中显式声明对应的 MCP 搜索工具（mcp__ 前缀名称），或在设置中关闭 MCP 搜索`);
      }
    }
  }
}

function validateManifestAgents(raw: unknown): Array<{
  name: string;
  tools?: string[];
}> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('manifest.agents 必须是数组');
  }
  const agents: Array<{ name: string; tools?: string[] }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('agents 每个元素必须是对象');
    }
    const a = item as {
      name?: unknown;
      model?: unknown;
      maxToolRounds?: unknown;
      inheritContext?: unknown;
      tools?: string[];
    };
    if (!a.name || typeof a.name !== 'string' || a.name.trim().length === 0) {
      throw new Error('agents 每个元素必须包含非空 name 字段');
    }
    if (a.name.length > 64) {
      throw new Error(`agent name 超过 64 字符限制: ${a.name}`);
    }
    if (a.model !== undefined && !['main', 'fast', 'mentor'].includes(String(a.model))) {
      throw new Error(`agent model 必须是 main/fast/mentor，收到: ${a.model}`);
    }
    if (
      a.maxToolRounds !== undefined &&
      (typeof a.maxToolRounds !== 'number' || !Number.isInteger(a.maxToolRounds) || a.maxToolRounds < 1)
    ) {
      throw new Error(`agent maxToolRounds 必须是正整数: ${a.maxToolRounds}`);
    }
    if (a.inheritContext !== undefined) {
      if (typeof a.inheritContext !== 'object' || a.inheritContext === null || Array.isArray(a.inheritContext)) {
        throw new Error(`agent inheritContext 必须是对象: ${JSON.stringify(a.inheritContext)}`);
      }
      const inherit = a.inheritContext as Record<string, unknown>;
      for (const field of ['skills', 'projectRules', 'projectMemory', 'customPrompt'] as const) {
        const val = inherit[field];
        if (val !== undefined && typeof val !== 'boolean') {
          throw new Error(`agent inheritContext.${field} 必须是布尔值: ${val}`);
        }
      }
    }
    agents.push({ name: a.name, tools: a.tools });
  }
  return agents;
}

async function readAppTextFile(
  workspacePath: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const file = await invoke<ReadFileResult>('read_text_file', {
      workspacePath,
      relativePath,
      maxBytes: 2_000_000,
    });
    return typeof file?.content === 'string' ? file.content : null;
  } catch {
    return null;
  }
}

export async function resolveAppManifest(
  appId: string,
  workspacePath: string,
): Promise<{ manifest: PaprManifest; scope: 'global' | 'workspace' } | null> {
  const inStore = useAppRuntimeStore.getState().apps.find((a) => a.appId === appId);
  if (inStore?.manifestJson) {
    try {
      return { manifest: JSON.parse(inStore.manifestJson) as PaprManifest, scope: inStore.scope ?? 'workspace' };
    } catch {
      /* ignore */
    }
  }
  if (workspacePath) {
    const wsManifestRaw = await readAppTextFile(workspacePath, `.CodePapr/apps/${appId}/manifest.json`);
    if (wsManifestRaw) {
      try {
        return { manifest: JSON.parse(wsManifestRaw) as PaprManifest, scope: 'workspace' };
      } catch {
        /* ignore */
      }
    }
  }
  try {
    const scanned = await invoke<Array<{ app_id: string; manifest_json: string | null; scope?: 'workspace' | 'global' }>>(
      'scan_workspace_apps',
      { workspacePath: workspacePath || '' },
    );
    const match = scanned.find((d) => d.app_id === appId);
    if (match?.manifest_json) {
      return { manifest: JSON.parse(match.manifest_json) as PaprManifest, scope: match.scope ?? 'workspace' };
    }
  } catch {
    /* best-effort */
  }
  return null;
}

export function registerWorkspaceAppTools(ctx: WorkspaceToolContext): void {
  const { registry, workspace } = ctx;

  registry.register(toolByName('app_render'), async (args: Record<string, unknown>) => {
    const writeKeys = APP_RENDER_WRITE_ARG_KEYS.filter((key) => {
      const value = args[key];
      return value !== undefined && value !== null;
    });
    if (writeKeys.length > 0) {
      throw new Error(
        `app_render 只打开已落盘的应用，不能写入文件。请用 write/edit/patch 把 ${writeKeys.join(', ')} 写入 .CodePapr/apps/<appId>/，然后只传 appId 调用 app_render({ appId })。`,
      );
    }

    const rawAppId = asString(args.appId, 'appId');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) {
      throw new Error(
        `appId 必须是 kebab-case（仅小写字母、数字、连字符，1-63 字符），收到: ${rawAppId}`,
      );
    }

    let appDir = `.CodePapr/apps/${rawAppId}`;
    const manifestPath = `${appDir}/manifest.json`;
    let manifestRaw = await readAppTextFile(workspace(), manifestPath);
    let appScope: 'workspace' | 'global' = 'workspace';
    if (!manifestRaw) {
      const resolved = await resolveAppManifest(rawAppId, workspace());
      if (!resolved) {
        throw new Error(
          `找不到 ${manifestPath}。请先用 write 写入 manifest.json 和入口 HTML（如 index.html），再调用 app_render({ appId: "${rawAppId}" })。`,
        );
      }
      manifestRaw = JSON.stringify(resolved.manifest);
      appScope = resolved.scope;
      appDir = appScope === 'global' ? `~/.codepapr/apps/${rawAppId}` : appDir;
    }

    let manifest: PaprManifest;
    try {
      manifest = JSON.parse(manifestRaw) as PaprManifest;
    } catch {
      throw new Error(
        `${manifestPath} 不是合法 JSON。请用 write/edit 修好后再调用 app_render({ appId: "${rawAppId}" })。`,
      );
    }

    const title = typeof manifest.name === 'string' ? manifest.name.trim() : '';
    if (title.length === 0) {
      throw new Error(`${manifestPath} 缺少非空 name 字段`);
    }

    const agents = validateManifestAgents(manifest.agents);
    const access = parseAccess(manifest as unknown as Record<string, unknown>);
    const kind = parsePaprKind(manifest);
    const command =
      typeof manifest.command === 'string' && manifest.command.trim().length > 0
        ? manifest.command.trim()
        : undefined;
    const cmdArgs = Array.isArray(manifest.args)
      ? manifest.args.filter((item): item is string => typeof item === 'string')
      : undefined;
    const port = typeof manifest.port === 'number' ? manifest.port : undefined;
    const normalizedIcon = normalizeAppIcon(
      typeof manifest.icon === 'string' ? manifest.icon : undefined,
    );

    if (command && (typeof port !== 'number' || port < 1024 || port > 65535)) {
      throw new Error(`提供 command 时必须同时提供有效 port（1024-65535）`);
    }
    if (!command && port !== undefined) {
      throw new Error(`提供 port 时必须同时提供 command`);
    }
    if (!command && cmdArgs && cmdArgs.length > 0) {
      throw new Error(`提供 args 时必须同时提供 command`);
    }
    if (command && access.local !== 'read' && access.local !== 'write') {
      throw new Error(
        `后端服务（command）需要 local 至少为 read（当前 local: ${LOCAL_LABEL[access.local]}）。请在 manifest.json 中设置 local: "read" 或 local: "write"。`,
      );
    }
    if (kind === 'plugin' && command) {
      throw new Error('插件不能带后端服务（command/args/port）。请改用 kind: "app"，或去掉 command。');
    }
    if (kind === 'plugin' && access.local === 'write') {
      throw new Error(
        '插件不能声明 local: "write"。小组件不能改仓库；请改用 kind: "app"，或把 local 设为 none/read。',
      );
    }
    if (kind === 'plugin') {
      parsePluginSurfaceArg(manifest.surface);
    }

    validateManifestInbox(manifest);

    validateAgentTools({
      agents,
      access,
      disableWebSearchTools: ctx.options.disableWebSearchTools ?? false,
    });

    const entryFile = resolvePaprEntryFile(manifest);
    const indexRelativePath = `${appDir}/${entryFile}`;
    let entryHtml = '';
    if (appScope !== 'global') {
      const diskHtml = await readAppTextFile(workspace(), indexRelativePath);
      if (diskHtml == null) {
        throw new Error(
          `找不到入口文件 ${indexRelativePath}。请先用 write 写入该文件，再调用 app_render({ appId: "${rawAppId}" })。`,
        );
      }
      entryHtml = diskHtml;
    }

    await invoke('register_app_workspace', {
      appId: rawAppId,
      workspacePath: workspace(),
      manifestJson: JSON.stringify(manifest),
    });

    useAppRuntimeStore.getState().mountApp({
      appId: rawAppId,
      title,
      icon: normalizedIcon,
      html: '',
      filePath: indexRelativePath,
      command: command ?? undefined,
      args: cmdArgs ?? undefined,
      port: port ?? undefined,
      manifestJson: JSON.stringify(manifest),
      scope: appScope,
    });
    const runtime = useAppRuntimeStore.getState();
    if (kind === 'plugin') {
      if (runtime.openedAppId === rawAppId) runtime.closeAppModal();
      runtime.pinPlugin(rawAppId);
    } else {
      runtime.unpinPlugin(rawAppId);
    }

    const hasBackend = !!command;
    const pluginHint =
      '插件已显示。有 inbox 的插件默认停靠右侧栏；可改回浮窗。收起只隐藏、不会停用；Agent 仍可 app_publish。';
    return {
      appId: rawAppId,
      title,
      icon: normalizedIcon ?? null,
      filePath: indexRelativePath,
      bytes: new TextEncoder().encode(entryHtml).length,
      mounted: true,
      kind,
      scope: appScope,
      hasBackend,
      ...(kind === 'plugin' ? { pinned: true } : {}),
      ...(hasBackend
        ? {
            command,
            args: cmdArgs,
            port,
            hint: '应用已从磁盘打开并注册后端服务。用户点击"运行"启动后端后，可在管理面板点"打开"查看。后端进程运行在应用目录（.CodePapr/apps/<appId>/）下。修改文件后再次 app_render({ appId }) 即可刷新。',
          }
        : {
            hint:
              kind === 'plugin'
                ? pluginHint
                : '应用已从磁盘打开到应用管理面板。用户可点击"打开"查看。修改文件后再次 app_render({ appId }) 即可刷新。',
          }),
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

    // Ground truth for running backends: the Rust process registry (survives
    // webview reloads). D-13: match via loopbackPreview (localhost/127.0.0.1/::1
    // 与大小写容错)——旧实现用 `http://localhost:<port>/` 字符串相等比对，
    // 后端登记的 preview_url 常是 127.0.0.1，app_list 因此漏判 running。
    interface PreviewProc { pid: number; previewUrl?: string; preview_url?: string }
    let procs: PreviewProc[] = [];
    try {
      procs = await invoke<PreviewProc[]>('list_background_processes', { workspacePath: workspace() });
    } catch { /* best-effort */ }
    const urlForPort = (port?: number | null): string | null => (port ? `http://localhost:${port}/` : null);
    const liveUrlForPort = (port?: number | null): string | null => {
      const proc = findPreviewProcessForPort(procs, port ?? null);
      return proc ? processPreviewUrl(proc) ?? urlForPort(port) : null;
    };

    const fromStore = storeApps.map((app) => {
      const regUrl = liveUrlForPort(app.port);
      const regRunning = regUrl !== null;
      const plugin = isPluginApp(app);
      const chrome = useAppRuntimeStore.getState().pluginChrome[app.appId];
      return {
        appId: app.appId,
        title: app.title,
        kind: plugin ? 'plugin' : 'app',
        hasBackend: !!(app.command && app.port),
        isRunning: !!(app.pid && app.url) || regRunning,
        pinned: useAppRuntimeStore.getState().pinnedPluginIds.includes(app.appId),
        enabled: plugin ? pluginIsEnabled(readAppManifest(app), chrome) : undefined,
        port: app.port ?? null,
        url: app.url ?? (regRunning ? regUrl : null),
        inbox: summarizeManifestInbox(readAppManifest(app)),
      };
    });
    const fromDisk = diskApps.map((d) => {
      const regUrl = liveUrlForPort(d.port);
      const regRunning = regUrl !== null;
      const diskManifest = readAppManifest({ manifestJson: d.manifest_json ?? undefined });
      const plugin = diskManifest?.kind === 'plugin';
      return {
        appId: d.app_id,
        title: d.title,
        kind: plugin ? 'plugin' : 'app',
        hasBackend: !!(d.command && d.port),
        isRunning: regRunning,
        pinned: false,
        enabled: plugin ? pluginIsEnabled(diskManifest, undefined) : undefined,
        port: d.port ?? null,
        url: regRunning ? regUrl : null,
        inbox: summarizeManifestInbox(diskManifest),
      };
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

    const { pid, url } = await launchAppBackend(
      { appId, command: app.command, args: app.args ?? [], port: app.port, manifestJson: app.manifestJson },
      workspace(),
    );
    useAppRuntimeStore.getState().setAppRunning(appId, pid, url);
    return { appId, pid, url, started: true };
  });

  registry.register(toolByName('app_stop'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);

    // D-13：与 app_list 同一判定——webview reload 后 store 丢了 pid 但后端
    // 进程仍在 Rust 注册表里活着时，按 manifest.port 找回 pid 再停，
    // 不再误报「未在运行」。
    let pid = app.pid ?? null;
    if (!pid && app.port) {
      try {
        interface PreviewProc { pid: number; previewUrl?: string; preview_url?: string }
        const procs = await invoke<PreviewProc[]>('list_background_processes', {
          workspacePath: workspace(),
        });
        pid = findPreviewProcessForPort(procs, app.port)?.pid ?? null;
      } catch {
        /* best-effort */
      }
    }
    if (!pid) throw new Error(`应用 '${appId}' 后端未在运行`);

    let killFailed = false;
    try { await invoke('stop_background_process', { pid, source: 'app_stop-tool' }); } catch { killFailed = true; }
    try { await invoke('unregister_app_backend_port', { appId }); } catch { /* best-effort */ }
    useAppRuntimeStore.getState().setAppStopped(appId);
    return { appId, stopped: true, pid, ...(killFailed ? { warning: '进程停止命令失败，后端进程可能仍在运行并占用端口。' } : {}) };
  });

  registry.register(toolByName('app_delete'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);

    // 工具定义承诺「会同时停止后端进程」：必须显式先停，不能只删文件——
    // 旧实现依赖 papr_delete_app 按 manifest.port 快照停进程，manifest 无
    // port/加载失败时后端进程变孤儿继续占端口，store 清空后再也看不到。
    if (app.pid) {
      try { await invoke('stop_background_process', { pid: app.pid, source: 'app_delete-tool' }); } catch { /* best-effort */ }
    }
    try { await invoke('papr_delete_app', { appId }); } catch { /* best-effort */ }
    try { await invoke('unregister_app_workspace', { appId }); } catch { /* best-effort */ }
    usePaprPermissionStore.getState().clearManifest(appId);
    useAppRuntimeStore.getState().closeApp(appId);
    return { appId, deleted: true };
  });

  registry.register(toolByName('app_publish'), async (args: Record<string, unknown>) => {
    const rawAppId = asString(args.appId, 'appId');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) {
      throw new Error(
        `appId 必须是 kebab-case（仅小写字母、数字、连字符，1-63 字符），收到: ${rawAppId}`,
      );
    }
    const channel = asString(args.channel, 'channel');
    if (!APP_PUBLISH_CHANNEL_RE.test(channel)) {
      throw new Error(
        `channel 必须字母/数字开头，仅字母/数字/-/_，1-64 字符，收到: ${channel}`,
      );
    }
    if (args.payload === undefined || args.payload === null) {
      throw new Error('payload 必填，且必须是 JSON 值（对象/数组/字符串等）');
    }
    const payloadJson = JSON.stringify(args.payload);
    if (new TextEncoder().encode(payloadJson).length > APP_PUBLISH_MAX_PAYLOAD_BYTES) {
      throw new Error('payload 超过 256KB 上限：请拆分或摘要后再推送，不要把大文件内容塞进应用存储');
    }

    // 目标应用必须已存在（磁盘 manifest 为准，与 app_render 同一事实源）
    const manifestPath = `.CodePapr/apps/${rawAppId}/manifest.json`;
    let manifestRaw = await readAppTextFile(workspace(), manifestPath);
    if (!manifestRaw) {
      const resolved = await resolveAppManifest(rawAppId, workspace());
      if (!resolved) {
        throw new Error(
          `找不到 ${manifestPath}。app_publish 只推送给已存在的应用——先在 App 模式用 write 写好 manifest.json 与页面并 app_render({ appId: "${rawAppId}" })。`,
        );
      }
      manifestRaw = JSON.stringify(resolved.manifest);
    }
    let manifest: PaprManifest;
    try {
      manifest = JSON.parse(manifestRaw) as PaprManifest;
    } catch {
      throw new Error(`${manifestPath} 不是合法 JSON，请修复 manifest 后再推送。`);
    }

    // inbox 契约：声明了 inbox 的应用只接受已声明频道；报错带出全部可用频道
    // 与描述，LLM 可自我纠正重发。未声明 inbox 的应用不限制（向后兼容）。
    const inbox = manifest.inbox;
    if (inbox && typeof inbox === 'object' && !Array.isArray(inbox)) {
      if (!Object.prototype.hasOwnProperty.call(inbox, channel)) {
        const available = Object.entries(inbox)
          .map(([name, def]) => {
            const description = def && typeof def.description === 'string' ? def.description : '';
            return `  - ${name}${description ? `：${description}` : ''}`;
          })
          .join('\n');
        throw new Error(
          `应用 '${rawAppId}' 未声明频道 '${channel}'。可用频道：\n${available || '  （无）'}\n请按 manifest inbox 的 description/example 形状重新推送。`,
        );
      }
    }

    // 数据面：Rust 原子追加（进程锁 + BEGIN IMMEDIATE，并发不丢事件）。
    // app db 随 workspace 打开已注册（App.tsx 扫描恢复），无需先 app_render。
    const { seq, ts } = await invoke<{ seq: number; ts: number }>('papr_inbox_append', {
      appId: rawAppId,
      channel,
      payload: args.payload,
    });

    // 通知面：已挂载则实时送达（SDK papr.events.on）；未挂载仅落库。
    const delivered = postAppEvent(rawAppId, { channel, seq, ts, payload: args.payload });

    if (parsePaprKind(manifest) === 'plugin') {
      const runtime = useAppRuntimeStore.getState();
      if (
        shouldRevealOnPublish(
          manifest,
          runtime.pluginChrome[rawAppId],
          runtime.pinnedPluginIds.includes(rawAppId),
        )
      ) {
        runtime.pinPlugin(rawAppId);
      }
    }

    return {
      appId: rawAppId,
      channel,
      seq,
      delivered,
      hint: delivered
        ? '已实时推送到挂载中的应用（papr.events.on 收到事件）。'
        : `事件已写入应用存储（papr.db 键 inbox:${channel}），应用打开时可回放历史；当前应用未挂载。`,
    };
  });

}

export interface AppLaunchTarget {
  appId: string;
  command: string;
  args: string[];
  port: number;
  manifestJson?: string;
}

/** 后端 app 启动核心路径：manifest 两轴沙箱 + 依赖安装 + 端口分配 + spawn + 轮询等待监听 +
 * 失败时捕获进程输出。app_start 工具与应用面板 ▶ 按钮都走这里——
 * 保证无论从哪启动，沙箱权限、校验与诊断行为完全一致。 */
export async function launchAppBackend(
  app: AppLaunchTarget,
  workspacePath: string,
): Promise<{ pid: number; url: string }> {
  // 后端沙箱按生效档（manifest ∩ 用户设置）构建：设置收窄后新启动的进程必须跟着收窄。
  const appAccess = await resolveLaunchAccess(app.appId, app.manifestJson, workspacePath);
  if (appAccess.local !== 'read' && appAccess.local !== 'write') {
    throw new Error(`应用 '${app.appId}' 的 local 访问为 ${appAccess.local}，不允许启动后端服务`);
  }
  // C-5：非 macOS 平台两轴沙箱不生效，收窄档只是纸面承诺——向 UI 推告警。
  const sandboxWarning = platformSandboxWarning({
    network: appAccess.network,
    local: appAccess.local,
  });
  if (sandboxWarning) pushDebugLog('app', `[${app.appId}] ${sandboxWarning}`);

  try {
    // 离线档（network:false）禁止 npm 拉包：Rust 侧 node_modules 缺失时直接报错，
    // 已装则跳过——声明完全离线的本地后端 app 不再被静默放行联网。
    await invoke<string>('install_app_npm_deps', {
      workspacePath,
      appId: app.appId,
      allowNetwork: appAccess.network,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`应用 '${app.appId}' 安装依赖失败：${detail}`);
  }

  const preferred = app.port;
  let port = preferred;
  try {
    port = await invoke<number>('allocate_app_port', { preferred });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`应用 '${app.appId}' 无法分配端口 ${preferred}：${detail}`);
  }

  const url = `http://127.0.0.1:${port}/`;
  // cwd 必须是 app 目录：manifest args 里的相对脚本（如 "server.js"）相对
  // 该目录解析。用工作区根当 cwd 时 node 会「Cannot find module」秒退，
  // 表现为端口轮询全 refused 的启动失败（math-mentor 事故）。
  // 走 start_app_background_command：由服务端 resolve_app_dir 按 appId 解析目录，
  // global 应用（~/.codepapr/apps/<id>）不再被硬编码成 <ws>/.CodePapr/apps 而启动失败。
  const result = await invoke<{ pid: number }>('start_app_background_command', {
    workspacePath,
    appId: app.appId,
    command: app.command,
    args: app.args,
    previewUrl: url,
    sandbox: {
      network: appAccess.network,
      workspaceWrite: appAccess.local === 'write',
      allowBind: true,
    },
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
    },
  });

  // 轮询等待端口被监听：冷启动（尤其刚跑完 npm install）可能超过固定短等待，
  // 过早判失败会误杀正在启动的进程（随后它又绑上端口，变成 store 追踪不到的孤儿）。
  const PORT_POLL_INTERVAL_MS = 250;
  const PORT_POLL_TIMEOUT_MS = 20_000;
  const deadline = Date.now() + PORT_POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  const pollTrace: string[] = [];
  let portTaken = false;
  let portOwnedByUs = false;
  let pollError = '';
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
      // 结构化探测：v4/v6 各自 connect 是否成功（有监听即视为被占用）。
      // 旧实现靠 !detail.includes('conn') 子串解析诊断文本判状态——文本里出现
      // "conn"（如 err:ConnectionRefused 之外的措辞）就会翻转判定，改用
      // 结构化布尔字段彻底消除对文案的依赖。
      const probe = await invoke<{ v4: boolean; v6: boolean }>('check_port_available_structured', {
        port,
      });
      const available = !probe.v4 && !probe.v6;
      let detail = 'n/a';
      try {
        detail = await invoke<string>('check_port_available_detail', { port });
      } catch { /* detail 缺失不致命 */ }
      pollTrace.push(`+${Date.now() - startedAt}ms:${detail}`);
      if (!available) {
        portTaken = true;
        // TOCTOU 修复：端口被监听 ≠ 我们 spawn 的进程在监听。外部进程在
        // 预检之后抢占端口时，旧实现照样判「启动成功」并返回死进程 pid。
        // 归属按进程组判定（后端经 sandbox-exec 包装时，注册 pid 是包装进程，
        // 真正监听的是组内 node，二者 pid 不等但 pgid 相同）。拿不到 lsof
        // （容器/CI）时退化为仅存活检查。
        try {
          portOwnedByUs = await invoke<boolean>('check_port_owned_by', {
            port,
            pid: result.pid,
          });
        } catch {
          portOwnedByUs = true;
        }
        break;
      }
      if (Date.now() >= deadline) break;
    }
  } catch (err) {
    // 探测命令异常（如命令未注册）绝不能把进程留在"活着但无人认领"的中间态：
    // 记录错误并走统一失败分支清理，保证"要么成功接管、要么清理干净"。
    pollError = err instanceof Error ? err.message : String(err);
    pollTrace.push(`+${Date.now() - startedAt}ms:ERROR(${pollError})`);
  }
  if (!portTaken || !portOwnedByUs) {
    // 先取进程勘验信息再停掉它：spawn 秒退的真实原因（如 sandbox-exec
    // 找不到 node、脚本语法错误）只存在于捕获的输出，不捞出来就死无对证。
    // 旧实现用 list_background_processes——它内部先跑 cleanup，死亡条目连同
    // log_tail 已被移除，秒退进程永远取不到输出。exit_info 对已退出进程返回
    // 归档的退出码 + 回收前捕获的输出，agent 凭真实报错自行修复应用。
    const exitInfo = await fetchProcessExitInfo(result.pid);
    // Kill the spawned child so a slow-starting server does not become an
    // orphan that later grabs the port untracked by the store.
    try { await invoke('stop_background_process', { pid: result.pid, source: 'app_start-failure' }); } catch { /* best-effort */ }
    try { await invoke('log_ui_event', { workspacePath, message: `app_start-failure ${app.appId} port=${port} pid=${result.pid} ownedByUs=${portOwnedByUs} polls=[${pollTrace.join(' ')}]` }); } catch { /* best-effort */ }
    const detail = formatExitDetail(exitInfo);
    const reason = !portTaken
      ? (pollError ? `端口探测失败（${pollError}）` : `进程未能监听端口${formatExitStatus(exitInfo)}`)
      : '端口监听者不是本次启动的进程（可能被外部进程抢占）';
    throw new Error(
      `应用 '${app.appId}' 后端启动失败：${reason}。请根据进程输出定位问题（常见：args 脚本路径错误、依赖缺失、语法错误、端口占用），修复后用 app_start 重新启动。${detail}`,
    );
  }

  // #60 回环约束：沙箱 SBPL 的 network-bind 地址过滤对本平台无效（实测
  // (local ip ...) 过滤器不限制 bind 地址，bind 0.0.0.0 照样成功），回环
  // 强制放这里做。注意：`*`（IPv6 双栈通配）是 node listen(PORT) 的平台
  // 默认，绝大多数后端无法修改，且它回环可达（connect 探测能通）——因此
  // `*` 仅落 warning 不判失败；只有监听在具体的非回环 IP（如 192.168.x.x）
  // 才判定暴露到局域网并拒绝启动。拿不到 lsof（容器/CI）时跳过。
  let bindHosts: string[] = [];
  try {
    bindHosts = await invoke<string[]>('check_port_bind_address', { port });
  } catch {
    bindHosts = [];
  }
  const wildcardHosts = bindHosts.filter((host) => isWildcardBindHost(host));
  if (wildcardHosts.length > 0) {
    try {
      await invoke('log_ui_event', {
        workspacePath,
        message: `app_start-warn ${app.appId} port=${port} pid=${result.pid} binds-wildcard（双栈通配，回环可达；如需局域网不可达请显式绑定 127.0.0.1/::1）`,
      });
    } catch { /* best-effort */ }
  }
  const nonLoopbackHosts = bindHosts.filter((host) => !isLoopbackBindHost(host) && !isWildcardBindHost(host));
  if (nonLoopbackHosts.length > 0) {
    const exitInfo = await fetchProcessExitInfo(result.pid);
    try { await invoke('stop_background_process', { pid: result.pid, source: 'app_start-loopback-failure' }); } catch { /* best-effort */ }
    try {
      await invoke('log_ui_event', {
        workspacePath,
        message: `app_start-failure ${app.appId} port=${port} pid=${result.pid} reason=non-loopback-bind hosts=[${nonLoopbackHosts.join(',')}]`,
      });
    } catch { /* best-effort */ }
    const detail = formatExitDetail(exitInfo);
    throw new Error(
      `应用 '${app.appId}' 后端监听在非回环地址（${nonLoopbackHosts.join(', ')}），` +
      `服务会暴露到局域网。请在 command/args 中配置服务只监听 localhost/127.0.0.1。${detail}`
    );
  }

  try {
    await invoke('register_app_backend_port', { appId: app.appId, port });
  } catch { /* 协议注入回落到 manifest.port */ }

  return { pid: result.pid, url };
}

/** 进程勘验信息：存活进程返回实时输出；已退出进程返回归档的退出码 + 回收前
 * 捕获的输出（cleanup 移除条目时归档）。取不到不致命，返回 null。 */
async function fetchProcessExitInfo(pid: number): Promise<BackgroundProcessExitInfo | null> {
  try {
    return await invoke<BackgroundProcessExitInfo | null>('background_process_exit_info', { pid });
  } catch {
    return null;
  }
}

/** 退出状态描述：exit=1 / signal=9；无信息时为空串。 */
function formatExitStatus(exitInfo: BackgroundProcessExitInfo | null): string {
  if (!exitInfo) return '';
  if (exitInfo.exitCode != null) return `（exit=${exitInfo.exitCode}）`;
  if (exitInfo.signal != null) return `（signal=${exitInfo.signal}）`;
  return '';
}

function formatExitDetail(exitInfo: BackgroundProcessExitInfo | null): string {
  const spawnLog = exitInfo?.logTail?.trim() ?? '';
  return spawnLog ? `\n进程输出：\n${spawnLog}` : '';
}

/** #60：通配监听（IPv6 双栈 `*`，node listen(PORT) 平台默认）。 */
function isWildcardBindHost(host: string): boolean {
  return host === '*';
}

/** #60：监听地址回环判定（与 Rust app_runtime::is_loopback_bind 对齐）。 */
function isLoopbackBindHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

/** 从 manifest JSON 解析两轴访问（供 app_start 等校验沙箱档）。 */
function accessFromManifestJson(manifestJson: string | null | undefined): PaprManifest | null {
  if (!manifestJson) return null;
  try {
    return JSON.parse(manifestJson) as PaprManifest;
  } catch {
    return null;
  }
}

/** 启动后端用的生效访问：manifest 声明 ∩ 用户设置覆盖（覆盖只能收窄）。
 *  override 按当前工作区命名空间查找（C-2）。 */
async function resolveLaunchAccess(
  appId: string,
  manifestJson: string | null | undefined,
  workspacePath: string,
): Promise<PaprAccess> {
  const manifest = accessFromManifestJson(manifestJson);
  let settings: PaprAppSettings | null = usePaprPermissionStore.getState().appSettings;
  if (!settings) {
    try {
      const loaded = await invoke<PaprAppSettings>('papr_get_app_settings');
      if (loaded && typeof loaded.defaultLocal === 'string') {
        settings = loaded;
        usePaprPermissionStore.getState().setAppSettings(loaded);
      }
    } catch {
      settings = null;
    }
  }
  return resolveEffectiveAccess(manifest, settings, appId, normalizeWorkspaceId(workspacePath));
}

/** 设置变更后：对生效档（local/network）发生变化的运行中后端停掉再拉起，
 *  让 sandbox-exec 与新权限一致。local 收到 none 时只停不启（后端至少要 read）。 */
export async function syncRunningBackendsToAccess(
  prev: PaprAppSettings | null,
  next: PaprAppSettings,
  workspacePath: string,
): Promise<{ restarted: string[]; stoppedOnly: string[] }> {
  const restarted: string[] = [];
  const stoppedOnly: string[] = [];
  if (!workspacePath) return { restarted, stoppedOnly };

  const running = useAppRuntimeStore.getState().apps.filter(
    (app) => app.pid && app.command && app.port,
  );
  for (const app of running) {
    if (!app.command || app.port == null) continue;
    const command = app.command;
    const port = app.port;
    const manifest = accessFromManifestJson(app.manifestJson);
    const workspaceKey = normalizeWorkspaceId(workspacePath);
    const before = resolveEffectiveAccess(manifest, prev, app.appId, workspaceKey);
    const after = resolveEffectiveAccess(manifest, next, app.appId, workspaceKey);
    if (before.local === after.local && before.network === after.network) continue;

    try {
      await invoke('stop_background_process', {
        pid: app.pid,
        source: 'app-permission-settings',
      });
    } catch {
      /* best-effort */
    }
    useAppRuntimeStore.getState().setAppStopped(app.appId);

    if (after.local !== 'read' && after.local !== 'write') {
      stoppedOnly.push(app.appId);
      continue;
    }
    try {
      const { pid, url } = await launchAppBackend(
        {
          appId: app.appId,
          command,
          args: app.args ?? [],
          port,
          manifestJson: app.manifestJson,
        },
        workspacePath,
      );
      useAppRuntimeStore.getState().setAppRunning(app.appId, pid, url);
      restarted.push(app.appId);
    } catch {
      stoppedOnly.push(app.appId);
    }
  }
  return { restarted, stoppedOnly };
}
