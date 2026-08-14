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
    expect(byId.get('lint')?.failureReason).toBeNull();
    expect(byId.get('typecheck')?.success).toBe(true);

    const cargo = byId.get('cargo-check');
    expect(cargo).toBeDefined();
    expect(cargo?.success).toBe(false);
    expect(cargo?.status).toBeNull();
    expect(cargo?.stderr).toContain('ENOENT');
    // 工具链缺失属于环境问题，标记为 spawn 而非 exit，供自动修复流过滤
    expect(cargo?.failureReason).toBe('spawn');

    expect(report.overallStatus).toBe('failed');
  });

  it('reports all stages passing when nothing fails', async () => {
    const report = await runProjectDiagnostics(createHost(new Set()));
    expect(report.available).toBe(true);
    expect(report.stages.length).toBeGreaterThanOrEqual(3);
    expect(report.stages.every((s) => s.success)).toBe(true);
    expect(report.stages.every((s) => s.failureReason === null)).toBe(true);
    expect(report.overallStatus).toBe('passed');
  });

  it('marks non-zero exit codes as exit failures (code problem)', async () => {
    const host: DiagHost = {
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
      async runCommand({ command, args }) {
        if (command === 'cargo') {
          return { command, args: args ?? [], status: 101, stdout: '', stderr: 'error: compilation failed', timedOut: false };
        }
        return { command, args: args ?? [], status: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    };

    const report = await runProjectDiagnostics(host);

    const cargo = report.stages.find((s) => s.id === 'cargo-check');
    expect(cargo?.success).toBe(false);
    expect(cargo?.failureReason).toBe('exit');
    expect(report.overallStatus).toBe('failed');
  });

  it('detects project types and reports node as primary when it owns most stages', async () => {
    const host: DiagHost = {
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
      async runCommand({ command, args }) {
        return { command, args: args ?? [], status: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    };

    const report = await runProjectDiagnostics(host);

    expect(report.projectTypes).toEqual(['node', 'rust']);
    expect(report.primaryProjectType).toBe('node');
    expect(report.packageManager).toBe('npm');
    expect(report.packageJsonPath).toBe('package.json');
  });

  it('reports null package fields for non-node projects', async () => {
    const host: DiagHost = {
      workspacePath: '/proj',
      async listFiles() {
        return {
          entries: [{ path: 'Cargo.toml', name: 'Cargo.toml', isDir: false, bytes: 50 }],
        };
      },
      async readTextFile() {
        throw new Error('no package.json');
      },
      async runCommand({ command, args }) {
        return { command, args: args ?? [], status: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    };

    const report = await runProjectDiagnostics(host);

    expect(report.available).toBe(true);
    expect(report.projectTypes).toEqual(['rust']);
    expect(report.primaryProjectType).toBe('rust');
    expect(report.packageManager).toBeNull();
    expect(report.packageJsonPath).toBeNull();
  });

  it('produces go-build and go-vet stages with module workdir instead of go test', async () => {
    const host: DiagHost = {
      workspacePath: '/proj',
      async listFiles() {
        return {
          entries: [{ path: 'services/api/go.mod', name: 'go.mod', isDir: false, bytes: 50 }],
        };
      },
      async readTextFile() {
        throw new Error('no package.json');
      },
      async runCommand({ command, args }) {
        return { command, args: args ?? [], status: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    };

    const report = await runProjectDiagnostics(host, { changedPaths: ['services/api/main.go'] });

    expect(report.projectTypes).toEqual(['go']);
    expect(report.primaryProjectType).toBe('go');
    const build = report.stages.find((s) => s.id === 'go-build');
    const vet = report.stages.find((s) => s.id === 'go-vet');
    expect(build).toMatchObject({
      command: 'go',
      args: ['build', './...'],
      workdir: 'services/api',
      kind: 'go-build',
      category: 'compile',
    });
    expect(vet).toMatchObject({
      command: 'go',
      args: ['vet', './...'],
      workdir: 'services/api',
      kind: 'go-vet',
      category: 'static-analysis',
    });
    expect(report.stages.some((s) => s.id === 'go-test')).toBe(false);
  });

  it('uses gradle classes (compile only) instead of gradle check', async () => {
    const host: DiagHost = {
      workspacePath: '/proj',
      async listFiles() {
        return {
          entries: [
            { path: 'build.gradle', name: 'build.gradle', isDir: false, bytes: 50 },
            { path: 'gradlew', name: 'gradlew', isDir: false, bytes: 50 },
          ],
        };
      },
      async readTextFile() {
        throw new Error('no package.json');
      },
      async runCommand({ command, args }) {
        return { command, args: args ?? [], status: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    };

    const report = await runProjectDiagnostics(host);

    expect(report.projectTypes).toEqual(['gradle']);
    const gradle = report.stages.find((s) => s.id === 'gradle-classes');
    expect(gradle).toMatchObject({
      command: './gradlew',
      args: ['classes'],
      kind: 'gradle-classes',
      category: 'compile',
    });
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
