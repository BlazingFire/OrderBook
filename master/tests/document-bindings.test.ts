/**
 * The binding catalogue (`docs/backend-modules/10-TESTING.md` §6.7).
 *
 * Version 1 of the layout could not leak, because a block was a named section
 * and the only data that reached the page came through a closed column union.
 * Free-form elements could leak, and this catalogue is what stops them: an
 * element carries a *binding*, and every binding declares whether it is money
 * and which switch governs it.
 *
 * These tests are about the catalogue's completeness and its refusals. The
 * proof that the refusals reach the rendered bytes is PDF-55, which renders as
 * a rate-blind actor and reads the text back out of the PDF.
 */

import { describe, expect, it } from 'vitest';

import {
  BINDINGS,
  DOCUMENT_BINDINGS,
  assertBindingCatalogueComplete,
  isDocumentBinding,
  resolveBinding,
  type BindingContext,
} from '../src/domain/document-bindings.js';

const SWITCHES = {
  showPartyBlock: true,
  showTerms: true,
  showSignature: true,
  showRates: true,
};

const CONTEXT = {
  subject: { id: 'LD0000000001', items: [{}, {}] },
  party: {
    name: 'Sharma Tiles',
    partyCode: 'PT0001',
    addressLine1: '12 Kiln Road',
    addressLine2: null,
    city: 'Morbi',
    state: 'Gujarat',
    pincode: '363641',
    phone: '9876500000',
    email: 'orders@example.com',
    gstNumber: '24AAAAA0000A1Z5',
    customFields: { siteName: 'Plot 4' },
  },
  identity: { companyName: 'Smruti Ceramics' },
  title: 'Quotation',
  issuedOn: '2026-08-20',
  termsText: 'Rates hold for fifteen days.',
  footerText: 'Thank you',
  boxCount: 42,
  grandTotal: '15,000.00',
} as unknown as BindingContext;

const NO_CUSTOM = { values: {}, definitions: [] };

describe('the document binding catalogue', () => {
  it('PDF-77: every binding in the union has a spec, and nothing extra has one', () => {
    expect(() => assertBindingCatalogueComplete()).not.toThrow();

    for (const binding of DOCUMENT_BINDINGS) {
      const spec = BINDINGS[binding];

      expect(spec, binding).toBeDefined();
      expect(['plain', 'rate'], binding).toContain(spec.group);
      expect(spec.paletteLabel.length, binding).toBeGreaterThan(0);
    }

    expect(Object.keys(BINDINGS).sort()).toEqual([...DOCUMENT_BINDINGS].sort());
  });

  it('PDF-77: a name that is not in the catalogue resolves to nothing', () => {
    // Not an exception: an element naming something unknown drops, the same as
    // one naming something forbidden. A template edited by hand, or written by
    // a newer client, must not be able to crash a render.
    expect(isDocumentBinding('party.bankAccount')).toBe(false);

    expect(
      resolveBinding(
        { source: 'catalogue', binding: 'party.bankAccount' },
        CONTEXT,
        SWITCHES,
        true,
        NO_CUSTOM,
      ),
    ).toBeNull();
  });

  it('PDF-83: every money binding resolves to nothing for a rate-blind reader', () => {
    const money = DOCUMENT_BINDINGS.filter((binding) => BINDINGS[binding].group === 'rate');

    // If this list is ever empty the test below proves nothing, so assert it.
    expect(money.length).toBeGreaterThan(0);

    for (const binding of money) {
      expect(
        resolveBinding({ source: 'catalogue', binding }, CONTEXT, SWITCHES, false, NO_CUSTOM),
        binding,
      ).toBeNull();
    }
  });

  it('PDF-83: the same bindings do resolve when rates are in', () => {
    const total = resolveBinding(
      { source: 'catalogue', binding: 'document.grandTotal' },
      CONTEXT,
      SWITCHES,
      true,
      NO_CUSTOM,
    );

    expect(total).toContain('15,000.00');
  });

  it('PDF-83: a switch turned off suppresses every binding it governs', () => {
    const off = { ...SWITCHES, showPartyBlock: false };

    for (const binding of DOCUMENT_BINDINGS) {
      if (BINDINGS[binding].switchedBy !== 'showPartyBlock') continue;

      expect(
        resolveBinding({ source: 'catalogue', binding }, CONTEXT, off, true, NO_CUSTOM),
        binding,
      ).toBeNull();
    }
  });

  it('PDF-83: a party address keeps its own line breaks', () => {
    // Joined with newlines, not spaces: `wrapLines` splits on them before it
    // word-wraps, so an address entered as three lines prints as three lines.
    const address = resolveBinding(
      { source: 'catalogue', binding: 'party.addressLines' },
      CONTEXT,
      SWITCHES,
      true,
      NO_CUSTOM,
    );

    expect(address?.split('\n').length).toBeGreaterThan(1);
  });

  it('PDF-87: a custom field resolves from the record’s own blob, formatted by its type', () => {
    const definitions = [
      { entity: 'lead', key: 'siteName', fieldType: 'text', isActive: true },
      { entity: 'lead', key: 'visitedOn', fieldType: 'date', isActive: true },
      { entity: 'lead', key: 'urgent', fieldType: 'boolean', isActive: true },
      { entity: 'lead', key: 'floors', fieldType: 'number', isActive: true },
    ] as never;

    const values = {
      siteName: 'Plot 4',
      visitedOn: '2026-08-20',
      urgent: true,
      floors: 12,
    };

    const read = (key: string): string | null =>
      resolveBinding({ source: 'custom', entity: 'lead', key }, CONTEXT, SWITCHES, true, {
        values,
        definitions,
      });

    expect(read('siteName')).toBe('Plot 4');
    expect(read('urgent')).toBe('Yes');

    // Not money. Printing 12 as 0.12 because amounts are stored in paise would
    // be wrong in a way nobody would think to check.
    expect(read('floors')).toBe('12');
  });

  it('PDF-79: a custom field whose definition is gone resolves to nothing', () => {
    const values = { siteName: 'Plot 4' };

    // Deleted, deactivated, or never defined — all three drop the element. An
    // empty box under a stale label is a worse lie than a missing one.
    for (const definitions of [
      [] as never,
      [{ entity: 'lead', key: 'siteName', fieldType: 'text', isActive: false }] as never,
      [{ entity: 'order', key: 'siteName', fieldType: 'text', isActive: true }] as never,
    ]) {
      expect(
        resolveBinding(
          { source: 'custom', entity: 'lead', key: 'siteName' },
          CONTEXT,
          SWITCHES,
          true,
          { values, definitions },
        ),
      ).toBeNull();
    }
  });

  it('PDF-79: a custom field cannot name a priced field however it is spelled', () => {
    // The namespaces are separate by construction: this resolver indexes the
    // record's `custom_fields` blob and nothing else, so a field somebody named
    // "rate" reaches the blob, not the money.
    const definitions = [
      { entity: 'lead', key: 'totalAmount', fieldType: 'text', isActive: true },
    ] as never;

    expect(
      resolveBinding(
        { source: 'custom', entity: 'lead', key: 'totalAmount' },
        CONTEXT,
        SWITCHES,
        true,
        { values: {}, definitions },
      ),
    ).toBeNull();
  });
});
