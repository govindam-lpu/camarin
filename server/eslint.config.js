// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', 'data', 'public'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off', // used deliberately after auth/env guards
      'no-console': 'warn',
    },
  },
  {
    // CLI scripts talk to humans via stdout — that's their job.
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
