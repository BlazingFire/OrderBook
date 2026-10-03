/**
 * Reader-facing names for permission keys.
 *
 * Each comes from the catalogue token the permission surface promises for it
 * (`shared/src/domain/permissions.ts`, held to it by
 * `shared/tests/i18n-coverage.test.ts`): `module.<key>`, `action.<action>`,
 * `permission.<key>` and `capabilityGroup.<key>`. The naming is mechanical, so
 * the key the grid already has is enough to find its token — no field of the
 * wire catalogue has to be threaded through.
 *
 * A key the catalogue has no token for still gets a name, built from the key
 * itself: `recycleBin.purgeAll` reads "Recycle bin purge all". That is the case
 * of a Master newer than this panel serving a permission the panel's messages
 * have never heard of, and the raw token `t()` would otherwise return is the
 * worse of the two.
 *
 * Deliberately the only place that happens, so the grid and the read-only
 * summary of the same role cannot disagree about what a key is called.
 */

import { t } from './i18n.js';

/** `leads` -> Leads. */
export function moduleLabel(key: string): string {
  return labelFor(`module.${key}`, key);
}

/** `view` -> View. Action names sit in a header, so they stay short. */
export function actionLabel(action: string): string {
  return labelFor(`action.${action}`, action);
}

/**
 * `orders.dispatch` -> "Mark orders as dispatched"; a module action
 * (`leads.view`) too, which the Integrations screen's key scopes list.
 *
 * Its fallback is built from the whole key, never just its tail: the admin
 * group's `panels.manage`, `fields.manage`, `settings.manage`,
 * `storage.manage` and `users.manage` would otherwise be five identical
 * "Manage" checkboxes in a row.
 */
export function capabilityLabel(key: string): string {
  return labelFor(`permission.${key}`, key);
}

/** `admin` -> Administration. */
export function groupLabel(key: string): string {
  return labelFor(`capabilityGroup.${key}`, key);
}

function labelFor(token: string, key: string): string {
  const label = t(token);
  return label === token ? sentenceCase(splitCamel(key)) : label;
}

function splitCamel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._]/g, ' ')
    .toLowerCase();
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
