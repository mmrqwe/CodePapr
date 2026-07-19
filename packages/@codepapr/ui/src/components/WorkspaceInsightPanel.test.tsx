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

import { WorkspaceInsightPanel } from './WorkspaceInsightPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('WorkspaceInsightPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let gitInitialized: boolean;

  function buildMock() {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        return {
          root: '.', truncated: false,
          entries: [
            { path: 'src', name: 'src', isDir: true, bytes: 0 },
            { path: 'src/Program.cs', name: 'Program.cs', isDir: false, bytes: 69 },
          ],
        };
      }
      if (command === 'read_text_file') {
        if (args?.relativePath === '.CodePapr/codepapr-projectgraph-cache.json') {
          return { path: '.CodePapr/codepapr-projectgraph-cache.json', content: '', bytes: 0 };
        }
        return { path: String(args?.relativePath ?? ''), content: 'export class Program {}', bytes: 30 };
      }
      if (command === 'read_text_files_batch') {
        const paths: string[] = (args as Record<string, unknown>)?.relativePaths as string[] ?? [];
        return paths.map((p) => ({ path: p, content: 'export class Program {}', bytes: 30 }));
      }
      if (command === 'load_projectgraph_cache') {
        return null;
      }
      if (command === 'save_projectgraph_cache') {
        return undefined;
      }
      if (command === 'write_text_file') {
        return { path: String(args?.relativePath ?? ''), bytes: 0 };
      }
      if (command === 'lsp_open_document') {
        return { message: { server: { toolSource: 'managed-cache' } } };
      }
      if (command === 'lsp_request') {
        return { message: { result: [] } };
      }
      if (command === 'lsp_close_document') {
        return true;
      }
      if (command === 'run_workspace_command') {
        const a = args as { command?: string; args?: string[] } | undefined;
        if (a?.command === 'git' && a?.args?.[0] === 'rev-parse') {
          if (gitInitialized) {
            return { command: 'git', args: ['rev-parse'], status: 0, stdout: '/tmp/repo', stderr: '', timedOut: false };
          }
          return { command: 'git', args: ['rev-parse'], status: 128, stdout: '', stderr: 'fatal: not a git repository', timedOut: false };
        }
        if (a?.command === 'git' && a?.args?.[0] === 'init') {
          gitInitialized = true;
          return { command: 'git', args: ['init'], status: 0, stdout: 'ok', stderr: '', timedOut: false };
        }
        if (a?.command === 'git' && a?.args?.[0] === 'status') {
          return { command: 'git', args: ['status'], status: 0, stdout: '', stderr: '', timedOut: false };
        }
        if (a?.command === 'git' && a?.args?.[0] === 'add') {
          return { command: 'git', args: ['add', '-A'], status: 0, stdout: '', stderr: '', timedOut: false };
        }
        if (a?.command === 'git' && a?.args?.[0] === 'commit') {
          return { command: 'git', args: a?.args ?? [], status: 0, stdout: '', stderr: '', timedOut: false };
        }
        return { command: 'git', args: a?.args ?? [], status: 0, stdout: '', stderr: '', timedOut: false };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  }

  beforeEach(() => {
    gitInitialized = false;
    invokeMock.mockReset();
    buildMock();

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

  it('renders a grouped ProjectGraph without the old Project Map tab', async () => {
    await act(async () => {
      root.render(
        <WorkspaceInsightPanel
          workspacePath="/tmp/codepapr-workspace"
          entries={[
            { path: 'src', name: 'src', isDir: true, bytes: 0 },
            { path: 'src/Program.cs', name: 'Program.cs', isDir: false, bytes: 69 },
          ]}
          lang="zh-CN"
          selectedPath={null}
          onSelectPath={() => undefined}
        />
      );
    });

    for (let i = 0; i < 30; i++) {
      await flushEffects();
    }

    expect(invokeMock).toHaveBeenCalled();
    expect(container.textContent).not.toContain('ProjectGraph 与 Git');
    expect(container.textContent).not.toContain('项目图谱');
    expect(container.textContent).toContain('ProjectGraph');
    expect(container.textContent).toContain('刷新');
  });

  it('does not show "0 files" error when workspace switches during cache lookup (race condition fix)', async () => {
    let resolveCacheLookup: ((value: string | null) => void) | null = null;

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_projectgraph_cache') {
        return new Promise<string | null>((resolve) => {
          resolveCacheLookup = resolve;
        });
      }
      if (command === 'read_text_file') {
        return { path: String(args?.relativePath ?? ''), content: 'export const x = 1;', bytes: 20 };
      }
      if (command === 'read_text_files_batch') {
        const paths: string[] = (args as Record<string, unknown>)?.relativePaths as string[] ?? [];
        return paths.map((p) => ({ path: p, content: 'export const x = 1;', bytes: 20 }));
      }
      if (command === 'save_projectgraph_cache') {
        return undefined;
      }
      if (command === 'lsp_start_server') {
        return { running: true, serverFamily: 'test', command: 'test', toolLabel: 'test' };
      }
      if (command === 'lsp_open_document') {
        return { message: { server: { toolSource: 'managed-cache' } } };
      }
      if (command === 'lsp_get_diagnostics') {
        return { diagnostics: {} };
      }
      if (command === 'run_workspace_command') {
        const a = args as { command?: string; args?: string[] } | undefined;
        if (a?.command === 'git' && a?.args?.[0] === 'rev-parse') {
          return { command: 'git', args: ['rev-parse'], status: 0, stdout: '/tmp/repo', stderr: '', timedOut: false };
        }
        return { command: 'git', args: a?.args ?? [], status: 0, stdout: '', stderr: '', timedOut: false };
      }
      return undefined;
    });

    const validEntries = [
      { path: 'src/main.ts', name: 'main.ts', isDir: false, bytes: 100 },
    ];

    await act(async () => {
      root.render(
        <WorkspaceInsightPanel
          workspacePath="/tmp/project-a"
          entries={validEntries}
          lang="zh-CN"
          selectedPath={null}
          onSelectPath={() => undefined}
          canStartLoading={true}
        />
      );
    });

    await flushEffects();
    expect(resolveCacheLookup).not.toBeNull();

    await act(async () => {
      root.render(
        <WorkspaceInsightPanel
          workspacePath="/tmp/project-b"
          entries={[]}
          lang="zh-CN"
          selectedPath={null}
          onSelectPath={() => undefined}
          canStartLoading={false}
        />
      );
    });

    await act(async () => {
      resolveCacheLookup!(null);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    for (let i = 0; i < 10; i++) {
      await flushEffects();
    }

    expect(container.textContent).not.toContain('文件读取全部失败');
    expect(container.textContent).not.toContain('0 个文件');
  });

  it('clears stale error when switching workspaces after a failed build', async () => {
    const nonCodeEntries = [
      { path: 'readme.txt', name: 'readme.txt', isDir: false, bytes: 100 },
    ];

    await act(async () => {
      root.render(
        <WorkspaceInsightPanel
          workspacePath="/tmp/project-a"
          entries={nonCodeEntries}
          lang="zh-CN"
          selectedPath={null}
          onSelectPath={() => undefined}
          canStartLoading={true}
        />
      );
    });

    for (let i = 0; i < 30; i++) {
      await flushEffects();
    }

    expect(container.textContent).toContain('文件读取全部失败');
    expect(container.textContent).toContain('0 个文件');

    await act(async () => {
      root.render(
        <WorkspaceInsightPanel
          workspacePath="/tmp/project-b"
          entries={[]}
          lang="zh-CN"
          selectedPath={null}
          onSelectPath={() => undefined}
          canStartLoading={false}
        />
      );
    });

    for (let i = 0; i < 10; i++) {
      await flushEffects();
    }

    expect(container.textContent).not.toContain('文件读取全部失败');
  });
});
