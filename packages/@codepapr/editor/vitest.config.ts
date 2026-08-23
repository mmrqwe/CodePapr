import { defineConfig } from 'vitest/config';
import { sharedCoverageConfig, sharedTestExclude } from '../../../vitest.shared';

export default defineConfig({
  test: {
    exclude: [...sharedTestExclude],
    coverage: sharedCoverageConfig,
  },
});
