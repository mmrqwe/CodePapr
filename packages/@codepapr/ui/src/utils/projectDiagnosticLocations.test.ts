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

  it('parses cargo diagnostics with --> arrows and carries the head severity', () => {
    const locations = parseProjectDiagnosticLocations(
      '/tmp/workspace',
      createStage({
        stderr: [
          'error[E0382]: borrow of moved value: x',
          '   --> src/main.rs:10:5',
          '    |',
          '9   |     let y = x;',
          '    |         ^ value moved here',
          'warning: unused variable: z',
          '   --> src/main.rs:14:9',
        ].join('\n'),
      })
    );

    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({
      path: 'src/main.rs',
      line: 10,
      column: 5,
      severity: 'error',
    });
    expect(locations[1]).toMatchObject({
      path: 'src/main.rs',
      line: 14,
      column: 9,
      severity: 'warning',
    });
  });

  it('parses maven compiler bracket locations', () => {
    const locations = parseProjectDiagnosticLocations(
      '/tmp/workspace',
      createStage({
        stderr: '[ERROR] /tmp/workspace/src/main/java/app/Main.java:[10,20] error: ; expected',
      })
    );

    expect(locations).toEqual([
      expect.objectContaining({
        path: 'src/main/java/app/Main.java',
        line: 10,
        column: 20,
        severity: 'error',
      }),
    ]);
  });
});
