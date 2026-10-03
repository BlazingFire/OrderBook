/**
 * Which chord runs which command, and how a person changes it.
 *
 * Bindings live in `localStorage`, not in the settings table, for the same
 * reason theme, density and motion do: **a keyboard is a property of a
 * machine.** The shop PC has a full-size board with a numeric keypad; the
 * laptop in the office does not. Syncing a remap between them would push one
 * person's answer onto the other's hardware.
 *
 * Accepted cost, stated rather than discovered: a remap does not follow
 * somebody from the Master to an Office panel. Nobody has asked for that, and
 * the alternative is a settings row per person per binding.
 */

import { formatChord, isReservedChord, parseChord, type Chord } from './chord.js';
import { COMMANDS_BY_ID, commandsFor } from './commands.js';

/** Command id to chord text. Absent means "the default"; `null` means unbound. */
export type BindingMap = Record<string, string | null>;

export const BINDINGS_STORAGE_KEY = 'ob.keys.v1';

/**
 * Detect macOS from the browser's user agent or platform string.
 * Safe to call from any context — returns false on the server.
 */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (ua.includes('Mac')) return true;
  // navigator.userAgentData is available in Chromium-based browsers
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform === 'macOS';
}

/**
 * The chord a command answers to, given a person's overrides.
 *
 * Resolution order:
 * 1. User override from localStorage
 * 2. Platform-specific default (if macOS and platformDefaultChord exists)
 * 3. Generic default (defaultChord)
 *
 * An override of `null` is "unbound", which is different from absent — somebody
 * who deliberately cleared Ctrl+S must not have it handed back by the next
 * upgrade that changes the default.
 */
export function chordFor(commandId: string, overrides: BindingMap): Chord | null {
  const hasOwn = Object.prototype.hasOwnProperty.call(overrides, commandId);
  const command = COMMANDS_BY_ID.get(commandId);

  let override: string | null | undefined;
  if (hasOwn) {
    override = overrides[commandId];
  } else if (command) {
    const mac = isMacPlatform();
    override = mac && command.platformDefaultChord?.darwin
      ? command.platformDefaultChord.darwin
      : command.defaultChord;
  }

  if (!override) return null;

  const chord = parseChord(override);
  if (!chord || isReservedChord(chord)) return null;
  return chord;
}

/**
 * Every chord that runs a command: the one `chordFor` names, plus its
 * `alsoChords` while the person has not set a binding of their own for it.
 */
export function chordsFor(commandId: string, overrides: BindingMap): Chord[] {
  const primary = chordFor(commandId, overrides);
  const chords = primary ? [primary] : [];
  if (Object.prototype.hasOwnProperty.call(overrides, commandId)) return chords;
  for (const text of COMMANDS_BY_ID.get(commandId)?.alsoChords ?? []) {
    const chord = parseChord(text);
    if (chord && !isReservedChord(chord)) chords.push(chord);
  }
  return chords;
}

export interface BindingConflict {
  chord: string;
  commandIds: string[];
}

/**
 * Two commands answering to one chord, **on one panel**.
 *
 * Per panel rather than across the catalogue, because the Master's Alt+1 and the
 * Office panel's Alt+1 are not a clash: no running panel has both registered, so
 * reporting them would mean shipping nine conflicts out of the box and teaching
 * people to ignore the warning.
 *
 * Reported rather than refused. Somebody mid-remap legitimately passes through
 * a state where two commands share a chord — refusing the first edit would make
 * swapping two shortcuts impossible — so the editor shows the clash and the
 * resolver takes the first match, deterministically.
 */
export function findConflicts(
  panel: 'master' | 'office',
  overrides: BindingMap,
): BindingConflict[] {
  const byChord = new Map<string, string[]>();

  for (const command of commandsFor(panel)) {
    const chord = chordFor(command.id, overrides);
    if (!chord) continue;

    const text = formatChord(chord);
    byChord.set(text, [...(byChord.get(text) ?? []), command.id]);
  }

  return [...byChord.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([chord, commandIds]) => ({ chord, commandIds }));
}

/**
 * Parse whatever was in `localStorage`.
 *
 * Anything unrecognisable is dropped rather than failing: a keyboard remap is a
 * convenience, and a panel that refused to start because one entry was corrupt
 * would be trading a working shop for a tidy invariant.
 */
export function parseBindings(raw: unknown): BindingMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const map: BindingMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!COMMANDS_BY_ID.has(id)) continue;
    if (value === null) {
      map[id] = null;
      continue;
    }
    if (typeof value !== 'string') continue;

    const chord = parseChord(value);
    if (chord && !isReservedChord(chord)) map[id] = formatChord(chord);
  }

  return map;
}
