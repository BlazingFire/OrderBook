/**
 * The contract the Logs module renders against.
 *
 * `activity_log` refuses UPDATE and DELETE by trigger
 * (`20260303000000_roles_and_users.ts`), so retiring a token would orphan rows
 * that can never be corrected — `ACTIVITY_TOKENS` is therefore frozen and
 * APPEND-ONLY. `action` is free-form TEXT with no CHECK constraint, so a row
 * whose action predates or postdates this bundle's catalogue will occur;
 * `activityMessageKey` returns `null` rather than throwing, and the caller
 * renders the raw pair honestly instead of a blank cell.
 */

import type { MessageKey } from './keys.js';
import { EN_MESSAGES } from './en.js';
import type { Translator } from './translate.js';

export type ActivityToken = `activity.${string}.${string}` & MessageKey;

/** The frozen, append-only set of `entityType.action` pairs this bundle can render. */
export const ACTIVITY_TOKENS: ReadonlySet<string> = new Set(
  Object.keys(EN_MESSAGES)
    .filter((key) => key.startsWith('activity.'))
    .map((key) => key.slice('activity.'.length)),
);

/** `activity.<entityType>.<action>` when the catalogue holds it, else `null`. */
export function activityMessageKey(entityType: string, action: string): MessageKey | null {
  const pair = `${entityType}.${action}`;
  if (!ACTIVITY_TOKENS.has(pair)) return null;
  return `activity.${pair}` as MessageKey;
}

export interface ActivityRenderInput {
  entityType: string;
  action: string;
  actorName: string | null;
  details: Record<string, unknown> | null;
}

/** Renders, or falls back to the raw pair — honestly, never blank. */
export function renderActivity(t: Translator, input: ActivityRenderInput): string {
  const key = activityMessageKey(input.entityType, input.action);

  if (!key) return `${input.entityType} · ${input.action}`;

  // From the catalogue, not a literal: this is the subject of a sentence the
  // reader's own catalogue builds, and an English word there rendered as
  // "Somebody ने …".
  const actor = input.actorName ?? t.t('logs.actor.unknown');
  const params: Record<string, string | number> = { actor };
  for (const [field, value] of Object.entries(input.details ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') params[field] = value;
  }

  return t.t(key, params as never);
}
