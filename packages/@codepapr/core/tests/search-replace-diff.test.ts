import { describe, expect, it } from 'vitest';
import { applySearchReplaceDiff, applySearchReplacePatch } from '../src';

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
