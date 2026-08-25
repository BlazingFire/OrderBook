/**
 * The "went quiet" rule as a pure classifier
 * (`docs/backend-modules/04-API-CONTRACT.md` §3.4), so Reports and any
 * future stale-leads view cannot disagree about it.
 *
 * Two rules that are easy to get wrong:
 *  - it **never keys on a stage name** — stages are tenant-configurable rows,
 *    renamable from the Fields screen;
 *  - it **never treats a terminal "Won"-shaped stage as converted on its
 *    own.** `20260302` deliberately produced leads that are in a won stage
 *    *and* converted, because conversion is a separate act that stamps
 *    `converted_order_id`. Only that stamp means converted; a terminal,
 *    unconverted lead is classified `lost` regardless of which terminal
 *    stage it sits in — the ledger has no record of a sale until conversion
 *    says so.
 *
 * `daysBetween` uses a pure calendar day-number conversion (no `Date`, no
 * timezone) so the SQL side and this pure classifier can never disagree at a
 * month or year boundary the way floating-point date arithmetic could.
 */

import type { LeadOutcome } from '@orderbook/shared';

import type { DateComponents } from './report-range.js';

/** A designer's placeholder, not the owner's number — see `HANDOFF.md`. Change here; nothing else. */
export const QUIET_AFTER_DAYS = 30;

export interface LeadOutcomeFacts {
  convertedOrderId: string | null;
  /** Whether the lead's *current* stage is terminal — never the stage name. */
  isTerminal: boolean;
  /** The last time this lead was touched — `leads.updated_at`'s date components. */
  lastActivityAt: DateComponents;
}

/** Proleptic Gregorian calendar day number (Fliegel & Van Flandern) — integer arithmetic only. */
function dayNumber({ year, month, day }: DateComponents): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

export function daysBetween(from: DateComponents, to: DateComponents): number {
  return dayNumber(to) - dayNumber(from);
}

export function classifyLeadOutcome(facts: LeadOutcomeFacts, asOf: DateComponents): LeadOutcome {
  if (facts.convertedOrderId !== null) return 'converted';
  if (facts.isTerminal) return 'lost';
  if (daysBetween(facts.lastActivityAt, asOf) >= QUIET_AFTER_DAYS) return 'quiet';
  return 'open';
}
