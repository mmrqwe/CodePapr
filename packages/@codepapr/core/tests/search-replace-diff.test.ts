import { describe, expect, it } from 'vitest';
import { applySearchReplaceDiff, applySearchReplacePatch, locateSearchOccurrences } from '../src';

describe('applySearchReplacePatch', () => {
  it('applies a single precise search replace block', () => {
    expect(
      applySearchReplacePatch('const value = 1;\n', {
        search: 'const value = 1;',
        replace: 'const value = 2;',
      })
    ).toEqual({ content: 'const value = 2;\n', replacements: 1 });
  });

  it('rejects ambiguous matches unless replaceAll is explicit', () => {
    expect(() =>
      applySearchReplacePatch('a\na\n', {
        search: 'a',
        replace: 'b',
      })
    ).toThrow('匹配到 2 处文本块');
  });

  // 回归：String.replace(search, replace) 会把替换串里的 $& / $' / $` / $$
  // 当特殊模式展开，导致文件被静默损坏。单处替换必须按字面量处理。
  it('treats $ replacement patterns literally in single replace', () => {
    const patterns = ["$&", "$'", '$`', '$$', "$'ansi'"];
    for (const literal of patterns) {
      const result = applySearchReplacePatch('OLD\n', {
        search: 'OLD',
        replace: literal,
      });
      expect(result.content).toBe(`${literal}\n`);
      expect(result.replacements).toBe(1);
    }
  });

  it('treats $ replacement patterns literally with replaceAll', () => {
    const result = applySearchReplacePatch('a\na\n', {
      search: 'a',
      replace: "$'",
      replaceAll: true,
    });
    expect(result.content).toBe("$'\n$'\n");
    expect(result.replacements).toBe(2);
  });
});

describe('applySearchReplaceDiff', () => {
  it('applies ordered patches across multiple files', () => {
    expect(
      applySearchReplaceDiff(
        {
          'src/a.ts': 'const value = 1;\nexport const label = "old";\n',
          'src/b.ts': 'export const enabled = false;\n',
        },
        [
          {
            relativePath: 'src/a.ts',
            search: 'const value = 1;',
            replace: 'const value = 2;',
          },
          {
            relativePath: 'src/a.ts',
            search: 'export const label = "old";',
            replace: 'export const label = "new";',
          },
          {
            relativePath: 'src/b.ts',
            search: 'false',
            replace: 'true',
            expectedOccurrences: 1,
          },
        ]
      )
    ).toEqual({
      files: [
        {
          path: 'src/a.ts',
          content: 'const value = 2;\nexport const label = "new";\n',
          patches: 2,
          replacements: 2,
        },
        {
          path: 'src/b.ts',
          content: 'export const enabled = true;\n',
          patches: 1,
          replacements: 1,
        },
      ],
      totalFiles: 2,
      totalPatches: 3,
      totalReplacements: 3,
    });
  });

  it('rejects the whole diff when any patch cannot be matched', () => {
    expect(() =>
      applySearchReplaceDiff(
        {
          'src/a.ts': 'const value = 1;\n',
        },
        [
          {
            relativePath: 'src/a.ts',
            search: 'const value = 1;',
            replace: 'const value = 2;',
          },
          {
            relativePath: 'src/a.ts',
            search: 'missing();',
            replace: 'present();',
          },
        ]
      )
    ).toThrow('补丁 2 (src/a.ts) 应用失败');
  });
});

describe('locateSearchOccurrences', () => {
  it('returns empty for an empty search', () => {
    expect(locateSearchOccurrences('a\nb\n', '')).toEqual([]);
  });

  it('locates a single occurrence with 1-based line and column', () => {
    expect(locateSearchOccurrences('const value = 1;\n', 'value')).toEqual([
      { line: 1, column: 7 },
    ]);
  });

  it('locates multiple occurrences across lines', () => {
    expect(locateSearchOccurrences('foo\nbar\nfoo\n', 'foo')).toEqual([
      { line: 1, column: 1 },
      { line: 3, column: 1 },
    ]);
  });

  it('reports the first line of a multiline match', () => {
    expect(locateSearchOccurrences('a\nconst x = 1;\nconst y = 2;\n', 'const x = 1;\nconst y = 2;')).toEqual([
      { line: 2, column: 1 },
    ]);
  });

  it('handles CRLF content using normalized line numbers', () => {
    expect(locateSearchOccurrences('foo\r\nbar\r\nfoo\r\n', 'foo')).toEqual([
      { line: 1, column: 1 },
      { line: 3, column: 1 },
    ]);
  });
});
