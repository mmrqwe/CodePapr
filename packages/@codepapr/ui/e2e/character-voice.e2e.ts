import { test, expect, configureVoiceTest } from './fixtures';

test('character voice controls report upload progress and the actual GPU, and follow the theme', async ({ page }) => {
  await configureVoiceTest(page);
  await page.goto('/');
  await page.evaluate(() => {
    // @ts-expect-error injected by tauriMock
    const mock = window.__CODEPAPR_E2E__;
    mock.setHandler('tts_save_voice_file', () => {
      throw new Error('Cannot decode MP3');
    });
  });
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  const input = page.locator('input[type=file][accept*=".mp3"]');
  const mp3 = { name: 'voice.MP3', mimeType: 'audio/mpeg', buffer: Buffer.from('mock MP3') };
  await input.setInputFiles(mp3);
  await expect(page.getByRole('alert')).toContainText('Cannot decode MP3');

  await page.evaluate(() => {
    // @ts-expect-error injected by tauriMock
    const mock = window.__CODEPAPR_E2E__;
    mock.setHandler('tts_save_voice_file', ({ extension }: { extension: string }) => {
      if (extension !== 'MP3') throw new Error('Unexpected file extension');
      return new Promise<string>((resolve) => {
        mock.setHandler('finish_upload', () => resolve('char_test_ref.wav'));
      });
    });
    mock.setHandler('tts_read_voice_file', () => 'data:audio/wav;base64,UklGRg==');
  });
  await input.setInputFiles(mp3);
  await expect(page.getByRole('button', { name: 'Processing audio…' })).toBeDisabled();
  await page.waitForFunction(() => {
    // @ts-expect-error injected by tauriMock
    return window.__CODEPAPR_E2E__.listHandlers().includes('finish_upload');
  });
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('finish_upload'));
  await expect(page.getByText('Reference audio loaded')).toBeVisible();
  await expect(page.locator('audio')).toHaveAttribute('src', /^data:audio\/wav/);
  await expect(page.getByRole('alert')).toHaveCount(0);

  for (const backend of ['CUDA', 'MPS']) {
    await page.evaluate((backend) => {
      // @ts-expect-error injected by tauriMock
      const mock = window.__CODEPAPR_E2E__;
      mock.setHandler('tts_server_status', () => true);
      mock.setHandler('tts_warmup_gpu', () => backend);
    }, backend);
    await page.getByRole('button', { name: 'Warm Up GPU' }).click();
    await expect(page.getByText(`GPU warm-up complete (${backend}).`, { exact: true })).toBeVisible();
  }

  const languageControls = page.locator('#voice-training-language, #voice-reference-language, #voice-speaking-language');
  await expect(languageControls).toHaveCount(3);
  const readColors = () => languageControls.evaluateAll((selects) => selects.map((select) => {
    const css = getComputedStyle(select);
    return [css.backgroundColor, css.color];
  }));
  const lightColors = await readColors();
  expect(lightColors.every((colors) => colors.join() === lightColors[0].join())).toBe(true);
  await page.evaluate(async () => {
    const themeModule = '/src/store/themeStore.ts';
    const { useThemeStore } = await import(themeModule);
    useThemeStore.getState().applyFromSettings({
      followSystem: false, themeMode: 'dark', lightTheme: 'paper-light', darkTheme: 'paper-dark',
      customThemes: {}, accent: null,
    });
  });
  const darkColors = await readColors();
  expect(darkColors.every((colors, index) => colors[0] !== lightColors[index][0] && colors[1] !== lightColors[index][1])).toBe(true);
});
