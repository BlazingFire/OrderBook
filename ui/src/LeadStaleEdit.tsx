/**
 * Stale-edit protection for the pending order form, shared by both copies of
 * it (`LeadEntryScreen` here, `AddLeadScreen` on the Office).
 *
 * An edit sends only the fields the person changed since opening the record,
 * plus the field clocks (`sync.fieldHlc`) it opened at. The Master refuses a
 * field somebody else saved since with 409 `error.conflict.staleEdit`; an
 * Office queues the edit and the Master's merge records a conflict instead.
 * Either way nothing is silently overwritten.
 *
 * When somebody else's save reaches the open form, it says who and when, and
 * offers **Reload theirs** (open the form again on their version) or **Keep
 * mine** (carry on; the next save is checked against their version, so it
 * overwrites only what this person changed).
 */

import { useRef, useState } from 'react';
import { sameLines } from '@orderbook/shared';
import type { Lead, LeadUpdateInput, LineItemInput, PresenceLastWrite } from '@orderbook/shared';

import { t } from './i18n.js';
import { ConflictNotice } from './OptionListEditor.js';

/** The fields the form edits, by their `fieldHlc` names. */
const FORM_FIELDS = [
  'partyId',
  'ownerId',
  'sourcePlatform',
  'followUpDate',
  'partyWiseMode',
  'notes',
  'items',
] as const;

/** What the form would save, before it is cut down to the changes. */
export interface LeadFormValues {
  partyId: string;
  /** Absent when the form offers no Owner picker. */
  ownerId?: string;
  sourcePlatform: string | null;
  followUpDate: string | null;
  partyWiseMode: boolean;
  notes: string | null;
  items: LineItemInput[];
}

/**
 * Only what differs from the lead as it was opened, with the clocks to check
 * it against. Lines go only when they really changed (`sameLines`), so an
 * untouched line set never replaces somebody else's line edit. Null when
 * nothing changed at all.
 */
export function changedLeadFields(
  opened: Lead,
  values: LeadFormValues,
  base: Record<string, string>,
): LeadUpdateInput | null {
  const input: LeadUpdateInput = {};
  if (values.partyId !== opened.partyId) input.partyId = values.partyId;
  if (values.ownerId !== undefined && values.ownerId !== '' && values.ownerId !== opened.ownerId) {
    input.ownerId = values.ownerId;
  }
  if (values.sourcePlatform !== (opened.sourcePlatform ?? null)) {
    input.sourcePlatform = values.sourcePlatform;
  }
  if (values.followUpDate !== (opened.followUpDate ?? null)) input.followUpDate = values.followUpDate;
  if (values.partyWiseMode !== opened.partyWiseMode) input.partyWiseMode = values.partyWiseMode;
  if (values.notes !== (opened.notes ?? null)) input.notes = values.notes;
  if (!sameLines(opened.items, values.items)) input.items = values.items;
  if (Object.keys(input).length === 0) return null;
  return { ...input, baseFieldHlc: base };
}

/** The clocks of the form's fields that moved past both `seen` and `base`. */
function movedPast(
  now: Record<string, string>,
  seen: Record<string, string>,
  base: Record<string, string>,
): boolean {
  return FORM_FIELDS.some((field) => {
    const clock = now[field] ?? '';
    return clock !== (seen[field] ?? '') && clock !== (base[field] ?? '');
  });
}

/** A 409 `error.conflict.staleEdit`, with the clocks the Master holds now. */
function staleClocks(caught: unknown): Record<string, string> | null {
  if (!(caught instanceof Error)) return null;
  const error = caught as Error & { messageKey?: string; details?: { fieldHlc?: unknown } };
  if (error.messageKey !== 'error.conflict.staleEdit') return null;
  const clocks = error.details?.fieldHlc;
  return clocks && typeof clocks === 'object' ? (clocks as Record<string, string>) : {};
}

export interface LeadEditBase {
  /** The lead as the form opened it: what the changes are measured from. */
  opened: Lead | undefined;
  /** The clocks the next save is checked against. */
  base: Record<string, string>;
  /** Somebody else saved this record since; the notice is up. */
  conflicted: boolean;
  /** Reads a failed save: true when it was a stale edit, which the notice now shows. */
  refused: (caught: unknown) => boolean;
  /** Keep mine: carry on over their version. */
  keepMine: () => void;
}

export function useLeadEditBase(lead: Lead | undefined): LeadEditBase {
  const opened = useRef(lead).current;
  const [base, setBase] = useState<Record<string, string>>(() => lead?.sync.fieldHlc ?? {});
  const [seen, setSeen] = useState<Record<string, string>>(() => lead?.sync.fieldHlc ?? {});
  /** The Master's clocks from a 409, when the record here has not caught up yet. */
  const [refusedAt, setRefusedAt] = useState<Record<string, string> | null>(null);

  const now = lead?.sync.fieldHlc ?? {};
  const conflicted = refusedAt !== null || (lead !== undefined && movedPast(now, seen, base));

  return {
    opened,
    base,
    conflicted,
    refused(caught) {
      const clocks = staleClocks(caught);
      if (!clocks) return false;
      setRefusedAt(clocks);
      return true;
    },
    keepMine() {
      setBase({ ...now, ...(refusedAt ?? {}) });
      setSeen(now);
      setRefusedAt(null);
    },
  };
}

function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Ravi saved this at 10:42", with Reload theirs / Keep mine. */
export function StaleEditNotice({
  lastWrite,
  busy,
  onReload,
  onKeepMine,
}: {
  /** Who saved, when the Master said (a presence push); absent, the notice says somebody did. */
  lastWrite?: PresenceLastWrite | null;
  busy: boolean;
  onReload: () => void;
  onKeepMine: () => void;
}) {
  const message =
    lastWrite?.displayName && lastWrite.action !== 'deleted'
      ? t('lead.conflict.savedBy', { name: lastWrite.displayName, time: timeOf(lastWrite.at) })
      : t('error.conflict.staleEdit');
  return (
    <ConflictNotice
      message={message}
      diff={{}}
      busy={busy}
      onReload={onReload}
      onOverwrite={onKeepMine}
      overwriteLabel={t('lead.conflict.keepMine')}
    />
  );
}
