import { test, expect } from './fixtures';

/**
 * Toast UI invariants: the container appears only after a toast is queued,
 * stacks horizontally on the bottom-right, and dismiss button removes it.
 */
test.describe('Toast notifications', () => {
  test('container renders only when toasts exist', async ({ page }) => {
    await page.goto('/');

    // Initially no toast container in DOM.
    await expect(page.locator('[data-toast-container]')).toHaveCount(0);

    // Trigger a toast via the test hook on the toast store. The store is
    // not exposed on window by default, so we drive it through a helper
    // that imports it into the page context. We bridge by dispatching a
    // synthetic event the app does not normally use, but we need direct
    // store access. Use the shipped test hook: the toast store exposes
    // `useToastStore` via globalThis when running E2E builds. To avoid
    // shipping that hook in production, we use a back door: open the
    // chat panel and trigger an oversized text-file paste, which already
    // produces a toast.
    //
    // Simpler path: run code in page context that imports the store via
    // a Vite module URL (only the dev server is in use during E2E).
    await page.evaluate(async () => {
      const mod = await import('/src/store/toastStore.ts');
      mod.toast.info('e2e hello');
    });

    const container = page.locator('[data-toast-container]');
    await expect(container).toHaveCount(1);
    await expect(container).toContainText('e2e hello');
  });

  test('dismiss button removes a toast', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(async () => {
      const mod = await import('/src/store/toastStore.ts');
      mod.toast.warning('about to dismiss', { durationMs: 0 });
    });

    const card = page
      .locator('[data-toast-container] [role="status"], [data-toast-container] [role="alert"]')
      .first();
    await expect(card).toBeVisible();
    await card.getByRole('button').click();
    await expect(card).toHaveCount(0);
  });

  test('error variant uses alert role', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(async () => {
      const mod = await import('/src/store/toastStore.ts');
      mod.toast.error('boom', { durationMs: 0 });
    });

    await expect(page.locator('[data-toast-container] [role="alert"]')).toHaveCount(1);
  });
});
