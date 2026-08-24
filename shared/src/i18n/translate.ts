/**
 * `t()` — the only place a message key becomes a sentence.
 *
 * Deliberately has no number-formatting capability at all: `String(value)` and
 * nothing else. The rule that numbers, ids and fingerprints are never
 * localised is enforced by the function being unable to break it, not by a
 * comment asking nicely.
 */

import { EN_MESSAGES } from './en.js';
import { HI_MESSAGES } from './hi.js';
import type { CountKey, LocaleCatalogue, MessageKey, MessageParams, ParamsFor } from './keys.js';
import type { Locale } from './locales.js';

const CATALOGUES: Record<Locale, LocaleCatalogue> = {
  en: EN_MESSAGES,
  hi: HI_MESSAGES,
};

export function resolveCatalogue(locale: Locale): LocaleCatalogue {
  return CATALOGUES[locale];
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(template: string, params: MessageParams): string {
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * The missing-key fallback. `MessageKey` is a compile-time union, so a key can
 * only be missing at runtime when it arrived as a *string off the wire* — a
 * `messageKey` from a newer Master than this bundle. Order:
 *   1. the requested locale's catalogue;
 *   2. EN_MESSAGES (insurance against a future partial `hi.ts`, impossible
 *      today because `HI_MESSAGES` is a total `Record`);
 *   3. the raw key, returned verbatim — ugly, honest, greppable, and never
 *      confusable with a real translation.
 */
export function t<K extends MessageKey>(locale: Locale, key: K, ...params: ParamsFor<K>): string {
  const catalogue = resolveCatalogue(locale);
  const template = (catalogue as Record<string, string>)[key]
    ?? (EN_MESSAGES as Record<string, string>)[key]
    ?? key;

  return fill(template, (params[0] as MessageParams | undefined) ?? {});
}

/**
 * Plural selection via `Intl.PluralRules` — ECMA-402 core, no network, no DOM.
 * English and Hindi share the same two-category set (`one`, `other`).
 * `count` is injected as the `{count}` param, so it is never concatenated onto
 * the sentence and is never reformatted (it is a number, not localised text).
 */
export function tCount<S extends CountKey>(
  locale: Locale,
  stem: S,
  count: number,
  params: MessageParams = {},
): string {
  const rules = new Intl.PluralRules(locale);
  const category = rules.select(count) === 'one' ? 'one' : 'other';
  const key = `${stem}.${category}` as MessageKey;
  return t(locale, key, { count, ...params } as never);
}

export interface Translator {
  readonly locale: Locale;
  t<K extends MessageKey>(key: K, ...params: ParamsFor<K>): string;
  tCount<S extends CountKey>(stem: S, count: number, params?: MessageParams): string;
}

export function createTranslator(locale: Locale): Translator {
  return {
    locale,
    t: (key, ...params) => t(locale, key, ...params),
    tCount: (stem, count, params) => tCount(locale, stem, count, params),
  };
}
