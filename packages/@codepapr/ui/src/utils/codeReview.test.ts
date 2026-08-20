import { describe, expect, it } from 'vitest';
import {
  fileEntriesFromSnapshotDiffs,
  isWorktreeRef,
  mapSnapshotDiffStatus,
  WORKTREE_REF,
} from './codeReview';

describe('codeReview', () => {
  it('recognizes the working-tree sentinel used by Git panel compare buttons', () => {
    expect(isWorktreeRef(WORKTREE_REF)).toBe(true);
    expect(isWorktreeRef('HEAD')).toBe(false);
  });

  it('maps snapshot status codes onto review file kinds', () => {
    expect(mapSnapshotDiffStatus('A')).toBe('added');
    expect(mapSnapshotDiffStatus('C')).toBe('added');
    expect(mapSnapshotDiffStatus('U')).toBe('added');
    expect(mapSnapshotDiffStatus('D')).toBe('deleted');
    expect(mapSnapshotDiffStatus('R')).toBe('renamed');
    expect(mapSnapshotDiffStatus('M')).toBe('modified');
  });

  it('drops empty paths and keeps the destination path for each delta', () => {
    expect(
      fileEntriesFromSnapshotDiffs([
        { path: 'src/a.ts', status: 'M' },
        { path: '  ', status: 'A' },
        { path: 'src/b.ts', status: 'A' },
        { path: 'src/c.ts', status: 'D' },
        { path: 'src/new.ts', status: 'R' },
      ])
    ).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/c.ts', status: 'deleted' },
      { path: 'src/new.ts', status: 'renamed' },
    ]);
  });
});
