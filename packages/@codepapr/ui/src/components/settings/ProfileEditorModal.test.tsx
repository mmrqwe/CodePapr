// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ModelProfile } from '../../store/internals/types';
import { getTranslation } from '../../utils/i18n';
import { ProfileEditorModal } from './ProfileEditorModal';

it('validates, tests and saves custom request body fields in the model editor', async () => {
  const profile: ModelProfile = {
    id: 'primary',
    name: 'Relay',
    apiMode: 'custom',
    apiFormat: 'openai',
    baseURL: 'https://relay.example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-5.6-luna',
    maxTokens: 4096,
  };
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    id: 'chat',
    choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  }));
  vi.stubGlobal('fetch', fetchMock);
  const onSave = vi.fn();
  const t = getTranslation('en');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<ProfileEditorModal
        profile={profile}
        isOpen
        onSave={onSave}
        onClose={() => {}}
        t={t}
        currentLang="en"
      />);
    });

    const textarea = container.querySelector('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)!;
    const enterJson = (text: string) => act(() => {
      setValue.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await enterJson('{"stream": false}');
    expect(button(t.saveProfile).disabled).toBe(true);
    expect(textarea.getAttribute('aria-invalid')).toBe('true');

    const overrides = { max_tokens: null, max_completion_tokens: 2048 };
    await enterJson(JSON.stringify(overrides));
    expect(button(t.saveProfile).disabled).toBe(false);
    await act(async () => button(t.testProfileConnection).click());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
    await act(async () => button(t.saveProfile).click());
    expect(onSave).toHaveBeenCalledWith({ ...profile, requestBodyOverrides: overrides });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
