import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
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
    /*
     * The rules of hooks, enforced rather than assumed.
     *
     * Added after a `rules-of-hooks` violation shipped and made **both panels
     * unusable**: `App()` in each declared four hooks *below* its
     * signed-out early return, so the render after signing in produced more
     * hooks than the one before it, React threw, and the error boundary
     * replaced the whole panel with "Something went wrong on this screen".
     * Nothing caught it — this plugin was never installed, and the type
     * checker and the 1143-test suite cannot see it. A browser found it in
     * seconds.
     *
     * `rules-of-hooks` is an error, because every violation of it is a real
     * crash. `exhaustive-deps` stays a warning: this codebase deliberately
     * holds rebuilt-every-render callbacks in refs, and that pattern reads as
     * a missing dependency to the rule.
     */
    files: ['{master,office}/web/src/**/*.{ts,tsx}', 'ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Scoped to the web packages' JSX, where the rule is meaningful. Severity
    // is `'off'`: `lint` is the first step of `npm run verify`, and ~4,000
    // lines of existing JSX are unswept. Promoted to `'error'` screen by
    // screen in the UI phase (`docs/backend-modules/05-EXISTING-CODE-CHANGES.md`
    // §8.1) — this registration proves the plugin wiring now, without
    // failing the batch for work that belongs to a later phase.
    files: ['{master,office}/web/src/**/*.tsx', 'ui/src/**/*.tsx'],
    plugins: { 'orderbook-i18n': orderbookI18n },
    rules: {
      'orderbook-i18n/no-untranslated-jsx-text': 'off',
    },
  },
  {
    /*
     * The swept files, where the rule is `'error'`.
     *
     * The blanket `'off'` above is right for ~4,000 unswept lines and wrong for
     * a file somebody has just finished translating: without this block a
     * sweep lasts exactly until the next agent adds a `<span>Primary</span>`,
     * which is what happened to a since-removed screen — it gained eight
     * English literals, two of them duplicating tokens added twelve lines
     * away, in the same commit that added the tokens.
     *
     * A guardrail brief asked for a test that catches this. The rule that
     * catches it already existed and was switched off; turning it on for the
     * files it now passes on is the smaller change, and unlike a test it names
     * the offending line.
     *
     * Add a file here as you finish translating it. Never remove one.
     */
    files: [
      'ui/src/DocumentsScreen.tsx',
      'ui/src/ImageCropModal.tsx',
      'ui/src/PageDesigner.tsx',
      'ui/src/PageDesignerInspector.tsx',
      'office/web/src/components/ProductImages.tsx',
    ],
    plugins: { 'orderbook-i18n': orderbookI18n },
    rules: {
      'orderbook-i18n/no-untranslated-jsx-text': 'error',
    },
  },
);
