/**
 * The set of locales this product ships, and the picker's own label for each.
 *
 * Locale is per-machine and never synced (`docs/UI_REDESIGN.md`, "per-machine,
 * never synced" — the same rule as theme and density). One Master serves
 * several Office Panels on a LAN, so there is no single "the" locale to store
 * centrally; each browser profile picks its own.
 */

export const LOCALES = ['en', 'hi'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Each language named in its OWN script — deliberately NOT translatable. A
 * picker that renames the language you cannot read into the language you
 * cannot read is useless.
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  hi: 'हिन्दी',
};
