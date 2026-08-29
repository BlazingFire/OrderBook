/**
 * A request to the Master's panel-authenticated HTTP surface.
 *
 * Carries the pairing credentials **and** the acting user's token, because the
 * routes behind it run as the person, not as the machine: uploading an image
 * needs `products.edit`, and the audit trail has to name whoever did it.
 *
 * Lifted out of `http/app.ts` when the sign-in path needed it too — caching a
 * profile picture is the one thing that has to happen while somebody is
 * definitely online and definitely authorised. One copy rather than two, so the
 * header set cannot drift between callers.
 */

import { loadCredentials, masterBaseUrl } from '../services/credentials.store.js';
import { masterConnection } from '../realtime/master-connection.js';

// `globalThis.Response`, not Express's `Response` — both names are in scope in
// `app.ts` and the wrong one is a very confusing error.
export async function masterFetch(
  pathSuffix: string,
  init?: RequestInit,
): Promise<globalThis.Response> {
  const credentials = await loadCredentials();
  if (!credentials) throw new Error('This panel is not paired with a Master');

  const actingToken = masterConnection.getActingToken();

  return fetch(`${masterBaseUrl(credentials)}${pathSuffix}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-orderbook-panel-id': credentials.panelId,
      'x-orderbook-panel-secret': credentials.panelSecret,
      ...(actingToken ? { 'x-orderbook-acting-token': actingToken } : {}),
    },
  });
}
