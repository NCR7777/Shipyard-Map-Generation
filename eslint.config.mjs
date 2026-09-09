import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['node_modules/**', 'dist/**', 'playwright-report/**', 'test-results/**', 'src/domain/model.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } } },
  { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } }
];
