import { describe, expect, it } from 'vitest';
import {
  buildCheckpointCommitMessage,
  buildGitAddPathsCommandArgs,
  buildGitDiffContentPlan,
  buildGitDiffClipboardText,
  buildGitDiffCommandArgs,
  buildGitCommitCommandArgs,
  buildGitFileSelection,
  buildGitResetIndexCommandPlans,
  buildStageAllGitCommandArgs,
  buildStageGitFileCommandArgs,
  buildSyntheticUntrackedGitDiff,
  buildUnstageAllGitCommandPlans,
  buildUnstageGitFileCommandPlans,
  canOpenGitFileWorkspaceVersion,
  describeGitChange,
  describeGitFileStatus,
  filterVisibleGitFiles,
  formatCheckpointSubject,
  gitStatusCodeForChange,
  gitStatusCodeForMode,
  isVisibleGitPanelFile,
  listAllChangedGitFiles,
  listGitFilesForMode,
  nextCheckpointSequence,
  parseCheckpointTrailers,
  summarizeGitDiff,
} from './workspaceGitPanel';

describe('listGitFilesForMode', () => {
  const files = [
    { path: 'src/both.ts', indexStatus: 'M', worktreeStatus: 'M' },
    { path: 'src/staged.ts', indexStatus: 'A', worktreeStatus: '' },
    { path: 'src/unstaged.ts', indexStatus: '', worktreeStatus: 'M' },
    { path: 'src/untracked.ts', indexStatus: '?', worktreeStatus: '?' },
  ];

  it('splits staged and unstaged files from porcelain status columns', () => {
    expect(listGitFilesForMode(files, 'staged').map((file) => file.path)).toEqual([
      'src/both.ts',
      'src/staged.ts',
    ]);

    expect(listGitFilesForMode(files, 'unstaged').map((file) => file.path)).toEqual([
      'src/both.ts',
      'src/unstaged.ts',
      'src/untracked.ts',
    ]);
  });

  it('returns the mode-specific status code for display', () => {
    expect(gitStatusCodeForMode(files[0]!, 'staged')).toBe('M');
    expect(gitStatusCodeForMode(files[0]!, 'unstaged')).toBe('M');
    expect(gitStatusCodeForMode(files[3]!, 'unstaged')).toBe('??');
  });

  it('describes semantic file status for badges', () => {
    expect(describeGitFileStatus(files[1]!, 'staged')).toEqual({ code: 'A', kind: 'added' });
    expect(describeGitFileStatus(files[3]!, 'unstaged')).toEqual({ code: '??', kind: 'untracked' });
  });

  it('hides internal state files, repo noise files, and directory-like entries from the panel', () => {
    expect(
      filterVisibleGitFiles([
        { path: '.CodePapr/project.sqlite', indexStatus: '', worktreeStatus: 'M' },
        { path: '.CodePapr/project.sqlite-wal', indexStatus: '', worktreeStatus: 'M' },
        { path: '.CodePapr/state.json', indexStatus: '?', worktreeStatus: '?' },
        { path: '.DS_Store', indexStatus: '?', worktreeStatus: '?' },
        { path: '.gitignore', indexStatus: 'M', worktreeStatus: '' },
        { path: 'nested/.gitattributes', indexStatus: '', worktreeStatus: 'M' },
        { path: 'nested/', indexStatus: '?', worktreeStatus: '?' },
        { path: 'src/app.ts', indexStatus: 'M', worktreeStatus: '' },
      ]).map((file) => file.path)
    ).toEqual(['src/app.ts']);

    expect(
      isVisibleGitPanelFile({
        path: '.CodePapr/project.json',
        indexStatus: '?',
        worktreeStatus: '?',
      })
    ).toBe(false);

    expect(
      isVisibleGitPanelFile({
        path: '.gitmodules',
        indexStatus: 'M',
        worktreeStatus: '',
      })
    ).toBe(false);
  });
});

describe('buildGitDiffCommandArgs', () => {
  it('builds cached git diff commands for staged mode', () => {
    expect(
      buildGitDiffCommandArgs({
        mode: 'staged',
        pathspecs: ['src/App.tsx'],
        unified: 8,
      })
    ).toEqual({
      staged: true,
      statArgs: ['diff', '--no-ext-diff', '--cached', '--stat', '--', 'src/App.tsx'],
      diffArgs: ['diff', '--no-ext-diff', '--cached', '--unified=8', '--', 'src/App.tsx'],
    });
  });

  it('adds rename detection flags when requested', () => {
    expect(
      buildGitDiffCommandArgs({
        mode: 'staged',
        pathspecs: ['src/old.ts', 'src/new.ts'],
        findRenames: true,
      })
    ).toEqual({
      staged: true,
      statArgs: ['diff', '--no-ext-diff', '--cached', '--find-renames', '--stat', '--', 'src/old.ts', 'src/new.ts'],
      diffArgs: ['diff', '--no-ext-diff', '--cached', '--find-renames', '--unified=0', '--', 'src/old.ts', 'src/new.ts'],
    });
  });

  it('builds unstaged diff commands referenced against HEAD by default', () => {
    expect(buildGitDiffCommandArgs({ mode: 'unstaged' })).toEqual({
      staged: false,
      statArgs: ['diff', '--no-ext-diff', 'HEAD', '--stat'],
      diffArgs: ['diff', '--no-ext-diff', 'HEAD', '--unified=0'],
    });
  });
});

describe('local git action command builders', () => {
  it('builds stage commands for single files and whole worktree', () => {
    expect(
      buildStageGitFileCommandArgs({
        path: 'src/example.ts',
        originalPath: 'src/example-old.ts',
      })
    ).toEqual(['add', '-A', '--', 'src/example-old.ts', 'src/example.ts']);

    expect(buildStageAllGitCommandArgs()).toEqual(['add', '-A', '--', '.']);
  });

  it('builds resilient unstage fallback plans', () => {
    expect(
      buildUnstageGitFileCommandPlans({
        path: 'src/new.ts',
        indexStatus: 'A',
      })
    ).toEqual([
      ['restore', '--staged', '--', 'src/new.ts'],
      ['reset', 'HEAD', '--', 'src/new.ts'],
      ['rm', '--cached', '--ignore-unmatch', '--', 'src/new.ts'],
    ]);

    expect(buildUnstageAllGitCommandPlans()).toEqual([
      ['restore', '--staged', '.'],
      ['reset', 'HEAD', '--', '.'],
      ['rm', '-r', '--cached', '--ignore-unmatch', '.'],
    ]);
  });

  it('trims commit messages and blocks deleted files from workspace open actions', () => {
    expect(buildGitCommitCommandArgs('  fix git panel  ')).toEqual(['commit', '-m', 'fix git panel']);
    expect(
      canOpenGitFileWorkspaceVersion(
        { path: 'src/deleted.ts', indexStatus: '', worktreeStatus: 'D' },
        'unstaged'
      )
    ).toBe(false);
    expect(
      canOpenGitFileWorkspaceVersion(
        { path: 'src/new.ts', indexStatus: '?', worktreeStatus: '?' },
        'unstaged'
      )
    ).toBe(true);
  });
});

describe('one-click commit command builders (方案 A: 去暂存概念)', () => {
  it('buildGitResetIndexCommandPlans returns reset/rm fallback plans for clearing the index', () => {
    expect(buildGitResetIndexCommandPlans()).toEqual([
      ['reset', 'HEAD', '--', '.'],
      ['rm', '-r', '--cached', '--ignore-unmatch', '.'],
    ]);
  });

  it('buildGitAddPathsCommandArgs assembles a single git add for the selected files', () => {
    expect(
      buildGitAddPathsCommandArgs([
        { path: 'src/a.ts' },
        { path: 'src/b.ts', originalPath: 'src/b-old.ts' },
      ])
    ).toEqual(['add', '-A', '--', 'src/a.ts', 'src/b-old.ts', 'src/b.ts']);
  });

  it('buildGitAddPathsCommandArgs returns null when no files are selected', () => {
    expect(buildGitAddPathsCommandArgs([])).toBeNull();
  });
});

describe('listAllChangedGitFiles & describeGitChange (方案 A: 单一改动列表)', () => {
  const files = [
    { path: 'src/both.ts', indexStatus: 'M', worktreeStatus: 'M' },
    { path: 'src/staged.ts', indexStatus: 'A', worktreeStatus: '' },
    { path: 'src/unstaged.ts', indexStatus: '', worktreeStatus: 'M' },
    { path: 'src/untracked.ts', indexStatus: '?', worktreeStatus: '?' },
    { path: 'src/clean.ts', indexStatus: '', worktreeStatus: '' },
  ];

  it('returns every file with any change, regardless of staged state', () => {
    expect(listAllChangedGitFiles(files).map((file) => file.path)).toEqual([
      'src/both.ts',
      'src/staged.ts',
      'src/unstaged.ts',
      'src/untracked.ts',
    ]);
  });

  it('gitStatusCodeForChange prefers worktree code, falls back to index, and detects untracked', () => {
    expect(gitStatusCodeForChange(files[0]!)).toBe('M');
    expect(gitStatusCodeForChange(files[1]!)).toBe('A');
    expect(gitStatusCodeForChange(files[3]!)).toBe('??');
  });

  it('describeGitChange categorizes files without needing a mode', () => {
    expect(describeGitChange(files[1]!)).toEqual({ code: 'A', kind: 'added' });
    expect(describeGitChange(files[3]!)).toEqual({ code: '??', kind: 'untracked' });
    expect(describeGitChange({ path: 'src/r.ts', originalPath: 'src/old.ts', indexStatus: 'R', worktreeStatus: '' })).toEqual({
      code: 'R',
      kind: 'renamed',
    });
  });
});

describe('buildGitDiffContentPlan', () => {
  it('maps staged additions to empty-vs-index diff sources', () => {
    expect(
      buildGitDiffContentPlan(
        buildGitFileSelection(
          { path: 'src/new.ts', indexStatus: 'A', worktreeStatus: '' },
          'staged'
        )
      )
    ).toEqual({
      original: { kind: 'empty', path: 'src/new.ts' },
      modified: { kind: 'git', path: 'src/new.ts', revision: 'INDEX' },
    });
  });

  it('maps staged renames to head-vs-index paths', () => {
    expect(
      buildGitDiffContentPlan(
        buildGitFileSelection(
          {
            path: 'src/new-name.ts',
            originalPath: 'src/old-name.ts',
            indexStatus: 'R',
            worktreeStatus: '',
          },
          'staged'
        )
      )
    ).toEqual({
      original: { kind: 'git', path: 'src/old-name.ts', revision: 'HEAD' },
      modified: { kind: 'git', path: 'src/new-name.ts', revision: 'INDEX' },
    });
  });

  it('maps unstaged deletions to HEAD-vs-empty diff sources', () => {
    expect(
      buildGitDiffContentPlan(
        buildGitFileSelection(
          { path: 'src/removed.ts', indexStatus: '', worktreeStatus: 'D' },
          'unstaged'
        )
      )
    ).toEqual({
      original: { kind: 'git', path: 'src/removed.ts', revision: 'HEAD' },
      modified: { kind: 'empty', path: 'src/removed.ts' },
    });
  });

  it('maps unstaged untracked files to empty-vs-workspace diff sources', () => {
    expect(
      buildGitDiffContentPlan(
        buildGitFileSelection(
          { path: 'src/untracked.ts', indexStatus: '?', worktreeStatus: '?' },
          'unstaged'
        )
      )
    ).toEqual({
      original: { kind: 'empty', path: 'src/untracked.ts' },
      modified: { kind: 'workspace', path: 'src/untracked.ts' },
    });
  });
});

describe('buildSyntheticUntrackedGitDiff', () => {
  it('creates a readable synthetic diff for untracked files', () => {
    const summary = buildSyntheticUntrackedGitDiff('src/new.ts', 'const answer = 42;\nconsole.log(answer);', 1);

    expect(summary.stat).toContain('src/new.ts');
    expect(summary.diff).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(summary.diff).toContain('+++ b/src/new.ts');
    expect(summary.diff).toContain('+const answer = 42;');
    expect(summary.truncated).toBe(true);
  });
});

describe('buildGitDiffClipboardText', () => {
  it('combines stat and diff into a single clipboard payload', () => {
    expect(
      buildGitDiffClipboardText({
        available: true,
        isRepo: true,
        staged: false,
        pathspecs: ['src/example.ts'],
        stat: 'src/example.ts | 2 +-',
        diff: 'diff --git a/src/example.ts b/src/example.ts',
        truncated: false,
      })
    ).toBe('src/example.ts | 2 +-\n\ndiff --git a/src/example.ts b/src/example.ts');
  });

  it('falls back to the summary message when no patch text exists', () => {
    expect(
      buildGitDiffClipboardText({
        available: true,
        isRepo: true,
        staged: false,
        pathspecs: ['src/example.ts'],
        stat: '',
        diff: '',
        truncated: false,
        message: 'No patch is available.',
      })
    ).toBe('No patch is available.');
  });
});

describe('summarizeGitDiff', () => {
  it('counts changed lines and hunks from a unified patch', () => {
    expect(
      summarizeGitDiff([
        'diff --git a/src/App.tsx b/src/App.tsx',
        'index 1111111..2222222 100644',
        '--- a/src/App.tsx',
        '+++ b/src/App.tsx',
        '@@ -1,2 +1,3 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
      ].join('\n'))
    ).toEqual({
      additions: 2,
      deletions: 1,
      hunks: 1,
      files: 1,
    });
  });
});

describe('formatCheckpointSubject', () => {
  it('classifies user commits', () => {
    const info = formatCheckpointSubject('feat: add login');
    expect(info.kind).toBe('user');
    expect(info.display).toBe('feat: add login');
    expect(info.sequence).toBeNull();
  });

  it('classifies the baseline commit', () => {
    expect(formatCheckpointSubject('codepapr:baseline')).toEqual({
      kind: 'baseline',
      display: '初始快照',
      sequence: null,
      preview: null,
    });
  });

  it('classifies legacy uuid checkpoints', () => {
    const legacy = 'codepapr:checkpoint:7c1b9a4e-2f8d-4d6f-b9a7-1d5d2a82e3c1';
    const info = formatCheckpointSubject(legacy);
    expect(info.kind).toBe('legacy-checkpoint');
    expect(info.display).toBe('checkpoint (legacy)');
  });

  it('classifies new-format checkpoints with sequence', () => {
    const subject = 'checkpoint #42 · "重构登录页面..."';
    const info = formatCheckpointSubject(subject);
    expect(info.kind).toBe('checkpoint');
    expect(info.sequence).toBe(42);
    expect(info.display).toBe(subject);
    expect(info.preview).toBe('"重构登录页面..."');
  });

  it('only inspects the first line, ignoring trailers', () => {
    const subject = [
      'checkpoint #7 · "hi"',
      '',
      'CodePapr-Checkpoint-Id: abc',
    ].join('\n');
    const info = formatCheckpointSubject(subject);
    expect(info.kind).toBe('checkpoint');
    expect(info.sequence).toBe(7);
  });

  it('truncates very long subjects for display', () => {
    const long = `checkpoint #1 · "${'x'.repeat(200)}"`;
    const info = formatCheckpointSubject(long);
    expect(info.display.length).toBeLessThanOrEqual(80);
    expect(info.display.endsWith('…')).toBe(true);
  });

  it('handles empty subject gracefully', () => {
    expect(formatCheckpointSubject('').kind).toBe('user');
    expect(formatCheckpointSubject('').display).toBe('(no message)');
  });
});

describe('buildCheckpointCommitMessage', () => {
  it('embeds sequence, truncated preview, and trailers', () => {
    const msg = buildCheckpointCommitMessage({
      sequence: 3,
      userMessageId: 'msg-id-1',
      userMessageText: 'please refactor the login page to use the new design system',
    });
    const lines = msg.split('\n');
    expect(lines[0]).toBe('checkpoint #3 · "please refactor the logi…"');
    expect(lines[1]).toBe('');
    expect(msg).toContain('CodePapr-Checkpoint-Id: msg-id-1');
    expect(msg).toContain('CodePapr-Message-Id: msg-id-1');
  });

  it('handles empty user text', () => {
    const msg = buildCheckpointCommitMessage({
      sequence: 1,
      userMessageId: 'm',
      userMessageText: '',
    });
    expect(msg.split('\n')[0]).toBe('checkpoint #1 · (empty)');
  });

  it('flattens whitespace in preview', () => {
    const msg = buildCheckpointCommitMessage({
      sequence: 9,
      userMessageId: 'm',
      userMessageText: 'hello\n\n  world\t\there',
    });
    expect(msg.split('\n')[0]).toContain('"hello world here"');
  });
});

describe('nextCheckpointSequence', () => {
  it('returns 1 when no checkpoint commits exist', () => {
    expect(nextCheckpointSequence([])).toBe(1);
    expect(nextCheckpointSequence(['feat: x', 'codepapr:baseline'])).toBe(1);
  });

  it('returns max + 1 from existing checkpoint subjects', () => {
    const subjects = [
      'checkpoint #3 · "x"',
      'feat: something',
      'checkpoint #7 · "y"',
      'checkpoint #5 · "z"',
      'codepapr:baseline',
    ];
    expect(nextCheckpointSequence(subjects)).toBe(8);
  });

  it('ignores legacy uuid checkpoints', () => {
    const subjects = [
      'codepapr:checkpoint:7c1b9a4e-2f8d-4d6f-b9a7-1d5d2a82e3c1',
      'checkpoint #2 · "ok"',
    ];
    expect(nextCheckpointSequence(subjects)).toBe(3);
  });
});

describe('parseCheckpointTrailers', () => {
  it('extracts checkpoint id and message id from body', () => {
    const body = [
      'checkpoint #3 · "hi"',
      '',
      'CodePapr-Checkpoint-Id: cp-1',
      'CodePapr-Message-Id: msg-2',
    ].join('\n');
    expect(parseCheckpointTrailers(body)).toEqual({
      checkpointId: 'cp-1',
      messageId: 'msg-2',
    });
  });

  it('returns nulls when trailers are missing', () => {
    expect(parseCheckpointTrailers('plain commit message')).toEqual({
      checkpointId: null,
      messageId: null,
    });
  });
});
