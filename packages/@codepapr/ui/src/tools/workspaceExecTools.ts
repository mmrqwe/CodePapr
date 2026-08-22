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
import { agentSandboxArgs, assertShellCodePaprAccess } from './codepaprAgentAccess';

const SYSTEM_COMMAND_PATHS = [
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/local/bin/',
  '/opt/homebrew/bin/',
];

// 与 Rust 侧 sandbox unix_allowed_read_roots 对齐（#18）：沙箱 profile 放行
// 读取/执行的路径（PATH 项、Homebrew、工具缓存目录），预检不应要求授权，
// 否则 ~/.cargo/bin、~/.local/bin（在 PATH 内）等合法工具会被误拒/误弹窗。
// 每次调用时基于运行时 PATH 构建，避免模块加载时的静态快照过时。
function buildSandboxAlignedSkipPrefixes(): string[] {
  const home = process.env.HOME ?? '';
  const prefixes = [
    ...SYSTEM_COMMAND_PATHS,
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map((entry) => `${entry}/`),
  ];
  if (home) {
    // 注意：不放行 ~/.local 整体（bin/ 可写即能植入持久化二进制），只放行
    // 数据目录 ~/.local/share（与 Rust unix_tool_dirs 一致）。
    for (const name of ['.npm', '.cache', '.cargo', '.local/share', '.nvm', '.volta']) {
      prefixes.push(`${home}/${name}/`);
    }
    prefixes.push('/opt/homebrew/');
  }
  return prefixes;
}

// 首 token 通常是可执行文件本体，绝不能跳过：跳过它意味着
// `/tmp/evil/bin ...` 这类绝对路径可执行文件不会触发外部路径授权。
function extractAbsoluteCommandPaths(command: string): string[] {
  const skipPrefixes = buildSandboxAlignedSkipPrefixes();
  const candidates = command
    .split(/[\s"'`=<>|;&()]+/)
    .map((part) => part.replace(/^[,.;]+|[,.;]+$/g, ''))
    .map((part) => part.replace(/\\/g, '/'))
    .filter((part) => part.startsWith('/') || /^[A-Za-z]:\//.test(part));
  return [...new Set(candidates)].filter(
    (candidate) => !skipPrefixes.some((prefix) => candidate.startsWith(prefix)),
  );
}

/** 测试专用出口：验证 #18 的沙箱对齐跳过集。 */
export const __workspaceExecToolsTestUtils = {
  extractAbsoluteCommandPaths,
  buildSandboxAlignedSkipPrefixes,
};

// 可取消前台命令的令牌：Rust 侧 ACTIVE_COMMAND_CANCELS 以它注册取消标志，
// abort 时 cancel_running_command 置位，阻塞等待的命令轮询到后杀进程树。
function createCancelToken(): string {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function registerWorkspaceExecTools(ctx: WorkspaceToolContext): void {
  const {
    registry,
    workspace,
    ensureExternalPathAllowed,
    options,
  } = ctx;
  const agentMode = options.mode ?? 'agent';

  const ensureCommandPathsAllowed = async (
    command: string,
    args: string[] = [],
    signal?: AbortSignal,
  ): Promise<void> => {
    const candidates = [
      ...extractAbsoluteCommandPaths(command),
      ...args.flatMap((arg) => extractAbsoluteCommandPaths(arg)),
    ];
    for (const candidate of [...new Set(candidates)]) {
      await ensureExternalPathAllowed(candidate, 'execute', signal);
    }
  };

  registry.register(toolByName('workspace_run_command'), async (args: Record<string, unknown>, context) => {
    const parsed: RunCommandArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
    };
    await ensureCommandPathsAllowed(parsed.command, parsed.args ?? [], context?.signal);
    assertShellCodePaprAccess([parsed.command, ...(parsed.args ?? [])].join(' '), agentMode);
    // 取消通道：会话取消 / 工具超时（Agent 的 withTimeout）会 abort signal，
    // 此时通过 cancel_running_command 杀掉 Rust 侧正在执行的进程树，而不是
    // 让命令在后台继续跑完、副作用滞后落地。
    const cancelToken = context?.signal ? createCancelToken() : undefined;
    if (cancelToken && context?.signal) {
      context.signal.addEventListener('abort', () => {
        void invoke('cancel_running_command', { token: cancelToken }).catch(() => undefined);
      }, { once: true });
    }
    return await invoke('run_workspace_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      timeoutSeconds: parsed.timeoutSeconds,
      cancelToken,
    });
  });

  registry.register(toolByName('workspace_run_shell_command'), async (args: Record<string, unknown>, context) => {
    const workdir = asOptionalString(args.workdir);
    const command = asString(args.command, 'command');
    await ensureExternalPathAllowed(workdir, 'execute', context?.signal);
    await ensureCommandPathsAllowed(command, [], context?.signal);
    assertShellCodePaprAccess(command, agentMode, workdir);
    // app agent 调用时按两轴构建沙箱：网络关 → 无网络；local 非 write → 工作区只读
    const sandbox = agentSandboxArgs(agentMode, context?.appAccess);
    const cancelToken = context?.signal ? createCancelToken() : undefined;
    if (cancelToken && context?.signal) {
      context.signal.addEventListener('abort', () => {
        void invoke('cancel_running_command', { token: cancelToken }).catch(() => undefined);
      }, { once: true });
    }
    return await invoke('run_workspace_shell_command', {
      workspacePath: workspace(),
      command,
      workdir,
      timeoutSeconds: asOptionalNumber(args.timeoutSeconds),
      sandbox,
      cancelToken,
    });
  });

  registry.register(toolByName('workspace_start_shell_background_command'), async (args: Record<string, unknown>, context) => {
    const workdir = asOptionalString(args.workdir);
    const command = asString(args.command, 'command');
    await ensureExternalPathAllowed(workdir, 'execute', context?.signal);
    await ensureCommandPathsAllowed(command, [], context?.signal);
    assertShellCodePaprAccess(command, agentMode, workdir);
    return await invoke<BackgroundCommandResult>('start_workspace_shell_background_command', {
      workspacePath: workspace(),
      command,
      workdir,
      previewUrl: asOptionalString(args.previewUrl),
      sandbox: agentSandboxArgs(agentMode, context?.appAccess),
    });
  });


  registry.register(toolByName('workspace_start_background_command'), async (args: Record<string, unknown>, context) => {
    const parsed: BackgroundCommandArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      previewUrl: asOptionalString(args.previewUrl),
    };
    await ensureCommandPathsAllowed(parsed.command, parsed.args ?? [], context?.signal);
    assertShellCodePaprAccess([parsed.command, ...(parsed.args ?? [])].join(' '), agentMode);

    return await invoke<BackgroundCommandResult>('start_workspace_background_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      previewUrl: parsed.previewUrl,
      sandbox: agentSandboxArgs(agentMode, context?.appAccess),
    });
  });

  registry.register(toolByName('workspace_start_preview_session'), async (args: Record<string, unknown>, context) => {
    const parsed: PreviewSessionArgs = {
      command: asString(args.command, 'command'),
      args: asOptionalStringArray(args.args),
      previewUrl: asHttpOrHttpsUrl(args.previewUrl, 'previewUrl'),
      title: asOptionalString(args.title),
    };
    await ensureCommandPathsAllowed(parsed.command, parsed.args ?? [], context?.signal);
    assertShellCodePaprAccess([parsed.command, ...(parsed.args ?? [])].join(' '), agentMode);

    const result = await invoke<BackgroundCommandResult>('start_workspace_background_command', {
      workspacePath: workspace(),
      command: parsed.command,
      args: parsed.args,
      previewUrl: parsed.previewUrl,
      sandbox: agentSandboxArgs(agentMode, context?.appAccess),
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
      source: 'workspace_stop_background_process-tool',
    });
  });

  registry.register(toolByName('workspace_stop_all_background_processes'), async () => {
    return await invoke<StopAllBackgroundProcessesResult>('stop_all_background_processes', {
      workspacePath: workspace(),
      source: 'workspace_stop_all_background_processes-tool',
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
      assertShellCodePaprAccess([parsed.command, ...(parsed.args ?? [])].join(' '), agentMode);
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
    assertShellCodePaprAccess(parsed.input, agentMode);

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
