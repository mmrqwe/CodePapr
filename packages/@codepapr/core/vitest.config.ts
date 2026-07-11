import { defineConfig } from 'vitest/config';
import { sharedCoverageConfig } from '../../../vitest.shared';

export default defineConfig({
  test: {
    coverage: sharedCoverageConfig,
  },
});
