export async function yieldToMainThread(maxFrameWaitMs?: number): Promise<void> {
  await new Promise<void>((resolve) => {
    if (
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function' ||
      (maxFrameWaitMs !== undefined && globalThis.document?.visibilityState === 'hidden')
    ) {
      globalThis.setTimeout(resolve, 0);
      return;
    }

    if (maxFrameWaitMs === undefined) {
      window.requestAnimationFrame(() => resolve());
      return;
    }

    // Minimized or occluded WebViews may suspend frames without updating visibility.
    // A paint opportunity is useful, but it must never gate the next operation.
    const fallback = globalThis.setTimeout(() => {
      window.cancelAnimationFrame(frame);
      resolve();
    }, maxFrameWaitMs);
    const frame = window.requestAnimationFrame(() => {
      clearTimeout(fallback);
      resolve();
    });
  });
}
