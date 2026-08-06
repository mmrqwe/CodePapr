import { invoke } from '@tauri-apps/api/core';
import type { EditHistory, WorkspaceHost, WorkspaceLanguageServiceRequestOptions } from '@codepapr/core';

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
}): WorkspaceHost {
  return {
    workspacePath: params.workspacePath,
    async listFiles(options) {
      return await invoke<ListFilesResult>('list_workspace_files', {
        workspacePath: params.workspacePath,
        relativePath: options.relativePath,
        maxDepth: options.maxDepth,
      });
    },
    async readTextFile(options) {
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
      const before = await invoke<ReadFileResult>('read_text_file', {
        workspacePath: params.workspacePath,
        relativePath: options.relativePath,
        maxBytes: 1_000_000,
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
        const content =
          options.content ??
          (
            await invoke<ReadFileResult>('read_text_file', {
              workspacePath: params.workspacePath,
              relativePath: options.relativePath,
              maxBytes: 1_000_000,
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
