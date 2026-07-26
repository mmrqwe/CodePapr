import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceProjectGraph,
  performProjectGraphRename,
  performWorkspaceRename,
  performWorkspaceFormatFiles,
  requestWorkspaceSymbolDefinition,
} from '../src';
import type {
  WorkspaceHost,
  WorkspaceHostReadTextFileOptions,
  WorkspaceHostReadTextFileResult,
} from '../src/tool/workspace/host';

interface MockHostOptions {
  files: Record<string, string>;
  truncatedPaths?: string[];
  failingWritePaths?: string[];
  languageServiceResult?: unknown;
  languageServiceError?: Error;
}

interface MockHost extends WorkspaceHost {
  written: Record<string, string>;
  lastRequestParams: unknown;
}

function createMockHost(options: MockHostOptions): MockHost {
  const fs: Record<string, string> = { ...options.files };
  const truncated = new Set(options.truncatedPaths ?? []);
  const failingWrites = new Set(options.failingWritePaths ?? []);
  const written: Record<string, string> = {};
  const host: MockHost = {
    workspacePath: '/proj',
    written,
    lastRequestParams: undefined,
    async listFiles() {
      return { entries: [] };
    },
    async readTextFile(opts: WorkspaceHostReadTextFileOptions): Promise<WorkspaceHostReadTextFileResult> {
      const content = fs[opts.relativePath] ?? '';
      return {
        content,
        bytes: content.length,
        truncatedByBytes: truncated.has(opts.relativePath),
      };
    },
    async runCommand() {
      return { command: '', args: [], status: 0, stdout: '', stderr: '', timedOut: false };
    },
    async writeTextFile({ relativePath, content }) {
      if (failingWrites.has(relativePath)) {
        throw new Error(`write failed: ${relativePath}`);
      }
      fs[relativePath] = content;
      written[relativePath] = content;
      return { path: relativePath, bytes: content.length };
    },
    languageService: {
      async request(req) {
        host.lastRequestParams = req.params;
        if (options.languageServiceError) {
          throw options.languageServiceError;
        }
        return options.languageServiceResult as never;
      },
    },
  };
  return host;
}

function makeRenameGraph() {
  return buildWorkspaceProjectGraph({
    root: '.',
    tree: '.\n- src/',
    allFiles: [{ path: 'src/main.ts' }, { path: 'src/lib.ts' }],
    fileContents: {
      'src/main.ts': {
        content: 'import { helper } from "./lib";\nexport function main() { return helper(); }\n',
      },
      'src/lib.ts': {
        content: 'export function helper() { return 1; }\n',
      },
    },
    files: [
      {
        path: 'src/main.ts', language: 'TypeScript', bytes: 80, symbolSource: 'ast',
        symbols: [{ name: 'main', kind: 'function', signature: 'export function main()', line: 2, exported: true }],
      },
      {
        path: 'src/lib.ts', language: 'TypeScript', bytes: 40, symbolSource: 'ast',
        symbols: [{ name: 'helper', kind: 'function', signature: 'export function helper()', line: 1, exported: true }],
      },
    ],
    maxEdges: 200,
  });
}

describe('performProjectGraphRename', () => {
  it('renames the identifier at its real column, not the start of the line', async () => {
    const host = createMockHost({
      files: {
        'src/main.ts': 'import { helper } from "./lib";\nexport function main() { return helper(); }\n',
        'src/lib.ts': 'export function helper() { return 1; }\n',
      },
    });
    const result = await performProjectGraphRename(host, {
      relativePath: 'src/lib.ts',
      line: 1,
      character: 17,
      newName: 'util',
      graph: makeRenameGraph(),
    });

    expect(result.ok).toBe(true);
    expect(host.written['src/lib.ts']).toBe('export function util() { return 1; }\n');
    expect(host.written['src/main.ts']).toBe('import { util } from "./lib";\nexport function main() { return util(); }\n');
  });

  it('preserves CRLF line endings', async () => {
    const host = createMockHost({
      files: {
        'src/lib.ts': 'export function helper() {\r\n  return helper;\r\n}\r\n',
        'src/main.ts': 'import { helper } from "./lib";\r\n',
      },
    });
    const result = await performProjectGraphRename(host, {
      relativePath: 'src/lib.ts',
      line: 1,
      character: 17,
      newName: 'util',
      graph: makeRenameGraph(),
    });

    expect(result.ok).toBe(true);
    expect(host.written['src/lib.ts']).toBe('export function util() {\r\n  return util;\r\n}\r\n');
  });

  it('refuses to rewrite a file that was read truncated (data-loss guard)', async () => {
    const host = createMockHost({
      files: {
        'src/lib.ts': 'export function helper() { return 1; }\n',
        'src/main.ts': 'import { helper } from "./lib";\n',
      },
      truncatedPaths: ['src/lib.ts'],
    });
    const result = await performProjectGraphRename(host, {
      relativePath: 'src/lib.ts',
      line: 1,
      character: 17,
      newName: 'util',
      graph: makeRenameGraph(),
    });

    expect(host.written['src/lib.ts']).toBeUndefined();
    expect(result.message).toContain('截断');
  });
});

describe('performWorkspaceRename (LSP path)', () => {
  it('applies edits returned by the language server', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'const foo = 1;\n' },
      languageServiceResult: {
        changes: {
          'file:///proj/src/a.ts': [
            { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'bar' },
          ],
        },
      },
    });
    const result = await performWorkspaceRename(host, {
      relativePath: 'src/a.ts',
      languageId: 'typescript',
      line: 1,
      column: 7,
      newName: 'bar',
    });
    expect(result.ok).toBe(true);
    expect(host.written['src/a.ts']).toBe('const bar = 1;\n');
  });

  it('preserves the order of multiple inserts at the same position (LSP spec)', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'xy\n' },
      languageServiceResult: {
        changes: {
          'file:///proj/src/a.ts': [
            { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: 'A' },
            { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: 'B' },
          ],
        },
      },
    });
    const result = await performWorkspaceRename(host, {
      relativePath: 'src/a.ts',
      languageId: 'typescript',
      line: 1,
      column: 2,
      newName: 'z',
    });
    expect(result.ok).toBe(true);
    expect(host.written['src/a.ts']).toBe('xABy\n');
  });

  it('does not write back a truncated file and reports it as failed', async () => {
    const host = createMockHost({
      files: { 'src/big.ts': 'foo\n' },
      truncatedPaths: ['src/big.ts'],
      languageServiceResult: {
        changes: {
          'file:///proj/src/big.ts': [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' },
          ],
        },
      },
    });
    const result = await performWorkspaceRename(host, {
      relativePath: 'src/big.ts',
      languageId: 'typescript',
      line: 1,
      column: 1,
      newName: 'bar',
    });
    expect(host.written['src/big.ts']).toBeUndefined();
    expect(result.ok).toBe(false);
  });

  it('applies surviving files even when one write fails (partial atomicity)', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'foo\n', 'src/b.ts': 'foo\n' },
      failingWritePaths: ['src/b.ts'],
      languageServiceResult: {
        changes: {
          'file:///proj/src/a.ts': [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' },
          ],
          'file:///proj/src/b.ts': [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' },
          ],
        },
      },
    });
    const result = await performWorkspaceRename(host, {
      relativePath: 'src/a.ts',
      languageId: 'typescript',
      line: 1,
      column: 1,
      newName: 'bar',
    });
    expect(host.written['src/a.ts']).toBe('bar\n');
    expect(host.written['src/b.ts']).toBeUndefined();
    expect(result.changedFiles).toContain('src/a.ts');
    expect(result.message).toContain('src/b.ts');
  });

  it('round-trips a Windows drive file:// URI back to a relative path', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'foo\n' },
      languageServiceResult: {
        changes: {
          'file:///C:/proj/src/a.ts': [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' },
          ],
        },
      },
    });
    host.workspacePath = 'C:/proj';
    const result = await performWorkspaceRename(host, {
      relativePath: 'src/a.ts',
      languageId: 'typescript',
      line: 1,
      column: 1,
      newName: 'bar',
    });
    expect(result.ok).toBe(true);
    expect(host.written['src/a.ts']).toBe('bar\n');
  });
});

describe('performWorkspaceFormatFiles', () => {
  it('applies formatting edits returned by the language server', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'const x=1\n' },
      languageServiceResult: [
        { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 9 } }, newText: ';' },
      ],
    });
    const result = await performWorkspaceFormatFiles(host, [{ relativePath: 'src/a.ts', languageId: 'typescript' }]);
    expect(result.ok).toBe(true);
    expect(host.written['src/a.ts']).toBe('const x=1;\n');
  });
});

describe('requestWorkspaceSymbolDefinition (graceful failure)', () => {
  it('returns an unavailable result instead of throwing when the language service errors', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'foo\n' },
      languageServiceError: new Error('server crashed'),
    });
    const result = await requestWorkspaceSymbolDefinition(host, {
      relativePath: 'src/a.ts',
      languageId: 'typescript',
      line: 1,
      column: 1,
    });
    expect(result.available).toBe(false);
    expect(result.locations).toEqual([]);
    expect(result.message).toContain('server crashed');
  });
});
