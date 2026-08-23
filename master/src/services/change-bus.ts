/**
 * In-process publish/subscribe for data changes.
 *
 * Services publish here after a successful write; the realtime layer
 * subscribes and fans out over Socket.IO. This indirection is what keeps
 * services free of any Socket.IO knowledge — they describe *what* changed, not
 * *who* needs telling.
 */

import { EventEmitter } from 'node:events';
import type { DataChangedEvent, SyncConflict } from '@orderbook/shared';

const emitter = new EventEmitter();
const CHANGE_EVENT = 'change';
const CONFLICT_EVENT = 'conflict';

emitter.setMaxListeners(50);

export function publishChange(event: DataChangedEvent): void {
  emitter.emit(CHANGE_EVENT, event);
}

export function onChange(listener: (event: DataChangedEvent) => void): () => void {
  emitter.on(CHANGE_EVENT, listener);
  return () => emitter.off(CHANGE_EVENT, listener);
}

/**
 * A merge shadowed somebody's value.
 *
 * Kept on its own channel rather than folded into `data:changed`, because a
 * conflict is addressed to a *person* — it needs surfacing in the UI as
 * something to look at, not merely applied to a cached row.
 */
export function publishConflict(conflict: SyncConflict): void {
  emitter.emit(CONFLICT_EVENT, conflict);
}

export function onConflict(listener: (conflict: SyncConflict) => void): () => void {
  emitter.on(CONFLICT_EVENT, listener);
  return () => emitter.off(CONFLICT_EVENT, listener);
}
