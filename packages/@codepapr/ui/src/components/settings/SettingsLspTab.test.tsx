// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTranslation } from '../../utils/i18n';
import { normalizeSettings, useAgentStore } from '../../store/agentStore';
import { SettingsLspTab } from './SettingsLspTab';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('SettingsLspTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'lsp_list_components') {
        return {
          families: [
            {
              familyId: 'typescript',
              label: 'TypeScript / JavaScript',
              languageIds: ['typescript', 'javascript'],
              available: true,
              origin: 'bundled',
              toolLabel: 'typescript-language-server',
              path: '/app/lsp-tools/node-packages',
              sizeBytes: 0,
              usesRuntime: 'node-packages',
              running: false,
              enabled: true,
            },
            {
              familyId: 'rust',
              label: 'Rust',
              languageIds: ['rust'],
              available: true,
              origin: 'bundled',
              toolLabel: 'rust-analyzer',
              path: '/app/lsp-tools/rust-analyzer',
              sizeBytes: 12_000_000,
              usesRuntime: null,
              running: false,
              enabled: true,
            },
          ],
          runtimes: [
            {
              id: 'node-runtime',
              label: 'Node.js runtime',
              usedBy: ['typescript'],
              origin: 'bundled',
              path: '/app/lsp-tools/node-runtime',
              sizeBytes: 160_000_000,
              available: true,
            },
          ],
        };
      }
      return null;
    });

    useAgentStore.setState((state) => ({
      ...state,
      workspacePath: '/tmp/proj',
      settings: normalizeSettings({ lang: 'zh-CN' }),
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

  it('lists bundled families without starting servers and can disable one', async () => {
    const updates: Array<{ lspDisabledFamilies?: string[] }> = [];
    const local = normalizeSettings({ lang: 'zh-CN' });
    const t = getTranslation('zh-CN');

    await act(async () => {
      root.render(
        <SettingsLspTab
          local={local}
          update={(partial) => {
            updates.push(partial);
          }}
          t={t}
          currentLang="zh-CN"
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith('lsp_list_components');
    expect(invokeMock.mock.calls.some((call) => call[0] === 'lsp_start_server')).toBe(false);
    expect(container.textContent).toContain('TypeScript / JavaScript');
    expect(container.textContent).toContain('Rust');
    expect(container.textContent).toContain('安装包');

    const rustToggle = Array.from(container.querySelectorAll('input[type="checkbox"]')).at(1) as HTMLInputElement;
    expect(rustToggle).toBeTruthy();
    expect(rustToggle.checked).toBe(true);

    await act(async () => {
      rustToggle.click();
    });

    expect(updates.some((update) => update.lspDisabledFamilies?.includes('rust'))).toBe(true);
  });
});
