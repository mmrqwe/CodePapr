// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command?: string, _args?: unknown): Promise<unknown> => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('./AgentContribution', () => ({
  AgentContribution: () => null,
}));

vi.mock('./ToolUsageStats', () => ({
  ToolUsageStats: () => null,
}));

import {
  collapseLanguagesForBar,
  computeTreemap,
  OTHER_LANGUAGE_ID,
  ProjectStatsModal,
  resetProjectStatsCache,
} from './ProjectStatsModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const SAMPLE_STATS = {
  totalFiles: 4242,
  totalDirectories: 3,
  textFiles: 10,
  codeFiles: 8,
  skippedFiles: 1,
  totalLines: 100,
  codeLines: 80,
  blankLines: 10,
  commentLines: 10,
  languages: [{ id: 'typescript', files: 2, lines: 50, code: 40, blank: 5, comment: 5 }],
  largestFile: { path: 'src/a.ts', lines: 40 },
  truncated: false,
  directoryBreakdown: [{ name: 'src', files: 2, lines: 50 }],
  fileSizeDistribution: [{ label: 'small', files: 10, lines: 100 }],
  codeRatio: { code: 80, config: 10, doc: 10 },
  avgMetrics: { avgLinesPerFile: 10, medianLinesPerFile: 10, maxLinesPerFile: 40, totalTextFiles: 10 },
};

function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('computeTreemap', () => {
  it('returns empty for empty or zero-value input', () => {
    expect(computeTreemap([], 100, 100)).toEqual([]);
    expect(computeTreemap([{ id: 'a', value: 0 }], 100, 100)).toEqual([]);
  });

  it('gives a single item the whole space', () => {
    const rects = computeTreemap([{ id: 'a', value: 50 }], 100, 100);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ id: 'a', x: 0, y: 0, w: 100, h: 100 });
  });

  it('produces areas proportional to values, all within bounds', () => {
    const items = [
      { id: 'a', value: 600 },
      { id: 'b', value: 300 },
      { id: 'c', value: 100 },
    ];
    const rects = computeTreemap(items, 100, 100);
    expect(rects).toHaveLength(3);

    const totalArea = 100 * 100;
    const byId = new Map(rects.map((r) => [r.id, r]));
    const area = (id: string) => {
      const r = byId.get(id)!;
      return r.w * r.h;
    };
    expect(area('a') / totalArea).toBeCloseTo(0.6, 5);
    expect(area('b') / totalArea).toBeCloseTo(0.3, 5);
    expect(area('c') / totalArea).toBeCloseTo(0.1, 5);

    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-6);
    }
  });
});

describe('collapseLanguagesForBar', () => {
  function lang(id: string, lines: number): {
    id: string;
    label: string;
    files: number;
    lines: number;
    code: number;
    blank: number;
    comment: number;
  } {
    return { id, label: id, files: 1, lines, code: lines, blank: 0, comment: 0 };
  }

  it('returns the list unchanged when it fits the limit', () => {
    const languages = [lang('ts', 10), lang('py', 5)];
    expect(collapseLanguagesForBar(languages, '其他', 12)).toEqual(languages);
  });

  it('folds overflow languages into a single Other bucket', () => {
    const languages = Array.from({ length: 14 }, (_, i) => lang(`l${i}`, 14 - i));
    const collapsed = collapseLanguagesForBar(languages, '其他', 12);
    expect(collapsed).toHaveLength(13);
    expect(collapsed[12]).toMatchObject({
      id: OTHER_LANGUAGE_ID,
      label: '其他',
      lines: 1 + 2,
      files: 2,
    });
    const totalLines = collapsed.reduce((sum, item) => sum + item.lines, 0);
    expect(totalLines).toBe(languages.reduce((sum, item) => sum + item.lines, 0));
  });
});

describe('ProjectStatsModal cache display', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetProjectStatsCache();
    invokeMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    resetProjectStatsCache();
  });

  function renderModal(workspacePath = '/ws'): void {
    act(() => {
      root.render(
        <ProjectStatsModal workspacePath={workspacePath} lang="zh-CN" onClose={() => undefined} />,
      );
    });
  }

  it('shows a loading banner on first scan when there is no cache', async () => {
    const pending = defer<typeof SAMPLE_STATS>();
    invokeMock.mockImplementation(() => pending.promise);
    renderModal();
    await act(async () => undefined);

    expect(container.textContent).toContain('正在统计项目文件与代码行数');
    expect(container.textContent).toContain('gitignore');
    expect(container.textContent).not.toContain('6 层');
    expect(container.textContent).not.toMatch(/4,?242/);

    await act(async () => {
      pending.resolve(SAMPLE_STATS);
    });
    expect(container.textContent).toMatch(/4,?242/);
  });

  it('keeps cached stats visible while a refresh is in flight', async () => {
    invokeMock.mockResolvedValue(SAMPLE_STATS);
    renderModal();
    await act(async () => undefined);
    expect(container.textContent).toMatch(/4,?242/);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    const pending = defer<typeof SAMPLE_STATS>();
    invokeMock.mockImplementation(() => pending.promise);
    renderModal();
    await act(async () => undefined);

    expect(container.textContent).toMatch(/4,?242/);
    expect(container.textContent).toContain('正在统计项目文件与代码行数');

    await act(async () => {
      pending.resolve({ ...SAMPLE_STATS, totalFiles: 7 });
    });
    expect(container.textContent).toContain('7');
    expect(container.textContent).not.toMatch(/4,?242/);
  });

  it('does not keep the previous workspace stats when the next scan has no cache', async () => {
    invokeMock.mockResolvedValue(SAMPLE_STATS);
    renderModal('/ws-a');
    await act(async () => undefined);
    expect(container.textContent).toMatch(/4,?242/);

    const pending = defer<typeof SAMPLE_STATS>();
    invokeMock.mockImplementation(() => pending.promise);
    act(() => {
      root.render(
        <ProjectStatsModal workspacePath="/ws-b" lang="zh-CN" onClose={() => undefined} />,
      );
    });
    await act(async () => undefined);

    expect(container.textContent).not.toMatch(/4,?242/);
    expect(container.textContent).toContain('正在统计项目文件与代码行数');

    await act(async () => {
      pending.resolve({ ...SAMPLE_STATS, totalFiles: 9 });
    });
    expect(container.textContent).toContain('9');
  });

  it('shows a truncated warning in the header and body, not only beside the largest file', async () => {
    invokeMock.mockResolvedValue({ ...SAMPLE_STATS, truncated: true });
    renderModal();
    await act(async () => undefined);

    const warning = '文件数量达到上限，统计结果不完整。';
    expect(container.textContent).toContain(warning);
    expect(container.textContent?.split(warning).length).toBeGreaterThan(2);
  });
});
