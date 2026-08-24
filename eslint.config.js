import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import orderbookI18n from './tools/eslint-rules/index.js';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `varsIgnorePattern` covers destructuring-to-omit — `const { rate: _rate,
      // ...rest } = record` is how a key is dropped from an object, and the
      // binding it creates is unused by design.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The tools/ scripts run under plain Node, not the browser/ES globals
    // `js.configs.recommended` assumes — without this, `console` and
    // `process` read as undefined names to the linter.
    files: ['tools/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Scoped to the web packages' JSX, where the rule is meaningful. Severity
    // is `'off'`: `lint` is the first step of `npm run verify`, and ~4,000
    // lines of existing JSX are unswept. Promoted to `'error'` screen by
    // screen in the UI phase (`docs/backend-modules/05-EXISTING-CODE-CHANGES.md`
    // §8.1) — this registration proves the plugin wiring now, without
    // failing the batch for work that belongs to a later phase.
    files: ['{master,office}/web/src/**/*.tsx'],
    plugins: { 'orderbook-i18n': orderbookI18n },
    rules: {
      'orderbook-i18n/no-untranslated-jsx-text': 'off',
    },
  },
);
