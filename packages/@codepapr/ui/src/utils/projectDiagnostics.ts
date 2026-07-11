import {
  createProjectDiagnosticsPlan,
  runProjectDiagnostics as runSharedProjectDiagnostics,
  type ProjectDiagnosticsCommandResult,
  type ProjectDiagnosticStagePlan,
  type ProjectDiagnosticStageResult,
  type ProjectDiagnosticsListEntry,
  type ProjectDiagnosticsReport,
  type WorkspaceHost,
} from '@codepapr/core';
import type { Lang } from './i18n';

type InvokeLike = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type {
  ProjectDiagnosticsCommandResult,
  ProjectDiagnosticStagePlan,
  ProjectDiagnosticStageResult,
  ProjectDiagnosticsListEntry,
  ProjectDiagnosticsReport,
};

export { createProjectDiagnosticsPlan };

function createInvokeWorkspaceHost(workspacePath: string, invoke: InvokeLike): Pick<WorkspaceHost, 'workspacePath' | 'listFiles' | 'readTextFile' | 'runCommand'> {
  return {
    workspacePath,
    async listFiles(options) {
      const result = await invoke<{ root?: string; entries: ProjectDiagnosticsListEntry[]; truncated?: boolean }>('list_workspace_files', {
        workspacePath,
        relativePath: options.relativePath,
        maxDepth: options.maxDepth,
      });
      return {
        root: result.root,
        entries: result.entries,
        truncated: result.truncated,
      };
    },
    async readTextFile(options) {
      const result = await invoke<{ path?: string; content: string; bytes: number }>('read_text_file', {
        workspacePath,
        relativePath: options.relativePath,
        maxBytes: options.maxBytes,
        startLine: options.startLine,
        endLine: options.endLine,
        aroundLine: options.aroundLine,
        contextLines: options.contextLines,
      });
      return {
        path: result.path,
        content: result.content,
        bytes: result.bytes,
      };
    },
    async runCommand(options) {
      return await invoke<ProjectDiagnosticsCommandResult>('run_workspace_command', {
        workspacePath,
        command: options.command,
        args: options.args,
        timeoutSeconds: options.timeoutSeconds,
      });
    },
  };
}

export async function runProjectDiagnostics(
  workspacePath: string,
  invoke: InvokeLike,
  options: { changedPaths?: readonly string[] } = {}
): Promise<ProjectDiagnosticsReport> {
  return await runSharedProjectDiagnostics(createInvokeWorkspaceHost(workspacePath, invoke), options);
}

export function formatProjectDiagnosticsTimestamp(
  value: number,
  lang: Lang | undefined
): string {
  const locale =
    lang === 'en' ? 'en-US' : lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  return new Date(value).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
