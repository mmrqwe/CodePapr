import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertRecentWorkspace, sortRecentWorkspaces } from './recentWorkspaces';
import type { WorkspaceEntry } from './types';

function entry(path: string, overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    path,
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    lastOpenedAt: 0,
    pinned: false,
    ...overrides,
  };
}

describe('upsertRecentWorkspace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the list unchanged for a blank path', () => {
    const recent = [entry('/a')];
    expect(upsertRecentWorkspace(recent, '   ')).toBe(recent);
  });

  it('prepends a new workspace with a derived name and unpinned state', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    const result = upsertRecentWorkspace([entry('/existing')], '/foo/bar');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ path: '/foo/bar', name: 'bar', lastOpenedAt: 123, pinned: false });
    expect(result[1].path).toBe('/existing');
  });

  it('moves an existing workspace to the front and refreshes its timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(500);
    const recent = [entry('/a', { lastOpenedAt: 1 }), entry('/b', { lastOpenedAt: 2 })];
    const result = upsertRecentWorkspace(recent, '/b');
    expect(result.map((e) => e.path)).toEqual(['/b', '/a']);
    expect(result[0].lastOpenedAt).toBe(500);
    expect(result).toHaveLength(2);
  });

  it('preserves the pinned flag when re-opening a pinned workspace', () => {
    const recent = [entry('/a'), entry('/b', { pinned: true })];
    const result = upsertRecentWorkspace(recent, '/b');
    expect(result[0].pinned).toBe(true);
  });

  it('caps the list at 10 entries', () => {
    const recent = Array.from({ length: 10 }, (_, i) => entry(`/w${i}`));
    const result = upsertRecentWorkspace(recent, '/new');
    expect(result).toHaveLength(10);
    expect(result[0].path).toBe('/new');
    expect(result[9].path).toBe('/w8');
  });

  it('derives the name from the trailing path segment (windows separators)', () => {
    const result = upsertRecentWorkspace([], 'C:\\Users\\me\\proj');
    expect(result[0].name).toBe('proj');
  });
});

describe('sortRecentWorkspaces', () => {
  it('keeps pinned entries first, then orders the rest by recency', () => {
    const recent = [
      entry('/old', { lastOpenedAt: 1 }),
      entry('/pinnedOld', { lastOpenedAt: 1, pinned: true }),
      entry('/newest', { lastOpenedAt: 3 }),
      entry('/mid', { lastOpenedAt: 2 }),
    ];
    const result = sortRecentWorkspaces(recent);
    expect(result.map((e) => e.path)).toEqual(['/pinnedOld', '/newest', '/mid', '/old']);
  });

  it('returns an empty list unchanged', () => {
    expect(sortRecentWorkspaces([])).toEqual([]);
  });
});
