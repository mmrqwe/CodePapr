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

  // 替换改变行数时，未触碰行的行尾仍必须逐字节保留（旧逐行重建实现
  // 在此场景映射错位：区间后的行会拿到错误行的行尾）。
  it('preserves EOLs when the replacement changes the line count', () => {
    const content = 'a\r\nb\nc\r\n';
    const result = applySearchReplacePatch(content, {
      search: 'b',
      replace: 'x\ny',
    });
    // 新行继承被替换行（b）的 LF；a/c 未触碰，行尾逐字节不变
    expect(result.content).toBe('a\r\nx\ny\nc\r\n');
  });

  it('preserves EOLs of later lines when an early replacement adds lines', () => {
    const content = 'a\r\nb\nc\nd\r\n';
    const result = applySearchReplacePatch(content, {
      search: 'b',
      replace: 'x\ny',
    });
    // c 是 LF 行：即便前面插入了新行，它的行尾也不能被改写
    expect(result.content).toBe('a\r\nx\ny\nc\nd\r\n');
  });

  it('preserves EOLs when the replacement removes lines', () => {
    const content = 'keep-1\nold-a\r\nold-b\r\nold-c\nkeep-2\r\n';
    const result = applySearchReplacePatch(content, {
      search: 'old-a\r\nold-b\r\nold-c',
      replace: 'new-single',
    });
    // 区域行尾取被替换首行（old-a）的 \r\n；keep-1/keep-2 行尾不变
    expect(result.content).toBe('keep-1\nnew-single\r\nkeep-2\r\n');
  });

  it('keeps untouched bytes when replaceAll changes line counts in a mixed file', () => {
    const content = 'a\nm\nb\nm\r\nc\n';
    const result = applySearchReplacePatch(content, {
      search: 'm',
      replace: 'x\ny',
      replaceAll: true,
    });
    // 区域风格取首个被替换行（m\n）的 LF；第二个 m 行的 CRLF 被区域替换；a/b/c 行尾不变
    expect(result.content).toBe('a\nx\ny\nb\nx\ny\nc\n');
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

  it('深匹配不再按匹配数 × 文件长度重扫（行索引 + 二分），1MB 文件高频词毫秒级完成', () => {
    // 旧实现每处匹配都从文件头线性重扫到该偏移（O(k·n)）：
    // 1MB 文件里 10 万次短匹配 ≈ 5×10^10 字符迭代，直接冻结 UI 线程。
    // 行索引一次构建 + 二分定位后，总开销 O(n + k log n)。
    const line = 'console.log("token");\n';
    const content = line.repeat(40_000); // ≈ 1.2MB，5 万处匹配
    const started = Date.now();
    const locations = locateSearchOccurrences(content, 'token');
    const elapsed = Date.now() - started;

    expect(locations).toHaveLength(40_000);
    // 行号必须精确（二分定位正确性）：'console.log("token");' 中 token 从
    // 第 14 列开始（1 基）。
    expect(locations[0]).toEqual({ line: 1, column: 14 });
    expect(locations[39999]).toEqual({ line: 40000, column: 14 });
    // 旧实现在此规模下需数秒到数十秒；修复后应在百毫秒内完成。
    expect(elapsed).toBeLessThan(1000);
  });
});
