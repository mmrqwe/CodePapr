import type { UserConfig } from 'vitest/config';

/**
 * Shared vitest coverage configuration.
 *
 * Every workspace package's vitest.config.ts (or vite.config.ts for the UI
 * package) imports this object so that coverage thresholds and report format
 * stay consistent across the monorepo.
 *
 * Thresholds are intentionally conservative — they catch obvious regressions
 * (e.g. a new module with zero tests) without blocking incremental improvement.
 * Raise them over time as coverage improves.
 */
export const sharedCoverageConfig: NonNullable<NonNullable<UserConfig['test']>['coverage']> = {
  provider: 'v8',
  reporter: ['text', 'text-summary', 'lcov'],
  reportsDirectory: './coverage',
  include: ['src/**/*.ts', 'src/**/*.tsx'],
  exclude: [
    'src/**/*.test.ts',
    'src/**/*.test.tsx',
    'src/**/*.d.ts',
    'src/**/__test-utils__/**',
    'src/**/testing/**',
    'tests/**',
  ],
  thresholds: {
    lines: 40,
    functions: 40,
    branches: 30,
    statements: 40,
  },
};
