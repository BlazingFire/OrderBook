/**
 * A request that failed and that no screen caught still has to be said out loud.
 *
 * Most screens catch what their own calls throw and show an error state, but a call
 * somebody forgot to catch used to fail silently: a list that never loaded and no
 * word about why. The toast provider listens for those (`unhandledrejection`) and shows
 * them in the reader's words, so the worst case is a message, not a screen that just
 * looks stuck.
 */

import { apiErrorText } from './errorText.js';
import { t } from './i18n.js';

/** The sentence for an unhandled rejection, or null when it is not worth a toast. */
export function unhandledFailureText(reason: unknown): string | null {
  if (!(reason instanceof Error)) return null;
  // A request somebody cancelled (a screen closing, a Stop button) did not fail.
  if (reason.name === 'AbortError') return null;
  // An error that carries a code came from our server: its own words. Anything else is
  // the network stack or a bug, and its English message is no help to the reader.
  return 'code' in reason
    ? apiErrorText(reason, 'error.generic.requestFailed')
    : t('error.generic.requestFailed');
}
