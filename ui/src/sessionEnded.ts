/**
 * "The server has stopped honouring this session" — told once, to whoever is
 * listening, from the one place every request already passes through.
 *
 * Before this existed, a grep for `401` across both panels' sources and `ui/`
 * returned a single hit, and it was a comment. Both api clients built their
 * `ApiError` from the response body with no branch on `response.status`, so a
 * client could not tell a dead session from any other failed request: the
 * window stayed rendered as signed in, every screen showed its own generic
 * error toast, and nothing said why. The most ordinary cause is the most
 * confusing one — changing your own password invalidates every session you
 * have, including the window you changed it from.
 *
 * Deliberately a module-level emitter rather than React context: `send()` is
 * a plain function called from outside the component tree, and threading a
 * setter down to it would mean every api call site knew about session state.
 *
 * `reason` is a catalogue key, so the sign-in screen can say *why* in the
 * reader's own language rather than showing a generic "signed out".
 */

import type { MessageKey } from '@orderbook/shared';

export type SessionEndedReason = MessageKey;

type Listener = (reason: SessionEndedReason) => void;

const listeners = new Set<Listener>();

/**
 * Called by a panel's api client when the server answers 401.
 *
 * A no-op when nobody is listening, which is the case during first-run and on
 * the sign-in screen itself — a 401 there is an ordinary wrong password, not a
 * lost session.
 */
export function publishSessionEnded(reason: SessionEndedReason): void {
  for (const listener of [...listeners]) listener(reason);
}

/** Returns the unsubscribe, for a `useEffect` cleanup. */
export function onSessionEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
