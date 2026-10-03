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
 *    identity-based removal is correct under either order.
 *  · **Ordered by mount, not by effect timing.** The stack is kept sorted by
 *    when the registering component mounted (`useCommand` explains why), so
 *    whoever is on top is the most recently mounted registration still live —
 *    however often, and in whatever order, React re-runs the effects.
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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  /** When the registering component mounted — see `useCommand`. */
  order: number;
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
  /**
   * Whether running this command now would do anything — what the palette
   * lists. A screen that has nothing to save, a screen the sidebar does not
   * offer this person, a shell command the role may not use: each is a row
   * that closes the palette and does nothing, so the palette leaves it out.
   */
  offers: (commandId: string) => boolean;
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
  canNavigate,
  shellCommands,
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
  /**
   * Whether `onNavigate` would go to this screen — the same test the panel's
   * navigation applies, so the palette offers a screen exactly when the
   * sidebar does. Absent means every screen.
   */
  canNavigate?: (tab: string) => boolean;
  /**
   * Commands the shell answers rather than a screen — resetting the visible
   * pane, reloading, starting a new record.
   *
   * They live here rather than in a `useCommand` call because the component
   * that owns them is this provider's *parent*: `App()` renders the provider,
   * so it cannot use a hook that reads its context. A registration from a
   * screen still wins, because the stack is consulted first.
   */
  shellCommands?: Record<string, (() => void) | null | undefined>;
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
  const latest = useRef({ bindings, panel, onNavigate, canNavigate, shellCommands });
  latest.current = { bindings, panel, onNavigate, canNavigate, shellCommands };

  const runCommand = useCallback((commandId: string): boolean => {
    const command = COMMANDS_BY_ID.get(commandId);
    if (!command) return false;

    // The provider's own state, answered here rather than in the keydown
    // listener so a palette row or a menu item reaches it exactly as the chord
    // does. The palette runs every row through `run()`, and while this switch
    // lived in the listener, "Keyboard shortcuts" picked from the palette
    // closed the palette and opened nothing.
    if (command.id === 'palette.open' || command.id === 'palette.search') {
      setPaletteOpen(true);
      return true;
    }
    if (command.id === 'keys.help') {
      setHelpOpen(true);
      return true;
    }

    // The most recently mounted registration still live wins. A dialog that
    // registers `record.save` inside itself is above the screen behind it,
    // which is what makes Ctrl+S in an editor save the editor.
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

    const shell = latest.current.shellCommands?.[commandId];
    if (shell) {
      shell();
      return true;
    }

    return false;
  }, []);

  /*
   * The same order `runCommand` answers in, asked without running anything.
   * `view.find` has no entry here on purpose: it is answered by the chord alone
   * (see the listener below), so as a palette row it did nothing.
   */
  const offersCommand = useCallback((commandId: string): boolean => {
    const command = COMMANDS_BY_ID.get(commandId);
    if (!command) return false;
    if (command.id === 'palette.open' || command.id === 'palette.search') return true;
    if (command.id === 'keys.help') return true;
    if (stack.current.some((registration) => registration.id === commandId)) return true;
    if (command.tab && latest.current.onNavigate) {
      return latest.current.canNavigate?.(command.tab) ?? true;
    }
    return Boolean(latest.current.shellCommands?.[commandId]);
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
        // A function key is never text, so F1 still opens help from a field.
        if (typing && !chord.ctrl && !chord.alt && !chord.meta && !/^F\d{1,2}$/.test(chord.key)) continue;

        // `Ctrl+F` is the exception the modifier test above cannot see. It
        // carries a modifier, so it survives that check — and then swallows the
        // find somebody just pressed while typing a party name into a search
        // box, replacing their browser's find with a palette they did not ask
        // for. A screen-level command has no business firing inside a field;
        // `record.save` is `global` precisely so Ctrl+S still does.
        if (typing && command.scope === 'screen') continue;

        // Modality. `F5` behind a scrim would refresh the screen somebody
        // cannot see, and `Alt+3` would move the pane under an open editor.
        if (modal && command.scope === 'screen') continue;

        if (command.id === 'view.find' || command.id === 'palette.search') {
          // `/` is the easy one: it does what Ctrl+F does, so one bare key
          // reaches the search box of Pending Orders, Final Orders, Products and
          // Parties alike — and the palette's record search on a screen with none.
          event.preventDefault();
          // The screen's own search box when it has one — the one on screen,
          // not one on a hidden pane — and the palette's record search when
          // it has none, so the chord means "search here" everywhere.
          //
          // Chord only, unlike the palette and help cases in `runCommand`: a
          // palette row runs as the palette closes, and the palette's focus
          // restore (`useOverlay`) can then hand focus straight back to
          // whatever held it before — so the palette leaves the row out
          // (`offersCommand`) rather than offer one that does nothing.
          const box = Array.from(
            document.querySelectorAll<HTMLInputElement>('input[data-screen-search]'),
          ).find((input) => input.offsetParent !== null);
          if (box) {
            box.focus();
            box.select();
          } else {
            setPaletteOpen(true);
          }
          return;
        }

        if (runRef.current(command.id)) event.preventDefault();
        return;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  /*
   * The stack's two methods never change identity, and `useCommand` depends on
   * them rather than on the api object around them — which is rebuilt whenever
   * the palette or the help sheet opens or closes, and used to pop and re-push
   * every registration in the panel each time it did.
   */
  const registry = useRef({
    push(registration: Registration) {
      // Inserted by mount order rather than appended, because the effects that
      // push run children first: a screen and the dialog inside it pushed in
      // arrival order would put the screen on top.
      let index = stack.current.length;
      while (index > 0 && (stack.current[index - 1]?.order ?? 0) > registration.order) index -= 1;
      stack.current.splice(index, 0, registration);
    },
    pop(registration: Registration) {
      const index = stack.current.indexOf(registration);
      if (index >= 0) stack.current.splice(index, 1);
    },
  }).current;

  /*
   * A new object whenever the state changes, deliberately.
   *
   * `children` is the same element on every render of this provider, so React
   * skips the subtree unless the context value itself changes identity — mutate
   * fields on one stable object and the palette goes on showing the binding it
   * read the first time.
   */
  const api = useMemo<KeyboardApi>(
    () => ({
      panel,
      bindings,
      paletteOpen,
      helpOpen,
      setPaletteOpen,
      setHelpOpen,
      run: (commandId) => void runCommand(commandId),
      offers: offersCommand,
      push: registry.push,
      pop: registry.pop,
      setBinding: (commandId, chord) => {
        setBindings((current) => {
          const next = { ...current, [commandId]: chord };
          try {
            window.localStorage.setItem(storageKey(userId), JSON.stringify(next));
          } catch {
            // Unwritable storage costs the remap its persistence, not its effect.
          }
          return next;
        });
      },
      resetBindings: () => {
        try {
          window.localStorage.removeItem(storageKey(userId));
        } catch {
          // As above.
        }
        setBindings({});
      },
    }),
    [panel, bindings, paletteOpen, helpOpen, userId, runCommand, offersCommand, registry],
  );

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

/** How many `useCommand` callers have mounted, for their place on the stack. */
let mounted = 0;

/**
 * Answer a command while this component is mounted.
 *
 * Pass `null` while there is nothing to do — mid-submit, or on a screen with an
 * empty form — and the command falls through to whatever is below it on the
 * stack instead of running a handler that would do nothing.
 *
 * **Priority is mount order, fixed at the first render.** A component renders
 * after its parent, so a dialog inside a screen always outranks the screen,
 * and a component mounted later outranks one mounted earlier. That rank never
 * moves afterwards, however the effect below is re-run: when the handler flips
 * between `null` and a function, or when `<Activity>` shows a pane again and
 * re-runs all of its effects, children first. Ranked by push order instead,
 * either left the screen above the open `PartyFormModal` it contains — as did
 * every palette open while this effect still depended on the api object — and
 * Ctrl+S saved the lead instead of the party.
 *
 * The one arrangement this cannot rank is a dialog kept mounted *before* the
 * screens it covers — an always-present dialog in a panel's `App.tsx`. Every
 * dialog that registers a command today is rendered inside its screen; one at
 * the app level should mount only while open (`{open && <Dialog />}`), which
 * makes it the most recent mount.
 */
export function useCommand(commandId: string, run: (() => void) | null): void {
  const api = useContext(KeyboardContext);
  // The stable methods, not the api object: see `registry` above.
  const push = api?.push;
  const pop = api?.pop;
  const [order] = useState(() => (mounted += 1));
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!push || !pop || !runRef.current) return;
    // The registration holds a stable indirection rather than the caller's
    // closure, so a handler rebuilt on every render does not churn the stack.
    const registration = { id: commandId, order, run: () => runRef.current?.() };
    push(registration);
    return () => pop(registration);
    // `run` is deliberately absent: its identity changes every render, and the
    // ref above is what carries the current one. Only the null/non-null flip
    // re-registers, and `order` keeps even that from moving it on the stack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, pop, commandId, order, run === null]);
}
