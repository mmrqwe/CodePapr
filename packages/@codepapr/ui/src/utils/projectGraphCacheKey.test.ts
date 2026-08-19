import { describe, expect, it } from 'vitest';
import { computeInsightCacheKey, type InsightCacheSettings } from './projectGraphCacheKey';

const settings: InsightCacheSettings = {
  insightMaxDepth: 8,
  insightMaxSourceFiles: 500,
  insightMaxFileBytes: 50_000,
  insightMaxSymbols: 80,
  insightMaxEdges: 10_000,
  insightMaxTreeEntries: 320,
};

function file(path: string, bytes = 10, mtimeMs = 1) {
  return { path, isDir: false, bytes, mtimeMs };
}

describe('computeInsightCacheKey', () => {
  it('invalidates when an existing file is edited without changing the entry list', () => {
    const entries = [file('src/a.ts', 42, 100)];
    const before = computeInsightCacheKey('/ws', entries, settings, 'abc|');
    const afterEdit = computeInsightCacheKey('/ws', [file('src/a.ts', 42, 101)], settings, 'abc|');
    const afterGit = computeInsightCacheKey('/ws', entries, settings, 'abc| M src/a.ts');
    expect(afterEdit).not.toBe(before);
    expect(afterGit).not.toBe(before);
  });

  it('does not ignore files after the 200th path', () => {
    const first200 = Array.from({ length: 200 }, (_, index) => file(`src/f${index}.ts`));
    const withOldTail = [...first200, file('src/old-tail.ts')];
    const withNewTail = [...first200, file('src/new-tail.ts')];
    expect(computeInsightCacheKey('/ws', withOldTail, settings)).not.toBe(
      computeInsightCacheKey('/ws', withNewTail, settings),
    );
  });
});
