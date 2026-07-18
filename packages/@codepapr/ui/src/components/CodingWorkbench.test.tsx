// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
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

  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
    expect(container.textContent).toContain('NEW.md');
  });

  it('does not schedule any startup LSP warmup from the workbench shell', async () => {
    vi.useFakeTimers();

    try {
      invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'save_project_state') {
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
    invokeMock.mockResolvedValueOnce({
      root: '/tmp/codepapr-workspace',
      entries: [
        {
          path: 'README.md',
          name: 'README.md',
          isDir: false,
          bytes: 12,
        },
      ],
      truncated: false,
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
      (button) => button.textContent === '文件夹内容'
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

  it('closeWorkspace 后 projectGraphLoading 重置为 false，不再卡在初始化浮层', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_workspace_files') {
        return {
          root: '/tmp/proj-A',
          entries: [{ path: 'README.md', name: 'README.md', isDir: false, bytes: 12 }],
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