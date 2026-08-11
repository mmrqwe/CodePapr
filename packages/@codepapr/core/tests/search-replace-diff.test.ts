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

  // #24：纯 CRLF 文件整体回写 CRLF（保持旧行为）
  it('rewrites a pure-CRLF file back to CRLF', () => {
    const result = applySearchReplacePatch('a\r\nb\r\n', {
      search: 'b',
      replace: 'c',
    });
    expect(result.content).toBe('a\r\nc\r\n');
    expect(result.replacements).toBe(1);
  });

  // #24 回归：混合换行文件必须逐行保留原行尾——旧实现只要存在一处 CRLF 就
  // 全文规范化成 CRLF，未触碰的 LF 行也被改写，git diff 整文件爆炸。
  it('preserves per-line EOLs in a mixed-EOL file', () => {
    const content = 'one\r\nconst value = 1;\ntwo\r\nthree\n';
    const result = applySearchReplacePatch(content, {
      search: 'const value = 1;',
      replace: 'const value = 2;',
    });
    expect(result.content).toBe('one\r\nconst value = 2;\ntwo\r\nthree\n');
    expect(result.content).toBe('one\r\n' + 'const value = 2;\n' + 'two\r\n' + 'three\n');
  });

  it('preserves EOLs of untouched lines around a multi-line replacement', () => {
    const content = 'keep-lf-1\nkeep-crlf-2\r\nold-a\r\nold-b\nkeep-lf-3\r\nkeep-crlf-4\n';
    const result = applySearchReplacePatch(content, {
      search: 'old-a\r\nold-b',
      replace: 'new-a\nnew-b',
    });
    // 新行继承被替换第一行（old-a）的 \r\n；未触碰行保持原行尾
    expect(result.content).toBe(
      'keep-lf-1\nkeep-crlf-2\r\nnew-a\r\nnew-b\r\nkeep-lf-3\r\nkeep-crlf-4\n'
    );
  });

  it('preserves per-line EOLs with replaceAll on a mixed-EOL file', () => {
    const content = 'x\nx\r\ny\r\nx\n';
    const result = applySearchReplacePatch(content, {
      search: 'x',
      replace: 'z',
      replaceAll: true,
    });
    // 替换区继承第一个被替换行（x\n）的 LF；未触碰的 y 保持 \r\n
    expect(result.content).toBe('z\nz\ny\r\nz\n');
  });

  it('preserves a missing trailing newline in a mixed-EOL file', () => {
    const content = 'a\r\nb\nc';
    const result = applySearchReplacePatch(content, {
      search: 'b',
      replace: 'B',
    });
    expect(result.content).toBe('a\r\nB\nc');
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
