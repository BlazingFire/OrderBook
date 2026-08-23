/**
 * Custom fields defined through Fields Management
 * (docs/LEAD_GENERATION_FLOW.md §3.1).
 *
 * The important design point is what a *required* custom field does: it flags
 * the record incomplete, it does not reject the save. A panel that has been
 * offline all afternoon must never lose a lead because head office added a
 * mandatory field this morning — the lead saves, syncs, and shows up on the
 * board wearing a badge that says what is missing.
 */

import type { CustomFieldDefinition } from '@orderbook/shared';

export interface CompletenessResult {
  incomplete: boolean;
  /** Labels, not keys — this goes straight into the UI badge. */
  missingFields: string[];
}

export function evaluateCompleteness(
  values: Record<string, unknown>,
  definitions: CustomFieldDefinition[],
): CompletenessResult {
  const missingFields = definitions
    .filter((definition) => definition.isActive && definition.isRequired)
    .filter((definition) => isBlank(values[definition.key]))
    .map((definition) => definition.label);

  return { incomplete: missingFields.length > 0, missingFields };
}

/**
 * Drop values with no matching definition and coerce the rest to their declared
 * type. A select whose option was later deleted keeps its value — deleting an
 * option must not silently blank historical records that legitimately used it.
 */
export function normalizeCustomFields(
  values: Record<string, unknown> | undefined,
  definitions: CustomFieldDefinition[],
): Record<string, unknown> {
  if (!values) return {};

  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    const definition = byKey.get(key);
    if (!definition) continue;
    if (isBlank(value)) continue;

    normalized[key] = coerce(value, definition);
  }

  return normalized;
}

function coerce(value: unknown, definition: CustomFieldDefinition): unknown {
  switch (definition.fieldType) {
    case 'number': {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1;
    case 'date':
    case 'select':
    case 'text':
    default:
      return String(value);
  }
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
