import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalStringArray,
} from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  type BackgroundProcessEntry,
  type WriteTextFileResult,
} from './workspaceToolHelpers';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';
import {
  LOCAL_ORDER,
  accessMeetsTool,
  legacyAccessToLevel,
  legacyLevelToAccess,
  type PaprAccess,
  type PaprLocalAccess,
} from '../papr/levelGrants';
import { type WorkspaceToolContext } from './workspaceToolContext';

/** app_render.files 不允许覆盖的保留文件：manifest/index 由 app_render 自身生成，
 * db.sqlite（含 WAL/SHM 边车）是 papr.db 的持久化数据。 */
const RESERVED_APP_FILES = new Set([
  'manifest.json',
  'index.html',
  'db.sqlite',
  'db.sqlite-wal',
  'db.sqlite-shm',
]);

const LOCAL_LABEL: Record<PaprLocalAccess, string> = {
  none: '无',
  read: '只读',
  write: '读写执行',
};

/**
 * 解析 app_render 的访问参数：优先 local/network（两轴），缺省回落旧 level。
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
          `agents[${agent.name}].tools 中的 ${toolName} 不在当前访问档（local=${LOCAL_LABEL[access.local]}, network=${access.network}）允许范围内，请调整 app_render 的 local/network 参数或从 tools 中移除。`
        );
      }
      if ((toolName === 'websearch' || toolName === 'webfetch') && disableWebSearchTools) {
        throw new Error(`设置已启用 MCP 搜索，websearch/webfetch 不可用。请改为在 agents[${agent.name}].tools 中显式声明对应的 MCP 搜索工具（mcp__ 前缀名称），或在设置中关闭 MCP 搜索`);
      }
    }
  }
}

export function registerWorkspaceAppTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    readBeforeContent,
    notifyWorkspaceMutation,
    editHistory,
  } = ctx;

  registry.register(toolByName('app_render'), async (args: Record<string, unknown>) => {
    const rawAppId = asString(args.appId, 'appId');
    const title = asString(args.title, 'title');
    const html = asString(args.html, 'html');
    const icon = asOptionalString(args.icon);
    const command = asOptionalString(args.command);
    const cmdArgs = asOptionalStringArray(args.args);
    const port = asOptionalNumber(args.port);
    const rawFiles = args.files as Array<{ relativePath: string; content: string }> | undefined;
    const permissions = (args.permissions as string[] | undefined) ?? [];
    const agents = (args.agents as Array<{name: string; model?: string; systemPrompt?: string; tools?: string[]; maxToolRounds?: number; inheritContext?: {skills?: boolean; projectRules?: boolean; projectMemory?: boolean; customPrompt?: boolean}}> | undefined) ?? [];

    for (const a of agents) {
      if (!a.name || typeof a.name !== 'string' || a.name.trim().length === 0) {
        throw new Error('agents 每个元素必须包含非空 name 字段');
      }
      if (a.name.length > 64) {
        throw new Error(`agent name 超过 64 字符限制: ${a.name}`);
      }
      if (a.model !== undefined && !['main', 'fast', 'mentor'].includes(a.model)) {
        throw new Error(`agent model 必须是 main/fast/mentor，收到: ${a.model}`);
      }
      if (a.maxToolRounds !== undefined && (typeof a.maxToolRounds !== 'number' || !Number.isInteger(a.maxToolRounds) || a.maxToolRounds < 1)) {
        throw new Error(`agent maxToolRounds 必须是正整数: ${a.maxToolRounds}`);
      }
      if (a.inheritContext !== undefined) {
        if (typeof a.inheritContext !== 'object' || a.inheritContext === null || Array.isArray(a.inheritContext)) {
          throw new Error(`agent inheritContext 必须是对象: ${JSON.stringify(a.inheritContext)}`);
        }
        for (const field of ['skills', 'projectRules', 'projectMemory', 'customPrompt'] as const) {
          const val = a.inheritContext[field];
          if (val !== undefined && typeof val !== 'boolean') {
            throw new Error(`agent inheritContext.${field} 必须是布尔值: ${val}`);
          }
        }
      }
    }

    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(rawAppId)) {
      throw new Error(
        `appId 必须是 kebab-case（仅小写字母、数字、连字符，1-63 字符），收到: ${rawAppId}`
      );
    }

    if (html.length > 2_000_000) {
      throw new Error(`HTML 内容超过 2MB 上限（当前 ${html.length} 字符），请精简后重试。`);
    }

    if (command && (typeof port !== 'number' || port < 1024 || port > 65535)) {
      throw new Error(`提供 command 时必须同时提供有效 port（1024-65535）`);
    }
    if (!command && port !== undefined) {
      throw new Error(`提供 port 时必须同时提供 command`);
    }
    if (!command && cmdArgs && cmdArgs.length > 0) {
      throw new Error(`提供 args 时必须同时提供 command`);
    }
    if (title.trim().length === 0) {
      throw new Error(`title 不能为空`);
    }

    const appLevel = typeof args.level === 'number' ? args.level : undefined;
    if (appLevel !== undefined && ![0, 1, 2, 3].includes(appLevel)) {
      throw new Error(`level 必须是 0/1/2/3，收到: ${args.level}`);
    }

    // 两轴访问：local（无/只读/读写执行）× network（关/开）
    const access = parseAccess(args);
    if (command && access.local !== 'read' && access.local !== 'write') {
      throw new Error(
        `后端服务（command）需要 local 至少为 read（当前 local: ${LOCAL_LABEL[access.local]}）。请设置 local: "read" 或 local: "write"。`
      );
    }

    validateAgentTools({
      agents,
      access,
      disableWebSearchTools: ctx.options.disableWebSearchTools ?? false,
    });

    const manifest = {
      spec: 'papr/0.1',
      name: title,
      version: '0.1.0',
      entry: 'index.html',
      permissions,
      local: access.local,
      network: access.network,
      level: appLevel ?? legacyAccessToLevel(access),
      agents: agents.map((a) => ({
        name: a.name,
        model: a.model ?? 'main',
        systemPrompt: a.systemPrompt,
        ...(a.tools ? { tools: a.tools } : {}),
        ...(a.maxToolRounds ? { maxToolRounds: Math.min(a.maxToolRounds, 50) } : {}),
        ...(a.inheritContext ? { inheritContext: a.inheritContext } : {}),
      })),
      ...(command ? { command } : {}),
      ...(cmdArgs && cmdArgs.length > 0 ? { args: cmdArgs } : {}),
      ...(port ? { port } : {}),
    };

    const manifestPath = `.CodePapr/apps/${rawAppId}/manifest.json`;
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestBefore = await readBeforeContent(manifestPath);
    const manifestResult = await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: manifestPath,
      content: manifestJson,
    });
    editHistory?.record({
      path: manifestResult.path,
      before: manifestBefore,
      after: manifestJson,
    });

    const indexRelativePath = `.CodePapr/apps/${rawAppId}/index.html`;
    const indexBefore = await readBeforeContent(indexRelativePath);

    const indexResult = await invoke<WriteTextFileResult>('write_text_file', {
      workspacePath: workspace(),
      relativePath: indexRelativePath,
      content: html,
    });
    editHistory?.record({
      path: indexResult.path,
      before: indexBefore,
      after: html,
    });

    const writtenPaths: string[] = [manifestResult.path, indexResult.path];

    let totalBytes = new TextEncoder().encode(html).length;

    if (rawFiles && rawFiles.length > 0) {
      for (const file of rawFiles) {
        if (!file.relativePath || typeof file.relativePath !== 'string') {
          throw new Error('files 每个元素必须包含 relativePath');
        }
        if (file.content == null || typeof file.content !== 'string') {
          throw new Error('files 每个元素必须包含 content');
        }
        const filePath = `.CodePapr/apps/${rawAppId}/${file.relativePath}`;
        if (filePath.includes('..') || file.relativePath.includes('\\') || file.relativePath.startsWith('/') || file.relativePath.includes('\0')) {
          throw new Error(`文件路径不合法（不能包含 ..、\\、绝对路径或 null 字节）: ${file.relativePath}`);
        }
        // #27：剥掉全部前导 ./（旧实现 replace(/^\.\//, '') 只剥一个前缀，
        // `././manifest.json` 能绕过保留文件校验；Rust 侧 normalize_relative_path
        // 会把 CurDir 组件折叠，最终仍写入 manifest.json，绕过两轴权限审计）。
        const normalizedRelative = file.relativePath.replace(/^(\.\/)+/, '').toLowerCase();
        if (RESERVED_APP_FILES.has(normalizedRelative)) {
          throw new Error(`不能通过 files 覆盖保留文件: ${file.relativePath}`);
        }
        const fileBefore = await readBeforeContent(filePath);
        const writeResult = await invoke<WriteTextFileResult>('write_text_file', {
          workspacePath: workspace(),
          relativePath: filePath,
          content: file.content,
        });
        editHistory?.record({
          path: writeResult.path,
          before: fileBefore,
          after: file.content,
        });
        writtenPaths.push(writeResult.path);
        totalBytes += writeResult.bytes;
      }
    }

    await invoke('register_app_workspace', {
      appId: rawAppId,
      workspacePath: workspace(),
    });

    const existingApp = useAppRuntimeStore.getState().apps.find((a) => a.appId === rawAppId);
    if (existingApp?.pid) {
      try { await invoke('stop_background_process', { pid: existingApp.pid, source: 'app_render' }); } catch { /* best-effort */ }
      useAppRuntimeStore.getState().setAppStopped(rawAppId);
    }

    useAppRuntimeStore.getState().mountApp({
      appId: rawAppId,
      title,
      icon,
      html,
      filePath: indexRelativePath,
      command: command ?? undefined,
      args: cmdArgs ?? undefined,
      port: port ?? undefined,
      manifestJson: JSON.stringify(manifest),
    });

    notifyWorkspaceMutation(writtenPaths);

    const hasBackend = !!command;
    return {
      appId: rawAppId,
      title,
      icon: icon ?? null,
      filePath: indexRelativePath,
      bytes: totalBytes,
      mounted: true,
      hasBackend,
      ...(hasBackend ? { command, args: cmdArgs, port, hint: '应用已生成并注册后端服务。用户点击"运行"启动后端后，可在管理面板点"打开"查看。后端进程运行在工作区目录下，可直接读写项目文件（如数据库）。' } : { hint: '应用已渲染到应用管理面板。用户可点击"打开"查看。如需修改应用，用相同 appId 再次调用 app_render 即可覆盖更新。' }),
    };
  });

  registry.register(toolByName('app_list'), async () => {
    const storeApps = useAppRuntimeStore.getState().apps;
    const storeIds = new Set(storeApps.map((a) => a.appId));

    let diskApps: Array<{ app_id: string; title: string; command?: string; port?: number }> = [];
    try {
      const discovered = await invoke<Array<{ app_id: string; title: string; command?: string; port?: number }>>('scan_workspace_apps', { workspacePath: workspace() });
      diskApps = discovered.filter((d) => !storeIds.has(d.app_id));
    } catch { /* best-effort */ }

    // Ground truth for running backends: the Rust process registry (survives
    // webview reloads). Keyed by preview URL so we can match an app by its port.
    const runningByUrl = new Map<string, number>();
    try {
      const procs = await invoke<Array<{ pid: number; preview_url?: string }>>('list_background_processes', { workspacePath: workspace() });
      for (const proc of procs) {
        if (proc.preview_url) runningByUrl.set(proc.preview_url, proc.pid);
      }
    } catch { /* best-effort */ }
    const urlForPort = (port?: number | null): string | null => (port ? `http://localhost:${port}/` : null);

    const fromStore = storeApps.map((app) => {
      const regUrl = urlForPort(app.port);
      const regRunning = regUrl !== null && runningByUrl.has(regUrl);
      return {
        appId: app.appId,
        title: app.title,
        hasBackend: !!(app.command && app.port),
        isRunning: !!(app.pid && app.url) || regRunning,
        port: app.port ?? null,
        url: app.url ?? (regRunning ? regUrl : null),
      };
    });
    const fromDisk = diskApps.map((d) => {
      const regUrl = urlForPort(d.port);
      const regRunning = regUrl !== null && runningByUrl.has(regUrl);
      return {
        appId: d.app_id,
        title: d.title,
        hasBackend: !!(d.command && d.port),
        isRunning: regRunning,
        port: d.port ?? null,
        url: regRunning ? regUrl : null,
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
    if (!app.pid) throw new Error(`应用 '${appId}' 后端未在运行`);

    let killFailed = false;
    try { await invoke('stop_background_process', { pid: app.pid, source: 'app_stop-tool' }); } catch { killFailed = true; }
    useAppRuntimeStore.getState().setAppStopped(appId);
    return { appId, stopped: true, ...(killFailed ? { warning: '进程停止命令失败，后端进程可能仍在运行并占用端口。' } : {}) };
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

}

export interface AppLaunchTarget {
  appId: string;
  command: string;
  args: string[];
  port: number;
  manifestJson?: string;
}

/** 后端 app 启动核心路径：manifest 两轴沙箱 + 端口预检 + spawn + 轮询等待监听 +
 * 失败时捕获进程输出。app_start 工具与应用面板 ▶ 按钮都走这里——
 * 保证无论从哪启动，沙箱权限、校验与诊断行为完全一致。 */
export async function launchAppBackend(
  app: AppLaunchTarget,
  workspacePath: string,
): Promise<{ pid: number; url: string }> {
  // 后端进程沙箱按 manifest 的两轴访问构建（防绕过：直接改文件启动也过不了 sandbox）
  const appAccess = accessFromManifestJson(app.manifestJson);
  if (appAccess.local !== 'read' && appAccess.local !== 'write') {
    throw new Error(`应用 '${app.appId}' 的 local 访问为 ${appAccess.local}，不允许启动后端服务`);
  }

  const available: boolean = await invoke('check_port_available', { port: app.port });
  if (!available) throw new Error(`端口 ${app.port} 已被占用`);

  const url = `http://localhost:${app.port}/`;
  const result = await invoke<{ pid: number }>('start_workspace_background_command', {
    workspacePath,
    command: app.command,
    args: app.args,
    previewUrl: url,
    sandbox: {
      network: appAccess.network,
      workspaceWrite: appAccess.local === 'write',
      allowBind: true,
    },
  });

  // 轮询等待端口被监听：冷启动在负载下可能超过固定短等待，过早判失败会误杀
  // 正在启动的进程（随后它又绑上端口，变成 store 追踪不到的孤儿）。
  const PORT_POLL_INTERVAL_MS = 250;
  const PORT_POLL_TIMEOUT_MS = 8000;
  const deadline = Date.now() + PORT_POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  const pollTrace: string[] = [];
  let portTaken = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
    // 带探测细节的诊断：v4/v6 各自 conn(有监听)/refused(无服务)/err，
    // 「监听中却判空闲」的怪象靠它勘验
    const detail = await invoke<string>('check_port_available_detail', { port: app.port });
    const available = !detail.includes('conn');
    pollTrace.push(`+${Date.now() - startedAt}ms:${detail}`);
    if (!available) { portTaken = true; break; }
    if (Date.now() >= deadline) break;
  }
  if (!portTaken) {
    // 先取进程捕获的输出再停掉它：spawn 秒退的真实原因（如 sandbox-exec
    // 找不到 node、脚本语法错误）只存在于 log_tail，不捞出来就死无对证。
    let spawnLog = '';
    try {
      const procs = await invoke<BackgroundProcessEntry[]>('list_background_processes', { workspacePath });
      spawnLog = procs.find((p) => p.pid === result.pid)?.logTail?.trim() ?? '';
    } catch { /* best-effort */ }
    // Kill the spawned child so a slow-starting server does not become an
    // orphan that later grabs the port untracked by the store.
    try { await invoke('stop_background_process', { pid: result.pid, source: 'app_start-failure' }); } catch { /* best-effort */ }
    try { await invoke('log_ui_event', { workspacePath, message: `app_start-failure ${app.appId} port=${app.port} pid=${result.pid} polls=[${pollTrace.join(' ')}]` }); } catch { /* best-effort */ }
    const detail = spawnLog ? `\n进程输出：\n${spawnLog}` : '';
    throw new Error(`应用 '${app.appId}' 后端启动失败：进程已退出或端口 ${app.port} 未被监听，请检查 command/args 配置。${detail}`);
  }

  return { pid: result.pid, url };
}

/** 从 manifest JSON 解析两轴访问（供 app_start 等校验沙箱档）。 */
function accessFromManifestJson(manifestJson: string | null | undefined): PaprAccess {
  if (manifestJson) {
    try {
      const manifest = JSON.parse(manifestJson) as { local?: PaprLocalAccess; network?: boolean; level?: number };
      if (manifest.local) {
        return { local: manifest.local, network: manifest.network === true };
      }
      if (typeof manifest.level === 'number') {
        return legacyLevelToAccess(manifest.level);
      }
    } catch { /* 解析失败回落默认 */ }
  }
  return { local: 'none', network: false };
}
