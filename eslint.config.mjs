// [DevOps + Security Engineer] ESLint flat config for the whole monorepo (go-live). Run: npm run lint
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/next-env.d.ts', '**/coverage/**', 'apps/web/tsconfig.tsbuildinfo', 'infra/**', 'site/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      // security-relevant: never let these in
      'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error',
      'no-restricted-syntax': ['error', { selector: "CallExpression[callee.property.name='setItem'][callee.object.name=/^(localStorage|sessionStorage)$/]", message: 'No tokens or personal data in web storage (D-32).' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // pragmatic for a NestJS + zod codebase (request objects, pg rows, provider payloads)
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  { files: ['**/*.mjs', '**/*.cjs'], languageOptions: { globals: { ...globals.node } } },
  // Playwright scripts: page.evaluate() callbacks run in the browser
  { files: ['scripts/*shots*.mjs', 'scripts/ui-smoke.mjs', 'scripts/*browser*.mjs', 'scripts/keycloak-*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['**/test/**', '**/*.test.ts'], rules: { '@typescript-eslint/no-non-null-assertion': 'off' } },
);
