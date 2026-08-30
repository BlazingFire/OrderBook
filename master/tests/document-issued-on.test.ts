/**
 * The date printed on a customer-facing document is the **business** timezone's
 * calendar day, and only the caller — which can read `config.locale.timeZone` —
 * knows what that day is. This pins the model to echoing the day it is handed,
 * so a clock of the model's own cannot creep back in front of a quotation.
 */

import { describe, expect, it } from 'vitest';
import type { Lead } from '@orderbook/shared';
import { TEMPLATE_DEFAULTS, normaliseLayout } from '@orderbook/shared';

import { buildDocumentModel } from '../src/domain/document-model.js';

/** Only the three fields the model reads off a subject; the rest is not in play here. */
const SUBJECT = { id: 'LD0000000001', totalAmount: null, items: [] } as unknown as Lead;

const GEOMETRY = {
  paperSize: TEMPLATE_DEFAULTS.quotation.paperSize,
  orientation: TEMPLATE_DEFAULTS.quotation.orientation,
  margins: TEMPLATE_DEFAULTS.quotation.margins,
};

/** Converted the way the mapper converts it, so the model gets what it expects. */
const LAYOUT = normaliseLayout(TEMPLATE_DEFAULTS.quotation.layout, GEOMETRY);

const TEMPLATE = {
  ...TEMPLATE_DEFAULTS.quotation,
  layout: LAYOUT,
  logoAssetId: null,
  signatureAssetId: null,
};

describe('document model — the issue date arrives from the caller', () => {
  it('formats the supplied business day rather than a day of its own', () => {
    const model = buildDocumentModel({
      subject: SUBJECT,
      subjectKind: 'lead',
      party: null,
      template: TEMPLATE,
      identity: null,
      ratesIncluded: false,
      colourHex: new Map(),
      issuedOn: '2026-08-20',
      layout: LAYOUT,
    });

    expect(model.issuedOn).toBe('20 Aug 2026');
  });
});
