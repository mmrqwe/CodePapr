import { invoke } from '@tauri-apps/api/core';
import {
  asString,
  asOptionalString,
  asOptionalNumber,
  asOptionalStringArray,
  asPositiveInteger,
} from '@codepapr/core';
import { toolByName } from './workspaceToolDefinitions';
import {
  asHttpOrHttpsUrl,
  type RunCommandArgs,
  type BackgroundCommandArgs,
  type PreviewSessionArgs,
  type StopBackgroundProcessArgs,
  type ShellOpenSessionArgs,
  type ShellSessionIdArgs,
  type ShellSendInputArgs,
  type BackgroundCommandResult,
  type BackgroundProcessEntry,
  type StopBackgroundProcessResult,
  type StopAllBackgroundProcessesResult,
  type ShellSessionResult,
  type ShellSessionEntry,
  type ShellReadOutputResult,
  type ShellSendInputResult,
  type ShellCloseSessionResult,
} from './workspaceToolHelpers';
import { type WorkspaceToolContext } from './workspaceToolContext';

const SYSTEM_COMMAND_PATHS = [
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/local/bin/',
  '/opt/homebrew/bin/',
];

function extractAbsoluteCommandPaths(command: string, skipFirstToken = true): string[] {
  const candidates = command
    .split(/[\s"'`=<>|;&()]+/)
    .map((part) => part.replace(/^[,.;]+|[,.;]+$/g, ''))
    .map((part) => part.replace(/\\/g, '/'))
    .filter(
      (part, index) =>
        (!skipFirstToken || index > 0) &&
        (part.startsWith('/') || /^[A-Za-z]:\//.test(part)),
    );
  return [...new Set(candidates)].filter(
    (candidate) => !SYSTEM_COMMAND_PATHS.some((prefix) => candidate.startsWith(prefix)),
  );
}

export function registerWorkspaceExecTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    ensureExternalPathAllowed,
  } = ctx;

  const ensureCommandPathsAllowed = async (command: string, args: string[] = []): Promise<void> => {
    const candidates = [
      ...extractAbsoluteCommandPaths(command),
      ...args.flatMap((arg) => extractAbsoluteCommandPaths(arg, false)),
    ];
    for (const candidate of [...new Set(candidates)]) {
      await ensureExternalPathAllowed(candidate, 'execute');
    }
  };

  registry.register(toolByName('workspace_run_command'), async (args: Record<string, unknown>) => {
    const parsed: RunCommandArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };
    await ensureCommandPathsAllowed(parsed.command, parsed.args ?? []);
    return await invoke('run_workspace_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      timeoutSeconds: parsed.timeoutSeconds,
    });
  });

  registry.register(toolByName('workspace_run_shell_command'), async (args: Record<string, unknown>) => {
    const workdir = asOptionalString(args.workdir);
    const command = asString(args.command, 'command');
    await ensureExternalPathAllowed(workdir, 'execute');
    await ensureCommandPathsAllowed(command);
    return await invoke('run_workspace_shell_command', {
      workspacePath: workspace(),
      command,
      workdir,
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    });
  });

  registry.register(toolByName('workspace_start_shell_background_command'), async (args: Record<string, unknown>) => {
    const workdir = asOptionalString(args.workdir);
    const command = asString(args.command, 'command');
    await ensureExternalPathAllowed(workdir, 'execute');
    await ensureCommandPathsAllowed(command);
    return await invoke<BackgroundCommandResult>('start_workspace_shell_background_command', {
      workspacePath: workspace(),
      command,
      workdir,
      previewUrl: asOptionalString(args.previewUrl),
    });
  });


  registry.register(toolByName('workspace_start_background_command'), async (args: Record<string, unknown>) => {
    const parsed: BackgroundCommandArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      previewUrl: asOptionalString(args.previewUrl),
    };
    await ensureCommandPathsAllowed(parsed.command, parsed.args ?? []);

    return await invoke<BackgroundCommandResult>('start_workspace_background_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      previewUrl: parsed.previewUrl,
    });
  });

  registry.register(toolByName('workspace_start_preview_session'), async (args: Record<string, unknown>) => {
    const parsed: PreviewSessionArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      previewUrl: asHttpOrHttpsUrl(args.previewUrl, 'previewUrl'),
      title: asOptionalString(args.title),
    };
    await ensureCommandPathsAllowed(parsed.command, parsed.args ?? []);

    const result = await invoke<BackgroundCommandResult>('start_workspace_background_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      previewUrl: parsed.previewUrl,
    });

    const previewUrl = result.previewUrl ?? parsed.previewUrl;
    if (typeof result.pid === 'number' && previewUrl) {
      // 不再自动弹出预览覆盖层；用户可从后台进程面板手动打开
    }

    return result;
  });

  registry.register(toolByName('workspace_list_background_processes'), async () => {
    return await invoke<BackgroundProcessEntry[]>('list_background_processes', {
      workspacePath: workspace(),
    });
  });

  registry.register(toolByName('workspace_stop_background_process'), async (args: Record<string, unknown>) => {
    const parsed: StopBackgroundProcessArgs = {
      pid: asPositiveInteger(args.pid, 'pid'),
    };

    return await invoke<StopBackgroundProcessResult>('stop_background_process', {
      pid: parsed.pid,
    });
  });

  registry.register(toolByName('workspace_stop_all_background_processes'), async () => {
    return await invoke<StopAllBackgroundProcessesResult>('stop_all_background_processes', {
      workspacePath: workspace(),
    });
  });


  registry.register(toolByName('shell_open_session'), async (args: Record<string, unknown>) => {
    const parsed: ShellOpenSessionArgs = {
      shell: asOptionalString(args.shell),
    };

    return await invoke<ShellSessionResult>('open_shell_session', {
      workspacePath: workspace(),
      shell: parsed.shell,
    });
  });

  registry.register(toolByName('shell_list_sessions'), async () => {
    return await invoke<ShellSessionEntry[]>('list_shell_sessions', {
      workspacePath: workspace(),
    });
  });

  registry.register(toolByName('shell_read_output'), async (args: Record<string, unknown>) => {
    const parsed: ShellSessionIdArgs = {
      sessionId: asString(args.sessionId, 'sessionId'),
    };

    return await invoke<ShellReadOutputResult>('read_shell_output', {
      sessionId: parsed.sessionId,
    });
  });

  registry.register(toolByName('shell_send_input'), async (args: Record<string, unknown>) => {
    const parsed: ShellSendInputArgs = {
      sessionId: asString(args.sessionId, 'sessionId'),
      input: asOptionalString(args.input),
      command: asOptionalString(args.command),
      args: asOptionalStringArray(args.args),
    };

    if (parsed.command && parsed.input) {
      throw new Error('shell_send_input 不能同时传 input 和 command');
    }
    if (parsed.command) {
      await ensureCommandPathsAllowed(parsed.command, parsed.args ?? []);
      return await invoke<ShellSendInputResult>('send_shell_command', {
        sessionId: parsed.sessionId,
        command: parsed.command,
        args: parsed.args,
      });
    }
    if (!parsed.input) {
      throw new Error('shell_send_input 必须提供 input 或 command');
    }

    await ensureCommandPathsAllowed(parsed.input);

    return await invoke<ShellSendInputResult>('send_shell_input', {
      sessionId: parsed.sessionId,
      input: parsed.input,
    });
  });

  registry.register(toolByName('shell_close_session'), async (args: Record<string, unknown>) => {
    const parsed: ShellSessionIdArgs = {
      sessionId: asString(args.sessionId, 'sessionId'),
    };

    return await invoke<ShellCloseSessionResult>('close_shell_session', {
      sessionId: parsed.sessionId,
    });
  });

}
