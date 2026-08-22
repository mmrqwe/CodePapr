import { invoke } from '@tauri-apps/api/core';
import type { EditHistory, WorkspaceHost, WorkspaceLanguageServiceRequestOptions } from '@codepapr/core';
import { assertAgentCodePaprAccess, assertShellCodePaprAccess } from './codepaprAgentAccess';

interface ListFilesResult {
  root?: string;
  entries: Array<{
    path: string;
    name: string;
    isDir: boolean;
    bytes: number;
  }>;
  truncated?: boolean;
}

interface ReadFileResult {
  path?: string;
  content: string;
  bytes: number;
  truncatedByBytes?: boolean;
  truncatedByRange?: boolean;
}

interface WriteTextFileResult {
  path: string;
  bytes: number;
}

interface CommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface LspRequestEnvelope<T> {
  message?: {
    result?: T;
  };
}

let lspDocumentVersion = 1;

function nextLspDocumentVersion(): number {
  const current = lspDocumentVersion;
  lspDocumentVersion += 1;
  return current;
}

export function createUiWorkspaceHost(params: {
  workspacePath: string;
  editHistory?: EditHistory;
  notifyWorkspaceMutation?: (paths: string[]) => void;
  mode?: 'ask' | 'plan' | 'agent' | 'app';
  ensureExternalPathAllowed?: (
    path: string | undefined,
    operation: 'read' | 'list' | 'write' | 'execute',
  ) => Promise<void>;
}): WorkspaceHost {
  const mode = params.mode ?? 'agent';
  return {
    workspacePath: params.workspacePath,
    async listFiles(options) {
      await params.ensureExternalPathAllowed?.(options.relativePath, 'list');
      assertAgentCodePaprAccess(options.relativePath, 'list', mode);
      return await invoke<ListFilesResult>('list_workspace_files', {
        workspacePath: params.workspacePath,
        relativePath: options.relativePath,
        maxDepth: options.maxDepth,
      });
    },
    async readTextFile(options) {
      await params.ensureExternalPathAllowed?.(options.relativePath, 'read');
      assertAgentCodePaprAccess(options.relativePath, 'read', mode);
      return await invoke<ReadFileResult>('read_text_file', {
        workspacePath: params.workspacePath,
        relativePath: options.relativePath,
        maxBytes: options.maxBytes,
        startLine: options.startLine,
        endLine: options.endLine,
        aroundLine: options.aroundLine,
        contextLines: options.contextLines,
      });
    },
    async writeTextFile(options) {
      await params.ensureExternalPathAllowed?.(options.relativePath, 'write');
      assertAgentCodePaprAccess(options.relativePath, 'write', mode);
      // 与 MAX_WRITE_BYTES(20MB) 对齐：before 快照必须覆盖可写入的全部范围，
      // 否则 undo 会把文件"恢复"成截断内容
      const before = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: params.workspacePath,
        relativePath: options.relativePath,
        maxBytes: 20_000_000,
      }).catch(() => null);
      const result = await invoke<WriteTextFileResult>('write_text_file', {
        workspacePath: params.workspacePath,
        relativePath: options.relativePath,
        content: options.content,
      });
      params.editHistory?.record({
        path: result.path,
        before: before?.content ?? null,
        after: options.content,
      });
      params.notifyWorkspaceMutation?.([result.path]);
      return result;
    },
    async runCommand(options) {
      await params.ensureExternalPathAllowed?.(options.workdir, 'execute');
      assertShellCodePaprAccess(
        [options.command, ...(options.args ?? [])].join(' '),
        mode,
        options.workdir
      );
      return await invoke<CommandResult>('run_workspace_command', {
        workspacePath: params.workspacePath,
        command: options.command,
        args: options.args,
        timeoutSeconds: options.timeoutSeconds,
        workdir: options.workdir,
      });
    },
    languageService: {
      async request<TResult, TParams>(options: WorkspaceLanguageServiceRequestOptions<TParams>) {
        await params.ensureExternalPathAllowed?.(options.relativePath, 'read');
        assertAgentCodePaprAccess(options.relativePath, 'read', mode);
        const content =
          options.content ??
          (
            await invoke<ReadFileResult>('read_text_file', {
              workspacePath: params.workspacePath,
              relativePath: options.relativePath,
              maxBytes: 20_000_000,
            })
          ).content;

        let opened = false;
        try {
          await invoke('lsp_open_document', {
            workspacePath: params.workspacePath,
            languageId: options.languageId,
            relativePath: options.relativePath,
            content,
            version: nextLspDocumentVersion(),
          });
          opened = true;
          const result = await invoke<LspRequestEnvelope<TResult>>('lsp_request', {
            workspacePath: params.workspacePath,
            languageId: options.languageId,
            method: options.method,
            params: options.params,
          });
          return result.message?.result as TResult;
        } finally {
          if (opened) {
            await invoke('lsp_close_document', {
              workspacePath: params.workspacePath,
              languageId: options.languageId,
              relativePath: options.relativePath,
            }).catch(() => undefined);
          }
        }
      },
    },
  };
}
