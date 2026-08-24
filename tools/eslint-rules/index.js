/**
 * Flat-config plugin entry point, so `eslint.config.js` registers one plugin
 * object rather than pointing at a rule file's path directly.
 */

import noUntranslatedJsxText from './no-untranslated-jsx-text.js';

const plugin = {
  meta: { name: 'orderbook-i18n' },
  rules: {
    'no-untranslated-jsx-text': noUntranslatedJsxText,
  },
};

export default plugin;
