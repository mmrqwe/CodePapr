import { describe, it, expect, beforeEach, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { useBrowserViewStore, applyBrowserEngine } from './browserViewStore';

function resetStore(): void {
  useBrowserViewStore.setState({
    pageSession: null,
    panelOpen: false,
    engine: 'embedded',
  });
}

describe('browserViewStore', () => {
  beforeEach(() => {
    resetStore();
    invokeMock.mockClear();
  });

  it('sets and clears the browser page session', () => {
    const session = {
      url: 'https://example.com',
      title: 'Example',
      workspacePath: '/ws',
      startedAt: 123,
    };
    useBrowserViewStore.getState().setPageSession(session);
    expect(useBrowserViewStore.getState().pageSession).toEqual(session);

    useBrowserViewStore.getState().setPageSession(null);
    expect(useBrowserViewStore.getState().pageSession).toBeNull();
  });

  it('opens and closes the panel', () => {
    useBrowserViewStore.getState().openPanel();
    expect(useBrowserViewStore.getState().panelOpen).toBe(true);
    useBrowserViewStore.getState().closePanel();
    expect(useBrowserViewStore.getState().panelOpen).toBe(false);
  });

  it('closes the panel when switching to the headless engine', () => {
    useBrowserViewStore.getState().openPanel();
    useBrowserViewStore.getState().setEngine('headless');
    expect(useBrowserViewStore.getState().engine).toBe('headless');
    expect(useBrowserViewStore.getState().panelOpen).toBe(false);
  });

  it('keeps the panel open when switching to the embedded engine', () => {
    useBrowserViewStore.getState().openPanel();
    useBrowserViewStore.getState().setEngine('embedded');
    expect(useBrowserViewStore.getState().engine).toBe('embedded');
    expect(useBrowserViewStore.getState().panelOpen).toBe(true);
  });

  it('applyBrowserEngine syncs the engine to the backend and store', async () => {
    await applyBrowserEngine('headless');
    expect(useBrowserViewStore.getState().engine).toBe('headless');
    expect(invokeMock).toHaveBeenCalledWith('set_browser_engine', { engine: 'headless' });
  });

  it('applyBrowserEngine swallows backend errors', async () => {
    invokeMock.mockRejectedValueOnce(new Error('backend not ready'));
    await expect(applyBrowserEngine('embedded')).resolves.toBeUndefined();
    expect(useBrowserViewStore.getState().engine).toBe('embedded');
  });
});
