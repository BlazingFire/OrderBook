/**
 * One keydown listener for the whole panel, and the registry it dispatches to.
 *
 * Replaces `SaveShortcutSlot`, which was the same idea with one slot and one
 * hard-coded chord. Three things forced the rewrite rather than an extension:
 *
 *  · **A stack, not a slot.** Screens are kept mounted and hidden by
 *    `<Activity>`, which tears their effects down and rebuilds them on the way
 *    back — but React does not promise the outgoing pane's cleanup runs before
 *    the incoming pane's effect. The old single slot worked around that by
 *    releasing only its own handler, which left the *previous* screen's handler
 *    installed when the order came out the other way. A stack with
 *    identity-based removal is correct under either order: whoever is on top is
 *    the most recent registration still mounted.
 *  · **Scope.** `Ctrl+S` inside a dialog must save the dialog, and `F5` behind
 *    a scrim must not fire at all. That is one line here and impossible there.
 *  · **Rebindable.** The chord is data now, so the handler cannot be the thing
 *    that knows it.
 *
 * The listener sits on `document` at the **bubble** phase, deliberately. Escape
 * and Tab are refused as chords (`isReservedChord`), so this provider and
 * `useOverlay` never contend for the same key — that, not listener ordering, is
 * what keeps the two apart.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BINDINGS_STORAGE_KEY,
  COMMANDS_BY_ID,
  chordFor,
  commandsFor,
  matchesChord,
  parseBindings,
  type BindingMap,
} from '@orderbook/shared';

interface Registration {
  id: string;
  run: () => void;
}

interface KeyboardApi {
  panel: 'master' | 'office';
  bindings: BindingMap;
  /** `null` unbinds; the command then answers to nothing until rebound. */
  setBinding: (commandId: string, chord: string | null) => void;
  resetBindings: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  /** Run a command by id, as if its chord had been pressed. */
  run: (commandId: string) => void;
  push: (registration: Registration) => void;
  pop: (registration: Registration) => void;
}

const KeyboardContext = createContext<KeyboardApi | null>(null);

/**
 * Bindings are per machine, so the store is `localStorage` and not a setting.
 *
 * Keyed by user id as well, because two people share the shop PC and a remap is
 * a personal habit, not a property of the till.
 */
function storageKey(userId: string | null): string {
  return userId ? `${BINDINGS_STORAGE_KEY}:${userId}` : BINDINGS_STORAGE_KEY;
}

function load(userId: string | null): BindingMap {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    return raw ? parseBindings(JSON.parse(raw)) : {};
  } catch {
    // A corrupt entry, a private window, a full disk: a keyboard remap is a
    // convenience and must never be the reason a panel refuses to start.
    return {};
  }
}

/**
 * True while a dialog is on screen.
 *
 * Visible ones only, for the reason `useOverlay` documents at length: hidden
 * screens keep their DOM, so a closed pane's open Modal is still a
 * `[role="dialog"]` in the document and would otherwise mute every screen
 * shortcut on the pane somebody is actually looking at.
 */
function dialogIsOpen(): boolean {
  return [...document.querySelectorAll('[role="dialog"]')].some((dialog) =>
    dialog.checkVisibility(),
  );
}

/** Typing into a field, where a bare letter or `/` is text and not a command. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function KeyboardProvider({
  panel,
  userId = null,
  onNavigate,
  children,
}: {
  panel: 'master' | 'office';
  /** Whose remaps to load. `null` before sign-in. */
  userId?: string | null;
  /**
   * The panel's own navigation, called verbatim — the Master's `navigate` asks
   * the sub-nav for permission to leave, and Alt+N must not be an easier way to
   * lose a half-filled form than clicking the sidebar is.
   */
  onNavigate?: (tab: string) => void;
  children: ReactNode;
}) {
  const [bindings, setBindings] = useState<BindingMap>(() => load(userId));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    setBindings(load(userId));
  }, [userId]);

  const stack = useRef<Registration[]>([]);

  /*
   * Everything the listener reads lives in a ref.
   *
   * The listener is bound once, for the life of the panel — re-binding it on
   * every render would mean tearing down and rebuilding a document listener on
   * every keystroke, and the handlers it dispatches to are closures rebuilt on
   * each render anyway.
   */
  const latest = useRef({ bindings, panel, onNavigate });
  latest.current = { bindings, panel, onNavigate };

  const runCommand = useCallback((commandId: string): boolean => {
    const command = COMMANDS_BY_ID.get(commandId);
    if (!command) return false;

    // The most recent registration still mounted wins. A dialog that registers
    // `record.save` inside itself is above the screen behind it, which is what
    // makes Ctrl+S in an editor save the editor.
    for (let index = stack.current.length - 1; index >= 0; index -= 1) {
      const registration = stack.current[index];
      if (registration?.id === commandId) {
        registration.run();
        return true;
      }
    }

    // Nav is uniform across every screen, so the provider answers it rather
    // than making nine screens register nine near-identical handlers.
    if (command.tab && latest.current.onNavigate) {
      latest.current.onNavigate(command.tab);
      return true;
    }

    return false;
  }, []);

  const runRef = useRef(runCommand);
  runRef.current = runCommand;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Somebody nearer the keystroke already dealt with it — a Combobox
      // closing its own listbox, a grid moving its own cursor.
      if (event.defaultPrevented) return;

      const typing = isTypingTarget(event.target);
      const modal = dialogIsOpen();

      for (const command of commandsFor(latest.current.panel)) {
        const chord = chordFor(command.id, latest.current.bindings);
        if (!chord || !matchesChord(event, chord)) continue;

        // A bare chord inside a field is text. `/` opens the palette from a
        // screen and types a slash in a search box, which is the only way both
        // can be true at once.
        if (typing && !chord.ctrl && !chord.alt && !chord.meta) continue;

        // Modality. `F5` behind a scrim would refresh the screen somebody
        // cannot see, and `Alt+3` would move the pane under an open editor.
        if (modal && command.scope === 'screen') continue;

        if (command.id === 'palette.open' || command.id === 'palette.search') {
          event.preventDefault();
          setPaletteOpen(true);
          return;
        }
        if (command.id === 'keys.help') {
          event.preventDefault();
          setHelpOpen(true);
          return;
        }

        if (runRef.current(command.id)) event.preventDefault();
        return;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const api = useRef<KeyboardApi>({
    panel,
    bindings,
    setBinding: () => undefined,
    resetBindings: () => undefined,
    paletteOpen,
    setPaletteOpen,
    helpOpen,
    setHelpOpen,
    run: (commandId) => void runCommand(commandId),
    push(registration) {
      stack.current.push(registration);
    },
    pop(registration) {
      const index = stack.current.indexOf(registration);
      if (index >= 0) stack.current.splice(index, 1);
    },
  }).current;

  // The stable object is what keeps `push`/`pop` out of every consumer's
  // dependency arrays; the mutable fields are what the consumers read.
  api.panel = panel;
  api.bindings = bindings;
  api.paletteOpen = paletteOpen;
  api.helpOpen = helpOpen;
  api.setBinding = (commandId, chord) => {
    setBindings((current) => {
      const next = { ...current, [commandId]: chord };
      try {
        window.localStorage.setItem(storageKey(userId), JSON.stringify(next));
      } catch {
        // Unwritable storage costs the remap its persistence, not its effect.
      }
      return next;
    });
  };
  api.resetBindings = () => {
    try {
      window.localStorage.removeItem(storageKey(userId));
    } catch {
      // As above.
    }
    setBindings({});
  };

  return <KeyboardContext.Provider value={api}>{children}</KeyboardContext.Provider>;
}

/**
 * Read the keyboard state — for the palette, the shortcut sheet, and the
 * settings editor. Throws outside a provider rather than returning a silent
 * no-op, because every one of those is useless without it.
 */
export function useKeyboard(): KeyboardApi {
  const api = useContext(KeyboardContext);
  if (!api) throw new Error('useKeyboard must be used inside a KeyboardProvider');
  return api;
}

/**
 * Answer a command while this component is mounted.
 *
 * Pass `null` while there is nothing to do — mid-submit, or on a screen with an
 * empty form — and the command falls through to whatever is below it on the
 * stack instead of running a handler that would do nothing.
 */
export function useCommand(commandId: string, run: (() => void) | null): void {
  const api = useContext(KeyboardContext);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!api || !runRef.current) return;
    // The registration holds a stable indirection rather than the caller's
    // closure, so a handler rebuilt on every render does not churn the stack.
    const registration = { id: commandId, run: () => runRef.current?.() };
    api.push(registration);
    return () => api.pop(registration);
    // `run` is deliberately absent: its identity changes every render, and the
    // ref above is what carries the current one.
  }, [api, commandId, run === null]);
}
