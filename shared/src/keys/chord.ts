/**
 * What key was pressed, and did it match the binding.
 *
 * DOM-free on purpose — `shared`'s `lib` is `["ES2022"]`, so this takes a
 * structural shape rather than a `KeyboardEvent`. That is also what makes the
 * three matching rules below testable without a browser, which matters because
 * every one of them is a bug that only appears on somebody else's keyboard.
 *
 * **Rule one: digits, function keys and named keys match on `code`.** On a Mac,
 * Option+1 delivers `key === '¡'`. Matching on `key` would mean Alt+1 works on
 * Windows and silently does nothing on a Mac — and the Master binds `0.0.0.0`,
 * so a Mac browser on the shop LAN is a real client, not a hypothetical one.
 *
 * **Rule two: letters match on `key.toLowerCase()`, unless Alt is held.** Then
 * they match on `code` too, because macOS Alt+K is `˚`. Letters cannot match on
 * `code` always: a French or Devanagari layout maps `KeyA` to something else,
 * and somebody pressing the key labelled with the letter in the shortcut is
 * what a shortcut means.
 *
 * **Rule three: an Alt-only chord requires `ctrlKey === false`.** AltGr on a
 * European layout reports as Ctrl+Alt, so without this every Alt-N binding
 * fires while somebody types an accented character.
 */

/** The parts of a keyboard event a chord is matched against. */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface Chord {
  /** Lower-case letter, digit, or a named key such as `F2` / `Enter` / `/`. */
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/**
 * Escape and Tab are **never** chords.
 *
 * Not a policy about what is tasteful: they are what the overlay layer uses to
 * close a dialog and to move focus, and a command bound to either would race
 * that. Keeping them out of the index entirely is what lets the keyboard
 * provider and the overlay coexist without either having to know the other's
 * listener phase.
 */
const RESERVED = new Set(['escape', 'tab']);

export function isReservedChord(chord: Chord): boolean {
  return RESERVED.has(chord.key.toLowerCase());
}

/** `Ctrl+Shift+K`, `Alt+1`, `F2`, `/` — the form a binding is written in. */
export function parseChord(text: string): Chord | null {
  const parts = text
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  const key = parts.pop();
  if (!key) return null;

  const chord: Chord = { key: key.length === 1 ? key.toLowerCase() : key };

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'ctrl':
      case 'control':
        chord.ctrl = true;
        break;
      case 'alt':
      case 'option':
        chord.alt = true;
        break;
      case 'shift':
        chord.shift = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        chord.meta = true;
        break;
      default:
        return null;
    }
  }

  return chord;
}

/** The canonical text for a chord, so two spellings of one binding compare equal. */
export function formatChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Meta');
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join('+');
}

function isLetter(key: string): boolean {
  return key.length === 1 && key >= 'a' && key <= 'z';
}

/** `1` → `Digit1`, `f2` → `F2`, `/` → `Slash`. */
function codeFor(key: string): string | null {
  if (key.length === 1 && key >= '0' && key <= '9') return `Digit${key}`;
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  if (isLetter(key)) return `Key${key.toUpperCase()}`;

  const NAMED: Record<string, string> = {
    '/': 'Slash',
    '.': 'Period',
    ',': 'Comma',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    '-': 'Minus',
    '=': 'Equal',
    '`': 'Backquote',
  };

  return NAMED[key] ?? null;
}

export function matchesChord(event: KeyEventLike, chord: Chord): boolean {
  if (Boolean(chord.ctrl) !== event.ctrlKey) return false;
  if (Boolean(chord.alt) !== event.altKey) return false;
  if (Boolean(chord.shift) !== event.shiftKey) return false;
  if (Boolean(chord.meta) !== event.metaKey) return false;

  // Rule three. AltGr reports as Ctrl+Alt, so an Alt-only chord that did not
  // check this would fire while somebody types an accented character.
  if (chord.alt && !chord.ctrl && event.ctrlKey) return false;

  const key = chord.key.toLowerCase();
  const code = codeFor(key);

  // Rule one, and rule two's Alt branch.
  if (!isLetter(key) || chord.alt) return code !== null && event.code === code;

  // Rule two. The key labelled with the letter, whatever the layout maps it to.
  return event.key.toLowerCase() === key;
}
