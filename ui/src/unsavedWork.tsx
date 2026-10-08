/**
 * Work somebody is part-way through, for "Save all and update" (1.4 R7b).
 *
 * An update closes the window. Before it does, everything open that can be saved
 * should be, and what cannot should be named, not silently thrown away.
 *
 * **What exists to save.** No form in this product keeps a draft on disk: a
 * half-filled lead lives in the screen's React state, kept alive by the shell's
 * screen cache, and is gone when the window closes. So there is no store to
 * "keep" drafts in; the choices are to *save* the work (a lead that is ready is
 * created, exactly as Ctrl+Enter would) or to *say* it cannot be saved yet
 * (no party chosen, a product card half-filled) and let the person decide.
 * Forms that register here: the New-lead form on both panels.
 *
 * The registry holds a function per screen rather than a copy of its state, so
 * it can never be out of date. A screen registers with {@link useUnsavedWork}
 * and the entry goes away when it unmounts.
 *
 * The same registrations, scoped to one way back, are what lets that back ask
 * before it throws the work away ({@link useGuardedBack}).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { useConfirm } from './ConfirmDialog.js';
import { t } from './i18n.js';

export interface UnsavedWorkItem {
  /** What it is, as the person would name it ("New lead for Acme"). */
  label: string;
  /**
   * Save it. Resolves true when it was saved, false when it cannot be saved as
   * it stands. Omitted for work that has no save: it is listed, never saved.
   */
  save?: () => Promise<boolean>;
}

type Provider = () => UnsavedWorkItem | null;

const providers = new Map<string, Provider>();

/**
 * The work registered under one way back — an `EditorScreen`, a chat room — so
 * that back can ask before it throws the work away (R8: Escape clicks it). Set
 * by {@link useGuardedBack}'s caller; `useUnsavedWork` below joins the nearest.
 */
export const UnsavedScope = createContext<Set<Provider> | null>(null);
let bridgeHooked = false;

/** What is open and unsaved right now, one entry per screen that has some. */
export function listUnsavedWork(): UnsavedWorkItem[] {
  const items: UnsavedWorkItem[] = [];
  for (const provider of providers.values()) {
    const item = provider();
    if (item) items.push(item);
  }
  return items;
}

export interface SaveAllResult {
  saved: UnsavedWorkItem[];
  /** Could not be saved: no save, a refusal, or one that threw. */
  unsaved: UnsavedWorkItem[];
}

/** Save everything that can be saved, one after the other. Never throws. */
export async function saveAllUnsavedWork(): Promise<SaveAllResult> {
  const result: SaveAllResult = { saved: [], unsaved: [] };
  for (const item of listUnsavedWork()) {
    let ok = false;
    try {
      ok = item.save ? await item.save() : false;
    } catch {
      ok = false;
    }
    (ok ? result.saved : result.unsaved).push(item);
  }
  return result;
}

/**
 * When the shell is about to close the window for an update it asks the page to
 * save first (`onBeforeUpdate` in the preload). Hooked once, the first time any
 * screen registers, so no App has to remember to.
 */
function hookDesktopShell(): void {
  if (bridgeHooked || typeof window === 'undefined') return;
  const bridge = (window as unknown as {
    orderbook?: { onBeforeUpdate?: (handler: () => Promise<void>) => void };
  }).orderbook;
  if (!bridge?.onBeforeUpdate) return;
  bridgeHooked = true;
  bridge.onBeforeUpdate(async () => {
    await saveAllUnsavedWork();
  });
}

/**
 * Register a screen's unsaved work while it has some. Pass `null` when there is
 * nothing to lose. The item is read through a ref, so it may be rebuilt every
 * render without re-registering (the same shape as `useResetGuard`).
 */
export function useUnsavedWork(id: string, item: UnsavedWorkItem | null): void {
  const latest = useRef<UnsavedWorkItem | null>(item);
  latest.current = item;
  const scope = useContext(UnsavedScope);

  useEffect(() => {
    const provider: Provider = () => latest.current;
    providers.set(id, provider);
    scope?.add(provider);
    hookDesktopShell();
    return () => {
      providers.delete(id);
      scope?.delete(provider);
    };
  }, [id, scope]);
}

/**
 * A way back that asks "Discard your changes?" before it throws typed work
 * away, rather than doing it silently — the question the role editor asks.
 *
 * The work is what was registered under `scope` (render the screen inside
 * `<UnsavedScope.Provider value={scope}>`), plus `held` for work the caller
 * keeps itself, above the provider. Nothing to lose: `onBack` runs at once.
 */
export function useGuardedBack(
  onBack: () => unknown,
  held = false,
): { scope: Set<Provider>; back: () => void } {
  const [scope] = useState(() => new Set<Provider>());
  const confirm = useConfirm();
  const back = (): void => {
    if (!held && ![...scope].some((work) => work() !== null)) {
      void onBack();
      return;
    }
    void confirm({
      title: t('action.back.discardTitle'),
      body: t('action.back.discardBody'),
      confirmLabel: t('action.back.discard'),
      cancelLabel: t('action.back.keep'),
      tone: 'danger',
    }).then((discard) => {
      if (discard) void onBack();
    });
  };
  return { scope, back };
}

/**
 * Whether a form differs from how it was loaded.
 *
 * `mark` is called where the form is filled (the effect that copies a record
 * into the fields, or the one that clears them for a new record), with the same
 * values that go into the fields; `dirty` is asked on every render with the
 * values as they are now. Compared as JSON, so the values must be plain data.
 * Nothing is dirty until `mark` has been called once, so a form that has not
 * been opened never claims to hold work.
 */
export function useFormBaseline<T>(
  initial?: T,
): { mark: (value: T) => void; dirty: (value: T) => boolean } {
  // A form that is mounted already filled (a dialog opened on a record) passes
  // its starting values here; one that fills itself in an effect calls `mark`.
  const base = useRef<string | null>(initial === undefined ? null : JSON.stringify(initial));
  return useRef({
    mark: (value: T): void => {
      base.current = JSON.stringify(value);
    },
    dirty: (value: T): boolean => base.current !== null && JSON.stringify(value) !== base.current,
  }).current;
}

/**
 * The "Save all" step of an update, for the Updates screens: resolves true when
 * it is fine to go on and close the window.
 *
 * Everything that can be saved is. If something could not be, the person is
 * shown what and asked; **No** keeps them on the screen with nothing lost.
 */
export function useSaveAllBeforeUpdate(): () => Promise<boolean> {
  const confirm = useConfirm();
  return useCallback(async () => {
    const { unsaved } = await saveAllUnsavedWork();
    if (unsaved.length === 0) return true;
    return confirm({
      title: t('updates.saveAll.unsavedTitle'),
      body: (
        <>
          <p>{t('updates.saveAll.unsavedBody')}</p>
          <ul>
            {unsaved.map((item) => (
              <li key={item.label}>{item.label}</li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: t('updates.saveAll.updateAnyway'),
      tone: 'danger',
    });
  }, [confirm]);
}

/** Test seam: forget every registration and the shell hook. */
export function __resetUnsavedWorkForTests(): void {
  providers.clear();
  bridgeHooked = false;
}
