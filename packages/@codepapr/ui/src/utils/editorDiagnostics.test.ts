import { describe, expect, it } from 'vitest';
import { summarizeEditorDiagnostics } from './editorDiagnostics';

describe('editorDiagnostics', () => {
  it('summarizes marker severities and locations', () => {
    const summary = summarizeEditorDiagnostics([
      {
        severity: 8,
        message: 'Cannot find name foo',
        startLineNumber: 3,
        startColumn: 12,
      },
      {
        severity: 4,
        message: 'Unused variable',
        startLineNumber: 5,
        startColumn: 7,
      },
      {
        severity: 1,
        message: 'Hint message',
        startLineNumber: 8,
        startColumn: 1,
      },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.hints).toBe(1);
    expect(summary.items[0]).toEqual({
      severity: 'error',
      message: 'Cannot find name foo',
      startLineNumber: 3,
      startColumn: 12,
    });
  });
});
