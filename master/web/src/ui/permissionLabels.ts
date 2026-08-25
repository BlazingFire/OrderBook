/**
 * Reader-facing names for permission keys.
 *
 * The catalogue carries a `labelToken` per module and capability, but those are
 * `MessageKey`s into the *shared* message table, which the panels' own `t()`
 * does not read — passing one through it renders the token itself. Until the
 * planned shared `ui/` workspace hoists both tables together
 * (docs/UI_REDESIGN.md §7), the key is turned into a name here rather than
 * shown raw: `leads` reads as Leads, `field.saleRate.edit` as Sale rate edit.
 *
 * Deliberately the only place that happens, so the grid and the read-only
 * summary of the same role cannot disagree about what a key is called.
 */

/** `leads` -> `Leads`, `recycleBin` -> `Recycle bin`. */
export function moduleLabel(key: string): string {
  return sentenceCase(splitCamel(key));
}

/** `verifyChain` -> `Verify chain`. Action names sit in a header, so they stay short. */
export function actionLabel(action: string): string {
  return sentenceCase(splitCamel(action));
}

/**
 * `logs.verifyChain` -> `Logs verify chain`.
 *
 * The whole key, not just its tail. Dropping the prefix looked tidier and made
 * the admin group unreadable: `panels.manage`, `fields.manage`,
 * `settings.manage`, `storage.manage` and `users.manage` all rendered as
 * "Manage", five identical checkboxes in a row with nothing to tell them apart.
 */
export function capabilityLabel(key: string): string {
  return sentenceCase(splitCamel(key));
}

/** `workflow` -> `Workflow`. */
export function groupLabel(key: string): string {
  return sentenceCase(splitCamel(key));
}

function splitCamel(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ').toLowerCase();
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
