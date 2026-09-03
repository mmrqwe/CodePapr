import { describe, expect, it } from 'vitest';
import {
  belongsToProject,
  clearedAtForProject,
  eventBelongsToProject,
  filterEvents,
  filterRecords,
  mergeProjectSlice,
  normalizeWorkspaceId,
  stampRecord,
  writeClearedAt,
} from './projectRecordScope';

describe('projectRecordScope', () => {
  it('normalizes trailing slashes on workspace ids', () => {
    expect(normalizeWorkspaceId('/tmp/proj/')).toBe('/tmp/proj');
    expect(normalizeWorkspaceId('\\tmp\\proj\\')).toBe('\\tmp\\proj');
  });

  it('hides untagged records so mixed legacy data cannot leak across projects', () => {
    expect(belongsToProject({ title: 'old' }, '/tmp/a')).toBe(false);
    expect(belongsToProject({ title: 'a', workspaceId: '/tmp/a' }, '/tmp/a')).toBe(true);
    expect(belongsToProject({ title: 'b', workspaceId: '/tmp/b' }, '/tmp/a')).toBe(false);
  });

  it('filters inbox envelopes by workspaceId on the event, not the payload', () => {
    const events = [
      { seq: 1, workspaceId: '/tmp/a', payload: { title: 'A' } },
      { seq: 2, workspaceId: '/tmp/b', payload: { title: 'B' } },
      { seq: 3, payload: { title: 'legacy' } },
    ];
    expect(filterEvents(events, '/tmp/a').map((e) => e.seq)).toEqual([1]);
    expect(eventBelongsToProject(events[2], '/tmp/a')).toBe(false);
  });

  it('merges one project slice back into the shared history array', () => {
    const all = [
      { title: 'A1', workspaceId: '/tmp/a' },
      { title: 'B1', workspaceId: '/tmp/b' },
    ];
    const next = mergeProjectSlice(all, [{ title: 'A2' }], '/tmp/a', 'a');
    expect(next.map((r) => r.title).sort()).toEqual(['A2', 'B1']);
    expect(next.find((r) => r.title === 'A2')?.workspaceId).toBe('/tmp/a');
    expect(next.find((r) => r.title === 'B1')?.workspaceId).toBe('/tmp/b');
  });

  it('stores clearedAt per project so clearing A does not hide B', () => {
    const afterA = writeClearedAt({}, '/tmp/a', 100);
    const afterB = writeClearedAt(afterA, '/tmp/b', 200);
    expect(clearedAtForProject(afterB, '/tmp/a')).toBe(100);
    expect(clearedAtForProject(afterB, '/tmp/b')).toBe(200);
    expect(clearedAtForProject(999, '/tmp/a')).toBe(0);
  });

  it('stamps workspaceName for display without using it as the identity', () => {
    const stamped = stampRecord({ title: 'x' }, '/Users/me/Learn', 'Learn');
    expect(stamped.workspaceId).toBe('/Users/me/Learn');
    expect(stamped.workspaceName).toBe('Learn');
    expect(belongsToProject(stamped, '/Users/me/Other')).toBe(false);
  });

  it('filters a mixed history list to the open project', () => {
    const history = [
      { title: 'A', workspaceId: '/p/a' },
      { title: 'B', workspaceId: '/p/b' },
      { title: 'A2', workspaceId: '/p/a' },
    ];
    expect(filterRecords(history, '/p/a').map((h) => h.title)).toEqual(['A', 'A2']);
  });

  it('clears one project slice without deleting other projects rows', () => {
    const all = [
      { title: 'A', workspaceId: '/p/a' },
      { title: 'B', workspaceId: '/p/b' },
    ];
    const next = mergeProjectSlice(all, [], '/p/a');
    expect(next.map((r) => r.title)).toEqual(['B']);
    expect(next[0]?.workspaceId).toBe('/p/b');
  });

  it('treats an empty current workspaceId as matching nothing', () => {
    expect(filterRecords([{ title: 'A', workspaceId: '/p/a' }], '')).toEqual([]);
    expect(filterEvents([{ seq: 1, workspaceId: '/p/a', payload: {} }], '')).toEqual([]);
  });
});
