/**
 * The palette's Records list when the Master is switched off.
 *
 * An Office panel spends normal working hours offline — that is the product —
 * so a palette whose record half simply fails is a palette people stop opening.
 * This scans the snapshot the browser already holds instead.
 *
 * **It scans the view the panel server handed over, which is
 * `forCurrentUser(view)`** — masked and party-scoped by `SNAPSHOT_POLICY` before
 * it ever reached this bundle. There is no second permission check here because
 * there is nothing left to check: a record this person may not see is not in the
 * object being scanned. That is also why this cannot be pointed at any other
 * source of rows.
 *
 * Honest cost, and the palette says so on screen: the snapshot holds one page
 * per collection, not the whole catalogue. Finding nothing offline does not mean
 * there is nothing.
 */

import type { SearchHit } from '@orderbook/shared';

import type { LocalView } from './api';

/** Enough to be useful, few enough to stay one glance. */
const LIMIT = 20;

function matches(needle: string, ...fields: Array<string | null | undefined>): boolean {
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

export function searchLocalView(view: LocalView, term: string): SearchHit[] {
  const needle = term.trim().toLowerCase();
  if (needle.length < 2) return [];

  const hits: SearchHit[] = [];

  for (const product of view.products) {
    // The codes and colours live on the variants: "41" and "Magenta" both
    // have to find the model they belong to.
    const codes = product.variants.map((variant) => variant.code);
    const labels = product.variants.map((variant) => variant.label);
    if (!matches(needle, product.name, product.alias, product.sin, ...codes, ...labels)) continue;
    hits.push({
      kind: 'product',
      id: product.id,
      title: product.name,
      subtitle: `${product.categoryName} · ${codes.join(', ')}`,
      // No `ts_rank` offline. A flat score keeps the order the snapshot is in,
      // which is the Master's own, rather than inventing a ranking that would
      // visibly reshuffle the moment the link comes back.
      rank: 0,
    });
  }

  for (const party of view.parties) {
    if (!matches(needle, party.name, party.partyCode, party.phone, party.city)) continue;
    hits.push({
      kind: 'party',
      id: party.id,
      title: party.name,
      subtitle: party.partyCode,
      rank: 0,
    });
  }

  for (const lead of view.leads) {
    if (!matches(needle, lead.partyName, lead.notes)) continue;
    hits.push({
      kind: 'lead_line',
      id: lead.id,
      title: lead.partyName,
      subtitle: lead.stageName,
      rank: 0,
    });
  }

  for (const order of view.orders) {
    if (!matches(needle, order.partyName, order.notes)) continue;
    hits.push({
      kind: 'order_line',
      id: order.id,
      title: order.partyName,
      subtitle: order.stageName,
      rank: 0,
    });
  }

  return hits.slice(0, LIMIT);
}
