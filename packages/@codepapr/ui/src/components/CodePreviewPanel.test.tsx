// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, monacoPropsSpy, listenMock, emitManagedLspStatus, resetManagedLspListener } = vi.hoisted(
  () => {
    let managedLspHandler: ((event: { payload: unknown }) => void) | null = null;

    return {
      invokeMock: vi.fn(),
      monacoPropsSpy: vi.fn(),
      listenMock: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
        if (eventName === 'codepapr://lsp-managed-status') {
          managedLspHandler = handler;
        }
        return () => {
          managedLspHandler = null;
        };
      }),
      emitManagedLspStatus: (payload: unknown) => {
        managedLspHandler?.({ payload });
      },
      resetManagedLspListener: () => {
        managedLspHandler = null;
      },
    };
  }
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('./MonacoDiffEditor', async () => {
  const React = await import('react');
  return {
    MonacoDiffEditor: () => React.createElement('div', { 'data-testid': 'monaco-diff-editor' }),
  };
});

vi.mock('./MonacoTextEditor', async () => {
  const React = await import('react');
  return {
    MonacoTextEditor: (props: {
      value?: string;
      language?: string;
      onDiagnosticsChange?: (summary: {
        total: number;
        errors: number;
        warnings: number;
        infos: number;
        hints: number;
        items: Array<unknown>;
      }) => void;
    }) => {
      React.useEffect(() => {
        monacoPropsSpy(props);
        props.onDiagnosticsChange?.({
          total: 0,
          errors: 0,
          warnings: 0,
          infos: 0,
          hints: 0,
          items: [],
        });
      }, [props.language, props.onDiagnosticsChange, props.value]);

      return React.createElement(
        'div',
        { 'data-testid': 'monaco-text-editor' },
        props.language ?? 'plaintext'
      );
    },
  };
});

import { normalizeSettings, useAgentStore } from '../store/agentStore';
import {
  clearLanguageIntelligenceWorkspace,
  scheduleLanguageIntelligenceRefresh,
} from '../utils/languageIntelligence';
import { CodePreviewPanel } from './CodePreviewPanel';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

describe('CodePreviewPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    monacoPropsSpy.mockReset();
    listenMock.mockClear();
    resetManagedLspListener();
    clearLanguageIntelligenceWorkspace('/workspace');
    useAgentStore.setState((state) => ({
      ...state,
      settings: normalizeSettings(),
      projectDiagnosticsReport: null,
    }));

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'package.json') {
          return {
            path: relativePath,
            content: JSON.stringify({
              name: 'codepapr',
              workspaces: ['packages/@codepapr/core'],
              dependencies: { react: '^18.0.0' },
            }),
            bytes: 0,
          };
        }

        if (relativePath === 'packages/@codepapr/core/package.json') {
          return {
            path: relativePath,
            content: JSON.stringify({ name: '@codepapr/core' }),
            bytes: 0,
          };
        }

        if (relativePath === 'scripts/example.py') {
          return {
            path: relativePath,
            content: 'def run():\n    return 1\n',
            bytes: 0,
          };
        }
      }

      if (command === 'lsp_open_document') {
        return {
          message: {
            opened: true,
            diagnostics: [],
            server: {
              languageId: 'python',
              serverFamily: 'python',
              running: true,
              command: 'pyright-langserver --stdio',
              toolOrigin: 'external',
              toolSource: 'path',
              toolLabel: 'pyright-langserver',
              managedCachePath: null,
              pid: 1234,
              openDocuments: 1,
              stderrTail: [],
            },
          },
        };
      }

      if (command === 'lsp_request') {
        const method = String(args?.method ?? '');
        if (method === 'textDocument/documentSymbol') {
          return {
            message: {
              result: [
                {
                  name: 'run',
                  detail: 'function',
                  selectionRange: {
                    start: { line: 0, character: 4 },
                    end: { line: 0, character: 7 },
                  },
                },
              ],
            },
          };
        }

        if (method === 'textDocument/hover') {
          return { message: { result: null } };
        }

        if (method === 'textDocument/definition') {
          return { message: { result: [] } };
        }
      }

      if (command === 'lsp_close_document') {
        return true;
      }

      throw new Error(`Unexpected command: ${command}`);
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
    clearLanguageIntelligenceWorkspace('/workspace');
  });

  it('uses cached language intelligence without opening LSP from the selected-file click path', async () => {
    scheduleLanguageIntelligenceRefresh({
      invoke: invokeMock,
      workspacePath: '/workspace',
      paths: ['scripts/example.py'],
      force: true,
    });

    for (let index = 0; index < 5; index += 1) {
      await flushEffects();
    }

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === 'lsp_open_document' && args?.relativePath === 'scripts/example.py'
      )
    ).toBe(true);
    invokeMock.mockClear();

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="scripts/example.py"
          selectedGitFile={null}
          selectedLocation={null}
          lang="en"
        />
      );
    });

    for (let index = 0; index < 5; index += 1) {
      await flushEffects();
    }

    expect(invokeMock.mock.calls.some(([command]) => command === 'lsp_open_document')).toBe(false);
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) => command === 'lsp_request' && args && args.method === 'textDocument/documentSymbol'
      )
    ).toBe(false);
    expect(container.textContent).not.toContain('Outline');
    expect(container.textContent).not.toContain('Connected (0)');
    expect(container.textContent).not.toContain('scripts/example.py');

    const observedMonacoProps = monacoPropsSpy.mock.calls.map((call) => call[0] as {
      excludedDiagnosticMarkerOwners?: string[];
    });
    expect(
      observedMonacoProps.some(
        (props) => JSON.stringify(props.excludedDiagnosticMarkerOwners) === JSON.stringify(['codepapr-lsp'])
      )
    ).toBe(true);
  });

  it('prewarms visible file content without running LSP from the preview layer', async () => {
    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath={null}
          selectedGitFile={null}
          selectedLocation={null}
          lang="en"
          prewarmPaths={['scripts/example.py']}
        />
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === 'read_text_file' && args && args.relativePath === 'scripts/example.py'
      )
    ).toBe(true);
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === 'lsp_open_document' && args && args.relativePath === 'scripts/example.py'
      )
    ).toBe(false);
  });

  it('shows a truncation warning when the file exceeds the preview size limit', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'scripts/example.py') {
          return {
            path: relativePath,
            content: 'def run():\n    return 1\n',
            bytes: 300001,
            truncatedByBytes: true,
          };
        }
        if (relativePath === 'package.json') {
          return { path: relativePath, content: '{}', bytes: 2, truncatedByBytes: false };
        }
        if (relativePath === 'packages/@codepapr/core/package.json') {
          return { path: relativePath, content: '{}', bytes: 2, truncatedByBytes: false };
        }
        return { path: relativePath, content: '', bytes: 0, truncatedByBytes: false };
      }
      if (command === 'lsp_open_document') return undefined;
      if (command === 'lsp_close_document') return undefined;
      return undefined;
    });

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="scripts/example.py"
          selectedGitFile={null}
          selectedLocation={null}
          lang="en"
        />
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('exceeds the preview size limit');
  });

  it('warms the selected file language intelligence asynchronously after the preview is ready', async () => {
    vi.useFakeTimers();

    try {
      await act(async () => {
        root.render(
          <CodePreviewPanel
            workspacePath="/workspace"
            selectedPath="scripts/example.py"
            selectedGitFile={null}
            selectedLocation={null}
            lang="en"
          />
        );
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === 'read_text_file' && args && args.relativePath === 'scripts/example.py'
        )
      ).toBe(true);
      expect(invokeMock.mock.calls.some(([command]) => command === 'lsp_open_document')).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(119);
      });

      expect(invokeMock.mock.calls.some(([command]) => command === 'lsp_open_document')).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === 'lsp_open_document' && args?.relativePath === 'scripts/example.py'
        )
      ).toBe(true);
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === 'lsp_request' && args?.method === 'textDocument/documentSymbol'
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prioritizes the selected file read instead of waiting for background prewarm', async () => {
    const slowPrewarmRead = createDeferred<ReadFileResult>();
    let exampleReadCount = 0;

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'package.json') {
          return { path: relativePath, content: JSON.stringify({ name: 'codepapr' }), bytes: 0 };
        }

        if (relativePath === 'scripts/example.py') {
          exampleReadCount += 1;
          if (exampleReadCount === 1) {
            return slowPrewarmRead.promise;
          }
          return { path: relativePath, content: 'def selected():\n    return 2\n', bytes: 0 };
        }
      }

      if (command === 'lsp_open_document') {
        return {
          message: {
            opened: true,
            diagnostics: [],
            server: {
              languageId: 'python',
              serverFamily: 'python',
              running: true,
              command: 'pyright-langserver --stdio',
              toolOrigin: 'external',
              toolSource: 'path',
              toolLabel: 'pyright-langserver',
              managedCachePath: null,
              pid: 1234,
              openDocuments: 1,
              stderrTail: [],
            },
          },
        };
      }

      if (command === 'lsp_request') {
        return { message: { result: null } };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath={null}
          selectedGitFile={null}
          selectedLocation={null}
          lang="en"
          prewarmPaths={['scripts/example.py']}
        />
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="scripts/example.py"
          selectedGitFile={null}
          selectedLocation={null}
          lang="en"
          prewarmPaths={['scripts/example.py']}
        />
      );
    });

    for (let index = 0; index < 5; index += 1) {
      await flushEffects();
    }

    expect(exampleReadCount).toBeGreaterThanOrEqual(2);
    expect(
      monacoPropsSpy.mock.calls.some((call) => (call[0] as { value?: string }).value?.includes('selected'))
    ).toBe(true);

    slowPrewarmRead.resolve({
      path: 'scripts/example.py',
      content: 'def stale():\n    return 1\n',
      bytes: 0,
    });
  });

  it('re-reads the open file when workspaceMutationVersion bumps (N4)', async () => {
    const baseImpl = invokeMock.getMockImplementation();
    let exampleReadCount = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file' && String(args?.relativePath ?? '') === 'scripts/example.py') {
        exampleReadCount += 1;
        return {
          path: 'scripts/example.py',
          content: exampleReadCount === 1 ? 'def run():\n    return 1\n' : 'def run():\n    return 2\n',
          bytes: 0,
        };
      }
      return await baseImpl!(command, args);
    });

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="scripts/example.py"
          selectedGitFile={null}
          selectedLocation={null}
          lang="en"
        />
      );
    });

    for (let index = 0; index < 5; index += 1) {
      await flushEffects();
    }

    expect(exampleReadCount).toBe(1);
    expect(
      monacoPropsSpy.mock.calls.some((call) => (call[0] as { value?: string }).value?.includes('return 1'))
    ).toBe(true);

    // agent 修改文件：mutation version bump（noteWorkspaceMutation 的防抖版本递增）。
    await act(async () => {
      useAgentStore.setState((state) => ({
        ...state,
        workspaceMutationVersion: state.workspaceMutationVersion + 1,
      }));
    });

    for (let index = 0; index < 5; index += 1) {
      await flushEffects();
    }

    expect(exampleReadCount).toBeGreaterThanOrEqual(2);
    expect(
      monacoPropsSpy.mock.calls.some((call) => (call[0] as { value?: string }).value?.includes('return 2'))
    ).toBe(true);
  });

  it('keeps routine project and static diagnostics out of the code surface', async () => {
    useAgentStore.setState((state) => ({
      ...state,
      projectDiagnosticsReport: {
        available: true,
        packageManager: 'npm',
        packageJsonPath: 'package.json',
        ranAt: Date.now(),
        overallStatus: 'passed',
        stages: [
          {
            id: 'typecheck',
            scriptName: 'python-syntax',
            label: 'Python syntax',
            command: 'python3',
            args: ['-c', 'print(1)'],
            fallback: false,
            kind: 'python-syntax',
            success: true,
            status: 0,
            timedOut: false,
            stdout: 'Python syntax OK (1 files checked)',
            stderr: '',
            excerpt: 'Python syntax OK (1 files checked)',
          },
        ],
      },
    }));

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="scripts/example.py"
          selectedGitFile={null}
          selectedLocation={null}
          lang="en"
        />
      );
    });

    for (let index = 0; index < 5; index += 1) {
      await flushEffects();
    }

    expect(container.textContent).not.toContain('scripts/example.py');
    expect(container.textContent).not.toContain(
      'Current file was included in project diagnostics and has no project-level issues'
    );
    expect(container.textContent).not.toContain('Project Diagnostics: 0');
    expect(container.textContent).not.toContain('Diagnostics: 0');
    expect(container.textContent).not.toContain('This file does not appear in the latest project diagnostics');
  });

  it('shows a concrete install hint when a language without built-in fallback is missing an LSP server', async () => {
    vi.useFakeTimers();

    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'package.json') {
          return {
            path: relativePath,
            content: JSON.stringify({ name: 'codepapr' }),
            bytes: 0,
          };
        }

        if (relativePath === 'src/lib.rs') {
          return {
            path: relativePath,
            content: 'pub fn add(left: i32, right: i32) -> i32 { left + right }\n',
            bytes: 0,
          };
        }
      }

      if (command === 'lsp_open_document') {
        throw new Error('无法为 `rust` 启动 LSP。已尝试:\nrust-analyzer: No such file or directory (os error 2)');
      }

      if (command === 'lsp_close_document') {
        return true;
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="src/lib.rs"
          selectedGitFile={null}
          selectedLocation={null}
          lang="zh-CN"
        />
      );
    });

    try {
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(120);
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('缺少 Rust LSP server');
      expect(container.textContent).toContain('rust-analyzer');
      expect(container.textContent).toContain('候选命令');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows managed LSP progress from the background language layer without a persistent success badge', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'package.json') {
          return {
            path: relativePath,
            content: JSON.stringify({ name: 'codepapr' }),
            bytes: 0,
          };
        }

        if (relativePath === 'src/Main.java') {
          return {
            path: relativePath,
            content: 'class Main { int value() { return 1; } }\n',
            bytes: 0,
          };
        }
      }

      if (command === 'lsp_open_document') {
        return {
          message: {
            opened: true,
            diagnostics: [],
            server: {
              languageId: 'java',
              serverFamily: 'java',
              running: true,
              command: '/Users/test/.codepapr/lsp-tools/java/jre/bin/java -jar launcher.jar',
              toolOrigin: 'managed',
              toolSource: 'managed-cache',
              toolLabel: 'JDTLS',
              managedCachePath: '/Users/test/.codepapr/lsp-tools/java',
              pid: 5678,
              openDocuments: 1,
              stderrTail: [],
            },
          },
        };
      }

      if (command === 'lsp_request') {
        const method = String(args?.method ?? '');
        if (method === 'textDocument/documentSymbol') {
          return { message: { result: [] } };
        }

        if (method === 'textDocument/hover') {
          return { message: { result: null } };
        }

        if (method === 'textDocument/definition') {
          return { message: { result: [] } };
        }
      }

      if (command === 'lsp_close_document') {
        return true;
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="src/Main.java"
          selectedGitFile={null}
          selectedLocation={null}
          lang="zh-CN"
        />
      );
    });

    for (let index = 0; index < 3; index += 1) {
      await flushEffects();
    }

    await act(async () => {
      emitManagedLspStatus({
        workspacePath: '/workspace',
        languageId: 'java',
        phase: 'downloading',
        toolLabel: 'JDTLS',
        detail: '',
        cachePath: '/Users/test/.codepapr/lsp-tools/java',
      });
    });

    await flushEffects();

    expect(container.textContent).toContain('正在下载托管 LSP: JDTLS');
    expect(container.textContent).toContain('/Users/test/.codepapr/lsp-tools/java');

    await act(async () => {
      emitManagedLspStatus({
        workspacePath: '/workspace',
        languageId: 'java',
        phase: 'ready',
        toolLabel: 'JDTLS',
        detail: '',
        cachePath: '/Users/test/.codepapr/lsp-tools/java',
      });
    });

    for (let index = 0; index < 4; index += 1) {
      await flushEffects();
    }

    expect(container.textContent).not.toContain('已使用托管工具: JDTLS');
  });

  it('loads git diff views for deleted files without trying to open the missing workspace file', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === 'package.json') {
          return {
            path: relativePath,
            content: JSON.stringify({ name: 'codepapr' }),
            bytes: 0,
          };
        }

        throw new Error(`Unexpected file read: ${relativePath}`);
      }

      if (command === 'run_workspace_command') {
        const gitArgs = (args?.args as string[]) ?? [];
        if (gitArgs[0] === 'show') {
          return {
            command: 'git',
            args: gitArgs,
            status: 0,
            stdout: 'const removed = true;\n',
            stderr: '',
            timedOut: false,
          };
        }
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    await act(async () => {
      root.render(
        <CodePreviewPanel
          workspacePath="/workspace"
          selectedPath="src/removed.ts"
          selectedGitFile={{
            path: 'src/removed.ts',
            mode: 'unstaged',
            indexStatus: '',
            worktreeStatus: 'D',
          }}
          selectedLocation={null}
          lang="en"
        />
      );
    });

    await flushEffects();
    await flushEffects();

    expect(container.querySelector('[data-testid="monaco-diff-editor"]')).not.toBeNull();
    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === 'read_text_file' && payload?.relativePath === 'src/removed.ts'
      )
    ).toBe(false);
  });
});
