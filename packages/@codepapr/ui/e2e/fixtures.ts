/**
 * Playwright test fixture: wraps the standard test with Tauri-mock init
 * and a few handy shortcuts for common operations.
 */
import { test as base } from '@playwright/test';
import { tauriMockInitScript } from './tauriMock';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(tauriMockInitScript);
    await use(page);
  },
});

export { expect } from '@playwright/test';