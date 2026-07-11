import { describe, expect, it } from 'vitest';
import { computeLineDiffStats, countLines } from './lineDiffStats';

describe('lineDiffStats', () => {
  it('counts lines consistently', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(3);
  });

  it('computes added and deleted lines from two versions', () => {
    const stats = computeLineDiffStats(
      ['const a = 1;', 'const b = 2;', 'console.log(a + b);'].join('\n'),
      ['const a = 1;', 'const c = 3;', 'console.log(a + c);', 'export {};'].join('\n')
    );

    expect(stats).toEqual({
      added: 3,
      deleted: 2,
      beforeLines: 3,
      afterLines: 4,
    });
  });
});
