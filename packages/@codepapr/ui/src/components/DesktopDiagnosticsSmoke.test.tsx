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

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openMock,
}));

// 用 importOriginal 展开真实模块：生产代码演进新增的导出（loadSessions、
// aggregateSessionRuntimeInDb 等）必须存在，否则 openWorkspace 直接抛
// "No export defined" 并走旧格式回退，掩盖真实路径的问题。
vi.mock('../utils/projectStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/projectStorage')>();
  return {
    ...actual,
    loadProjectState: loadProjectStateMock,
    saveProjectState: saveProjectStateMock,
  };
});

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

const configuredWorkspacePath = process.env.CODEPAPR_EXTERNAL_WORKSPACE?.trim() ?? '';
const targetWorkspacePath = configuredWorkspacePath || '/mock/fixture-workspace';
const PROJECT_PASSED_TEXT = '通过';

const defaultFixtureFiles: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'fixture-app',
    dependencies: { react: '^18.0.0' },
    devDependencies: { vite: '^5.0.0', '@vitejs/plugin-react': '^4.0.0' },
    scripts: { build: 'vite build', check: 'tsc' },
  }, null, 2),
  'vite.config.ts': 'export default {};',
  'src/App.tsx': 'export function App() { return <div>App</div>; }',
  'src/main.tsx': 'import { App } from "./App";',
};

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
  if (!configuredWorkspacePath) {
    return {
      command: params.command,
      args: params.args,
      status: 0,
      stdout: 'diagnostics passed',
      stderr: '',
      timedOut: false,
    };
  }
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
  openMock.mockResolvedValue(targetWorkspacePath);
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
      const content = configuredWorkspacePath
        ? await fsp.readFile(path.join(configuredWorkspacePath, relativePath), 'utf8')
        : (defaultFixtureFiles[relativePath] ?? '');
      return {
        path: relativePath,
        content,
        bytes: 0,
      };
    }

    if (command === 'run_workspace_command') {
      return await runWorkspaceCommand({
        workspacePath: targetWorkspacePath,
        command: String(args?.command ?? ''),
        args: Array.isArray(args?.args) ? args.args.map((value) => String(value)) : [],
        timeoutSeconds:
          typeof args?.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
      });
    }

    // 工作区打开/持久化路径的良性后端命令：空仓库语义（无会话、无缓存、无 watcher）。
    if (command === 'load_sessions') {
      return { sessionsJson: '[]' };
    }
    if (command === 'load_all_project_meta') {
      return { metaJson: '{}' };
    }
    if (command === 'load_session_messages') {
      return { messagesJson: '[]' };
    }
    if (command === 'load_all_session_messages') {
      return { messagesBySessionJson: '{}' };
    }
    if (command === 'aggregate_session_runtime') {
      return { runtimeJson: '{}' };
    }
    if (command === 'load_projectgraph_cache') {
      return null;
    }
    if (command === 'cache_get') {
      return null;
    }
    if (
      command === 'start_workspace_watcher' ||
      command === 'stop_workspace_watcher' ||
      command === 'grant_workspace_asset_scope' ||
      command === 'save_session' ||
      command === 'save_message_batch' ||
      command === 'save_project_meta' ||
      command === 'save_project_state' ||
      command === 'delete_session' ||
      command === 'cache_set' ||
      command === 'cache_remove'
    ) {
      return undefined;
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
  it(
    'selects an external workspace, runs project diagnostics, opens representative files, and keeps local markers from leaking under clean project diagnostics',
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
        () => findTreeItem(container!, 'vite.config.ts')?.getAttribute('aria-selected') === 'true',
        'vite.config.ts should be selected in the workbench'
      );
      expect(container.textContent).not.toContain(
        "Cannot find module 'vite' or its corresponding type declarations."
      );
      await waitFor(
        () =>
          invokeMock.mock.calls.some(
            (call) =>
              call[0] === 'read_text_file' &&
              typeof call[1]?.relativePath === 'string' &&
              call[1].relativePath === 'vite.config.ts'
          ),
        'vite.config.ts should be read via read_text_file'
      );

      await click(findTreeItem(container, 'src'));
      await waitFor(
        () => findTreeItem(container!, 'src/App.tsx') !== null,
        'src/App.tsx should become visible after expanding src'
      );
      await click(findTreeItem(container, 'src/App.tsx'));

      await waitFor(
        () => findTreeItem(container!, 'src/App.tsx')?.getAttribute('aria-selected') === 'true',
        'src/App.tsx should be selected in the workbench'
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
