import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/web/public/**',
      'workers/**',
      // Outside the pnpm workspace with its own React Native toolchain and
      // lint rules; linting it from here only produces false positives.
      'apps/mobile/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Domain code leans on explicit undefined checks; `??` and `?.` cover the
      // cases where a default is genuinely wanted.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Plain Node scripts: they run outside the TypeScript build, and writing to
    // stdout is the whole point of them.
    files: ['scripts/**/*.mjs', 'apps/*/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
);
