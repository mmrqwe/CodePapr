import type { UserConfig } from 'vitest/config';

/**
 * Shared vitest test-discovery exclude list.
 *
 * Vitest 4 的默认 exclude 只剩 node_modules/.git——不再排除 dist/。
 * tsc 构建会把源码里的测试文件编译进 dist（如 editor 的 index.test.js、
 * core 的 Agent 系列测试），不排除的话同一份测试会被跑两遍。
 * 各包的 vitest.config.ts 应把本数组并入 `test.exclude`。
 */
export const sharedTestExclude: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/.{idea,git,cache,output,temp}/**',
];

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
