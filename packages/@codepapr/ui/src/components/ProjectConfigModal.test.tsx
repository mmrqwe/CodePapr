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

vi.mock('./MonacoTextEditor', () => ({
  MonacoTextEditor: (props: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel?: string;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label={props.ariaLabel}
      readOnly={props.readOnly}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

import { ProjectConfigModal } from './ProjectConfigModal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ProjectConfigModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let projectStateJson: string;

  beforeEach(() => {
    projectStateJson = JSON.stringify({
      version: 1,
      sessions: [],
      activeSessionId: null,
      sessionMessages: {},
      skillEnabledById: {},
      cumulativeStats: {
        totalCacheRead: 0,
        totalCacheCreation: 0,
        totalInput: 0,
        totalOutput: 0,
        rounds: 0,
      },
      sessionCumulativeStats: {},
      projectDiagnosticsReport: null,
      updatedAt: Date.now(),
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_text_file') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === '.CodePapr/AGENTS.md') {
          return { path: relativePath, content: '# 项目规则', bytes: 5 };
        }
        if (relativePath === '.CodePapr/skills/search/SKILL.md') {
          return {
            path: relativePath,
            content: '---\ndescription: 搜索资料\n---\n优先查官方文档。',
            bytes: 32,
          };
        }
        throw new Error(`not found: ${relativePath}`);
      }
      if (command === 'list_workspace_files') {
        const relativePath = String(args?.relativePath ?? '');
        if (relativePath === '.CodePapr/skills') {
          return {
            root: relativePath,
            entries: [
              { path: '.CodePapr/skills/search', name: 'search', kind: 'dir', isDir: true },
              { path: '.CodePapr/skills/search/SKILL.md', name: 'SKILL.md', kind: 'file' },
            ],
            truncated: false,
          };
        }
        return { root: relativePath, entries: [], truncated: false };
      }
      if (command === 'load_project_state') {
        return {
          stateJson: projectStateJson,
          dbPath: '/tmp/codepapr-workspace/.CodePapr/project.sqlite',
        };
      }
      if (command === 'save_project_state') {
        projectStateJson = String(args?.stateJson ?? projectStateJson);
        return {
          stateJson: projectStateJson,
          dbPath: '/tmp/codepapr-workspace/.CodePapr/project.sqlite',
        };
      }
      if (
        command === 'write_text_file' ||
        command === 'delete_workspace_file' ||
        command === 'delete_workspace_dir'
      ) {
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
  });

  it('loads and saves project skills from the config modal', async () => {
    await act(async () => {
      root.render(
        <ProjectConfigModal
          workspacePath="/tmp/codepapr-workspace"
          lang="zh-CN"
          onClose={() => undefined}
        />
      );
    });
    await flushEffects();
    await flushEffects();

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Skills')
        ?.click();
    });
    await flushEffects();

    expect(container.textContent).toContain('search');
    expect(container.textContent).toContain('Skill 怎么工作');

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '保存 Skill')
        ?.click();
    });

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === 'write_text_file' &&
          args?.relativePath === '.CodePapr/skills/search/SKILL.md' &&
          String(args?.content) === '---\ndescription: 搜索资料\n---\n优先查官方文档。' &&
          !String(args?.content).includes('enabled:')
      )
    ).toBe(true);
  });

  it('toggles skill enablement from the config modal', async () => {
    await act(async () => {
      root.render(
        <ProjectConfigModal
          workspacePath="/tmp/codepapr-workspace"
          lang="zh-CN"
          onClose={() => undefined}
        />
      );
    });
    await flushEffects();
    await flushEffects();

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Skills')
        ?.click();
    });
    await flushEffects();

    const checkbox = container.querySelector('input[aria-label="启用: search"]') as HTMLInputElement | null;
    expect(checkbox?.checked).toBe(true);

    await act(async () => {
      checkbox?.click();
    });
    await flushEffects();

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === 'save_project_state' &&
          String(args?.stateJson).includes('"skillEnabledById"') &&
          String(args?.stateJson).includes('"search": false')
      )
    ).toBe(true);
  });

  it('deletes packaged skills by removing the whole folder', async () => {
    await act(async () => {
      root.render(
        <ProjectConfigModal
          workspacePath="/tmp/codepapr-workspace"
          lang="zh-CN"
          onClose={() => undefined}
        />
      );
    });
    await flushEffects();
    await flushEffects();

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Skills')
        ?.click();
    });
    await flushEffects();

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '删除')
        ?.click();
    });

    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === 'delete_workspace_dir' &&
          args?.relativePath === '.CodePapr/skills/search'
      )
    ).toBe(true);
  });
});
