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
