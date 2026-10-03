/**
 * The New / Edit pending order form on the Master: the shared `LeadEntryScreen`
 * plus the one thing the Office gets from its local snapshot and this panel has
 * to ask for, `GET /api/lead-entry`.
 *
 * The view is re-read whenever `revision` moves (a party's records, the option
 * lists or stock changed), and **the form is never unmounted for it**: the busy
 * mark shows only until the first answer, after which the previous view stays
 * on screen while the next one loads. Unmounting would throw away a half-typed
 * lead.
 */

import { useEffect, useState } from 'react';
import type { Lead, PresenceLastWrite } from '@orderbook/shared';
import {
  BusyMark,
  ConflictBanner,
  LeadEntryScreen,
  apiErrorText,
  type LeadEntryView,
} from '@orderbook/ui';

import { api } from '../api';
import { leadEntryTransport } from '../transports';

interface Props {
  /** Moves when something the form's view is built from changes. */
  revision: number;
  /** Bumped by the shell each time the form is asked for. */
  focusNonce?: number;
  /** `parties.create`: whether the party list offers Create party. */
  canCreateParty: boolean;
  /** A saved lead to edit instead of starting a new one. */
  lead?: Lead;
  /** The last save somebody else made to `lead` while it is open. */
  remoteChange?: PresenceLastWrite | null;
  onSaved: (id: string, saved?: Lead) => void;
  onCancel: () => void;
}

export function LeadEntry({
  revision,
  focusNonce,
  canCreateParty,
  lead,
  remoteChange,
  onSaved,
  onCancel,
}: Props) {
  const [view, setView] = useState<LeadEntryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .leadEntryView()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(apiErrorText(caught, 'lead.add.errors.generic'));
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  if (!view) return error ? <ConflictBanner>{error}</ConflictBanner> : <BusyMark />;

  return (
    <>
      {error && <ConflictBanner>{error}</ConflictBanner>}
      <LeadEntryScreen
        view={view}
        transport={leadEntryTransport}
        canCreateParty={canCreateParty}
        focusNonce={focusNonce}
        lead={lead}
        remoteChange={remoteChange}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </>
  );
}
