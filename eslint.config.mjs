import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import htmlPlugin from '@html-eslint/eslint-plugin';
import htmlParser from '@html-eslint/parser';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/target/**', '**/e2e/**', '*.config.js', '*.config.ts', '.opencode/**'] },
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
