/**
 * "Private" or "Shared with N", beside a party in a list.
 *
 * Built from the number of people holding a grant on the party (`accessCount` on
 * the Master's party list, `partyAccessCounts` in an Office's snapshot): one is
 * the creator alone, more is a shared party, none is a party open to everybody,
 * which gets no marker at all. A missing count draws nothing rather than
 * guessing "open": the number is a hint for the reader, never the rule — the
 * server decides who sees a party.
 */

import { StatusPill } from './DataDisplay.js';
import { t } from './i18n.js';

export function PartyVisibilityMark({ count }: { count: number | null | undefined }) {
  if (!count || count < 1) return null;

  return count === 1 ? (
    <span title={t('partyVisibility.privateHint')}>
      <StatusPill tone="default">{t('partyVisibility.private')}</StatusPill>
    </span>
  ) : (
    <span title={t('partyVisibility.sharedHint', { count })}>
      <StatusPill tone="accent">{t('partyVisibility.shared', { count })}</StatusPill>
    </span>
  );
}
