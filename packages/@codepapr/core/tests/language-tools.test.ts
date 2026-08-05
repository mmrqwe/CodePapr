import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceProjectGraph,
  performProjectGraphRename,
  performWorkspaceRename,
  performWorkspaceFormatFiles,
  requestWorkspaceSymbolDefinition,
  requestWorkspaceHover,
  requestWorkspaceDocumentSymbol,
  requestWorkspaceSymbol,
  requestWorkspaceImplementation,
  requestWorkspacePrepareCallHierarchy,
  requestWorkspaceIncomingCalls,
  requestWorkspaceOutgoingCalls,
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

  // P2-24：图兜底按「声明行 ≤ 目标行」解析、忽略列号，在函数体内的用法位置
  // 会解析到外层函数。必须用该位置的真实标识符核对，否则会把错误的标识符
  // 跨文件全文替换。
  function makeSameFileGraph() {
    return buildWorkspaceProjectGraph({
      root: '.',
      tree: '.\n- src/',
      allFiles: [{ path: 'src/mod.ts' }],
      fileContents: {
        'src/mod.ts': {
          content: 'function alpha() { return beta(); }\nfunction beta() { return 1; }\n',
        },
      },
      files: [
        {
          path: 'src/mod.ts', language: 'TypeScript', bytes: 70, symbolSource: 'ast',
          symbols: [
            { name: 'alpha', kind: 'function', signature: 'function alpha()', line: 1, exported: false },
            { name: 'beta', kind: 'function', signature: 'function beta()', line: 2, exported: false },
          ],
        },
      ],
      maxEdges: 200,
    });
  }

  it('re-resolves to the identifier actually at the position (not the enclosing symbol)', async () => {
    const host = createMockHost({
      files: {
        'src/mod.ts': 'function alpha() { return beta(); }\nfunction beta() { return 1; }\n',
      },
    });
    // 位置指向 alpha 体内的 beta() 用法（第 1 行第 27 列）。按行解析会得到
    // 外层 alpha，但真实标识符是 beta → 应重命名 beta 而非 alpha。
    const result = await performProjectGraphRename(host, {
      relativePath: 'src/mod.ts',
      line: 1,
      character: 27,
      newName: 'gamma',
      graph: makeSameFileGraph(),
    });

    expect(result.ok).toBe(true);
    expect(host.written['src/mod.ts']).toBe(
      'function alpha() { return gamma(); }\nfunction gamma() { return 1; }\n'
    );
  });

  it('refuses to rename when the position identifier matches no symbol in the file', async () => {
    const host = createMockHost({
      files: {
        'src/main.ts': 'import { helper } from "./lib";\nexport function main() { return helper(); }\n',
        'src/lib.ts': 'export function helper() { return 1; }\n',
      },
    });
    // 位置指向 main 体内的 helper() 用法（第 2 行第 33 列）。按行解析得到 main，
    // 真实标识符是 helper，而 helper 未声明在 src/main.ts → 拒绝，绝不误改 main。
    const result = await performProjectGraphRename(host, {
      relativePath: 'src/main.ts',
      line: 2,
      character: 33,
      newName: 'util',
      graph: makeRenameGraph(),
    });

    expect(result.ok).toBe(false);
    expect(host.written['src/main.ts']).toBeUndefined();
    expect(host.written['src/lib.ts']).toBeUndefined();
    expect(result.message).toContain('拒绝重命名');
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

describe('requestWorkspaceHover', () => {
  it('extracts MarkupContent value', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'const foo = 1;\n' },
      languageServiceResult: { contents: { kind: 'markdown', value: '```ts\nconst foo: number\n```' } },
    });
    const result = await requestWorkspaceHover(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, column: 7,
    });
    expect(result.available).toBe(true);
    expect(result.contents).toContain('const foo: number');
  });

  it('reports unavailable when the language service errors', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'foo\n' },
      languageServiceError: new Error('no server'),
    });
    const result = await requestWorkspaceHover(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, column: 1,
    });
    expect(result.available).toBe(false);
    expect(result.message).toContain('no server');
  });
});

describe('requestWorkspaceDocumentSymbol', () => {
  it('flattens a hierarchical DocumentSymbol tree into a list with container names', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'class MyClass { myMethod() {} }\n' },
      languageServiceResult: [
        {
          name: 'MyClass', kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
          children: [
            {
              name: 'myMethod', kind: 6,
              range: { start: { line: 1, character: 2 }, end: { line: 1, character: 12 } },
              selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } },
            },
          ],
        },
      ],
    });
    const result = await requestWorkspaceDocumentSymbol(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1,
    });
    expect(result.available).toBe(true);
    expect(result.symbols).toHaveLength(2);
    expect(result.symbols[0]).toMatchObject({ name: 'MyClass', kind: 'Class', relativePath: 'src/a.ts', line: 1, column: 7 });
    expect(result.symbols[1]).toMatchObject({ name: 'myMethod', kind: 'Method', containerName: 'MyClass', line: 2 });
  });
});

describe('requestWorkspaceSymbol', () => {
  it('parses SymbolInformation results and forwards the query', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'function foo() {}\n' },
      languageServiceResult: [
        {
          name: 'foo', kind: 12,
          location: { uri: 'file:///proj/src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        },
      ],
    });
    const result = await requestWorkspaceSymbol(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, query: 'foo',
    });
    expect(result.available).toBe(true);
    expect(result.symbols).toEqual([
      { name: 'foo', kind: 'Function', relativePath: 'src/a.ts', line: 1, column: 1 },
    ]);
    expect(host.lastRequestParams).toMatchObject({ query: 'foo' });
  });
});

describe('requestWorkspaceImplementation', () => {
  it('normalizes locations returned by the language server', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'interface I {}\n' },
      languageServiceResult: [
        { uri: 'file:///proj/src/impl.ts', range: { start: { line: 5, character: 2 }, end: { line: 5, character: 10 } } },
      ],
    });
    const result = await requestWorkspaceImplementation(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, column: 11,
    });
    expect(result.available).toBe(true);
    expect(result.locations[0]).toMatchObject({ relativePath: 'src/impl.ts', line: 6, column: 3 });
  });
});

describe('requestWorkspacePrepareCallHierarchy', () => {
  it('normalizes call hierarchy items', async () => {
    const host = createMockHost({
      files: { 'src/a.ts': 'function foo() {}\n' },
      languageServiceResult: [
        {
          name: 'foo', kind: 12, uri: 'file:///proj/src/a.ts',
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        },
      ],
    });
    const result = await requestWorkspacePrepareCallHierarchy(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, column: 10,
    });
    expect(result.available).toBe(true);
    expect(result.items[0]).toMatchObject({ name: 'foo', kind: 'Function', relativePath: 'src/a.ts', line: 1, column: 1 });
  });
});

describe('call hierarchy calls (two-step prepare + calls)', () => {
  const prepareItem = {
    name: 'foo', kind: 12, uri: 'file:///proj/src/a.ts',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  };

  it('incomingCalls prepares then reads `from` items', async () => {
    const host = createMockHost({ files: { 'src/a.ts': 'foo\n' } });
    host.languageService = {
      async request(req) {
        if (req.method === 'textDocument/prepareCallHierarchy') return [prepareItem] as never;
        if (req.method === 'callHierarchy/incomingCalls') {
          return [
            {
              from: { name: 'caller', uri: 'file:///proj/src/b.ts', selectionRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 6 } } },
              fromRanges: [],
            },
          ] as never;
        }
        return null as never;
      },
    };
    const result = await requestWorkspaceIncomingCalls(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, column: 1,
    });
    expect(result.available).toBe(true);
    expect(result.calls).toEqual([{ name: 'caller', relativePath: 'src/b.ts', line: 4, column: 1 }]);
  });

  it('outgoingCalls prepares then reads `to` items', async () => {
    const host = createMockHost({ files: { 'src/a.ts': 'foo\n' } });
    host.languageService = {
      async request(req) {
        if (req.method === 'textDocument/prepareCallHierarchy') return [prepareItem] as never;
        if (req.method === 'callHierarchy/outgoingCalls') {
          return [
            {
              to: { name: 'callee', uri: 'file:///proj/src/c.ts', selectionRange: { start: { line: 7, character: 4 }, end: { line: 7, character: 9 } } },
              fromRanges: [],
            },
          ] as never;
        }
        return null as never;
      },
    };
    const result = await requestWorkspaceOutgoingCalls(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, column: 1,
    });
    expect(result.available).toBe(true);
    expect(result.calls).toEqual([{ name: 'callee', relativePath: 'src/c.ts', line: 8, column: 5 }]);
  });

  it('returns an empty available result when prepare yields no item', async () => {
    const host = createMockHost({ files: { 'src/a.ts': 'foo\n' }, languageServiceResult: [] });
    const result = await requestWorkspaceIncomingCalls(host, {
      relativePath: 'src/a.ts', languageId: 'typescript', line: 1, column: 1,
    });
    expect(result.available).toBe(true);
    expect(result.calls).toEqual([]);
    expect(result.message).toContain('调用层级项');
  });
});
