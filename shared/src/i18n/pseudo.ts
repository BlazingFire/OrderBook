/**
 * Dev-only `en-XA`: pads every English string to 1.4x and brackets it, making
 * the design spec's "survives 1.4x expansion" budget checkable rather than
 * aspirational. Placeholders are left untouched, so a padding bug cannot
 * masquerade as a substitution bug.
 *
 * `en-XA` is deliberately NOT a `Locale` — it never appears in `LOCALES`, so it
 * cannot arrive from `localStorage`, an env var or the wire. It exists purely
 * for a developer flag, and is excluded from this function's callers in
 * production builds.
 */

import { EN_MESSAGES } from './en.js';
import type { LocaleCatalogue } from './keys.js';

export const PSEUDO_LOCALE = 'en-XA';

const PLACEHOLDER = /\{(\w+)\}/g;

function pad(template: string): string {
  const segments = template.split(PLACEHOLDER);
  // Odd indices are the captured placeholder names from `split` with a
  // capturing group; even indices are literal text to pad.
  const padded = segments.map((segment, index) => {
    if (index % 2 === 1) return `{${segment}}`;
    if (segment.length === 0) return segment;
    const extra = Math.ceil(segment.length * 0.4);
    return `${segment}${'—'.repeat(extra)}`;
  });
  return `[${padded.join('')}]`;
}

let cached: LocaleCatalogue | null = null;

export function buildPseudoCatalogue(): LocaleCatalogue {
  if (!cached) {
    cached = Object.fromEntries(
      Object.entries(EN_MESSAGES).map(([key, value]) => [key, pad(value)]),
    ) as LocaleCatalogue;
  }
  return cached;
}
