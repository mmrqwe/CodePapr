import { describe, expect, it } from 'vitest';
import {
  assertValidGitBranchName,
  assertValidGitReference,
  buildGitBackupBranchName,
  buildGitBranchCheckoutPlans,
  buildGitCommitCommandArgs,
  buildGitHistoryCommandArgs,
  buildGitLatestStashCommandArgs,
  buildGitResetCommandArgs,
  buildGitRestoreCommandPlans,
  buildGitSafetyStashMessage,
  buildGitStageCommandArgs,
  buildGitStashPushArgs,
  normalizeGitPathspecs,
  parseGitHistoryCommandResult,
  parseGitLatestStashCommandResult,
} from '../src/git';

describe('git helpers', () => {
  it('normalizes pathspecs and validates refs', () => {
    expect(normalizeGitPathspecs([' src/App.tsx ', '', 'README.md'])).toEqual([
      'src/App.tsx',
      'README.md',
    ]);
    expect(assertValidGitBranchName('feature/sandbox')).toBe('feature/sandbox');
    expect(assertValidGitReference('HEAD~1', 'target')).toBe('HEAD~1');
    expect(() => assertValidGitBranchName('bad name')).toThrow('非法分支名');
    expect(() => assertValidGitReference('-HEAD', 'target')).toThrow('非法 target');
  });

  it('builds history, branch, stage, commit, stash, restore, and reset commands', () => {
    expect(buildGitHistoryCommandArgs(99)).toEqual([
      'log',
      '-n50',
      '--date=iso-strict',
      '--decorate=short',
      '--pretty=format:%H%x1f%h%x1f%cI%x1f%an%x1f%D%x1f%s%x1e',
    ]);
    expect(
      buildGitBranchCheckoutPlans({
        branchName: 'feature/sandbox',
        createIfMissing: true,
        startPoint: 'HEAD~1',
      })
    ).toEqual([
      ['switch', 'feature/sandbox'],
      ['checkout', 'feature/sandbox'],
      ['switch', '-c', 'feature/sandbox', 'HEAD~1'],
      ['checkout', '-b', 'feature/sandbox', 'HEAD~1'],
    ]);
    expect(buildGitStageCommandArgs({ pathspecs: ['src/App.tsx'] })).toEqual([
      'add',
      '-A',
      '--',
      'src/App.tsx',
    ]);
    expect(buildGitCommitCommandArgs('  checkpoint  ')).toEqual(['commit', '-m', 'checkpoint']);
    expect(
      buildGitStashPushArgs('backup', { includeUntracked: true, pathspecs: ['src/App.tsx'] })
    ).toEqual(['stash', 'push', '--include-untracked', '-m', 'backup', '--', 'src/App.tsx']);
    expect(buildGitLatestStashCommandArgs()).toEqual(['stash', 'list', '-1', '--format=%gd%x1f%s']);
    expect(buildGitRestoreCommandPlans({ source: 'HEAD', pathspecs: ['src/App.tsx'] })).toEqual([
      ['restore', '--source', 'HEAD', '--staged', '--worktree', '--', 'src/App.tsx'],
      ['reset', 'HEAD', '--', 'src/App.tsx'],
      ['checkout', 'HEAD', '--', 'src/App.tsx'],
    ]);
    expect(buildGitResetCommandArgs('abc1234')).toEqual(['reset', '--hard', 'abc1234']);
  });

  it('parses history and latest stash output', () => {
    const history = parseGitHistoryCommandResult({
      status: 0,
      stdout:
        'abc123456789\x1fabc1234\x1f2026-06-01T12:34:56+08:00\x1ftest-user\x1fHEAD -> main, origin/main\x1ffeat: add git panel\x1e',
      stderr: '',
    });

    expect(history.available).toBe(true);
    expect(history.isRepo).toBe(true);
    expect(history.entries).toEqual([
      {
        hash: 'abc123456789',
        shortHash: 'abc1234',
        committedAt: '2026-06-01T12:34:56+08:00',
        authorName: 'test-user',
        refNames: ['HEAD -> main', 'origin/main'],
        subject: 'feat: add git panel',
        isHead: true,
      },
    ]);

    expect(
      parseGitLatestStashCommandResult({
        status: 0,
        stdout: 'stash@{0}\x1fCodePapr safety snapshot | restore | 20260601-123456-000\n',
        stderr: '',
      })
    ).toEqual({
      ref: 'stash@{0}',
      message: 'CodePapr safety snapshot | restore | 20260601-123456-000',
    });
  });

  it('builds deterministic backup names and stash messages', () => {
    const now = new Date('2026-06-01T12:34:56.789Z');
    expect(buildGitBackupBranchName('codepapr/backup', now)).toBe('codepapr/backup/20260601-123456-789');
    expect(buildGitSafetyStashMessage('restore', 'src/App.tsx', now)).toBe(
      'CodePapr safety snapshot | restore | src/App.tsx | 20260601-123456-789'
    );
  });
});