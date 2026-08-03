import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalStringArray,
} from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  type WriteTextFileResult,
} from './workspaceToolHelpers';
import { useAppRuntimeStore } from '../store/appRuntimeStore';
import { usePermissionStore as usePaprPermissionStore } from '../papr/permissionStore';
import { disallowedPermissionsForLevel } from '../papr/levelGrants';
import { type WorkspaceToolContext } from './workspaceToolContext';

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

    const appLevel = typeof args.level === 'number' ? args.level : 1;
    if (![0, 1, 2, 3].includes(appLevel)) {
      throw new Error(`level 必须是 0/1/2/3，收到: ${args.level}`);
    }

    const invalidPerms = disallowedPermissionsForLevel(appLevel, permissions);
    if (invalidPerms.length > 0) {
      throw new Error(`permissions ${JSON.stringify(invalidPerms)} 超出 level ${appLevel} 允许范围，请提升 level 或移除这些权限。`);
    }

    const manifest = {
      spec: 'papr/0.1',
      name: title,
      version: '0.1.0',
      entry: 'index.html',
      permissions,
      level: appLevel,
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
        if (file.relativePath === 'manifest.json' || file.relativePath === 'index.html') {
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
      try { await invoke('stop_background_process', { pid: existingApp.pid }); } catch { /* best-effort */ }
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

    const available: boolean = await invoke('check_port_available', { port: app.port });
    if (!available) throw new Error(`端口 ${app.port} 已被占用`);

    const url = `http://localhost:${app.port}/`;
    const result = await invoke<{ pid: number }>('start_workspace_background_command', {
      workspacePath: workspace(),
      command: app.command,
      args: app.args ?? [],
      previewUrl: url,
    });
    useAppRuntimeStore.getState().setAppRunning(appId, result.pid, url);

    await new Promise((r) => setTimeout(r, 800));
    const stillAvailable: boolean = await invoke('check_port_available', { port: app.port });
    if (stillAvailable) {
      // Kill the spawned child so a slow-starting server does not become an
      // orphan that later grabs the port untracked by the store.
      try { await invoke('stop_background_process', { pid: result.pid }); } catch { /* best-effort */ }
      useAppRuntimeStore.getState().setAppStopped(appId);
      throw new Error(`应用 '${appId}' 后端启动失败：进程已退出或端口 ${app.port} 未被监听，请检查 command/args 配置。`);
    }

    return { appId, pid: result.pid, url, started: true };
  });

  registry.register(toolByName('app_stop'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);
    if (!app.pid) throw new Error(`应用 '${appId}' 后端未在运行`);

    let killFailed = false;
    try { await invoke('stop_background_process', { pid: app.pid }); } catch { killFailed = true; }
    useAppRuntimeStore.getState().setAppStopped(appId);
    return { appId, stopped: true, ...(killFailed ? { warning: '进程停止命令失败，后端进程可能仍在运行并占用端口。' } : {}) };
  });

  registry.register(toolByName('app_delete'), async (args: Record<string, unknown>) => {
    const appId = asString(args.appId, 'appId');
    const store = useAppRuntimeStore.getState();
    const app = store.apps.find((a) => a.appId === appId);
    if (!app) throw new Error(`应用 '${appId}' 不存在`);

    try { await invoke('papr_delete_app', { appId }); } catch { /* best-effort */ }
    try { await invoke('unregister_app_workspace', { appId }); } catch { /* best-effort */ }
    usePaprPermissionStore.getState().clearManifest(appId);
    useAppRuntimeStore.getState().closeApp(appId);
    return { appId, deleted: true };
  });

}
