/**
 * The three matching rules, and the reason each exists.
 *
 * Every one of them is a bug that appears only on somebody else's keyboard, so
 * a browser test would not have found any of them — which is exactly why the
 * matcher is DOM-free and tested here instead.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMANDS,
  COMMANDS_BY_ID,
  chordFor,
  chordFromEvent,
  findConflicts,
  formatChord,
  isReservedChord,
  matchesChord,
  navCommands,
  parseBindings,
  parseChord,
  type KeyEventLike,
} from '../src/index.js';

function press(overrides: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe('parsing a chord', () => {
  it('reads modifiers in any order and any spelling', () => {
    expect(parseChord('Ctrl+Shift+K')).toEqual({ key: 'k', ctrl: true, shift: true });
    expect(parseChord('Shift+Control+K')).toEqual({ key: 'k', ctrl: true, shift: true });
    expect(parseChord('Cmd+S')).toEqual({ key: 's', meta: true });
  });

  it('keeps a named key as written and lower-cases a letter', () => {
    expect(parseChord('F2')).toEqual({ key: 'F2' });
    expect(parseChord('A')).toEqual({ key: 'a' });
  });

  it('refuses a modifier it does not know rather than guessing', () => {
    expect(parseChord('Hyper+K')).toBeNull();
  });

  it('round-trips through its canonical form', () => {
    expect(formatChord(parseChord('shift+ctrl+k')!)).toBe('Ctrl+Shift+K');
  });
});

describe('rule one — digits and function keys match on the physical key', () => {
  it('matches Alt+1 on a Mac, where the character is not "1"', () => {
    const chord = parseChord('Alt+1')!;
    // macOS Option+1 delivers `key === '¡'`. Matching on `key` would mean this
    // shortcut worked on Windows and silently did nothing on a Mac — and the
    // Master binds 0.0.0.0, so a Mac browser on the shop LAN is a real client.
    expect(matchesChord(press({ key: '¡', code: 'Digit1', altKey: true }), chord)).toBe(true);
  });

  it('matches F5 by code', () => {
    expect(matchesChord(press({ key: 'F5', code: 'F5' }), parseChord('F5')!)).toBe(true);
  });
});

describe('rule two — a letter is the key with that letter on it', () => {
  it('matches on the character, not the physical position', () => {
    // A French layout puts `KeyQ` where a US board has A. Somebody pressing the
    // key labelled S is what Ctrl+S means.
    expect(
      matchesChord(press({ key: 's', code: 'KeyO', ctrlKey: true }), parseChord('Ctrl+S')!),
    ).toBe(true);
  });

  it('falls back to the physical key when Alt is held', () => {
    // macOS Alt+K is `˚`.
    expect(
      matchesChord(press({ key: '˚', code: 'KeyK', altKey: true }), parseChord('Alt+K')!),
    ).toBe(true);
  });
});

describe('rule three — AltGr is not Alt', () => {
  it('does not fire an Alt chord while somebody types an accented character', () => {
    // AltGr on a European layout reports as Ctrl+Alt. Without this check every
    // Alt+N binding would fire mid-word.
    expect(
      matchesChord(
        press({ key: 'ñ', code: 'KeyN', altKey: true, ctrlKey: true }),
        parseChord('Alt+N')!,
      ),
    ).toBe(false);
  });
});

describe('recording a chord', () => {
  it('records the physical key for a digit, so the binding survives a Mac', () => {
    expect(chordFromEvent(press({ key: '¡', code: 'Digit1', altKey: true }))).toEqual({
      key: '1',
      alt: true,
    });
  });

  it('records the letter on the key, which is what a letter chord matches on', () => {
    expect(chordFromEvent(press({ key: 's', code: 'KeyO', ctrlKey: true }))).toEqual({
      key: 's',
      ctrl: true,
    });
  });

  it('ignores a modifier pressed on its own', () => {
    // Otherwise the capture ends the moment somebody reaches for Ctrl, before
    // they have pressed the key they meant.
    expect(
      chordFromEvent(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true })),
    ).toBeNull();
  });

  it('records Escape rather than dropping it, so the editor can refuse it by name', () => {
    const chord = chordFromEvent(press({ key: 'Escape', code: 'Escape' }));
    expect(chord).not.toBeNull();
    expect(isReservedChord(chord!)).toBe(true);
  });

  it('round-trips whatever it records', () => {
    const chord = chordFromEvent(press({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true }))!;
    expect(
      matchesChord(press({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true }), chord),
    ).toBe(true);
    expect(formatChord(chord)).toBe('Ctrl+Shift+K');
  });
});

describe('reserved chords', () => {
  it('refuses Escape and Tab', () => {
    // Not taste: they are what the overlay layer uses to close a dialog and to
    // move focus. Keeping them out of the index entirely is what lets the
    // keyboard provider and the overlay coexist without knowing each other's
    // listener phase.
    expect(isReservedChord(parseChord('Escape')!)).toBe(true);
    expect(isReservedChord(parseChord('Tab')!)).toBe(true);
    expect(isReservedChord(parseChord('Ctrl+K')!)).toBe(false);
  });

  it('will not bind one even if somebody edits localStorage by hand', () => {
    expect(parseBindings({ 'palette.open': 'Escape' })).toEqual({});
  });
});

describe('bindings', () => {
  it('treats an explicit null as unbound, not as absent', () => {
    // Somebody who deliberately cleared Ctrl+S must not have it handed back by
    // the next upgrade that changes the default.
    expect(chordFor('record.save', {})).not.toBeNull();
    expect(chordFor('record.save', { 'record.save': null })).toBeNull();
  });

  it('drops an override for a command that no longer exists', () => {
    expect(parseBindings({ 'command.that.went.away': 'Ctrl+J' })).toEqual({});
  });

  it('reports a clash rather than refusing the edit', () => {
    // Somebody swapping two shortcuts passes through a state where both share a
    // chord; refusing the first edit would make the swap impossible.
    const conflicts = findConflicts('office', { 'record.new': 'Ctrl+S' });
    expect(conflicts.map((conflict) => conflict.chord)).toContain('Ctrl+S');
  });

  it('ships no conflicting defaults on either panel', () => {
    // Per panel, not across the catalogue: Alt+1 opens the Master's dashboard
    // and the Office panel's, and no running panel has both registered.
    expect(findConflicts('master', {})).toEqual([]);
    expect(findConflicts('office', {})).toEqual([]);
  });
});

/** A panel's nav commands in sidebar order, as `[tab, chord]` pairs. */
function navChords(panel: 'master' | 'office'): Array<[string, string | undefined]> {
  return COMMANDS.filter((command) => command.panel === panel && command.navOrder)
    .sort((a, b) => (a.navOrder as number) - (b.navOrder as number))
    .map((command) => [command.tab as string, command.defaultChord]);
}

describe('the command catalogue', () => {
  it('numbers each panel nav from one, in that panel own sidebar order', () => {
    const office = COMMANDS.filter((command) => command.panel === 'office' && command.navOrder);
    expect(office.map((command) => command.navOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(office[0]?.tab).toBe('basicHome');
    expect(office[4]?.tab).toBe('conflicts');
    // The Chatroom follows Conflicts in the Work group; its letter chord takes no digit.
    expect(office[5]?.tab).toBe('chatroom');
    // The Printroom follows the Chatroom, with a letter chord of its own.
    expect(office[6]?.tab).toBe('printroom');
    // Reports has a row and no chord, so it takes no digit and pushes nothing else.
    expect(office[7]?.tab).toBe('reports');
    expect(office[11]?.tab).toBe('settings');
    expect(office[12]?.tab).toBe('logs');
  });

  it('binds the Chatroom to Alt+C on both panels, with no Meta twin on a Mac', () => {
    for (const panel of ['master', 'office'] as const) {
      const chatroom = COMMANDS.find((command) => command.panel === panel && command.tab === 'chatroom');
      expect(chatroom?.defaultChord).toBe('Alt+C');
      expect(chatroom?.platformDefaultChord).toBeUndefined();
      expect(chatroom?.titleToken).toBe('nav.chatroom');
    }
  });

  it('binds the Printroom to Alt+P on both panels, with no Meta twin on a Mac, and no other command takes it', () => {
    for (const panel of ['master', 'office'] as const) {
      const printroom = COMMANDS.find((command) => command.panel === panel && command.tab === 'printroom');
      expect(printroom?.defaultChord).toBe('Alt+P');
      expect(printroom?.platformDefaultChord).toBeUndefined();
      expect(printroom?.titleToken).toBe('nav.printroom');
      const holders = COMMANDS.filter(
        (command) => (command.panel === panel || command.panel === undefined) && command.defaultChord === 'Alt+P',
      );
      expect(holders.map((command) => command.id)).toEqual([`nav.${panel}.printroom`]);
    }
  });

  it('gives both panels the mockup chord map', () => {
    // Basic Home 1 to Settings 9 on both panels, so a person moving between
    // the Master and an Office PC finds every screen under the same digit.
    const map = {
      basicHome: 'Alt+1',
      dashboard: 'Alt+2',
      leads: 'Alt+3',
      orders: 'Alt+4',
      conflicts: 'Alt+5',
      products: 'Alt+6',
      parties: 'Alt+7',
      partyAccess: 'Alt+8',
      settings: 'Alt+9',
    };
    for (const panel of ['master', 'office'] as const) {
      const chords = Object.fromEntries(navChords(panel));
      for (const [tab, chord] of Object.entries(map)) expect(chords[tab], `${panel} ${tab}`).toBe(chord);
    }
  });

  it('gives the Reports, Admin and System rows a letter chord (1.4 R13)', () => {
    const master = Object.fromEntries(navChords('master'));
    expect(master).toMatchObject({
      reports: 'Alt+R',
      panels: 'Alt+O',
      access: 'Alt+A',
      fields: 'Alt+E',
      logs: 'Alt+L',
      recycleBin: 'Alt+B',
      integrations: 'Alt+I',
      updates: 'Alt+U',
    });
    const office = Object.fromEntries(navChords('office'));
    expect(office).toMatchObject({ reports: 'Alt+R', logs: 'Alt+L', updates: 'Alt+U' });
    // Alt+F and Alt+D belong to the note screen's Filling and Dispatch.
    for (const chord of Object.values({ ...master, ...office })) {
      expect(['Alt+F', 'Alt+D']).not.toContain(chord);
    }
    // Inventory's screen is hidden on the Master; its row went with it.
    expect('inventory' in master).toBe(false);
  });

  it('opens help on F1, keeps Cmd+/ on a Mac, and binds the new action chords (1.4 R13)', () => {
    const byId = (id: string) => COMMANDS.find((command) => command.id === id);
    expect(byId('keys.help')?.defaultChord).toBe('F1');
    expect(byId('keys.help')?.platformDefaultChord?.darwin).toBe('Meta+/');
    expect(byId('party.new')?.defaultChord).toBe('Ctrl+Shift+A');
    expect(byId('product.new')?.defaultChord).toBe('Ctrl+Shift+M');
    expect(byId('session.signOut')?.defaultChord).toBe('Ctrl+Shift+L');
  });

  it('does not use up an Alt digit on a row with an explicit chord or none', () => {
    const built = navCommands('office', [
      ['a', 'nav.dashboard'],
      ['b', 'nav.leads', 'Alt+C'],
      ['c', 'nav.orders', null],
      ['d', 'nav.products'],
    ]);
    expect(built.map((command) => command.defaultChord)).toEqual([
      'Alt+1',
      'Alt+C',
      undefined,
      'Alt+2',
    ]);
    // The sidebar position still counts every row.
    expect(built.map((command) => command.navOrder)).toEqual([1, 2, 3, 4]);
    // An explicit letter chord has no Mac twin; a digit chord keeps Cmd+N.
    expect(built[1]?.platformDefaultChord).toBeUndefined();
    expect(built[3]?.platformDefaultChord).toEqual({ darwin: 'Meta+2' });
  });

  it('never binds Cmd+C, Cmd+V, Cmd+X or Cmd+P', () => {
    // On a Mac browser those are Copy, Paste, Cut and Print. A shortcut that
    // took one of them would break the browser for everybody on the LAN.
    const taken = COMMANDS.flatMap((command) =>
      [command.defaultChord, command.platformDefaultChord?.darwin]
        .filter((text): text is string => Boolean(text))
        .map((text) => [command.id, parseChord(text)] as const),
    ).filter(([, chord]) => chord?.meta && ['c', 'v', 'x', 'p'].includes(chord.key));
    expect(taken).toEqual([]);
  });

  it('has a unique id for every command', () => {
    expect(COMMANDS_BY_ID.size).toBe(COMMANDS.length);
  });

  it('round-trips every default chord through parseChord → formatChord', () => {
    const failures: string[] = [];

    for (const command of COMMANDS) {
      const chords = [command.defaultChord, command.platformDefaultChord?.darwin].filter(
        Boolean,
      ) as string[];

      for (const chordText of chords) {
        const parsed = parseChord(chordText);
        if (!parsed) {
          failures.push(`${command.id}: "${chordText}" failed to parse`);
        } else {
          // formatChord normalizes modifier order (Ctrl, Alt, Shift, Meta),
          // so we compare the canonical form rather than the original text.
          const formatted = formatChord(parsed);
          const reparsed = parseChord(formatted);
          if (!reparsed) {
            failures.push(`${command.id}: canonical "${formatted}" failed to re-parse`);
          } else if (formatChord(reparsed) !== formatted) {
            failures.push(`${command.id}: "${formatted}" did not round-trip through re-parse`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  /**
   * Every chord in the catalogue must be reachable from a real keypress.
   *
   * `matchesChord` resolves a non-letter key through a private `codeFor`, and a
   * key it has no entry for can never match — the binding parses, formats,
   * prints in the help sheet, and then does nothing when pressed. `nav.prev`
   * and `nav.next` shipped bound to `Alt+ArrowLeft` / `Alt+ArrowRight`, which
   * `codeFor` returns null for.
   *
   * The check asks `matchesChord` itself rather than restating its table. An
   * earlier version of this test re-declared the punctuation list *and added
   * the four arrow names to it* — so it asserted that the broken chords were
   * fine. A copy of a table is not a test of the table; the only honest
   * question is whether some keypress can fire the binding, so that is the
   * question this asks.
   */
  it('can be fired by an actual keypress, for every chord in the catalogue', () => {
    // A generous universe of plausible events. Nothing here claims to be the
    // supported set — `matchesChord` decides. It is wide enough that a failure
    // means the key is genuinely unreachable rather than merely unlisted.
    const codes = [
      ...'abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => ({
        key: letter,
        code: `Key${letter.toUpperCase()}`,
      })),
      ...'0123456789'.split('').map((digit) => ({ key: digit, code: `Digit${digit}` })),
      ...Array.from({ length: 24 }, (_, i) => ({ key: `F${i + 1}`, code: `F${i + 1}` })),
      { key: '/', code: 'Slash' },
      { key: '.', code: 'Period' },
      { key: ',', code: 'Comma' },
      { key: ';', code: 'Semicolon' },
      { key: "'", code: 'Quote' },
      { key: '[', code: 'BracketLeft' },
      { key: ']', code: 'BracketRight' },
      { key: '\\', code: 'Backslash' },
      { key: '-', code: 'Minus' },
      { key: '=', code: 'Equal' },
      { key: '`', code: 'Backquote' },
      { key: ' ', code: 'Space' },
      { key: 'Enter', code: 'Enter' },
      { key: 'ArrowLeft', code: 'ArrowLeft' },
      { key: 'ArrowRight', code: 'ArrowRight' },
      { key: 'ArrowUp', code: 'ArrowUp' },
      { key: 'ArrowDown', code: 'ArrowDown' },
      { key: 'Home', code: 'Home' },
      { key: 'End', code: 'End' },
    ];

    const failures: string[] = [];

    for (const command of COMMANDS) {
      const chords = [command.defaultChord, command.platformDefaultChord?.darwin].filter(
        Boolean,
      ) as string[];

      for (const chordText of chords) {
        const chord = parseChord(chordText);
        if (!chord) continue;

        const fired = codes.some((candidate) =>
          matchesChord(
            {
              key: candidate.key,
              code: candidate.code,
              ctrlKey: Boolean(chord.ctrl),
              altKey: Boolean(chord.alt),
              shiftKey: Boolean(chord.shift),
              metaKey: Boolean(chord.meta),
            },
            chord,
          ),
        );

        if (!fired) {
          failures.push(`${command.id}: no keypress can match "${chordText}"`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('would report an arrow-key chord as unreachable', () => {
    // The guard's own guard. If `codeFor` ever grows arrow support this goes
    // red, which is the right moment to revisit `nav.prev` / `nav.next`.
    const chord = parseChord('Alt+ArrowLeft');
    expect(chord).not.toBeNull();
    expect(
      matchesChord(
        { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
        chord!,
      ),
    ).toBe(false);
  });
});
