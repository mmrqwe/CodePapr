/**
 * Playwright test fixture: wraps the standard test with Tauri-mock init
 * and a few handy shortcuts for common operations.
 */
import { test as base, type Page } from '@playwright/test';
import { tauriMockInitScript } from './tauriMock';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(tauriMockInitScript);
    await use(page);
  },
});

export { expect } from '@playwright/test';

export async function configureVoiceTest(page: Page, playbackMode?: string) {
  const settings = {
    lang: 'en', experimentalCharacters: true, experimentalVoice: true,
    apiMode: 'local', model: 'speech-qa', followSystem: false, themeMode: 'light',
  };
  const character = {
    id: 'voice-qa', name: 'Voice test',
    voice: playbackMode ? {
      engine: 'gpt-sovits', enabled: true, referenceSamplePath: 'reference.wav',
      referenceText: '参考语音。', playbackMode, sampleSteps: 16, sentencesPerChunk: 3,
    } : undefined,
  };
  await page.addInitScript(`${tauriMockInitScript}
    (() => {
      const mock = window.__CODEPAPR_E2E__;
      const settings = ${JSON.stringify(settings)};
      const character = ${JSON.stringify(character)};
      mock.setHandler('load_app_settings', () => ({ settingsJson: JSON.stringify(settings) }));
      mock.setHandler('load_app_characters', () => ({
        charactersJson: JSON.stringify({ characters: [character] }),
      }));
      mock.setHandler('tts_server_status', () => true);
      mock.setHandler('tts_check_installed', () => ({ installed: true }));
    })();
  `);
}
