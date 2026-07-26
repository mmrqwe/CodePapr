// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { computeTreemap } from './ProjectStatsModal';

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
