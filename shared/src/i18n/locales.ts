/**
 * The UI is English only. The names below are kept so callers that still take a
 * locale compile; a stored value other than 'en' is simply not a locale.
 */

export const LOCALES = ['en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
};
