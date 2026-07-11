import { describe, expect, it } from 'vitest';
import {
  createEmptyProjectFileDiagnosticsSummary,
  summarizeProjectFileDiagnostics,
} from './projectFileDiagnostics';
import type { ProjectDiagnosticsReport } from './projectDiagnostics';

function createReport(): ProjectDiagnosticsReport {
  return {
    available: true,
    packageManager: 'npm',
    packageJsonPath: 'package.json',
    ranAt: 1,
    overallStatus: 'failed',
    stages: [
      {
        id: 'typecheck',
        scriptName: 'typecheck',
        label: 'typecheck',
        command: 'npm',
        args: ['run', 'typecheck'],
        fallback: false,
        kind: 'package-script',
        success: false,
        status: 1,
        timedOut: false,
        stdout: '',
        stderr:
          'src/App.tsx:3:14 error Cannot find name foo\n' +
          'src/App.tsx:8:2 warning Unused variable bar\n' +
          'src/main.tsx:1:1 error Another file issue\n',
        excerpt: '',
      },
    ],
  };
}

describe('projectFileDiagnostics', () => {
  it('summarizes project diagnostics for the selected file only', () => {
    const summary = summarizeProjectFileDiagnostics({
      workspacePath: '/workspace/demo',
      selectedPath: 'src/App.tsx',
      report: createReport(),
    });

    expect(summary.available).toBe(true);
    expect(summary.covered).toBe(true);
    expect(summary.total).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.items[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 3,
      column: 14,
      stageLabel: 'typecheck',
    });
  });

  it('returns an unavailable summary when the project report is missing or unavailable', () => {
    expect(
      summarizeProjectFileDiagnostics({
        workspacePath: '/workspace/demo',
        selectedPath: 'src/App.tsx',
        report: null,
      })
    ).toEqual(createEmptyProjectFileDiagnosticsSummary());

    expect(
      summarizeProjectFileDiagnostics({
        workspacePath: '/workspace/demo',
        selectedPath: 'src/App.tsx',
        report: {
          available: false,
          packageManager: 'npm',
          packageJsonPath: 'package.json',
          ranAt: 1,
          overallStatus: 'unavailable',
          message: 'unavailable',
          stages: [],
        },
      })
    ).toEqual(createEmptyProjectFileDiagnosticsSummary('unavailable'));
  });

  it('marks Python files as covered when the report used Python syntax diagnostics', () => {
    const report = createReport();
    report.stages = [
      {
        id: 'typecheck',
        scriptName: 'python-syntax',
        label: 'python syntax',
        command: 'python3',
        args: ['-c', 'print(1)'],
        fallback: false,
        kind: 'python-syntax',
        success: true,
        status: 0,
        timedOut: false,
        stdout: 'Python syntax OK (9 files checked)',
        stderr: '',
        excerpt: 'Python syntax OK (9 files checked)',
      },
    ];

    const summary = summarizeProjectFileDiagnostics({
      workspacePath: '/workspace',
      selectedPath: 'agent_tui/memory.py',
      report,
    });

    expect(summary.covered).toBe(true);
    expect(summary.total).toBe(0);
  });

  it('marks clean TypeScript files as covered by successful project scripts', () => {
    const report = createReport();
    report.overallStatus = 'passed';
    report.stages = [
      {
        id: 'typecheck',
        scriptName: 'typecheck',
        label: 'typecheck',
        command: 'npm',
        args: ['run', 'typecheck'],
        fallback: false,
        kind: 'package-script',
        success: true,
        status: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        excerpt: '',
      },
    ];

    const summary = summarizeProjectFileDiagnostics({
      workspacePath: '/workspace',
      selectedPath: 'vite.config.ts',
      report,
    });

    expect(summary.covered).toBe(true);
    expect(summary.total).toBe(0);
  });
});