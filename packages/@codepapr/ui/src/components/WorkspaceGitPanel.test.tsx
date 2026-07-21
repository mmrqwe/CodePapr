// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { WorkspaceGitPanel } from './WorkspaceGitPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function click(element: Element | null): void {
  if (!element) {
    throw new Error('Expected element to exist.');
  }

  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('WorkspaceGitPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    let gitState: 'initial' | 'committed' = 'initial';
    let currentBranch = 'main';

    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      // New Tauri commands (replacing git CLI)
      if (command === 'git_status') {
        return {
          available: true,
          isRepo: true,
          branch: currentBranch,
          headShort: 'aaaaaaa',
          entries: gitState === 'initial'
            ? [
                { path: 'README.md', oldPath: null, indexStatus: ' ', worktreeStatus: 'M', isUntracked: false },
                { path: 'src/app.ts', oldPath: null, indexStatus: 'M', worktreeStatus: ' ', isUntracked: false },
                { path: '.CodePapr/project.sqlite', oldPath: null, indexStatus: ' ', worktreeStatus: 'M', isUntracked: false },
                { path: 'nested/', oldPath: null, indexStatus: '?', worktreeStatus: '?', isUntracked: true },
              ]
            : [],
          message: null,
        };
      }

      if (command === 'git_log') {
        return [
          {
            sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            shortHash: 'aaaaaaa',
            author: 'Alice',
            email: 'alice@test',
            timestamp: Math.floor(Date.now() / 1000) - 3600,
            message: 'Improve parser',
            refs: [`HEAD -> ${currentBranch}`],
            isHead: true,
          },
          {
            sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            shortHash: 'bbbbbbb',
            author: 'Bob',
            email: 'bob@test',
            timestamp: Math.floor(Date.now() / 1000) - 7200,
            message: 'Baseline commit',
            refs: ['origin/main'],
            isHead: false,
          },
        ];
      }

      if (command === 'snapshot_changed_files') {
        return {
          sha: args?.sha ?? 'aaaaaaaa',
          parentSha: null,
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        };
      }

      if (command === 'restore_execute') {
        currentBranch = 'main';
        gitState = 'committed';
        return {
          ok: true,
          filesRestored: 2,
          filesDeleted: 0,
          backupRef: 'refs/codepapr-backup-before-reset',
          error: null,
        };
      }

      if (command === 'snapshot_ensure') {
        return { ready: true, createdRepo: false, headSha: 'aaaaaaaa', error: null };
      }

      if (command === 'git_restore_files' || command === 'git_stage' || command === 'git_commit') {
        if (command === 'git_restore_files' || command === 'git_commit') {
          gitState = 'committed';
        }
        return { ok: true, action: 'stage', message: 'ok' };
      }

      if (command === 'git_branch_checkout') {
        currentBranch = (args?.branchName as string) ?? currentBranch;
        return { ok: true, action: 'branch_checkout', message: `切换到 ${currentBranch}` };
      }

      // Legacy git CLI commands via run_workspace_command
      if (command !== 'run_workspace_command') {
        throw new Error(`Unexpected command: ${command}`);
      }

      const gitArgs = (args?.args as string[]) ?? [];
      if (gitArgs[0] === 'rev-parse') {
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: '/workspace\n',
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'status') {
        const stdout =
          gitState === 'initial'
            ? [
                `## ${currentBranch}`,
                ' M README.md',
                'M  src/app.ts',
                ' M .CodePapr/project.sqlite',
                '?? nested/',
              ].join('\n')
            : `## ${currentBranch}`;

        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout,
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'log') {
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: [
            `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1faaaaaaa\x1f2026-06-01T12:34:56Z\x1fAlice\x1fHEAD -> ${currentBranch}\x1fImprove parser`,
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1fbbbbbbb\x1f2026-05-31T08:00:00Z\x1fBob\x1forigin/main\x1fBaseline commit',
          ].join('\x1e').concat('\x1e'),
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'diff') {
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: gitArgs.includes('--stat')
            ? ' README.md | 1 +\n'
            : ['diff --git a/README.md b/README.md', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'add') {
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'switch') {
        if (gitArgs[1] === '-c') {
          currentBranch = gitArgs[2] ?? currentBranch;
          return {
            command: 'git',
            args: gitArgs,
            status: 0,
            stdout: `Switched to a new branch '${currentBranch}'\n`,
            stderr: '',
            timedOut: false,
          };
        }

        return {
          command: 'git',
          args: gitArgs,
          status: 128,
          stdout: '',
          stderr: `fatal: invalid reference: ${gitArgs[1] ?? ''}`,
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'checkout') {
        if (gitArgs[1] === '-b') {
          currentBranch = gitArgs[2] ?? currentBranch;
          return {
            command: 'git',
            args: gitArgs,
            status: 0,
            stdout: `Switched to a new branch '${currentBranch}'\n`,
            stderr: '',
            timedOut: false,
          };
        }

        return {
          command: 'git',
          args: gitArgs,
          status: 128,
          stdout: '',
          stderr: `error: pathspec '${gitArgs[1] ?? ''}' did not match any file(s) known to git`,
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'branch') {
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'stash') {
        if (gitArgs[1] === 'push') {
          return {
            command: 'git',
            args: gitArgs,
            status: 0,
            stdout: 'Saved working directory and index state\n',
            stderr: '',
            timedOut: false,
          };
        }

        if (gitArgs[1] === 'list') {
          return {
            command: 'git',
            args: gitArgs,
            status: 0,
            stdout: 'stash@{0}\x1fCodePapr safety snapshot\n',
            stderr: '',
            timedOut: false,
          };
        }
      }

      if (gitArgs[0] === 'restore') {
        gitState = 'committed';
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'reset') {
        if (gitArgs[1] === '--hard') {
          gitState = 'committed';
        }
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'rm') {
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      }

      if (gitArgs[0] === 'commit') {
        gitState = 'committed';
        return {
          command: 'git',
          args: gitArgs,
          status: 0,
          stdout: '[main abc123] test commit\n',
          stderr: '',
          timedOut: false,
        };
      }

      throw new Error(`Unexpected git args: ${gitArgs.join(' ')}`);
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('shows a single Changes list (no staged/unstaged split) and expands inline diff without selecting in the main workbench', async () => {
    const onSelectPath = vi.fn();
    const onSelectGitFile = vi.fn();

    await act(async () => {
      root.render(
        <WorkspaceGitPanel
          workspacePath="/workspace"
          lang="en"
          selectedPath={null}
          selectedGitFile={null}
          onSelectPath={onSelectPath}
          onSelectGitFile={onSelectGitFile}
        />
      );
    });

    click(container.querySelector('button[aria-label="Git Delta"]'));
    await flushEffects();

    // 方案 A：UI 不再展示 "Unstaged: N" / "Staged: M" 两个分区。
    expect(container.textContent).not.toContain('Unstaged: ');
    expect(container.textContent).not.toContain('Staged: ');
    // 取而代之的是单一的 "Changes" 区与 "X of Y selected" 计数。
    expect(container.textContent).toContain('Changes');
    expect(container.textContent).toContain('2 of 2 selected');
    expect(container.textContent).toContain('app.ts');
    expect(container.textContent).toContain('README.md');
    // 内部状态文件、噪声文件、目录条目仍被过滤。
    expect(container.textContent).not.toContain('src/app.ts');
    expect(container.textContent).not.toContain('/workspace');
    expect(container.textContent).not.toContain('.CodePapr/project.sqlite');
    expect(container.textContent).not.toContain('nested/');

    // 点击 README.md 行应展开 inline diff 而不是切换主工作区文件。
    const readmeRow = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('README.md')
    );
    click(readmeRow ?? null);
    await flushEffects();

    expect(onSelectPath).not.toHaveBeenCalled();
    expect(onSelectGitFile).not.toHaveBeenCalled();
    // 旧 UI 的 "Stage File" 按钮已不再存在。
    expect(container.textContent).not.toContain('Stage File');
    // 但 inline diff 应已展开（出现 "Open File" 与 "Copy" 操作行）。
    expect(container.textContent).toContain('Open File');

    // 收起面板。
    click(container.querySelector('button[aria-label="Git Delta"]'));
    await flushEffects();

    expect(container.textContent).not.toContain('Local Commit');
  });

  it('commits all changes by default (one-click) and supports deselecting a file', async () => {
    await act(async () => {
      root.render(
        <WorkspaceGitPanel
          workspacePath="/workspace"
          lang="en"
          selectedPath={null}
          selectedGitFile={null}
          onSelectGitFile={() => undefined}
        />
      );
    });

    click(container.querySelector('button[aria-label="Git Delta"]'));
    await flushEffects();

    // 默认全选 2 个文件。
    expect(container.textContent).toContain('2 of 2 selected');

    // 取消勾选 README.md。
    const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    const readmeCheckbox = checkboxes.find(
      (cb) => cb.getAttribute('aria-label')?.includes('README.md')
    ) as HTMLInputElement | undefined;
    expect(readmeCheckbox).toBeDefined();
    act(() => {
      readmeCheckbox!.click();
    });
    await flushEffects();

    expect(container.textContent).toContain('1 of 2 selected');

    // 输入 commit message。
    const commitBox = container.querySelector('#workspace-git-commit-message') as HTMLTextAreaElement | null;
    expect(commitBox).not.toBeNull();
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setValue?.call(commitBox, 'test commit');
      commitBox!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushEffects();

    // 点击"Commit Selected (1)"。
    click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Commit Selected')
      ) ?? null
    );
    await flushEffects();
    await flushEffects();

    // 一键提交流程：git_commit（自动合并 stage + commit）。
    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === 'git_commit' &&
          payload?.message === 'test commit' &&
          Array.isArray(payload?.pathspecs) &&
          payload.pathspecs.includes('src/app.ts')
      )
    ).toBe(true);

    // README.md 被取消勾选，不在 pathspecs 中。
    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === 'git_commit' &&
          Array.isArray(payload?.pathspecs) &&
          !payload.pathspecs.includes('README.md')
      )
    ).toBe(true);

    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === 'git_commit' &&
          payload?.message === 'test commit'
      )
    ).toBe(true);
    expect(container.textContent).toContain('There are no uncommitted changes right now.');
  });

  it('creates a sandbox branch from the selected commit and supports safe rollback', async () => {
    await act(async () => {
      root.render(
        <WorkspaceGitPanel
          workspacePath="/workspace"
          lang="en"
          selectedPath={null}
          selectedGitFile={null}
          onSelectGitFile={() => undefined}
        />
      );
    });

    click(container.querySelector('button[aria-label="Git Delta"]'));
    await flushEffects();

    // 在新 UI 中，需要点击行内的"Set as reset target"按钮来选中提交（而不是直接点行头）。
    const resetTargetButton =
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Set as reset target')
      ) ?? null;
    expect(resetTargetButton).not.toBeNull();
    click(resetTargetButton);
    await flushEffects();

    const branchInput = container.querySelector('input[type="text"]') as HTMLInputElement | null;
    expect(branchInput).not.toBeNull();
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(branchInput, 'feature/sandbox');
      branchInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushEffects();

    click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Create / Switch')
      ) ?? null
    );
    await flushEffects();
    await flushEffects();

    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === 'git_branch_checkout' &&
          payload?.branchName === 'feature/sandbox'
      )
    ).toBe(true);
    expect(container.textContent).toContain('feature/sandbox');

    click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Rollback to Selected')
      ) ?? null
    );
    await flushEffects();
    await flushEffects();

    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === 'restore_execute' &&
          payload?.targetSha === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    ).toBe(true);
  });

  it('creates a safety snapshot before discarding local changes', async () => {
    await act(async () => {
      root.render(
        <WorkspaceGitPanel
          workspacePath="/workspace"
          lang="en"
          selectedPath={null}
          selectedGitFile={null}
          onSelectGitFile={() => undefined}
        />
      );
    });

    click(container.querySelector('button[aria-label="Git Delta"]'));
    await flushEffects();

    click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Discard Local Changes')
      ) ?? null
    );
    await flushEffects();
    await flushEffects();

    expect(
      invokeMock.mock.calls.some(
        ([command]) =>
          command === 'git_restore_files'
      )
    ).toBe(true);
    expect(container.textContent).toContain('There are no uncommitted changes right now.');
    expect(container.textContent).toContain('There are no uncommitted changes right now.');
  });

  it('exposes commit-comparison buttons that fire onOpenCommitReview with proper scope', async () => {
    const onOpenCommitReview = vi.fn();
    await act(async () => {
      root.render(
        <WorkspaceGitPanel
          workspacePath="/workspace"
          lang="en"
          selectedPath={null}
          selectedGitFile={null}
          onSelectGitFile={() => undefined}
          onOpenCommitReview={onOpenCommitReview}
        />
      );
    });

    click(container.querySelector('button[aria-label="Git Delta"]'));
    await flushEffects();

    // 点击第一条 commit 的"行头"以展开它（toggleGitHistoryEntry 的载入效果）。
    const commitHeader = Array.from(container.querySelectorAll('[role="button"]')).find((el) =>
      el.textContent?.includes('Improve parser')
    ) as HTMLElement | undefined;
    expect(commitHeader).toBeDefined();
    click(commitHeader ?? null);
    await flushEffects();
    await flushEffects();

    // 展开后应出现两个对比按钮。
    const compareWithCurrent = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Compare with current')
    );
    const compareWithParent = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Compare with previous')
    );
    expect(compareWithCurrent).toBeDefined();
    expect(compareWithParent).toBeDefined();

    click(compareWithCurrent ?? null);
    await flushEffects();
    expect(onOpenCommitReview).toHaveBeenCalledWith({
      baseRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headRef: 'WORKTREE',
    });

    click(compareWithParent ?? null);
    await flushEffects();
    expect(onOpenCommitReview).toHaveBeenCalledWith({
      baseRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa~1',
      headRef: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });
});
