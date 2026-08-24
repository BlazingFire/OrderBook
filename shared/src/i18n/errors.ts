/**
 * One wire shape for the HTTP error envelope AND the socket ack, so the two
 * cannot drift apart again — they already had, once: `details` reached the
 * browser over HTTP and died at the socket.
 */

import type { MessageKey, MessageParams } from './keys.js';

export interface ErrorPayload {
  /** Stable code — branch on this, never on the message. */
  error: string;
  /** English, derived from `messageKey`. The last-resort render tier. */
  message: string;
  messageKey?: MessageKey;
  params?: MessageParams;
  details?: Record<string, unknown>;
}

export function hasMessageKey(value: unknown): value is { messageKey: MessageKey } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'messageKey' in value &&
    typeof (value as { messageKey: unknown }).messageKey === 'string'
  );
}

/** The coarse `error.<code>`-family token for a failure whose thrower named no finer one. */
const CODE_TOKENS: Record<string, MessageKey> = {
  validation_error: 'error.generic.validation',
  unauthorized: 'error.unauthorized',
  forbidden: 'error.generic.forbidden',
  tenant_violation: 'error.tenantViolation',
  not_found: 'error.generic.notFound',
  conflict: 'error.generic.conflict',
  internal_error: 'error.generic.internal',
  internal: 'error.generic.internal',
  unavailable: 'error.unavailable',
  master_command_failed: 'error.generic.masterCommandFailed',
  invalid_request: 'error.generic.invalidRequest',
  not_signed_in: 'error.unauthorized',
  not_synced: 'error.generic.notSynced',
  permission_denied: 'error.generic.forbidden',
  queue_failed: 'error.generic.queueFailed',
  scan_failed: 'error.generic.scanFailed',
  sign_in_failed: 'error.unauthorized.signInFailed',
  pairing_failed: 'error.generic.pairingFailed',
  invalid_credentials: 'error.generic.invalidCredentials',
  locked_out: 'error.generic.lockedOut',
  unknown_here: 'error.generic.unknownHere',
};

/** Total over every stable code the two servers emit, with `error.unknown` as the last resort. */
export function errorMessageKey(code: string): MessageKey {
  return CODE_TOKENS[code] ?? 'error.unknown';
}
