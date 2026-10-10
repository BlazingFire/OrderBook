/**
 * Owner, 2026-10-07: saving from the New Order screen says "order", not "pending order".
 * Every message on the create and save path, the toasts, the checks, the server's refusals
 * and the new activity line, so none of them drifts back. The Pending Orders list, Final
 * Orders, conversion, notes and reports keep their names; those keys are not listed here.
 */

import { describe, expect, it } from 'vitest';

import { t } from '../src/index.js';

const SAVE_PATH_KEYS = [
  'lead.add.saved',
  'lead.add.savedOnline',
  'lead.add.savedProvisional',
  'lead.edit.saved',
  'lead.add.errors.generic',
  'lead.add.errors.partyRequired',
  'lead.add.draft.hintPieces',
  'lead.add.discardConfirm',
  'lead.add.review.title',
  'lead.add.catalogue.goneOne',
  'lead.add.catalogue.goneMany',
  'lead.numbered.toast',
  'notification.lead.numbered',
  'validation.lead.partyRequired',
  'validation.lead.itemsRequired',
  'validation.lead.sourceInvalid',
  'activity.lead.created',
] as const;

/** `t` with any of the listed keys and the placeholders any of them takes. */
const say = t as unknown as (
  lang: 'en',
  key: string,
  params: Record<string, string | number>,
) => string;

describe('the New Order save path says "order"', () => {
  it.each(SAVE_PATH_KEYS)('%s', (key) => {
    const text = say('en', key, {
      id: 'PO/1',
      count: 2,
      names: 'X',
      number: 'PO/1',
      party: 'P',
      value: 'v',
      actor: 'A',
    });
    expect(text).toMatch(/order/i);
    expect(text).not.toMatch(/pending order/i);
  });

  it('names the list and conversion New Orders (owner, 2026-10-08)', () => {
    expect(t('en', 'nav.leads')).toBe('New Orders');
    expect(t('en', 'lead.error.convert')).toMatch(/new order/i);
  });
});
