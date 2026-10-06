/**
 * Whether a party this person creates is private to them (and the administrators).
 *
 * The Master gives a creator without `party.accessAll` a `manage` grant on every party they
 * create (`createParty`), so only they and the holders of `party.accessAll` see it until an
 * administrator shares it. The party form says so before it is saved. The form is reached
 * from half a dozen screens that do not all carry the person's permissions, so each panel's
 * shell sets this once, from the signed-in person, and the form reads it.
 */

import { useSyncExternalStore } from 'react';

let privateByDefault = false;
const listeners = new Set<() => void>();

export function setCreatedPartiesPrivate(next: boolean): void {
  if (next === privateByDefault) return;
  privateByDefault = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCreatedPartiesPrivate(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => privateByDefault,
    () => false,
  );
}
