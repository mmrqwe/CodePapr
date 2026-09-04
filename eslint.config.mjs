import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import htmlPlugin from '@html-eslint/eslint-plugin';
import htmlParser from '@html-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/target/**', '**/e2e/**', '*.config.js', '*.config.ts', '.opencode/**', '.cargo-vendor/**', '**/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    // D-4：React Hooks 规则。rules-of-hooks 违例（early return 后藏 hook）是
    // 真实崩溃面；exhaustive-deps 存量欠账多，先 warn 逐步还。
    files: ['packages/@codepapr/ui/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['packages/@codepapr/common/src/index.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.html'],
    plugins: {
      '@html-eslint': htmlPlugin,
    },
    languageOptions: {
      parser: htmlParser,
    },
    rules: {
      '@html-eslint/no-duplicate-attrs': 'error',
      '@html-eslint/require-doctype': 'error',
      '@html-eslint/require-lang': 'error',
    },
  },
);
