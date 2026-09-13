/**
 * What a placed element is allowed to print, and who is allowed to see it.
 *
 * A pure peer of `document-model.ts`, and it exists for one reason. Version 1
 * of the layout could not leak anything: a block was a named section, and the
 * only data that reached the page came through the model's closed
 * `DocumentColumnKey` union. A free-form element that could name arbitrary
 * record data would throw that away — it is precisely the code path
 * `document-model.ts` warns about, the one that "will print a rate the first
 * time somebody adds a code path".
 *
 * So an element does not carry data. It carries a **binding**, and every
 * binding in this catalogue declares two things:
 *
 *  · `group` — `rate` bindings are **omitted from the model entirely** when
 *    rates are out. Not blanked, not zeroed, not flagged hidden. Absent, the
 *    same way the rate column is absent, so the renderer has nothing to decide.
 *  · `switchedBy` — which of the eight typed template switches also suppresses
 *    it. This is how those switches keep meaning something once geometry
 *    exists, and it is why they stay BOOLEAN columns rather than moving into
 *    the layout JSON.
 *
 * Resolution happens here and produces a **string**. Nothing below this file —
 * nothing in `master/src/pdf/` — ever sees a subject, a party, a template or a
 * binding. That boundary is checked by a test that reads the source.
 */

import type { Lead, Order, Party, MasterIdentity } from '@orderbook/shared';
import type { CustomFieldDefinition, DocumentBindingRef } from '@orderbook/shared';

import { formatDateForDocument } from './document-text.js';

/**
 * Every binding an element may name.
 *
 * A closed union, exhaustively mapped below. Adding a member without a spec is
 * a compile error, and a runtime count assert catches the case where the union
 * is widened by something the compiler cannot see.
 */
export type DocumentBinding =
  | 'company.name'
  | 'document.title'
  | 'document.reference'
  | 'document.issuedOn'
  | 'document.terms'
  | 'document.footer'
  | 'document.boxCount'
  | 'document.grandTotal'
  | 'document.lineCount'
  | 'party.name'
  | 'party.code'
  | 'party.addressLines'
  | 'party.city'
  | 'party.state'
  | 'party.pincode'
  | 'party.phone'
  | 'party.email'
  | 'party.gstNumber';

export const DOCUMENT_BINDINGS: readonly DocumentBinding[] = [
  'company.name',
  'document.title',
  'document.reference',
  'document.issuedOn',
  'document.terms',
  'document.footer',
  'document.boxCount',
  'document.grandTotal',
  'document.lineCount',
  'party.name',
  'party.code',
  'party.addressLines',
  'party.city',
  'party.state',
  'party.pincode',
  'party.phone',
  'party.email',
  'party.gstNumber',
];

/**
 * `plain` is printable to anybody who may render the document at all.
 * `rate` is money, and drops with `ratesIncluded`.
 */
type BindingGroup = 'plain' | 'rate';

/** The eight typed switches, by the name they carry on the template. */
type BindingSwitch = 'showPartyBlock' | 'showTerms' | 'showSignature' | 'showRates';

export interface BindingContext {
  subject: Lead | Order;
  party: Party | null;
  identity: MasterIdentity | null;
  title: string;
  issuedOn: string;
  termsText: string | null;
  footerText: string | null;
  boxCount: number;
  /** Already formatted; absent when rates are out, which is belt to the group's braces. */
  grandTotal: string | null;
}

export interface BindingSpec {
  group: BindingGroup;
  /** null when no switch governs it. */
  switchedBy: BindingSwitch | null;
  /** A label for the designer's palette. Not printed — the element carries its own. */
  paletteLabel: string;
  /** null means "nothing to print", and an element that resolves to null is dropped. */
  resolve(context: BindingContext): string | null;
}

const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * A party's address as the party block has always assembled it, joined with
 * newlines rather than spaces.
 *
 * `wrapLines` splits on newlines before it word-wraps, so an address entered as
 * three lines prints as three lines instead of being re-flowed into a
 * paragraph.
 */
function addressLinesOf(party: Party | null): string | null {
  if (!party) return null;

  const lines = [party.addressLine1, party.addressLine2, party.city, party.state]
    .map((line) => blankToNull(line))
    .filter((line): line is string => line !== null);

  return lines.length > 0 ? lines.join('\n') : null;
}

function identityLines(identity: MasterIdentity | null): string | null {
  if (!identity) return null;
  return blankToNull(identity.companyName);
}

/**
 * The catalogue.
 *
 * `Record<DocumentBinding, BindingSpec>` is the guard: a new binding with no
 * entry does not compile.
 */
export const BINDINGS: Readonly<Record<DocumentBinding, BindingSpec>> = {
  'company.name': {
    group: 'plain',
    switchedBy: null,
    paletteLabel: 'Company name',
    resolve: (context) => identityLines(context.identity),
  },

  'document.title': {
    group: 'plain',
    switchedBy: null,
    paletteLabel: 'Document title',
    resolve: (context) => blankToNull(context.title),
  },
  'document.reference': {
    group: 'plain',
    switchedBy: null,
    paletteLabel: 'Reference',
    resolve: (context) => blankToNull(context.subject.id),
  },
  'document.issuedOn': {
    group: 'plain',
    switchedBy: null,
    paletteLabel: 'Date',
    resolve: (context) => formatDateForDocument(context.issuedOn),
  },
  'document.terms': {
    group: 'plain',
    switchedBy: 'showTerms',
    paletteLabel: 'Terms',
    resolve: (context) => blankToNull(context.termsText),
  },
  'document.footer': {
    group: 'plain',
    switchedBy: null,
    paletteLabel: 'Footer text',
    resolve: (context) => blankToNull(context.footerText),
  },
  'document.boxCount': {
    group: 'plain',
    switchedBy: null,
    paletteLabel: 'Total boxes',
    resolve: (context) => String(context.boxCount),
  },
  'document.grandTotal': {
    // The one that matters. Grouped as money, so an element naming it is not
    // built at all for a reader without the rate permission.
    group: 'rate',
    switchedBy: 'showRates',
    paletteLabel: 'Grand total',
    resolve: (context) => (context.grandTotal === null ? null : `₹${context.grandTotal}`),
  },
  'document.lineCount': {
    group: 'plain',
    switchedBy: null,
    paletteLabel: 'Number of lines',
    resolve: (context) => String(context.subject.items.length),
  },

  'party.name': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party name',
    resolve: (context) => blankToNull(context.party?.name ?? null),
  },
  'party.addressLines': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party address',
    resolve: (context) => addressLinesOf(context.party),
  },
  'party.city': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party city',
    resolve: (context) => blankToNull(context.party?.city ?? null),
  },
  'party.phone': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party phone',
    resolve: (context) => blankToNull(context.party?.phone ?? null),
  },
  'party.code': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party code',
    resolve: (context) => blankToNull(context.party?.partyCode ?? null),
  },
  'party.state': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party state',
    resolve: (context) => blankToNull(context.party?.state ?? null),
  },
  'party.pincode': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party pincode',
    resolve: (context) => blankToNull(context.party?.pincode ?? null),
  },
  'party.email': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party email',
    resolve: (context) => blankToNull(context.party?.email ?? null),
  },
  'party.gstNumber': {
    group: 'plain',
    switchedBy: 'showPartyBlock',
    paletteLabel: 'Party GST number',
    resolve: (context) => blankToNull(context.party?.gstNumber ?? null),
  },
};

/**
 * The union and the catalogue agree.
 *
 * The `Record` type already refuses a missing entry, but a union widened to
 * `string` by an inference nobody intended would defeat that silently. Counting
 * costs nothing and fails loudly at boot instead of at render time.
 */
export function assertBindingCatalogueComplete(): void {
  const specs = Object.keys(BINDINGS).length;

  if (specs !== DOCUMENT_BINDINGS.length) {
    throw new Error(
      `Binding catalogue is out of step: ${specs} specs for ${DOCUMENT_BINDINGS.length} bindings`,
    );
  }
}

export const isDocumentBinding = (value: string): value is DocumentBinding =>
  Object.prototype.hasOwnProperty.call(BINDINGS, value);

/** The eight switches, as the resolver needs to read them. */
export interface BindingSwitches {
  showPartyBlock: boolean;
  showTerms: boolean;
  showSignature: boolean;
  showRates: boolean;
}

/**
 * Resolve one element's binding to printable text, or to null.
 *
 * **Null means the element is not built.** Every reason an element might not
 * print collapses into that one answer — the reader may not see prices, a
 * switch is off, the record simply has no value, the custom field was deleted.
 * A caller that receives null drops the element; there is deliberately no way
 * to ask for "the value, but hidden", because a hidden value is a value on the
 * page.
 */
export function resolveBinding(
  ref: DocumentBindingRef,
  context: BindingContext,
  switches: BindingSwitches,
  ratesIncluded: boolean,
  customFields: {
    values: Record<string, unknown>;
    definitions: readonly CustomFieldDefinition[];
  },
): string | null {
  if (ref.source === 'custom') return resolveCustomField(ref, context, customFields);

  if (!isDocumentBinding(ref.binding)) return null;

  const spec = BINDINGS[ref.binding];

  // Money, and this reader is not seeing money.
  if (spec.group === 'rate' && !ratesIncluded) return null;

  // A switch the operator turned off.
  if (spec.switchedBy && !switches[spec.switchedBy]) return null;

  return spec.resolve(context);
}

/**
 * A field somebody defined on the Fields screen.
 *
 * A separate namespace from the catalogue above, and closed by construction:
 * this indexes the record's own `custom_fields` JSONB and nothing else, so it
 * cannot reach a rate, a line total or an order's amount however it is named.
 * The values were written by the Fields screen; masking never touches them.
 *
 * A definition that has been deleted, deactivated, or never existed resolves to
 * null and the element is dropped. An empty box under a stale label is a worse
 * lie than a missing one, and it matches the rule the rest of this product
 * follows: what a reader may not have is *absent*.
 */
function resolveCustomField(
  ref: Extract<DocumentBindingRef, { source: 'custom' }>,
  context: BindingContext,
  customFields: {
    values: Record<string, unknown>;
    definitions: readonly CustomFieldDefinition[];
  },
): string | null {
  const definition = customFields.definitions.find(
    (candidate) =>
      candidate.entity === ref.entity && candidate.key === ref.key && candidate.isActive,
  );
  if (!definition) return null;

  const raw =
    ref.entity === 'party'
      ? (context.party?.customFields ?? {})[ref.key]
      : customFields.values[ref.key];

  if (raw === null || raw === undefined || raw === '') return null;

  switch (definition.fieldType) {
    case 'date':
      return formatDateForDocument(String(raw));
    case 'boolean':
      return raw === true || raw === 'true' ? 'Yes' : 'No';
    case 'number':
      // Not `formatMinorUnits`: a custom number is a count, a weight or a
      // reference, and printing 12 as 0.12 because money is stored in paise
      // would be wrong in a way nobody would think to check.
      return String(raw);
    default:
      return String(raw);
  }
}
