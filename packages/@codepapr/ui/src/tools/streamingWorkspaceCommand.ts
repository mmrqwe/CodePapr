import { invoke } from '@tauri-apps/api/core';
import { getTranslation, type Lang } from '../utils/i18n';

export interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ShellSessionResult {
  sessionId: string;
  shell: string;
}

interface ShellReadOutputResult {
  sessionId: string;
  outputTail: string;
  active: boolean;
}

export interface StreamingCommandProgress {
  statusText: string;
  output: string;
}

interface RunStreamingWorkspaceCommandParams {
  workspacePath: string;
  command: string;
  args?: string[];
  timeoutSeconds?: number;
  lang?: Lang;
  invokeFn?: typeof invoke;
  onProgress?: (progress: StreamingCommandProgress) => void;
  signal?: AbortSignal;
}

type ShellFamily = 'posix' | 'powershell' | 'cmd';

const EXIT_MARKER_PREFIX = '__CODEPAPR_EXIT__';
const POLL_INTERVAL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function buildCommandLine(command: string, args: string[]): string {
  return [command, ...args].filter(Boolean).join(' ').trim();
}

function truncateText(value: string, maxLength: number = 120): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function detectShellFamily(shell: string): ShellFamily {
  const base = shell.split(/[\\/]/).pop()?.toLowerCase() ?? shell.toLowerCase();
  if (base === 'cmd' || base === 'cmd.exe') {
    return 'cmd';
  }
  if (base === 'powershell' || base === 'powershell.exe' || base === 'pwsh' || base === 'pwsh.exe') {
    return 'powershell';
  }
  return 'posix';
}

function buildExitProbe(shell: string, marker: string): string {
  switch (detectShellFamily(shell)) {
    case 'cmd':
      return `echo ${marker}:%errorlevel%`;
    case 'powershell':
      return `Write-Output '${marker}:'+$LASTEXITCODE`;
    default:
      return `printf '${marker}:%s\n' "$?"`;
  }
}

function classifyCommandStatus(command: string, args: string[], lang: Lang | undefined): string {
  const t = getTranslation(lang);
  const fullText = buildCommandLine(command, args).toLowerCase();
  const summary = truncateText(buildCommandLine(command, args));

  const label =
    /(\btest\b|vitest|jest|pytest|dotnet test|cargo test|go test)/.test(fullText)
      ? t.toolRunningTests
      : /(\blint\b|eslint|stylelint|ruff|clippy)/.test(fullText)
      ? t.toolRunningLint
      : /(\binstall\b|npm i\b|npm install\b|pnpm add\b|pnpm install\b|yarn add\b|yarn install\b|cargo install)/.test(fullText)
      ? t.toolRunningInstall
      : /(\bgenerate\b|codegen|scaffold|gen:)/.test(fullText)
      ? t.toolRunningGenerate
      : /(\bbuild\b|compile|tsc\b|release:|cargo build|vite build|next build)/.test(fullText)
      ? t.toolRunningBuild
      : t.toolRunningCommand;

  return `${label}: ${summary}`;
}

function splitShellOutput(output: string): Pick<CommandResult, 'stdout' | 'stderr'> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith('[err] ')) {
      stderrLines.push(line.slice('[err] '.length));
      continue;
    }
    if (line.startsWith('[out] ')) {
      stdoutLines.push(line.slice('[out] '.length));
      continue;
    }
    stdoutLines.push(line);
  }

  return {
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
  };
}

interface ParsedShellTail {
  cleanedOutput: string;
  exitCode: number | null;
}

function parseShellTail(output: string, marker: string): ParsedShellTail {
  const lines = output.split(/\r?\n/);
  let exitCode: number | null = null;
  const cleanedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const normalized = trimmed.startsWith('[out] ') ? trimmed.slice('[out] '.length) : trimmed;
    if (normalized.startsWith(`${marker}:`)) {
      const value = normalized.slice(marker.length + 1).trim();
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        exitCode = parsed;
      }
      continue;
    }

    cleanedLines.push(trimmed);
  }

  return {
    cleanedOutput: cleanedLines.join('\n'),
    exitCode,
  };
}

export async function runStreamingWorkspaceCommand(
  params: RunStreamingWorkspaceCommandParams
): Promise<CommandResult> {
  const invokeFn = params.invokeFn ?? invoke;
  const args = params.args ?? [];
  const timeoutSeconds = Math.max(1, Math.min(600, params.timeoutSeconds ?? 30));
  const timeoutMs = timeoutSeconds * 1000;
  const marker = `${EXIT_MARKER_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const progressStatus = classifyCommandStatus(params.command, args, params.lang);
  const initialProgress = { statusText: progressStatus, output: '' };
  params.onProgress?.(initialProgress);

  const session = await invokeFn<ShellSessionResult>('open_shell_session', {
    workspacePath: params.workspacePath,
  });

  let latestOutput = '';

  try {
    await invokeFn('send_shell_command', {
      sessionId: session.sessionId,
      command: params.command,
      args,
    });
    await invokeFn('send_shell_input', {
      sessionId: session.sessionId,
      input: buildExitProbe(session.shell, marker),
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (params.signal?.aborted) {
        await invokeFn('close_shell_session', {
          sessionId: session.sessionId,
        }).catch(() => undefined);
        // 必须与超时区分：抛 AbortError 而不是返回 timedOut:true。
        // 旧实现把用户主动中止报告成「超时」，模型通常会原样重试——
        // 一条已被中止、可能已产生半副作用（写文件、git 操作）的命令
        // 会被再次完整执行。
        throw new DOMException(
          `命令被取消：${params.command}（已产生的输出：${latestOutput.slice(0, 500)}）`,
          'AbortError',
        );
      }
      const output = await invokeFn<ShellReadOutputResult>('read_shell_output', {
        sessionId: session.sessionId,
      });
      const parsed = parseShellTail(output.outputTail ?? '', marker);

      if (parsed.cleanedOutput !== latestOutput) {
        latestOutput = parsed.cleanedOutput;
        params.onProgress?.({
          statusText: progressStatus,
          output: latestOutput,
        });
      }

      if (parsed.exitCode !== null) {
        const streams = splitShellOutput(latestOutput);
        return {
          command: params.command,
          args,
          status: parsed.exitCode,
          stdout: streams.stdout,
          stderr: streams.stderr,
          timedOut: false,
        };
      }

      await delay(POLL_INTERVAL_MS);
    }

    const streams = splitShellOutput(latestOutput);
    return {
      command: params.command,
      args,
      status: null,
      stdout: streams.stdout,
      stderr: streams.stderr,
      timedOut: true,
    };
  } finally {
    await invokeFn('close_shell_session', {
      sessionId: session.sessionId,
    }).catch(() => undefined);
  }
}

export const __streamingWorkspaceCommandTestUtils = {
  classifyCommandStatus,
  parseShellTail,
  splitShellOutput,
};