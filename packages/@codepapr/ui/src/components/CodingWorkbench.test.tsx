// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, openMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openMock,
}));

vi.mock('./CodePreviewPanel', async () => {
  const React = await import('react');
  return {
    CodePreviewPanel: () => React.createElement('div', { 'data-testid': 'code-preview-panel' }),
  };
});

vi.mock('./WorkspaceInsightPanel', async () => {
  const React = await import('react');
  return {
    WorkspaceInsightPanel: () => React.createElement('div', { 'data-testid': 'workspace-insight-panel' }),
  };
});

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import { CodingWorkbench } from './CodingWorkbench';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('CodingWorkbench', () => {
  let container: HTMLDivElement;
  let root: Root;
  let watcherCallback: (() => void) | null;

  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    listenMock.mockReset();
    watcherCallback = null;
    // `listen` captures the `workspace-files-changed` handler so tests can
    // simulate native watcher events (replacing the old 1.5s poll).
    listenMock.mockImplementation(async (event: string, cb: () => void) => {
      if (event === 'workspace-files-changed') {
        watcherCallback = cb;
      }
      return () => undefined;
    });
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings(),
      workspacePath: '/tmp/codepapr-workspace',
      workspaceMutationVersion: 0,
      sessions: [],
      activeSessionId: null,
      messages: [],
      sessionMessages: {},
      projectDiagnosticsReport: null,
      isLoading: false,
      showSettings: false,
    }));

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

  it('refreshes the file tree after the system mutates workspace files', async () => {
    let includeNewFile = false;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== 'list_workspace_files') {
        return undefined;
      }

      const entries = [
        {
          path: 'README.md',
          name: 'README.md',
          isDir: false,
          bytes: 12,
        },
      ];

      if (includeNewFile) {
        entries.push({
          path: 'NEW.md',
          name: 'NEW.md',
          isDir: false,
          bytes: 8,
        });
      }

      return {
        root: '/tmp/codepapr-workspace',
        entries,
        truncated: false,
      };
    });

    await act(async () => {
      root.render(
        <CodingWorkbench
          selectedPath={null}
          selectedGitFile={null}
          selectedLocation={null}
          previewPlacement="hidden"
          onSelectPath={() => undefined}
        />
      );
    });

    await flushEffects();
    expect(container.textContent).toContain('README.md');
    const initialCalls = invokeMock.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    act(() => {
      includeNewFile = true;
      useAgentStore.getState().noteWorkspaceMutation(['NEW.md']);
    });

    // Simulate the native watcher emitting a change event (the agent's file
    // write would trigger this in the real app).
    await act(async () => {
      watcherCallback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('NEW.md');
  });

  it('N21：文件树加载失败时显示错误与重试入口，而非误导性的「没有文件」', async () => {
    let failListing = true;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_workspace_files') {
        if (failListing) {
          throw new Error('permission denied');
        }
        return {
          root: '/tmp/codepapr-workspace',
          entries: [{ path: 'README.md', name: 'README.md', isDir: false, bytes: 12 }],
          truncated: false,
        };
      }
      // 自愈 effect 只对默认项目生效：返回不同路径跳过重建
      if (command === 'ensure_default_project') {
        return { path: '/tmp/some-other-project' };
      }
      return undefined;
    });

    await act(async () => {
      root.render(
        <CodingWorkbench
          selectedPath={null}
          selectedGitFile={null}
          selectedLocation={null}
          previewPlacement="hidden"
          onSelectPath={() => undefined}
        />
      );
    });
    await flushEffects();
    await flushEffects();

    // 加载失败：绝不显示「没有文件」，而是可见的错误与重试入口
    expect(container.textContent).not.toContain('没有文件');
    expect(container.textContent).toContain('文件列表加载失败');
    expect(container.textContent).toContain('permission denied');

    // 重试成功：树恢复显示
    failListing = false;
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('重新加载')
    );
    expect(retry).not.toBeNull();
    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await flushEffects();

    expect(container.textContent).toContain('README.md');
    expect(container.textContent).not.toContain('文件列表加载失败');
  });

  it('does not schedule any startup LSP warmup from the workbench shell', async () => {
    vi.useFakeTimers();

    try {
      invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (
          command === 'save_project_state' ||
          command === 'start_workspace_watcher' ||
          command === 'stop_workspace_watcher'
        ) {
          return undefined;
        }

        if (command === 'list_workspace_files') {
          return {
            root: '/tmp/codepapr-workspace',
            entries: [
              {
                path: 'src/App.tsx',
                name: 'App.tsx',
                isDir: false,
                bytes: 24,
              },
              {
                path: 'src/util.ts',
                name: 'util.ts',
                isDir: false,
                bytes: 20,
              },
            ],
            truncated: false,
          };
        }

        if (command === 'read_text_file') {
          const relativePath = String(args?.relativePath ?? '');
          if (relativePath === 'package.json') {
            return {
              path: relativePath,
              content: JSON.stringify({ name: 'codepapr' }),
              bytes: 0,
            };
          }

          return {
            path: relativePath,
            content: relativePath.endsWith('.tsx') ? 'export function App() { return null; }' : 'export const x = 1;',
            bytes: 0,
          };
        }

        if (command === 'lsp_open_document') {
          return {
            message: {
              opened: true,
              diagnostics: [],
              server: {
                languageId: 'typescript',
                serverFamily: 'typescript',
                running: true,
                command: 'typescript-language-server --stdio',
                toolOrigin: 'managed',
                toolSource: 'workspace',
                toolLabel: 'typescript-language-server',
                managedCachePath: null,
                pid: 123,
                openDocuments: 1,
                stderrTail: [],
              },
            },
          };
        }

        if (command === 'lsp_request') {
          return { message: { result: [] } };
        }

        throw new Error(`Unexpected command: ${command}`);
      });

      await act(async () => {
        root.render(
          <CodingWorkbench
            selectedPath={null}
            selectedGitFile={null}
            selectedLocation={null}
            previewPlacement="hidden"
            onSelectPath={() => undefined}
          />
        );
      });

      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });
      expect(invokeMock.mock.calls.some(([command]) => command === 'lsp_open_document')).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(450);
        await Promise.resolve();
      });

      expect(invokeMock.mock.calls.filter(([command]) => command === 'lsp_open_document')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the file tree tab first and switches to the ProjectGraph panel in hidden preview mode', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_workspace_files') {
        return {
          root: '/tmp/codepapr-workspace',
          entries: [
            {
              path: 'README.md',
              name: 'README.md',
              isDir: false,
              bytes: 12,
            },
            {
              path: 'app.ts',
              name: 'app.ts',
              isDir: false,
              bytes: 100,
            },
          ],
          truncated: false,
        };
      }
      return undefined;
    });

    await act(async () => {
      root.render(
        <CodingWorkbench
          selectedPath={null}
          selectedGitFile={null}
          selectedLocation={null}
          previewPlacement="hidden"
          onSelectPath={() => undefined}
        />
      );
    });

    await flushEffects();

    const fileTreeButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '文件夹'
    );
    const projectGraphButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'ProjectGraph'
    );

    expect(fileTreeButton?.getAttribute('aria-pressed')).toBe('true');
    expect(projectGraphButton?.getAttribute('aria-pressed')).toBe('false');
    expect(container.textContent).toContain('README.md');

    const insightPanel = container.querySelector('[data-testid="workspace-insight-panel"]');
    expect(insightPanel?.parentElement?.classList.contains('hidden')).toBe(false);

    await act(async () => {
      projectGraphButton?.click();
    });

    const visibleInsightPanel = container.querySelector('[data-testid="workspace-insight-panel"]');
    expect(visibleInsightPanel?.parentElement?.classList.contains('hidden')).toBe(false);
  });

  it('lazily loads a directory subtree when the user expands an unloaded directory', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_workspace_files') {
        if (args?.relativePath === 'src') {
          return {
            root: '/tmp/codepapr-workspace',
            entries: [
              {
                path: 'src/App.tsx',
                name: 'App.tsx',
                isDir: false,
                bytes: 24,
                hasChildren: false,
              },
              {
                path: 'src/components',
                name: 'components',
                isDir: true,
                bytes: 0,
                hasChildren: true,
              },
            ],
            truncated: false,
          };
        }
        return {
          root: '/tmp/codepapr-workspace',
          entries: [
            {
              path: 'README.md',
              name: 'README.md',
              isDir: false,
              bytes: 12,
              hasChildren: false,
            },
            {
              path: 'src',
              name: 'src',
              isDir: true,
              bytes: 0,
              hasChildren: true,
            },
          ],
          truncated: false,
        };
      }
      return undefined;
    });

    await act(async () => {
      root.render(
        <CodingWorkbench
          selectedPath={null}
          selectedGitFile={null}
          selectedLocation={null}
          previewPlacement="hidden"
          onSelectPath={() => undefined}
        />
      );
    });

    await flushEffects();
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('src');
    expect(container.textContent).not.toContain('App.tsx');

    const srcButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'src'
    );
    expect(srcButton).toBeTruthy();

    await act(async () => {
      srcButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('App.tsx');
    const lazyCall = invokeMock.mock.calls.find(
      ([command, args]) => command === 'list_workspace_files' && args?.relativePath === 'src'
    );
    expect(lazyCall).toBeTruthy();
  });

  it('closeWorkspace 后 projectGraphLoading 重置为 false，不再卡在初始化浮层', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_workspace_files') {
        return {
          root: '/tmp/proj-A',
          entries: [
            { path: 'README.md', name: 'README.md', isDir: false, bytes: 12 },
            { path: 'main.ts', name: 'main.ts', isDir: false, bytes: 50 },
          ],
          truncated: false,
        };
      }
      return undefined;
    });

    useAgentStore.setState({
      workspacePath: '/tmp/proj-A',
      projectGraphLoading: false,
    });

    await act(async () => {
      root.render(
        <CodingWorkbench
          selectedPath={null}
          selectedGitFile={null}
          selectedLocation={null}
          previewPlacement="hidden"
          onSelectPath={() => undefined}
        />
      );
    });

    await flushEffects();

    // 有文件的项目会触发 line 447 effect 设 setProjectGraphLoading(true)
    expect(useAgentStore.getState().projectGraphLoading).toBe(true);

    // 关闭当前项目
    await act(async () => {
      useAgentStore.getState().closeWorkspace();
    });

    await flushEffects();

    // 关闭后 projectGraphLoading 应为 false，UI 不再卡在「正在初始化工作区」
    expect(useAgentStore.getState().projectGraphLoading).toBe(false);
    expect(useAgentStore.getState().workspacePath).toBe('');
    expect(useAgentStore.getState().projectGraphPhase).toBeNull();
  });
});