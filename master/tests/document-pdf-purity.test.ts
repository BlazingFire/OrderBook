/**
 * The seam holds (`docs/backend-modules/10-TESTING.md` §6.7).
 *
 * `document-model.ts` calls itself the architectural seam and explains what it
 * buys: the renderer "has nothing to decide — it draws the columns it is
 * given", so a rate cannot leak by somebody forgetting a check, only by
 * somebody deleting code.
 *
 * Free-form elements are the first thing that could quietly undo that. If any
 * file under `master/src/pdf/` could reach a subject, a party or a binding, it
 * could resolve a value the model deliberately refused to build — and it would
 * do so in a file whose reviewers are thinking about typography.
 *
 * So this reads the source rather than the behaviour. Behaviour tests prove the
 * output is right today; this proves the shape that makes it right tomorrow.
 * It is the same technique as `credential-invariants.test.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF_DIR = path.join(here, '..', 'src', 'pdf');

const sources = readdirSync(PDF_DIR)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(path.join(PDF_DIR, file), 'utf8') }));

/** Comments discuss the rules this file enforces; only code may break them. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('the PDF layer stays downstream of every decision', () => {
  it('PDF-82: nothing under src/pdf imports the binding catalogue', () => {
    // Bindings are where permission lives. A renderer that could resolve one
    // could print a value the model refused to build.
    for (const { file, text } of sources) {
      expect(code(text), file).not.toContain('document-bindings');
    }
  });

  it('PDF-82: nothing under src/pdf imports a repository, a service or the database', () => {
    for (const { file, text } of sources) {
      const body = code(text);

      expect(body, file).not.toMatch(/from '\.\.\/repositories\//);
      expect(body, file).not.toMatch(/from '\.\.\/services\//);
      expect(body, file).not.toMatch(/from '\.\.\/db\//);
    }
  });

  it('PDF-82: no file under src/pdf mentions a subject, a party or custom fields', () => {
    // The model resolves those into strings and hands over what survives. A
    // renderer that named one of them would be deciding, and deciding is the
    // thing this layer is not allowed to do.
    for (const { file, text } of sources) {
      const body = code(text);

      expect(body, `${file} names a subject`).not.toMatch(/\bsubject\b/);
      expect(body, `${file} names custom fields`).not.toMatch(/\bcustomFields\b/);
      // `model.party` is deliberately not forbidden: it is a name and some
      // address lines the seam already resolved and already permission-checked,
      // no different from `model.rows`. What must not appear is the *record* —
      // a `Party` this layer could read another field off.
      expect(body, `${file} imports a Party record`).not.toMatch(/\bParty\b/);
    }
  });

  it('PDF-82: the only domain types src/pdf imports are the model and its text helpers', () => {
    // A narrow allow-list rather than a blanket ban: the renderer legitimately
    // needs `DocumentModel` and the script splitter. Anything else arriving
    // from `domain/` deserves a conversation, which is what a failure here is.
    const allowed = new Set(['document-model.js', 'document-text.js']);

    for (const { file, text } of sources) {
      for (const match of code(text).matchAll(/from '\.\.\/domain\/([\w.-]+)'/g)) {
        expect(allowed.has(match[1] ?? ''), `${file} imports domain/${match[1]}`).toBe(true);
      }
    }
  });

  it('PDF-82: elements.ts exists and draws from the model alone', () => {
    const elements = sources.find((source) => source.file === 'elements.ts');

    expect(elements, 'elements.ts is missing').toBeDefined();
    expect(code(elements?.text ?? '')).toContain('ResolvedElement');
  });
});
