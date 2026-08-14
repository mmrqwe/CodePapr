import { describe, expect, it } from 'vitest';
import {
  createEmptyProjectFileDiagnosticsSummary,
  summarizeProjectFileDiagnostics,
} from './projectFileDiagnostics';
import type { ProjectDiagnosticsReport } from './projectDiagnostics';

function createReport(): ProjectDiagnosticsReport {
  return {
    available: true,
    projectTypes: ['node'],
    primaryProjectType: 'node',
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
        category: 'typecheck',
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
          projectTypes: [],
          primaryProjectType: null,
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
    report.projectTypes = ['python'];
    report.primaryProjectType = 'python';
    report.packageManager = null;
    report.packageJsonPath = null;
    report.stages = [
      {
        id: 'typecheck',
        scriptName: 'python-static',
        label: 'python syntax',
        command: 'python3',
        args: ['-c', 'print(1)'],
        fallback: false,
        kind: 'python-static',
        category: 'syntax',
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

  it('marks Rust files as covered by successful cargo-check stages', () => {
    const report = createReport();
    report.overallStatus = 'passed';
    report.projectTypes = ['rust'];
    report.primaryProjectType = 'rust';
    report.packageManager = null;
    report.packageJsonPath = null;
    report.stages = [
      {
        id: 'cargo-check',
        scriptName: 'cargo-check',
        label: 'cargo check',
        command: 'cargo',
        args: ['check', '--workspace', '--all-targets'],
        fallback: false,
        kind: 'cargo-check',
        category: 'compile',
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
      selectedPath: 'src/lib.rs',
      report,
    });

    expect(summary.covered).toBe(true);
  });

  it('marks Go files as covered by go-build and go-vet stages', () => {
    const report = createReport();
    report.overallStatus = 'passed';
    report.projectTypes = ['go'];
    report.primaryProjectType = 'go';
    report.packageManager = null;
    report.packageJsonPath = null;
    report.stages = [
      {
        id: 'go-build',
        scriptName: 'go-build',
        label: 'go build ./...',
        command: 'go',
        args: ['build', './...'],
        fallback: false,
        kind: 'go-build',
        category: 'compile',
        success: true,
        status: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        excerpt: '',
      },
      {
        id: 'go-vet',
        scriptName: 'go-vet',
        label: 'go vet ./...',
        command: 'go',
        args: ['vet', './...'],
        fallback: false,
        kind: 'go-vet',
        category: 'static-analysis',
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
      selectedPath: 'cmd/server/main.go',
      report,
    });

    expect(summary.covered).toBe(true);
  });

  it('marks Java files as covered by maven/gradle compile stages', () => {
    const report = createReport();
    report.overallStatus = 'passed';
    report.projectTypes = ['gradle'];
    report.primaryProjectType = 'gradle';
    report.packageManager = null;
    report.packageJsonPath = null;
    report.stages = [
      {
        id: 'gradle-classes',
        scriptName: 'gradle-classes',
        label: 'gradle classes',
        command: './gradlew',
        args: ['classes'],
        fallback: false,
        kind: 'gradle-classes',
        category: 'compile',
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
      selectedPath: 'src/main/java/app/Main.java',
      report,
    });

    expect(summary.covered).toBe(true);
  });

  it('does not mark files as covered when the stage failed (spawn or exit)', () => {
    const report = createReport();
    report.projectTypes = ['rust'];
    report.primaryProjectType = 'rust';
    report.packageManager = null;
    report.packageJsonPath = null;
    report.stages = [
      {
        id: 'cargo-check',
        scriptName: 'cargo-check',
        label: 'cargo check',
        command: 'cargo',
        args: ['check', '--workspace', '--all-targets'],
        fallback: false,
        kind: 'cargo-check',
        category: 'compile',
        success: false,
        status: null,
        timedOut: false,
        stdout: '',
        stderr: 'spawn cargo ENOENT',
        excerpt: 'spawn cargo ENOENT',
        failureReason: 'spawn',
      },
    ];

    const summary = summarizeProjectFileDiagnostics({
      workspacePath: '/workspace',
      selectedPath: 'src/lib.rs',
      report,
    });

    expect(summary.covered).toBe(false);
  });
});