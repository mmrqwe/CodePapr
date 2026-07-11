import { describe, expect, it, vi } from 'vitest';
import {
  createProjectDiagnosticsPlan,
  runProjectDiagnostics,
} from './projectDiagnostics';

describe('projectDiagnostics', () => {
  it('builds lint and typecheck stages from package scripts', () => {
    const plan = createProjectDiagnosticsPlan({
      entries: [
        { path: 'package.json', name: 'package.json', isDir: false, bytes: 300 },
        { path: 'pnpm-lock.yaml', name: 'pnpm-lock.yaml', isDir: false, bytes: 1000 },
      ],
      packageJsonContent: JSON.stringify({
        scripts: {
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
    });

    expect(plan.available).toBe(true);
    expect(plan.packageManager).toBe('pnpm');
    expect(plan.stages).toHaveLength(2);
    expect(plan.stages[0]).toMatchObject({
      id: 'lint',
      command: 'pnpm',
      args: ['run', 'lint'],
      kind: 'package-script',
    });
    expect(plan.stages[1]).toMatchObject({
      id: 'typecheck',
      command: 'pnpm',
      args: ['run', 'typecheck'],
      fallback: false,
      kind: 'package-script',
    });
  });

  it('falls back to build when no explicit typecheck script exists', () => {
    const plan = createProjectDiagnosticsPlan({
      entries: [{ path: 'package-lock.json', name: 'package-lock.json', isDir: false, bytes: 1 }],
      packageJsonContent: JSON.stringify({
        scripts: {
          lint: 'eslint .',
          build: 'tsc',
        },
      }),
    });

    expect(plan.available).toBe(true);
    expect(plan.stages[1]).toMatchObject({
      id: 'typecheck',
      command: 'npm',
      args: ['run', 'build'],
      fallback: true,
      kind: 'package-script',
    });
  });

  it('runs diagnostics and returns stage results', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return {
          entries: [
            { path: 'package.json', name: 'package.json', isDir: false, bytes: 200 },
            { path: 'package-lock.json', name: 'package-lock.json', isDir: false, bytes: 1000 },
          ],
        };
      }
      if (command === 'read_text_file') {
        return {
          content: JSON.stringify({
            scripts: {
              lint: 'eslint .',
              build: 'tsc',
            },
          }),
        };
      }
      if (command === 'run_workspace_command') {
        const script = Array.isArray(args?.args) ? String(args?.args?.[1]) : '';
        return {
          command: 'npm',
          args: ['run', script],
          status: script === 'lint' ? 0 : 1,
          stdout: script === 'lint' ? 'lint ok' : '',
          stderr: script === 'lint' ? '' : 'build failed',
          timedOut: false,
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const report = await runProjectDiagnostics(
      '/tmp/workspace',
      invoke as unknown as Parameters<typeof runProjectDiagnostics>[1]
    );

    expect(report.available).toBe(true);
    expect(report.overallStatus).toBe('failed');
    expect(report.stages).toHaveLength(2);
    expect(report.stages[0]?.success).toBe(true);
    expect(report.stages[1]?.fallback).toBe(true);
    expect(report.stages[1]?.excerpt).toContain('build failed');
  });

  it('prefers Python syntax diagnostics over build fallback for Python workspaces', () => {
    const plan = createProjectDiagnosticsPlan({
      entries: [
        { path: 'package.json', name: 'package.json', isDir: false, bytes: 120 },
        { path: 'requirements.txt', name: 'requirements.txt', isDir: false, bytes: 42 },
        { path: 'main.py', name: 'main.py', isDir: false, bytes: 80 },
      ],
      packageJsonContent: JSON.stringify({
        scripts: {
          build: 'python -m py_compile main.py',
        },
      }),
    });

    expect(plan.available).toBe(true);
    expect(plan.stages).toHaveLength(1);
    expect(plan.stages[0]).toMatchObject({
      id: 'typecheck',
      label: 'python static',
      command: 'python',
      kind: 'python-static',
      fallback: false,
    });
    expect(plan.stages[0]?.args[0]).toBe('-c');
  });

  it('supports Python workspaces without package.json', async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return {
          entries: [
            { path: 'requirements.txt', name: 'requirements.txt', isDir: false, bytes: 20 },
            { path: 'main.py', name: 'main.py', isDir: false, bytes: 60 },
          ],
        };
      }
      if (command === 'read_text_file') {
        throw new Error('missing package.json');
      }
      if (command === 'run_workspace_command') {
        return {
          command: 'python3',
          args: Array.isArray(args?.args) ? (args.args as string[]) : [],
          status: 0,
          stdout: 'Python syntax OK (1 files checked)',
          stderr: '',
          timedOut: false,
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const report = await runProjectDiagnostics(
      '/tmp/python-workspace',
      invoke as unknown as Parameters<typeof runProjectDiagnostics>[1]
    );

    expect(report.available).toBe(true);
    expect(report.overallStatus).toBe('passed');
    expect(report.stages[0]).toMatchObject({
      label: 'python static',
      kind: 'python-static',
    });
  });

  it('adds a C# project build stage for the owning csproj after a changed file', () => {
    const plan = createProjectDiagnosticsPlan({
      entries: [
        { path: 'App.sln', name: 'App.sln', isDir: false, bytes: 100 },
        { path: 'src/App/App.csproj', name: 'App.csproj', isDir: false, bytes: 200 },
        { path: 'tests/App.Tests/App.Tests.csproj', name: 'App.Tests.csproj', isDir: false, bytes: 200 },
      ],
      changedPaths: ['tests/App.Tests/OrderControllerTests.cs'],
    });

    expect(plan.available).toBe(true);
    expect(plan.stages).toContainEqual(
      expect.objectContaining({
        id: 'dotnet-build',
        command: 'dotnet',
        args: ['build', 'tests/App.Tests/App.Tests.csproj', '--nologo'],
        kind: 'dotnet-build',
      })
    );
  });

  it('includes nested Cargo checks only when changed files live under that project', () => {
    const noRustChange = createProjectDiagnosticsPlan({
      entries: [
        { path: 'package.json', name: 'package.json', isDir: false, bytes: 100 },
        { path: 'packages/native/Cargo.toml', name: 'Cargo.toml', isDir: false, bytes: 200 },
      ],
      packageJsonContent: JSON.stringify({ scripts: { lint: 'eslint .' } }),
      changedPaths: ['src/App.tsx'],
    });

    expect(noRustChange.stages.some((stage) => stage.kind === 'cargo-check')).toBe(false);

    const rustChange = createProjectDiagnosticsPlan({
      entries: [
        { path: 'package.json', name: 'package.json', isDir: false, bytes: 100 },
        { path: 'packages/native/Cargo.toml', name: 'Cargo.toml', isDir: false, bytes: 200 },
      ],
      packageJsonContent: JSON.stringify({ scripts: { lint: 'eslint .' } }),
      changedPaths: ['packages/native/src/lib.rs'],
    });

    expect(rustChange.stages).toContainEqual(
      expect.objectContaining({
        id: 'cargo-check',
        command: 'cargo',
        args: ['check', '--manifest-path', 'packages/native/Cargo.toml', '--all-targets'],
        kind: 'cargo-check',
      })
    );
  });
});
