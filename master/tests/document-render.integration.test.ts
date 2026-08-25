/**
 * Rendering end to end against a real cluster and real PDFKit
 * (`docs/backend-modules/10-TESTING.md` §6.7).
 *
 * The load-bearing test here is `PDF-55`: it renders a real PDF for an actor
 * without `field.saleRate.view` and asserts the **extracted text** carries no
 * rate and no total. `document-model.test.ts` proves the model omits the
 * columns; this proves nothing downstream puts them back.
 */

import { existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { config } from '../src/config/index.js';
import { db } from '../src/db/knex.js';
import { absoluteFromData } from '../src/lib/document-files.js';
import * as catalogService from '../src/services/catalog.service.js';
import * as documentService from '../src/services/document.service.js';
import * as inventoryService from '../src/services/inventory.service.js';
import * as leadService from '../src/services/lead.service.js';
import * as orderService from '../src/services/order.service.js';
import * as renderService from '../src/services/document-render.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import { actorWith, resetData, setupDatabase, teardownDatabase, testActor } from './helpers/fixtures.js';

let actor: ActorContext;

/**
 * Reads a PDF the way a person or a search index would.
 *
 * This has to go through a real PDF reader, and a hand-rolled one will lie.
 * PDFKit **subsets** every embedded font, so the content stream holds subset
 * glyph indices rather than characters — grepping the bytes for `'1,250.00'`
 * finds nothing whether or not the rate is printed, which would make the
 * redaction gate below pass for entirely the wrong reason. `pdfjs` maps the
 * glyphs back through the font's ToUnicode CMap, which is what the assertions
 * actually need.
 */
async function extractText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
  }).promise;

  let text = '';
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    text += `${content.items.map((item) => ('str' in item ? item.str : '')).join(' ')}\n`;
  }

  return text;
}

async function seedLead(): Promise<{ leadId: string; partyId: string }> {
  const party = await catalogService.createParty(
    { name: `Doc Party ${Math.random().toString(36).slice(2, 8)}`, city: 'Morbi' },
    actor,
  );
  const product = await catalogService.createProduct(
    {
      name: 'Ivory Basin',
      productCode: `DOC-${Math.random().toString(36).slice(2, 8)}`,
      rate: 125_000,
    },
    actor,
  );
  await inventoryService.recordInbound(
    { productId: product.id, colour: 'White', quantityBoxes: 100 },
    actor,
  );

  const lead = await leadService.createLead(
    {
      partyId: party.id,
      items: [
        { productId: product.id, packaging: 'Box', quantities: [{ colour: 'White', quantity: 12 }] },
      ],
    },
    actor,
  );

  return { leadId: lead.id, partyId: party.id };
}

async function quotationTemplate(overrides: Record<string, unknown> = {}) {
  return documentService.createTemplate(
    {
      name: `Quote ${Math.random().toString(36).slice(2, 8)}`,
      documentType: 'quotation',
      ...overrides,
    } as never,
    actor,
  );
}

describe.skipIf(!canRunIntegrationTests)('Document rendering (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('PDF-55: a render by an actor without field.saleRate.view produces a PDF whose TEXT carries no rate or total', async () => {
    const { leadId } = await seedLead();
    // Terms off, because the default quotation terms are the sentence "Rates
    // are valid for 15 days…" — leaving them on makes a search for the word
    // "Rate" match the prose rather than the column heading, and the gate
    // would fail for a reason that has nothing to do with redaction.
    const template = await quotationTemplate({ showTerms: false });

    // Holds everything the render needs — except the rate key.
    const rateBlind = await actorWith([
      'documents.view',
      'documents.render',
      'leads.view',
    ]);

    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      rateBlind,
    );

    expect(result.ratesIncluded).toBe(false);

    const file = await renderService.fetchExportFile(result.exportId, rateBlind);
    const text = await extractText(Buffer.from(file.bytes));

    // The document was really produced and really has content.
    expect(text).toContain('Ivory Basin');
    // …and none of the money: neither the figures nor the columns that would
    // hold them, nor the totals block.
    expect(text).not.toContain('1,250.00');
    expect(text).not.toContain('15,000.00');
    expect(text).not.toContain('₹');
    expect(text).not.toContain('Rate');
    expect(text).not.toContain('Amount');
    expect(text).not.toContain('Total');
  });

  it('PDF-56: the same render for a rate-permitted actor does carry the figures', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();

    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    expect(result.ratesIncluded).toBe(true);

    const file = await renderService.fetchExportFile(result.exportId, actor);
    const text = await extractText(Buffer.from(file.bytes));

    expect(text).toContain('Rate');
    expect(text).toContain('15,000.00');
  });

  it('PDF-57: rates_included is recorded on the row, as the audit-grade fact about the file sent', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();

    const rateBlind = await actorWith(['documents.view', 'documents.render', 'leads.view']);
    const blind = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      rateBlind,
    );
    const priced = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    const rows = await db()('document_exports')
      .whereIn('id', [blind.exportId, priced.exportId])
      .orderBy('id');

    expect(rows[0]!.rates_included).toBe(false);
    expect(rows[1]!.rates_included).toBe(true);
  });

  it('PDF-58: the export row, its file and its audit entry all exist after a render', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();

    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    const row = await db()('document_exports').where({ id: result.exportId }).first();
    expect(row).toBeDefined();
    expect(existsSync(absoluteFromData(row.storage_path))).toBe(true);
    expect(Number(row.page_count)).toBeGreaterThan(0);

    const entries = await db()('activity_log').where({
      entity_type: 'document_export',
      entity_id: result.exportId,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('rendered');
  });

  it('PDF-59: rendering twice stamps the first export as superseded by the second', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();

    const first = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );
    const second = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    const rows = await db()('document_exports')
      .whereIn('id', [first.exportId, second.exportId])
      .orderBy('id');

    expect(String(rows[0]!.superseded_by)).toBe(second.exportId);
    expect(rows[1]!.superseded_by).toBeNull();
  });

  it('PDF-60: a different document type for the same subject supersedes nothing', async () => {
    const { leadId } = await seedLead();
    const quotation = await quotationTemplate();
    const order = await orderService.convertLead({ leadId }, actor);
    const confirmation = await documentService.createTemplate(
      { name: `Conf ${Math.random().toString(36).slice(2, 8)}`, documentType: 'order_confirmation' },
      actor,
    );

    const quote = await renderService.renderDocument(
      { templateId: quotation.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );
    await renderService.renderDocument(
      { templateId: confirmation.id, subjectKind: 'order', subjectId: order.id },
      actor,
    );

    const row = await db()('document_exports').where({ id: quote.exportId }).first();
    // Different subject and different type — the quotation is still current.
    expect(row.superseded_by).toBeNull();
  });

  it('PDF-61: a preview writes no file, no export row and no activity entry', async () => {
    const { leadId } = await seedLead();

    const before = await db()('document_exports').count<Array<{ count: string }>>('id as count');
    const auditBefore = await db()('activity_log')
      .where({ entity_type: 'document_export' })
      .count<Array<{ count: string }>>('id as count');

    const preview = await renderService.previewDocument(
      {
        template: { name: 'Draft', documentType: 'quotation' },
        subjectKind: 'lead',
        subjectId: leadId,
      },
      actor,
    );

    expect(preview.contentType).toBe('application/pdf');
    expect(preview.bytes.length).toBeGreaterThan(0);

    const after = await db()('document_exports').count<Array<{ count: string }>>('id as count');
    const auditAfter = await db()('activity_log')
      .where({ entity_type: 'document_export' })
      .count<Array<{ count: string }>>('id as count');

    expect(after[0]!.count).toBe(before[0]!.count);
    expect(auditAfter[0]!.count).toBe(auditBefore[0]!.count);
  });

  it('PDF-62: a preview stamps the PREVIEW watermark even when the template disables it', async () => {
    const { leadId } = await seedLead();

    const preview = await renderService.previewDocument(
      {
        template: { name: 'No watermark', documentType: 'quotation', showWatermark: false },
        subjectKind: 'lead',
        subjectId: leadId,
      },
      actor,
    );

    const text = await extractText(Buffer.from(preview.bytes));
    expect(text).toContain('PREVIEW');
  });

  it('PDF-63: rendering for a subject the actor may not view is refused before any file is written', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();

    // Holds `documents.render` but not `leads.view` — this is the gate that
    // stops a document being a way to read a record you may not open.
    const noLeads = await actorWith(['documents.view', 'documents.render', 'orders.view']);

    const before = await db()('document_exports').count<Array<{ count: string }>>('id as count');

    await expect(
      renderService.renderDocument(
        { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
        noLeads,
      ),
    ).rejects.toMatchObject({ statusCode: 403, permission: 'leads.view' });

    const after = await db()('document_exports').count<Array<{ count: string }>>('id as count');
    expect(after[0]!.count).toBe(before[0]!.count);
  });

  it('PDF-64: documents.render alone is not enough, and its absence is named', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();

    const viewer = await actorWith(['documents.view', 'leads.view']);

    await expect(
      renderService.renderDocument(
        { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
        viewer,
      ),
    ).rejects.toMatchObject({ statusCode: 403, permission: 'documents.render' });
  });

  it('PDF-65: a dispatch-note template cannot be rendered for a lead', async () => {
    const { leadId } = await seedLead();
    const dispatch = await documentService.createTemplate(
      {
        name: `DN ${Math.random().toString(36).slice(2, 8)}`,
        documentType: 'dispatch_note',
        showRates: false,
      },
      actor,
    );

    await expect(
      renderService.renderDocument(
        { templateId: dispatch.id, subjectKind: 'lead', subjectId: leadId },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400, details: { field: 'templateId' } });
  });

  it('PDF-66: an export id from another tenant answers 404, never 403', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();
    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    const otherTenant = await testActor({ tenantId: '00000000-0000-0000-0000-0000000000ff' });

    // 404 rather than 403 — a 403 would confirm the id exists.
    await expect(renderService.getExport(result.exportId, otherTenant)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      renderService.fetchExportFile(result.exportId, otherTenant),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('PDF-67: a stored export is not reachable under uploadsDir', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();
    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    const row = await db()('document_exports').where({ id: result.exportId }).first();
    const absolute = absoluteFromData(row.storage_path);

    // `/uploads` is unauthenticated `express.static`. A rendered quotation
    // carries prices and a customer's address, so it must not live there.
    expect(absolute.startsWith(config.uploadsDir)).toBe(false);
    expect(absolute.startsWith(config.documents.exportsDir)).toBe(true);
  });

  it('PDF-68: export history omits rows whose subject kind the caller may not view, rather than refusing', async () => {
    const { leadId } = await seedLead();
    const quotation = await quotationTemplate();
    const order = await orderService.convertLead({ leadId }, actor);
    const confirmation = await documentService.createTemplate(
      { name: `Conf ${Math.random().toString(36).slice(2, 8)}`, documentType: 'order_confirmation' },
      actor,
    );

    await renderService.renderDocument(
      { templateId: quotation.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );
    await renderService.renderDocument(
      { templateId: confirmation.id, subjectKind: 'order', subjectId: order.id },
      actor,
    );

    // A dispatch clerk: orders but not leads.
    const clerk = await actorWith(['documents.view', 'orders.view']);
    const page = await renderService.listExports({ limit: 50 }, clerk);

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.subjectKind === 'order')).toBe(true);
  });

  it('PDF-69: a single export row DOES refuse when its subject is unviewable — there is nothing to filter to', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();
    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    const clerk = await actorWith(['documents.view', 'orders.view']);

    await expect(renderService.getExport(result.exportId, clerk)).rejects.toMatchObject({
      statusCode: 403,
      permission: 'leads.view',
    });
  });

  it('PDF-70: the export cursor round-trips a BIGINT id as a string and pages without repeats', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate();

    for (let i = 0; i < 5; i += 1) {
      await renderService.renderDocument(
        { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
        actor,
      );
    }

    const first = await renderService.listExports({ limit: 2 }, actor);
    expect(first.items).toHaveLength(2);
    expect(typeof first.items[0]!.id).toBe('string');
    expect(first.nextCursor).not.toBeNull();

    const second = await renderService.listExports({ limit: 2, cursor: first.nextCursor! }, actor);
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Newest-first.
    expect(BigInt(first.items[0]!.id) > BigInt(second.items[0]!.id)).toBe(true);
  });

  it('PDF-71: an export keeps its template name after the template is renamed', async () => {
    const { leadId } = await seedLead();
    const template = await quotationTemplate({ name: 'Original Name' });

    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: leadId },
      actor,
    );

    await documentService.updateTemplate(
      template.id,
      { name: 'Renamed Later', documentType: 'quotation', expectedVersion: 1 },
      actor,
    );

    const row = await renderService.getExport(result.exportId, actor);
    // Denormalised on the row, so history reads the way it did when it was made.
    expect(row.templateName).toBe('Original Name');
  });

  it('PDF-72: a Devanagari party name survives into the rendered document', async () => {
    const party = await catalogService.createParty({ name: 'शर्मा टाइल्स', city: 'Morbi' }, actor);
    const product = await catalogService.createProduct(
      { name: 'Tile', productCode: `DV-${Math.random().toString(36).slice(2, 8)}` },
      actor,
    );
    await inventoryService.recordInbound(
      { productId: product.id, colour: 'White', quantityBoxes: 50 },
      actor,
    );
    const lead = await leadService.createLead(
      {
        partyId: party.id,
        items: [
          { productId: product.id, packaging: 'Box', quantities: [{ colour: 'White', quantity: 2 }] },
        ],
      },
      actor,
    );

    const template = await quotationTemplate();
    const result = await renderService.renderDocument(
      { templateId: template.id, subjectKind: 'lead', subjectId: lead.id },
      actor,
    );

    // The bytes exist and the render did not fall over on the shaper — the
    // glyph-level correctness is `document-fonts.test.ts`'s job.
    const file = await renderService.fetchExportFile(result.exportId, actor);
    expect(file.bytes.length).toBeGreaterThan(1000);

    const raw = Buffer.from(file.bytes).toString('latin1');
    expect(raw).toContain('NotoSansDevanagari');
    // Never the standard-14 fallback, which would render Hindi as blank boxes.
    expect(raw).not.toContain('Helvetica');
  });
});
