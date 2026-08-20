/**
 * In-process publish/subscribe for data changes.
 *
 * Services publish here after a successful write; the realtime layer
 * subscribes and fans out over Socket.IO. This indirection is what keeps
 * services free of any Socket.IO knowledge — they describe *what* changed, not
 * *who* needs telling.
 */

import { EventEmitter } from 'node:events';
import type { DataChangedEvent } from '@orderbook/shared';

const emitter = new EventEmitter();
const CHANGE_EVENT = 'change';

emitter.setMaxListeners(50);

export function publishChange(event: DataChangedEvent): void {
  emitter.emit(CHANGE_EVENT, event);
}

export function onChange(listener: (event: DataChangedEvent) => void): () => void {
  emitter.on(CHANGE_EVENT, listener);
  return () => emitter.off(CHANGE_EVENT, listener);
}
