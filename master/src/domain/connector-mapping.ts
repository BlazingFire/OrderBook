/**
 * Turning one remote row into one local input, with no database and no network.
 *
 * Pure on purpose: this is where a mapping either does what the person who
 * filled in the form expected or quietly corrupts the catalogue, and that is a
 * thing to test with a plain object rather than a live remote system.
 *
 * **Transforms are a closed set of names, never an expression.** A mapping is
 * data a shopkeeper enters; an expression language would make that form a code
 * path running with the connector's authority.
 */

import { createHash } from 'node:crypto';
import type { ConnectorFieldMap, ConnectorTransform } from '@orderbook/shared';

import { readPointer } from './json-pointer.js';

export function applyTransform(value: unknown, transform: ConnectorTransform | null): unknown {
  if (value === null || value === undefined) return value;

  switch (transform) {
    case 'trim':
      return String(value).trim();
    case 'upper':
      return String(value).toUpperCase();
    case 'lower':
      return String(value).toLowerCase();
    case 'digits':
      // What a phone number needs: a remote `+91 98250-11111` is the same
      // number as `9825011111`, and the catalogue stores one of them.
      return String(value).replace(/\D/g, '');
    case null:
    default:
      return value;
  }
}

export interface MappedRow {
  /** The local input, keyed by local field name. */
  input: Record<string, unknown>;
  /** Fields the remote row did not supply and the map marked required. */
  missing: string[];
  /** A stable digest of `input`, for the unchanged-row skip. */
  hash: string;
}

/**
 * Read one remote row through a field map.
 *
 * A pointer that does not resolve leaves the field **absent**, not null. That
 * is what makes an import a patch rather than a replace: a remote system that
 * does not carry a `notes` column must not blank the note somebody typed here.
 */
export function mapRow(row: unknown, fieldMaps: readonly ConnectorFieldMap[]): MappedRow {
  const input: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const map of fieldMaps) {
    const raw = readPointer(row, map.remotePointer);

    if (raw === undefined) {
      if (map.isRequired) missing.push(map.localField);
      continue;
    }

    input[map.localField] = applyTransform(raw, map.transform);
  }

  return { input, missing, hash: hashInput(input) };
}

/**
 * A digest of what we would write, not of what the remote sent.
 *
 * Keyed on the mapped input so a remote system that reformats a field it does
 * not otherwise change — a timestamp, a computed total — does not make every
 * row look modified. Keys are sorted so JSON key order, which is not
 * meaningful, cannot change the hash.
 *
 * This is also the loop guard for `on_change` connectors: a change event
 * carries no actor, so the only way to tell "the remote sent us back what we
 * just sent it" is that the write would be a no-op.
 */
export function hashInput(input: Record<string, unknown>): string {
  const sorted = Object.keys(input)
    .sort()
    .map((key) => [key, input[key]] as const);

  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Which fields a mapped row would actually change on the record we hold.
 *
 * Compared loosely on purpose — a remote `9876543210` and a stored
 * `"9876543210"` are the same phone number, and reporting that as a change
 * would make every run rewrite every row.
 */
export function changedFields(
  existing: Record<string, unknown>,
  input: Record<string, unknown>,
): string[] {
  return Object.keys(input).filter((field) => {
    const before = existing[field];
    const after = input[field];
    if (before === after) return false;
    if (before === null || before === undefined) return after !== null && after !== undefined;
    return String(before) !== String(after);
  });
}
