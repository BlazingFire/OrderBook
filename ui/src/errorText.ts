/**
 * Turn whatever a failed api call threw into a sentence for the reader.
 *
 * The three-tier error pipeline — a specific `messageKey`, failing that the
 * coarse `error.<code>` token, failing that English — was built end to end on
 * both servers and had **no client**. A repo-wide grep for `.messageKey` in
 * either front end found only the two assignments that create it, the two
 * server-side serialisers, and the type definitions. Every screen did
 * `caught instanceof Error ? caught.message : …`, which renders the server's
 * `message` the server composed and throws the key away, so no screen could
 * word a failure for itself.
 *
 * Structurally typed rather than taking each panel's own `ApiError` class:
 * `ui/` cannot import from either panel, and the two classes are the same
 * shape where it matters.
 */

import { errorMessageKey } from '@orderbook/shared';
import type { MessageKey, MessageParams } from '@orderbook/shared';

import { t } from './i18n.js';

interface ApiErrorShape {
  code: string;
  messageKey?: MessageKey;
  params?: MessageParams;
}

function isApiErrorShape(value: unknown): value is ApiErrorShape {
  return (
    value instanceof Error &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string'
  );
}

/**
 * `fallback` is used only when the thrown value carries no code at all — a
 * network stack failure, or something that is not an `Error`.
 */
export function apiErrorText(caught: unknown, fallback: MessageKey): string {
  if (isApiErrorShape(caught)) {
    if (caught.messageKey) return t(caught.messageKey, caught.params);
    return t(errorMessageKey(caught.code));
  }
  return caught instanceof Error ? caught.message : t(fallback);
}

/**
 * A refused delete names what still points at the record (`details.blockedBy`,
 * a 409); the reader needs those names, not "could not delete".
 */
export function deleteErrorText(caught: unknown, fallback: MessageKey): string {
  const blockedBy = isApiErrorShape(caught)
    ? (caught as { details?: { blockedBy?: unknown } }).details?.blockedBy
    : undefined;
  const labels = Array.isArray(blockedBy)
    ? blockedBy
        .map((blocker) => (blocker as { label?: unknown } | null)?.label)
        .filter((label): label is string => typeof label === 'string' && label !== '')
    : [];
  return labels.length > 0
    ? t('leadsOrders.delete.blocked', { items: labels.slice(0, 3).join(', ') })
    : apiErrorText(caught, fallback);
}
