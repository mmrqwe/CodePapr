import { invoke } from '@tauri-apps/api/core';

interface PollResult {
  done: boolean;
  result: WorkspaceTaskResult | null;
}

type WorkspaceTaskResult =
  | { type: 'listFiles'; id: number; result: ListFilesResult | { error: string } }
  | { type: 'readFile'; id: number; result: ReadFileResult | { error: string } }
  | { type: 'runCommand'; id: number; result: CommandResult | { error: string } };

interface ListFilesResult {
  root: string;
  entries: { path: string; name: string; isDir: boolean; bytes: number }[];
  truncated: boolean;
}

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncatedByRange: boolean;
  locationLine: number | null;
  locationColumn: number | null;
}

interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const POLL_INTERVAL_MS = 80;
const POLL_TIMEOUT_MS = 8_000;

let taskQueueAvailable: boolean | null = null;

async function enqueueAndWait<T>(
  taskType: string,
  params: {
    workspacePath: string;
    relativePath?: string;
    maxDepth?: number;
    maxBytes?: number;
    command?: string;
    args?: string[];
    timeoutSeconds?: number;
  },
  signal?: AbortSignal,
): Promise<T> {
  if (taskQueueAvailable !== false) {
    try {
      const taskId = await invoke<number>('enqueue_workspace_task', {
        taskType,
        workspacePath: params.workspacePath,
        relativePath: params.relativePath ?? null,
        maxDepth: params.maxDepth ?? null,
        maxBytes: params.maxBytes ?? null,
        command: params.command ?? null,
        args: params.args ?? null,
        timeoutSeconds: params.timeoutSeconds ?? null,
      });

      if (typeof taskId !== 'number') {
        taskQueueAvailable = false;
        return fallbackDirectInvoke<T>(taskType, params);
      }

      taskQueueAvailable = true;

      const start = Date.now();
      let iterations = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (signal?.aborted) {
          throw new Error('Task aborted');
        }

        iterations++;
        if (iterations > POLL_TIMEOUT_MS / POLL_INTERVAL_MS + 10) {
          throw new Error(`Task ${taskType} exceeded maximum poll iterations`);
        }

        const poll = await invoke<PollResult>('poll_workspace_task', { taskId });

        if (poll && poll.done && poll.result) {
          return extractResult<T>(poll.result);
        }

        if (Date.now() - start > POLL_TIMEOUT_MS) {
          throw new Error(`Task ${taskType} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch {
      taskQueueAvailable = false;
      return fallbackDirectInvoke<T>(taskType, params);
    }
  }

  return fallbackDirectInvoke<T>(taskType, params);
}

function extractResult<T>(raw: WorkspaceTaskResult): T {
  const result = raw.result;
  if (typeof result === 'string') {
    throw new Error(result);
  }
  if (result !== null && typeof result === 'object' && 'error' in result) {
    throw new Error((result as { error: string }).error);
  }
  return result as T;
}

async function fallbackDirectInvoke<T>(
  taskType: string,
  params: {
    workspacePath: string;
    relativePath?: string;
    maxDepth?: number;
    maxBytes?: number;
  },
): Promise<T> {
  if (taskType === 'list_files') {
    return invoke<T>('list_workspace_files', {
      workspacePath: params.workspacePath,
      maxDepth: params.maxDepth,
    });
  }
  if (taskType === 'read_file') {
    return invoke<T>('read_text_file', {
      workspacePath: params.workspacePath,
      relativePath: params.relativePath,
      maxBytes: params.maxBytes,
    });
  }
  throw new Error(`Unknown task type: ${taskType}`);
}

export async function enqueueListFiles(
  workspacePath: string,
  maxDepth: number,
  signal?: AbortSignal,
): Promise<ListFilesResult> {
  return enqueueAndWait<ListFilesResult>('list_files', { workspacePath, maxDepth }, signal);
}

export async function enqueueReadFile(
  workspacePath: string,
  relativePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ReadFileResult> {
  return enqueueAndWait<ReadFileResult>('read_file', { workspacePath, relativePath, maxBytes }, signal);
}

export async function enqueueRunCommand(
  workspacePath: string,
  command: string,
  args: string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return enqueueAndWait<CommandResult>('run_command', { workspacePath, command, args, timeoutSeconds }, signal);
}
