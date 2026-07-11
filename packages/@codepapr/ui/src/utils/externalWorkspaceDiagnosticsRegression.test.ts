import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  filterDeclaredModuleResolutionDiagnostics,
  parseDeclaredModuleNames,
} from './editorWorkspaceModules';
import {
  runProjectDiagnostics,
  type ProjectDiagnosticsCommandResult,
  type ProjectDiagnosticsListEntry,
} from './projectDiagnostics';
import { summarizeProjectFileDiagnostics } from './projectFileDiagnostics';

const externalWorkspacePath = process.env.CODEPAPR_EXTERNAL_WORKSPACE?.trim() ?? '';
const itIfExternalWorkspace = externalWorkspacePath ? it : it.skip;

async function listTopLevelEntries(workspacePath: string): Promise<ProjectDiagnosticsListEntry[]> {
  const children = await fsp.readdir(workspacePath, { withFileTypes: true });
  return Promise.all(
    children.map(async (entry) => {
      const fullPath = path.join(workspacePath, entry.name);
      const stat = await fsp.stat(fullPath);
      return {
        path: entry.name,
        name: entry.name,
        isDir: entry.isDirectory(),
        bytes: entry.isDirectory() ? 0 : stat.size,
      } satisfies ProjectDiagnosticsListEntry;
    })
  );
}

async function runWorkspaceCommand(params: {
  workspacePath: string;
  command: string;
  args: string[];
  timeoutSeconds?: number;
}): Promise<ProjectDiagnosticsCommandResult> {
  const command = process.platform === 'win32' && params.command === 'npm' ? 'npm.cmd' : params.command;

  return await new Promise<ProjectDiagnosticsCommandResult>((resolve, reject) => {
    const child = spawn(command, params.args, {
      cwd: params.workspacePath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = (params.timeoutSeconds ?? 120) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({
        command: params.command,
        args: params.args,
        status,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

describe('external workspace diagnostics regression', () => {
  itIfExternalWorkspace(
    'keeps project diagnostics clean for representative files when the external workspace build passes',
    async () => {
      const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (command === 'list_workspace_files') {
          return {
            entries: await listTopLevelEntries(externalWorkspacePath),
          } as T;
        }

        if (command === 'read_text_file') {
          const relativePath = String(args?.relativePath ?? '');
          return {
            content: await fsp.readFile(path.join(externalWorkspacePath, relativePath), 'utf8'),
          } as T;
        }

        if (command === 'run_workspace_command') {
          return (await runWorkspaceCommand({
            workspacePath: externalWorkspacePath,
            command: String(args?.command ?? ''),
            args: Array.isArray(args?.args)
              ? args.args.map((value) => String(value))
              : [],
            timeoutSeconds:
              typeof args?.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
          })) as T;
        }

        throw new Error(`unexpected invoke command: ${command}`);
      };

      const report = await runProjectDiagnostics(externalWorkspacePath, invoke);

      expect(report.available).toBe(true);
      expect(report.overallStatus).toBe('passed');
      expect(report.stages.every((stage) => stage.success)).toBe(true);

      for (const filePath of ['vite.config.ts', 'src/App.tsx', 'src/main.tsx', 'package.json']) {
        const summary = summarizeProjectFileDiagnostics({
          workspacePath: externalWorkspacePath,
          selectedPath: filePath,
          report,
        });

        expect(summary.total, `${filePath} should stay clean in project diagnostics`).toBe(0);
      }

      const packageJsonContent = await fsp.readFile(
        path.join(externalWorkspacePath, 'package.json'),
        'utf8'
      );
      const declaredModuleNames = parseDeclaredModuleNames(packageJsonContent);
      const remainingMarkers = filterDeclaredModuleResolutionDiagnostics(
        [
          {
            message: "Cannot find module 'vite' or its corresponding type declarations.",
          },
          {
            message:
              "Cannot find module '@vitejs/plugin-react' or its corresponding type declarations.",
          },
        ],
        declaredModuleNames
      );

      expect(remainingMarkers).toHaveLength(0);
    },
    180_000
  );
});
