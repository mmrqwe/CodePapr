import { test, expect } from './fixtures';

test.describe('App boot smoke', () => {
  test('renders the root layout without throwing', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');

    // The chat panel input is rendered eventually after the store finishes loading.
    await expect(page.locator('#root')).toBeAttached();
    await expect(page.locator('#root')).not.toBeEmpty();

    // Settings or session manager column should be visible.
    await page.waitForLoadState('domcontentloaded');

    // We accept warnings, but no uncaught exceptions during boot.
    const blocking = errors.filter(
      (m) =>
        !m.includes('ResizeObserver') &&
        !m.includes('AbortError') &&
        !m.toLowerCase().includes('not implemented')
    );
    expect(blocking, blocking.join('\n')).toEqual([]);
  });

  test('exposes the Tauri-mock E2E hook', async ({ page }) => {
    await page.goto('/');
    const handlers = await page.evaluate(() => {
      // @ts-expect-error injected by tauriMock
      return window.__CODEPAPR_E2E__?.listHandlers?.() ?? null;
    });
    expect(handlers).not.toBeNull();
    expect(Array.isArray(handlers)).toBe(true);
  });
});
