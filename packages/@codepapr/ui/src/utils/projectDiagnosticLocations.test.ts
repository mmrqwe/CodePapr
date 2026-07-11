import { describe, expect, it } from 'vitest';
import type { ProjectDiagnosticStageResult } from './projectDiagnostics';
import { parseProjectDiagnosticLocations } from './projectDiagnosticLocations';

function createStage(
  overrides: Partial<ProjectDiagnosticStageResult> = {}
): ProjectDiagnosticStageResult {
  return {
    id: 'lint',
    scriptName: 'lint',
    label: 'lint',
    command: 'npm',
    args: ['run', 'lint'],
    fallback: false,
    success: false,
    status: 1,
    timedOut: false,
    stdout: '',
    stderr: '',
    excerpt: '',
    ...overrides,
  };
}

describe('projectDiagnosticLocations', () => {
  it('parses colon-based diagnostics and normalizes absolute workspace paths', () => {
    const locations = parseProjectDiagnosticLocations(
      '/tmp/workspace',
      createStage({
        stderr: '/tmp/workspace/src/app.ts:12:34 - error TS2322: bad assign',
      })
    );

    expect(locations).toEqual([
      expect.objectContaining({
        path: 'src/app.ts',
        line: 12,
        column: 34,
        severity: 'error',
      }),
    ]);
  });

  it('parses parenthesized diagnostics', () => {
    const locations = parseProjectDiagnosticLocations(
      '/tmp/workspace',
      createStage({
        stderr: 'src/main.ts(5,7): error TS1005: ; expected',
      })
    );

    expect(locations[0]).toMatchObject({
      path: 'src/main.ts',
      line: 5,
      column: 7,
      severity: 'error',
    });
  });

  it('parses eslint stylish output', () => {
    const locations = parseProjectDiagnosticLocations(
      '/tmp/workspace',
      createStage({
        stdout: ['src/view.tsx', '  8:15  warning  unused value  @typescript-eslint/no-unused-vars'].join('\n'),
      })
    );

    expect(locations[0]).toMatchObject({
      path: 'src/view.tsx',
      line: 8,
      column: 15,
      severity: 'warning',
    });
    expect(locations[0]?.message).toContain('unused value');
  });
});
