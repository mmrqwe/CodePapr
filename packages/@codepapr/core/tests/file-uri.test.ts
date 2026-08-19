import { describe, expect, it } from 'vitest';
import {
  filePathFromFileUri,
  relativePathFromFileUri,
  workspaceFileUri,
} from '../src/tool/workspace/fileUri';

describe('workspaceFileUri', () => {
  it('uses three slashes for Windows drive letters', () => {
    expect(workspaceFileUri('C:/proj', 'src/a.ts')).toBe('file:///C:/proj/src/a.ts');
    expect(workspaceFileUri('C:\\proj', 'src\\a.ts')).toBe('file:///C:/proj/src/a.ts');
  });

  it('keeps POSIX absolute paths as file:///…', () => {
    expect(workspaceFileUri('/tmp/proj', 'src/a.ts')).toBe('file:///tmp/proj/src/a.ts');
  });
});

describe('relativePathFromFileUri', () => {
  it('maps file:///C:/… diagnostics back to a workspace-relative path', () => {
    expect(relativePathFromFileUri('C:/proj', 'file:///C:/proj/src/Consumer.ts')).toBe(
      'src/Consumer.ts',
    );
    expect(relativePathFromFileUri('C:\\proj', 'file:///C:/proj/packages/core/src/index.ts')).toBe(
      'packages/core/src/index.ts',
    );
  });

  it('still accepts the non-standard file://C:/… form', () => {
    expect(relativePathFromFileUri('C:/proj', 'file://C:/proj/src/a.ts')).toBe('src/a.ts');
  });

  it('round-trips POSIX paths', () => {
    const uri = workspaceFileUri('/tmp/proj', 'src/a.ts');
    expect(relativePathFromFileUri('/tmp/proj', uri)).toBe('src/a.ts');
  });
});

describe('filePathFromFileUri', () => {
  it('strips the leading slash from Windows drive URIs', () => {
    expect(filePathFromFileUri('file:///C:/proj/src/a.ts')).toBe('C:/proj/src/a.ts');
  });
});
