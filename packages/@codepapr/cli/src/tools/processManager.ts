import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sanitizeSpawnEnv } from './spawnEnv';

const BLOCKED_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'sudo',
  'su',
  'doas',
  'login',
  'ssh',
  'scp',
  'sftp',
  'osascript',
]);

const TAIL_LIMIT = 24_000;

type ShellFamily = 'posix' | 'powershell' | 'cmd';

function detectShellFamily(shellPath: string): ShellFamily {
  const base = path.basename(shellPath).toLowerCase();
  if (base === 'cmd' || base === 'cmd.exe') {
    return 'cmd';
  }
  if (base === 'powershell' || base === 'powershell.exe' || base === 'pwsh' || base === 'pwsh.exe') {
    return 'powershell';
  }
  return 'posix';
}

function escapeShellArgForFamily(arg: string, family: ShellFamily): string {
  if (family === 'powershell') {
    return `'${arg.replace(/'/g, "''")}'`;
  }

  if (family === 'cmd') {
    const escaped = arg
      .replace(/"/g, '""')
      .replace(/%/g, '%%');
    return `"${escaped}"`;
  }

  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommandLine(shellPath: string, command: string, args: string[] = []): string {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('command 不能为空');
  }

  const family = detectShellFamily(shellPath);
  return [trimmed, ...args].map((part) => escapeShellArgForFamily(part, family)).join(' ');
}

function writeShellPayload(session: ManagedInteractiveProcess, payload: string): void {
  const line = payload.endsWith('\n') ? payload : `${payload}\n`;
  session.child.stdin.write(line, 'utf8');
}

function shellTokenLooksLikeUnquotedVersionConstraint(token: string): boolean {
  if (/^=\d/.test(token)) {
    return true;
  }

  for (const operator of ['>=', '<=', '==', '!=', '~=', '>', '<']) {
    const index = token.indexOf(operator);
    if (index < 0) {
      continue;
    }

    const left = token.slice(0, index);
    const right = token.slice(index + operator.length);
    if (!right) {
      continue;
    }
    if (left && !/[A-Za-z]/.test(left)) {
      continue;
    }
    if (!/^\d/.test(right)) {
      continue;
    }

    return true;
  }

  return false;
}

function findUnquotedShellVersionConstraint(input: string): string | null {
  let token = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escapeNext = false;

  const flush = (): string | null => {
    if (!token) {
      return null;
    }

    const candidate = token;
    token = '';
    return shellTokenLooksLikeUnquotedVersionConstraint(candidate) ? candidate : null;
  };

  for (const ch of input) {
    if (escapeNext) {
      escapeNext = false;
      if (!inSingle && !inDouble && !inBacktick) {
        if (ch === '\n') {
          // \<newline> 是 shell 行续接符，等价于把两行合并 — 视为 token 边界
          const found = flush();
          if (found) {
            return found;
          }
        } else {
          token += ch;
        }
      }
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escapeNext = true;
      continue;
    }

    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingle || inDouble || inBacktick) {
      continue;
    }

    if (/\s/.test(ch) || ch === '|' || ch === '&' || ch === ';' || ch === '(' || ch === ')') {
      const found = flush();
      if (found) {
        return found;
      }
      continue;
    }

    token += ch;
  }

  return flush();
}

interface ManagedProcess {
  child: ChildProcess;
  command: string;
  args: string[];
  workspacePath: string;
  startedAt: number;
  outputTail: string;
}

interface ManagedInteractiveProcess extends ManagedProcess {
  child: ChildProcessWithoutNullStreams;
}

export interface BackgroundCommandResult {
  command: string;
  args: string[];
  pid: number | null;
  started: boolean;
}

export interface BackgroundProcessEntry {
  pid: number;
  command: string;
  args: string[];
  workspacePath: string;
  startedAt: number;
  logTail: string;
}

export interface StopBackgroundProcessResult {
  pid: number;
  stopped: boolean;
}

export interface StopAllBackgroundProcessesResult {
  stopped: number;
}

export interface ShellSessionResult {
  sessionId: string;
  shell: string;
  workspacePath: string;
  startedAt: number;
  outputTail: string;
}

export interface ShellSessionEntry {
  sessionId: string;
  shell: string;
  workspacePath: string;
  startedAt: number;
  outputTail: string;
  active: boolean;
}

export interface ShellReadOutputResult {
  sessionId: string;
  outputTail: string;
  active: boolean;
}

export interface ShellSendInputResult {
  sessionId: string;
  accepted: boolean;
}

export interface ShellCloseSessionResult {
  sessionId: string;
  closed: boolean;
}

const backgroundProcesses = new Map<number, ManagedProcess>();
const shellSessions = new Map<string, ManagedInteractiveProcess>();
let shellCounter = 0;

function commandAllowed(command: string): boolean {
  return !BLOCKED_COMMANDS.has(path.basename(command));
}

const SHELL_SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.command', '.ksh', '.fish']);

function looksLikeShellScript(command: string): boolean {
  return SHELL_SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase());
}

async function scanScriptForVersionConstraint(
  workspace: string,
  command: string
): Promise<string | null> {
  if (!looksLikeShellScript(command)) return null;
  const scriptPath = path.isAbsolute(command) ? command : path.join(workspace, command);
  let content: string;
  try {
    const stat = await fs.stat(scriptPath);
    if (!stat.isFile() || stat.size > 500_000) return null;
    content = await fs.readFile(scriptPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const found = findUnquotedShellVersionConstraint(line);
    if (found) return found;
  }
  return null;
}

async function canonicalWorkspace(workspacePath: string): Promise<string> {
  const resolved = await fs.realpath(workspacePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error('项目文件夹不是目录');
  }
  return resolved;
}

function appendTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= TAIL_LIMIT ? next : next.slice(-TAIL_LIMIT);
}

function attachOutputTail(process: ManagedProcess): void {
  if (!process.child.stdout || !process.child.stderr) {
    return;
  }
  process.child.stdout.setEncoding('utf8');
  process.child.stderr.setEncoding('utf8');
  process.child.stdout.on('data', (chunk: string) => {
    process.outputTail = appendTail(process.outputTail, chunk);
  });
  process.child.stderr.on('data', (chunk: string) => {
    process.outputTail = appendTail(process.outputTail, chunk);
  });
}

function isRunning(process: ManagedProcess): boolean {
  return process.child.exitCode === null && !process.child.killed;
}

function buildShellSessionId(): string {
  shellCounter += 1;
  return `shell-${Date.now()}-${shellCounter}`;
}

function detectDefaultShell(customShell?: string): string {
  if (customShell?.trim()) {
    return customShell.trim();
  }

  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }

  if (process.env.SHELL?.trim()) {
    return process.env.SHELL.trim();
  }

  return '/bin/sh';
}

export async function startBackgroundCommand(
  workspacePath: string,
  command: string,
  args?: string[]
): Promise<BackgroundCommandResult> {
  if (!commandAllowed(command)) {
    throw new Error(
      `命令 \`${command}\` 被安全策略阻止。已阻止的入口: ${Array.from(BLOCKED_COMMANDS).join(', ')}`
    );
  }

  const workspace = await canonicalWorkspace(workspacePath);

  const constraint = await scanScriptForVersionConstraint(workspace, command);
  if (constraint) {
    throw new Error(
      `脚本 \`${command}\` 包含未加引号的版本约束 \`${constraint}\`，` +
      `shell 会将其中的 > 或 = 解析为重定向操作符并生成空文件。` +
      `请在脚本中改用 pip install -r requirements.txt 或将约束用引号括起。`
    );
  }

  const commandArgs = args ?? [];

  for (const [pid, process] of backgroundProcesses) {
    if (
      process.workspacePath === workspace &&
      process.command === command &&
      JSON.stringify(process.args) === JSON.stringify(commandArgs) &&
      isRunning(process)
    ) {
      return {
        command,
        args: commandArgs,
        pid,
        started: false,
      };
    }
  }

  const child = spawn(command, commandArgs, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeSpawnEnv(process.env),
  });

  const managed: ManagedProcess = {
    child,
    command,
    args: commandArgs,
    workspacePath: workspace,
    startedAt: Date.now(),
    outputTail: '',
  };
  attachOutputTail(managed);

  const pid = child.pid;
  if (typeof pid !== 'number') {
    child.kill();
    throw new Error('后台命令未返回有效 pid');
  }

  backgroundProcesses.set(pid, managed);
  child.on('exit', () => {
    backgroundProcesses.delete(pid);
  });

  return {
    command,
    args: commandArgs,
    pid,
    started: true,
  };
}

export async function listBackgroundProcesses(workspacePath?: string): Promise<BackgroundProcessEntry[]> {
  const filter = workspacePath ? await canonicalWorkspace(workspacePath) : undefined;
  return [...backgroundProcesses.entries()]
    .filter(([, process]) => !filter || process.workspacePath === filter)
    .map(([pid, process]) => ({
      pid,
      command: process.command,
      args: process.args,
      workspacePath: process.workspacePath,
      startedAt: process.startedAt,
      logTail: process.outputTail,
    }))
    .sort((left, right) => right.startedAt - left.startedAt || left.pid - right.pid);
}

export async function stopBackgroundProcess(pid: number): Promise<StopBackgroundProcessResult> {
  const process = backgroundProcesses.get(pid);
  if (!process) {
    return { pid, stopped: false };
  }

  backgroundProcesses.delete(pid);
  if (isRunning(process)) {
    process.child.kill();
  }
  return { pid, stopped: true };
}

export async function stopAllBackgroundProcesses(workspacePath?: string): Promise<StopAllBackgroundProcessesResult> {
  const filter = workspacePath ? await canonicalWorkspace(workspacePath) : undefined;
  let stopped = 0;

  for (const [pid, process] of [...backgroundProcesses.entries()]) {
    if (filter && process.workspacePath !== filter) {
      continue;
    }
    backgroundProcesses.delete(pid);
    if (isRunning(process)) {
      process.child.kill();
      stopped += 1;
    }
  }

  return { stopped };
}

export async function openShellSession(workspacePath: string, shell?: string): Promise<ShellSessionResult> {
  const workspace = await canonicalWorkspace(workspacePath);
  const shellPath = detectDefaultShell(shell);
  const child = spawn(shellPath, [], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sanitizeSpawnEnv(process.env),
  });

  const sessionId = buildShellSessionId();
  const managed: ManagedInteractiveProcess = {
    child,
    command: shellPath,
    args: [],
    workspacePath: workspace,
    startedAt: Date.now(),
    outputTail: '',
  };
  attachOutputTail(managed);
  shellSessions.set(sessionId, managed);
  child.on('exit', () => {
    shellSessions.delete(sessionId);
  });

  return {
    sessionId,
    shell: shellPath,
    workspacePath: workspace,
    startedAt: managed.startedAt,
    outputTail: managed.outputTail,
  };
}

export async function listShellSessions(workspacePath?: string): Promise<ShellSessionEntry[]> {
  const filter = workspacePath ? await canonicalWorkspace(workspacePath) : undefined;
  return [...shellSessions.entries()]
    .filter(([, process]) => !filter || process.workspacePath === filter)
    .map(([sessionId, process]) => ({
      sessionId,
      shell: process.command,
      workspacePath: process.workspacePath,
      startedAt: process.startedAt,
      outputTail: process.outputTail,
      active: isRunning(process),
    }))
    .sort((left, right) => right.startedAt - left.startedAt || left.sessionId.localeCompare(right.sessionId));
}

export function readShellOutput(sessionId: string): ShellReadOutputResult {
  const session = shellSessions.get(sessionId);
  if (!session) {
    throw new Error(`Shell 会话不存在: ${sessionId}`);
  }

  return {
    sessionId,
    outputTail: session.outputTail,
    active: isRunning(session),
  };
}

export async function sendShellInput(sessionId: string, input: string): Promise<ShellSendInputResult> {
  const session = shellSessions.get(sessionId);
  if (!session) {
    throw new Error(`Shell 会话不存在: ${sessionId}`);
  }

  const unsafeToken = findUnquotedShellVersionConstraint(input);
  if (unsafeToken) {
    throw new Error(
      `检测到未加引号的版本约束 ${JSON.stringify(unsafeToken)}。这会在 shell 中被解析成重定向并生成空文件。请把该参数包在引号里后重试，例如 '${unsafeToken}'。`
    );
  }

  writeShellPayload(session, input);
  return {
    sessionId,
    accepted: true,
  };
}

export async function sendShellCommand(
  sessionId: string,
  command: string,
  args?: string[]
): Promise<ShellSendInputResult> {
  const session = shellSessions.get(sessionId);
  if (!session) {
    throw new Error(`Shell 会话不存在: ${sessionId}`);
  }

  writeShellPayload(session, buildShellCommandLine(session.command, command, args ?? []));
  return {
    sessionId,
    accepted: true,
  };
}

export async function closeShellSession(sessionId: string): Promise<ShellCloseSessionResult> {
  const session = shellSessions.get(sessionId);
  if (!session) {
    return {
      sessionId,
      closed: false,
    };
  }

  shellSessions.delete(sessionId);
  if (isRunning(session)) {
    session.child.kill();
  }
  return {
    sessionId,
    closed: true,
  };
}
