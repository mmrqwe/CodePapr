// @vitest-environment jsdom

import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback } from '@tauri-apps/api/event';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TtsInstaller } from './TtsInstaller';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

it('keeps installation running until model downloads and verification finish', async () => {
  let onProgress: EventCallback<unknown> | undefined;
  vi.mocked(listen).mockImplementation(async (_event, callback) => {
    onProgress = callback;
    return () => {};
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const container = document.createElement('div');
  const root = createRoot(container);

  async function progress(stepId: string, status: string) {
    await act(() => onProgress?.({
      event: 'tts-install-progress',
      id: 0,
      payload: { step_id: stepId, label: stepId, status, log_line: '', percent: null },
    }));
  }

  try {
    await act(() => root.render(<TtsInstaller onClose={() => {}} />));
    const install = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Install GPT-SoVITS',
    );
    expect(install).toBeDefined();
    await act(async () => install?.click());
    expect(invoke).toHaveBeenCalledWith('tts_install', { source: 'hf-mirror' });

    await progress('check-python', 'ok');
    await progress('download-models', 'running');
    expect(container.textContent).toContain('Cancel');

    await progress('download-models', 'ok');
    expect(container.textContent).toContain('Cancel');

    await progress('verify', 'ok');
    expect(container.textContent).toContain('Install GPT-SoVITS');
    expect(container.textContent).not.toContain('Cancel');
  } finally {
    await act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
