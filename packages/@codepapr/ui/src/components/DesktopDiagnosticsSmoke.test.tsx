// @vitest-environment jsdom

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invokeMock,
  openMock,
  loadProjectStateMock,
  saveProjectStateMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
  loadProjectStateMock: vi.fn(),
  saveProjectStateMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openMock,
}));

vi.mock('../utils/projectStorage', () => ({
  createEmptyProjectState: () => ({
    version: 1,
    sessions: [],
    activeSessionId: null,
    sessionMessages: {},
    cumulativeStats: {
      totalCacheRead: 0,
      totalCacheCreation: 0,
      totalInput: 0,
      totalOutput: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      rounds: 0,
    },
    sessionCumulativeStats: {},
    projectDiagnosticsReport: null,

    updatedAt: Date.now(),
  }),
  loadProjectState: loadProjectStateMock,
  saveProjectState: saveProjectStateMock,
}));

vi.mock('./SplitPane', async () => {
  const React = await import('react');
  return {
    SplitPane: ({ first, second, className = '' }: { first: React.ReactNode; second: React.ReactNode; className?: string }) =>
      React.createElement(
        'div',
        { className },
        React.createElement('div', { 'data-testid': 'split-first' }, first),
        React.createElement('div', { 'data-testid': 'split-second' }, second)
      ),
  };
});

vi.mock('./MonacoDiffEditor', async () => {
  const React = await import('react');
  return {
    MonacoDiffEditor: () => React.createElement('div', { 'data-testid': 'monaco-diff-editor' }),
  };
});

vi.mock('./MonacoTextEditor', async () => {
  const React = await import('react');

  const createSummary = (modelPath: string | undefined) => {
    if (modelPath === 'vite.config.ts') {
      return {
        total: 2,
        errors: 2,
        warnings: 0,
        infos: 0,
        hints: 0,
        items: [
          {
            severity: 'error' as const,
            startLineNumber: 1,
            startColumn: 24,
            message: "Cannot find module 'vite' or its corresponding type declarations.",
          },
          {
            severity: 'error' as const,
            startLineNumber: 2,
            startColumn: 19,
            message:
              "Cannot find module '@vitejs/plugin-react' or its corresponding type declarations.",
          },
        ],
      };
    }

    return {
      total: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
      items: [],
    };
  };

  return {
    configureMonacoLanguageServices: () => undefined,
    MonacoTextEditor: (props: {
      value: string;
      modelPath?: string;
      onDiagnosticsChange?: (summary: {
        total: number;
        errors: number;
        warnings: number;
        infos: number;
        hints: number;
        items: Array<{
          severity: 'error' | 'warning' | 'info' | 'hint';
          startLineNumber: number;
          startColumn: number;
          message: string;
        }>;
      }) => void;
    }) => {
      React.useEffect(() => {
        props.onDiagnosticsChange?.(createSummary(props.modelPath));
      }, [props.modelPath, props.onDiagnosticsChange]);

      return React.createElement(
        'div',
        {
          'data-testid': 'monaco-text-editor',
          'data-model-path': props.modelPath,
        },
        props.value.slice(0, 80)
      );
    },
  };
});

import { CodingWorkbench } from './CodingWorkbench';
import { ProjectDiagnosticsPanel } from './ProjectDiagnosticsPanel';
import { normalizeSettings, useAgentStore } from '../store/agentStore';
import type { ProjectDiagnosticLocation } from '../utils/projectDiagnosticLocations';
import type {
  ProjectDiagnosticsCommandResult,
  ProjectDiagnosticsListEntry,
} from '../utils/projectDiagnostics';

const externalWorkspacePath = process.env.CODEPAPR_EXTERNAL_WORKSPACE?.trim() ?? '';
const itIfExternalWorkspace = externalWorkspacePath ? it : it.skip;
const PROJECT_PASSED_TEXT = '通过';
const LOCAL_HINT_TEXT = '以下仅为本地编辑器标记，可能与真实项目诊断不一致。';

function createEmptyProjectSnapshot() {
  return {
    version: 1,
    sessions: [],
    activeSessionId: null,
    sessionMessages: {},
    cumulativeStats: {
      totalCacheRead: 0,
      totalCacheCreation: 0,
      totalInput: 0,
      totalOutput: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      rounds: 0,
    },
    sessionCumulativeStats: {},
    projectDiagnosticsReport: null,

    updatedAt: Date.now(),
  };
}

function buildDesktopSmokeEntries(): ProjectDiagnosticsListEntry[] {
  return [
    'package.json',
    'vite.config.ts',
    'src',
    'src/App.tsx',
    'src/main.tsx',
  ].map((relativePath) => {
      const isDir = relativePath === 'src';
      const bytes = isDir ? 0 : 1;
      return {
        path: relativePath,
        name: path.basename(relativePath),
        isDir,
        bytes,
      } satisfies ProjectDiagnosticsListEntry;
    });
}

async function runWorkspaceCommand(params: {
  workspacePath: string;
  command: string;
  args: string[];
  timeoutSeconds?: number;
}): Promise<ProjectDiagnosticsCommandResult> {
  const command = process.platform === 'win32' && params.command === 'npm' ? 'npm.cmd' : params.command;

  return await new Promise<ProjectDiagnosticsCommandResult>((resolve, reject) => {
    const child = spawn(command, params.args, {
      cwd: params.workspacePath,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = (params.timeoutSeconds ?? 120) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({
        command: params.command,
        args: params.args,
        status,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === text
    ) ?? null
  );
}

function findTreeItem(container: HTMLElement, title: string): HTMLButtonElement | null {
  return container.querySelector(`button[title="${title.replace(/"/g, '\\"')}"]`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) {
    throw new Error('expected clickable element');
  }

  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function waitFor(check: () => boolean, message: string, timeoutMs: number = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timeout: ${message}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

function DesktopDiagnosticsSmokeHost() {
  const workspacePath = useAgentStore((state) => state.workspacePath);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<ProjectDiagnosticLocation | null>(null);

  return (
    <div>
      <ProjectDiagnosticsPanel
        workspacePath={workspacePath}
        lang="zh-CN"
        compact
        onSelectDiagnosticLocation={(location) => {
          setSelectedPath(location.path);
          setSelectedLocation(location);
        }}
      />
      <CodingWorkbench
        selectedPath={selectedPath}
        selectedGitFile={null}
        selectedLocation={selectedLocation}
        onSelectPath={(nextPath) => {
          setSelectedPath(nextPath);
          setSelectedLocation(null);
        }}
      />
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  loadProjectStateMock.mockResolvedValue(createEmptyProjectSnapshot());
  saveProjectStateMock.mockResolvedValue(undefined);
  openMock.mockResolvedValue(externalWorkspacePath);
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'list_workspace_files') {
      return {
        root: '',
        entries: buildDesktopSmokeEntries(),
        truncated: false,
      };
    }

    if (command === 'read_text_file') {
      const relativePath = String(args?.relativePath ?? '');
      return {
        path: relativePath,
        content: await fsp.readFile(path.join(externalWorkspacePath, relativePath), 'utf8'),
        bytes: 0,
      };
    }

    if (command === 'run_workspace_command') {
      return await runWorkspaceCommand({
        workspacePath: externalWorkspacePath,
        command: String(args?.command ?? ''),
        args: Array.isArray(args?.args) ? args.args.map((value) => String(value)) : [],
        timeoutSeconds:
          typeof args?.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
      });
    }

    throw new Error(`Unexpected invoke call: ${command}`);
  });

  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });

  useAgentStore.setState((state) => ({
    ...state,
    settings: normalizeSettings({
      apiKey: 'sk-test',
      fastModelEnabled: false,
      lang: 'zh-CN',
    }),
    workspacePath: '',
    sessions: [],
    activeSessionId: null,
    messages: [],
    sessionMessages: {},
    cumulativeStats: {
      totalCacheRead: 0,
      totalCacheCreation: 0,
      totalInput: 0,
      totalOutput: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      rounds: 0,
    },
    sessionCumulativeStats: {},
    projectDiagnosticsReport: null,

    isLoading: false,
    showSettings: false,
    settingsLoaded: true,
    _agent: null,
    _agentModel: null,
  }));

  container = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  invokeMock.mockReset();
  openMock.mockReset();
  loadProjectStateMock.mockReset();
  saveProjectStateMock.mockReset();
});

describe('desktop diagnostics smoke', () => {
  itIfExternalWorkspace(
    'selects an external workspace, runs project diagnostics, opens representative files, and downgrades local markers under clean project diagnostics',
    async () => {
      if (!container || !root) {
        throw new Error('test host not initialized');
      }

      await act(async () => {
        root!.render(<DesktopDiagnosticsSmokeHost />);
      });

      await click(findButtonByText(container, '选择文件夹'));

      await waitFor(
        () => container!.textContent?.includes('项目已加载') === true,
        'workspace should be loaded into the workbench'
      );

      await click(findButtonByText(container, '重新诊断'));

      await waitFor(
        () => container!.textContent?.includes(PROJECT_PASSED_TEXT) === true,
        'project diagnostics should report passed'
      );
      await waitFor(
        () => invokeMock.mock.calls.some((call) => call[0] === 'run_workspace_command'),
        'project diagnostics should invoke workspace commands'
      );

      await click(findTreeItem(container, 'vite.config.ts'));

      await waitFor(
        () => container!.textContent?.includes('vite.config.ts') === true,
        'vite.config.ts should be selected in the workbench'
      );
      expect(container.textContent).not.toContain(LOCAL_HINT_TEXT);
      expect(container.textContent).not.toContain(
        "Cannot find module 'vite' or its corresponding type declarations."
      );
      expect(
        invokeMock.mock.calls.some(
          (call) =>
            call[0] === 'read_text_file' &&
            typeof call[1]?.relativePath === 'string' &&
            call[1].relativePath === 'vite.config.ts'
        )
      ).toBe(true);

      await click(findTreeItem(container, 'src'));
      await waitFor(
        () => findTreeItem(container!, 'src/App.tsx') !== null,
        'src/App.tsx should become visible after expanding src'
      );
      await click(findTreeItem(container, 'src/App.tsx'));

      await waitFor(
        () => container!.textContent?.includes('src/App.tsx') === true,
        'src/App.tsx should be selected in the workbench'
      );
      await waitFor(
        () => container!.textContent?.includes(LOCAL_HINT_TEXT) !== true,
        'local diagnostics downgrade hint should clear for representative files without Monaco markers'
      );
      expect(
        container.textContent?.includes(
          "Cannot find module '@vitejs/plugin-react' or its corresponding type declarations."
        )
      ).toBe(false);
    },
    180_000
  );
});
