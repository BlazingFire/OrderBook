/**
 * The type machinery that makes a missing or misspelt message key, or a wrong
 * set of placeholders, a compile error rather than a runtime "renders blank".
 */

import type { EN_MESSAGES } from './en.js';

export type MessageKey = keyof typeof EN_MESSAGES;

/** The `{named}` placeholders inside a literal message template. */
export type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

export type MessageParams = Record<string, string | number>;

type ParamsOf<K extends MessageKey> = Placeholders<(typeof EN_MESSAGES)[K]>;

/**
 * `[]` when a message has no placeholders, so `t('common.save')` compiles with
 * one argument; a required record otherwise, so a missing placeholder, an
 * invented one, and params passed to a message that takes none are all compile
 * errors.
 *
 * The tuple wrapper (`[ParamsOf<K>] extends [never]`) is deliberate — a bare
 * `ParamsOf<K> extends never` distributes over the union and silently produces
 * `never` for keyed messages instead of testing the union as a whole.
 */
export type ParamsFor<K extends MessageKey> =
  [ParamsOf<K>] extends [never] ? [] : [params: Record<ParamsOf<K>, string | number>];

/** Stems that have BOTH a `.one` and an `.other` sibling — the only valid `tCount` inputs. */
export type CountKey = {
  [K in MessageKey]: K extends `${infer Stem}.other`
    ? `${Stem}.one` extends MessageKey
      ? Stem
      : never
    : never;
}[MessageKey];

export type LocaleCatalogue = Readonly<Record<MessageKey, string>>;
