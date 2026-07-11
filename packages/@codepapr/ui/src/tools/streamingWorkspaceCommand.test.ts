import { describe, expect, it } from 'vitest';
import { __streamingWorkspaceCommandTestUtils } from './streamingWorkspaceCommand';

describe('streamingWorkspaceCommand helpers', () => {
  it('parses shell tail exit markers and removes them from output', () => {
    const parsed = __streamingWorkspaceCommandTestUtils.parseShellTail(
      ['[out] PASS src/App.test.tsx', '[err] warning line', '[out] __CODEPAPR_EXIT__abc:0'].join('\n'),
      '__CODEPAPR_EXIT__abc'
    );

    expect(parsed.exitCode).toBe(0);
    expect(parsed.cleanedOutput).toContain('[out] PASS src/App.test.tsx');
    expect(parsed.cleanedOutput).toContain('[err] warning line');
    expect(parsed.cleanedOutput).not.toContain('__CODEPAPR_EXIT__abc:0');
  });

  it('splits shell stream prefixes into stdout and stderr blocks', () => {
    const streams = __streamingWorkspaceCommandTestUtils.splitShellOutput(
      ['[out] lint ok', '[err] src/App.tsx:3 error boom', 'plain line'].join('\n')
    );

    expect(streams.stdout).toBe(['lint ok', 'plain line'].join('\n'));
    expect(streams.stderr).toBe('src/App.tsx:3 error boom');
  });
});