import type { WorkspaceHost } from '@codepapr/core';
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  runWorkspaceCommand,
  type WorkspaceEditRecord,
  writeWorkspaceFile,
} from './workspaceFs';

export function createCliWorkspaceHost(params: {
  workspacePath: string;
  onEdit?: (record: WorkspaceEditRecord) => void;
}): WorkspaceHost {
  return {
    workspacePath: params.workspacePath,
    async listFiles(options) {
      return await listWorkspaceFiles(params.workspacePath, options.relativePath, options.maxDepth);
    },
    async readTextFile(options) {
      return await readWorkspaceFile(params.workspacePath, options.relativePath, {
        maxBytes: options.maxBytes,
        startLine: options.startLine,
        endLine: options.endLine,
        aroundLine: options.aroundLine,
        contextLines: options.contextLines,
      });
    },
    async writeTextFile(options) {
      return await writeWorkspaceFile(params.workspacePath, options.relativePath, options.content, params.onEdit);
    },
    async runCommand(options) {
      return await runWorkspaceCommand(
        params.workspacePath,
        options.command,
        options.args,
        options.timeoutSeconds
      );
    },
  };
}