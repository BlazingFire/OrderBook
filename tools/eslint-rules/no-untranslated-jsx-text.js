/**
 * Flags a JSX text node that is not wrapped in `t()` or `<Untranslated>`.
 *
 * Registered at severity `'off'` in this batch (`eslint.config.js`) and
 * promoted to `'error'` screen by screen in the UI phase — `lint` is the
 * first step of `npm run verify`, and turning this on today against ~4,000
 * unswept lines of JSX would fail every gate in the batch for a reason that
 * has nothing to do with it (`docs/backend-modules/05-EXISTING-CODE-CHANGES.md`
 * §8.1).
 *
 * Deliberately narrow rather than exhaustive: it catches the dominant case —
 * a literal sentence sitting directly in JSX — and leaves attribute strings
 * and template-literal composition for the UI phase to extend once a screen
 * is actually being swept, so the rule earns its keep incrementally rather
 * than producing a wall of findings nobody asked for yet.
 */

/** A node whose only content is whitespace, or that looks like a bare identifier/number, is not prose. */
function looksTranslatable(raw) {
  const text = raw.trim();
  if (text.length === 0) return false;
  // A lone punctuation/number run — "—", "1", "#42" — is not a sentence a
  // translator would touch. `\p{L}` matches a letter in any script, so this
  // does not privilege Latin letters.
  if (!/\p{L}/u.test(text)) return false;
  return true;
}

function isWithinUntranslated(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'JSXElement' &&
      current.openingElement?.name?.type === 'JSXIdentifier' &&
      current.openingElement.name.name === 'Untranslated'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a raw JSX text sentence that bypasses the t() translation layer.',
    },
    schema: [],
    messages: {
      untranslated:
        'Wrap this text in t() or <Untranslated> — see shared/src/i18n and docs/backend-modules/09-I18N.md.',
    },
  },
  create(context) {
    return {
      JSXText(node) {
        if (!looksTranslatable(node.value)) return;
        if (isWithinUntranslated(node)) return;
        context.report({ node, messageId: 'untranslated' });
      },
    };
  },
};

export default rule;
