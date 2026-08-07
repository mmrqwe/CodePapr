import { describe, expect, it } from 'vitest';
import { runProjectDiagnostics } from '../src/tool/workspace/diagnostics';
import type { WorkspaceHost } from '../src/tool/workspace/host';

type DiagHost = Pick<WorkspaceHost, 'workspacePath' | 'listFiles' | 'readTextFile' | 'runCommand'>;

function createHost(failingCommands: Set<string>): DiagHost {
  return {
    workspacePath: '/proj',
    async listFiles() {
      return {
        entries: [
          { path: 'package.json', name: 'package.json', isDir: false, bytes: 100 },
          { path: 'Cargo.toml', name: 'Cargo.toml', isDir: false, bytes: 50 },
        ],
      };
    },
    async readTextFile() {
      return {
        content: JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }),
        bytes: 100,
      };
    },
    async runCommand({ command }) {
      if (failingCommands.has(command)) {
        throw new Error(`spawn ${command} ENOENT`);
      }
      return { command, args: [], status: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  };
}

describe('runProjectDiagnostics stage isolation', () => {
  it('records a failed stage but still runs the remaining stages', async () => {
    const report = await runProjectDiagnostics(createHost(new Set(['cargo'])));

    expect(report.available).toBe(true);
    const byId = new Map(report.stages.map((s) => [s.id, s]));

    expect(byId.get('lint')?.success).toBe(true);
    expect(byId.get('typecheck')?.success).toBe(true);

    const cargo = byId.get('cargo-check');
    expect(cargo).toBeDefined();
    expect(cargo?.success).toBe(false);
    expect(cargo?.status).toBeNull();
    expect(cargo?.stderr).toContain('ENOENT');

    expect(report.overallStatus).toBe('failed');
  });

  it('reports all stages passing when nothing fails', async () => {
    const report = await runProjectDiagnostics(createHost(new Set()));
    expect(report.available).toBe(true);
    expect(report.stages.length).toBeGreaterThanOrEqual(3);
    expect(report.stages.every((s) => s.success)).toBe(true);
    expect(report.overallStatus).toBe('passed');
  });
});

describe('runProjectDiagnostics monorepo nested package.json', () => {
  function createMonorepoHost(nestedPaths: string[]): DiagHost {
    return {
      workspacePath: '/proj',
      async listFiles() {
        return {
          entries: [
            { path: 'package.json', name: 'package.json', isDir: false, bytes: 100 },
            ...nestedPaths.map((path) => ({
              path,
              name: 'package.json',
              isDir: false,
              bytes: 100,
            })),
          ],
        };
      },
      async readTextFile({ relativePath }) {
        if (relativePath === 'package.json') {
          // 根 package.json 没有 lint/typecheck 脚本
          return { content: JSON.stringify({ scripts: {} }), bytes: 20 };
        }
        return {
          content: JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }),
          bytes: 100,
        };
      },
      async runCommand({ command, args }) {
        return { command, args: args ?? [], status: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    };
  }

  it('falls back to nested package.json scripts when root has none', async () => {
    const report = await runProjectDiagnostics(createMonorepoHost(['packages/app/package.json']));

    expect(report.available).toBe(true);
    expect(report.packageJsonPath).toBe('packages/app/package.json');

    const lint = report.stages.find((s) => s.id === 'lint');
    const typecheck = report.stages.find((s) => s.id === 'typecheck');
    expect(lint).toBeDefined();
    expect(typecheck).toBeDefined();
    // 子包脚本必须在子包目录内执行
    expect(lint?.workdir).toBe('packages/app');
    expect(typecheck?.workdir).toBe('packages/app');
    expect(report.overallStatus).toBe('passed');
  });

  it('prefers the nested package.json covering changed paths', async () => {
    const report = await runProjectDiagnostics(
      createMonorepoHost(['packages/a/package.json', 'packages/b/package.json']),
      { changedPaths: ['packages/b/src/index.ts'] }
    );

    expect(report.packageJsonPath).toBe('packages/b/package.json');
    const lint = report.stages.find((s) => s.id === 'lint');
    expect(lint?.workdir).toBe('packages/b');
  });
});
