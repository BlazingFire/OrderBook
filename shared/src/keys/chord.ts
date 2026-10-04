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
 * `code` always: a French or Russian layout maps `KeyA` to something else,
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

/** Mac glyph display for chords — ⌘⌥⇧⌃ symbols. */
export function formatChordMac(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push('\u2303');
  if (chord.alt) parts.push('\u2325');
  if (chord.shift) parts.push('\u21E7');
  if (chord.meta) parts.push('\u2318');
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join('');
}

function isLetter(key: string): boolean {
  return key.length === 1 && key >= 'a' && key <= 'z';
}

/** The punctuation whose `code` name is worth knowing, both ways. */
const NAMED_CODES: Record<string, string> = {
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

/** `1` → `Digit1`, `f2` → `F2`, `/` → `Slash`. */
function codeFor(key: string): string | null {
  if (key.length === 1 && key >= '0' && key <= '9') return `Digit${key}`;
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  if (isLetter(key)) return `Key${key.toUpperCase()}`;

  return NAMED_CODES[key] ?? null;
}

/**
 * The chord somebody just pressed, for the rebinding editor.
 *
 * Reads `code` for everything except letters, which is the same asymmetry
 * `matchesChord` applies in reverse: recording `Digit1` and then matching on
 * `key` would produce a binding that never fires on the Mac it was recorded on.
 *
 * Returns `null` for a modifier pressed on its own, so holding Ctrl while
 * reaching for the second key does not end the capture early. Escape and Tab do
 * come back — `isReservedChord` is what refuses them, and refusing them by name
 * lets the editor say so rather than appearing to ignore the key.
 */
export function chordFromEvent(event: KeyEventLike): Chord | null {
  const key = keyNameFor(event);
  if (!key) return null;

  const chord: Chord = { key };
  if (event.ctrlKey) chord.ctrl = true;
  if (event.altKey) chord.alt = true;
  if (event.shiftKey) chord.shift = true;
  if (event.metaKey) chord.meta = true;
  return chord;
}

function keyNameFor(event: KeyEventLike): string | null {
  const digit = /^Digit(\d)$/.exec(event.code);
  if (digit) return digit[1]!;

  if (/^F\d{1,2}$/.test(event.code)) return event.code;

  const letter = /^Key([A-Z])$/.exec(event.code);
  // The letter on the key, not the position: `matchesChord` compares a letter
  // chord against `event.key`, so that is what has to be stored.
  if (letter) return event.key.length === 1 ? event.key.toLowerCase() : letter[1]!.toLowerCase();

  for (const [symbol, code] of Object.entries(NAMED_CODES)) {
    if (code === event.code) return symbol;
  }

  if (event.key === 'Escape' || event.key === 'Tab') return event.key;

  return null;
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
