/**
 * Template CRUD against a real cluster (`docs/backend-modules/10-TESTING.md`
 * §6.7). Everything here is a statement about what the *database* enforces —
 * the partial unique indexes on name and default, and the atomicity of a row
 * change with the entry recording it — so none of it can be proven in a pure
 * suite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '../src/domain/actor.js';
import { db } from '../src/db/knex.js';
import * as documentService from '../src/services/document.service.js';
import { canRunIntegrationTests } from './helpers/db.js';
import {
  actorWith,
  resetData,
  setupDatabase,
  teardownDatabase,
  testActor,
} from './helpers/fixtures.js';

let actor: ActorContext;

function uniqueName(prefix = 'Tpl'): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 9)}`;
}

async function createTemplate(overrides: Record<string, unknown> = {}) {
  return documentService.createTemplate(
    { name: uniqueName(), documentType: 'quotation', ...overrides } as never,
    actor,
  );
}

describe.skipIf(!canRunIntegrationTests)('Document templates (integration)', () => {
  beforeAll(setupDatabase);
  afterAll(teardownDatabase);

  beforeEach(async () => {
    await resetData();
    actor = await testActor();
  });

  it('PDF-38: a created template round-trips its eight switches and its layout', async () => {
    const created = await createTemplate({
      name: 'Round Trip',
      showRates: false,
      showColourChips: false,
      showSignature: true,
      accentColour: '#0F766E',
      layout: {
        blocks: [
          { kind: 'header', align: 'centre' },
          { kind: 'lines', groupByProduct: true },
          { kind: 'signature', label: 'For Sharma Tiles' },
        ],
      },
    });

    const fetched = await documentService.getTemplate(created.id, actor);

    expect(fetched.showRates).toBe(false);
    expect(fetched.showColourChips).toBe(false);
    expect(fetched.showSignature).toBe(true);
    expect(fetched.accentColour).toBe('#0F766E');
    // A caller may still send the old block shape — an Office panel holding a
    // stale client does — and it comes back converted, which is the promise
    // `normaliseLayout` makes at the mapper.
    expect(fetched.layout.version).toBe(2);
    expect(fetched.layout.elements.some((element) => element.kind === 'table')).toBe(true);

    // The centred header survived the conversion as a centred element.
    const title = fetched.layout.elements.find(
      (element) => element.kind === 'field' && element.style.align === 'centre',
    );
    expect(title).toBeDefined();

    // And the signature caption is carried as the text it prints.
    const caption = fetched.layout.elements.find(
      (element) => element.kind === 'text' && element.text === 'For Sharma Tiles',
    );
    expect(caption).toBeDefined();

    expect(fetched.version).toBe(1);
  });

  it('PDF-39: a duplicate name is a 409 carrying the value, case-insensitively', async () => {
    await createTemplate({ name: 'Standard Quotation' });

    await expect(createTemplate({ name: 'standard quotation' })).rejects.toMatchObject({
      statusCode: 409,
      details: { field: 'name', value: 'standard quotation' },
    });
  });

  it('PDF-40: expectedVersion is mandatory on update — omitting it is a 400, not a silent overwrite', async () => {
    const created = await createTemplate();

    await expect(
      documentService.updateTemplate(created.id, { name: 'Renamed' } as never, actor),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { field: 'expectedVersion', storedVersion: 1 },
    });
  });

  it('PDF-41: a stale expectedVersion is refused with the stored version', async () => {
    const created = await createTemplate();
    await documentService.updateTemplate(
      created.id,
      { name: 'First edit', documentType: 'quotation', expectedVersion: 1 },
      actor,
    );

    await expect(
      documentService.updateTemplate(
        created.id,
        { name: 'Second edit', documentType: 'quotation', expectedVersion: 1 },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409, details: { storedVersion: 2 } });
  });

  it('PDF-42: promoting a default demotes the previous one in the same transaction', async () => {
    const first = await createTemplate({ isDefault: true });
    const second = await createTemplate({ isDefault: true });

    const [reloadedFirst, reloadedSecond] = await Promise.all([
      documentService.getTemplate(first.id, actor),
      documentService.getTemplate(second.id, actor),
    ]);

    expect(reloadedFirst.isDefault).toBe(false);
    expect(reloadedSecond.isDefault).toBe(true);

    // And the partial unique index agrees there is exactly one.
    const rows = await db()('document_templates')
      .where({ tenant_id: actor.tenantId, document_type: 'quotation', is_default: true })
      .whereNull('deleted_at');
    expect(rows).toHaveLength(1);
  });

  it('PDF-43: two document types hold their own defaults independently', async () => {
    const quotation = await createTemplate({ documentType: 'quotation', isDefault: true });
    const dispatch = await createTemplate({
      documentType: 'dispatch_note',
      isDefault: true,
      showRates: false,
    });

    expect((await documentService.getTemplate(quotation.id, actor)).isDefault).toBe(true);
    expect((await documentService.getTemplate(dispatch.id, actor)).isDefault).toBe(true);
  });

  it('PDF-44: a soft-deleted template frees its name immediately', async () => {
    const created = await createTemplate({ name: 'Reusable' });
    await documentService.deleteTemplate(created.id, 1, actor);

    // The partial unique index excludes tombstones, so this must succeed.
    const replacement = await createTemplate({ name: 'Reusable' });
    expect(replacement.id).not.toBe(created.id);
  });

  it('PDF-45: restore refuses with 409 when a live template has taken the name since', async () => {
    const original = await createTemplate({ name: 'Contested' });
    await documentService.deleteTemplate(original.id, 1, actor);
    await createTemplate({ name: 'Contested' });

    await expect(documentService.restoreTemplate(original.id, actor)).rejects.toMatchObject({
      statusCode: 409,
      details: { field: 'name' },
    });
  });

  it('PDF-46: restore works when the name is still free, and clears the tombstone', async () => {
    const created = await createTemplate({ name: 'Uncontested' });
    await documentService.deleteTemplate(created.id, 1, actor);

    const restored = await documentService.restoreTemplate(created.id, actor);

    expect(restored.deletedAt).toBeNull();
    expect((await documentService.getTemplate(created.id, actor)).name).toBe('Uncontested');
  });

  it('PDF-47: deleting clears is_default, so the slot is free for the next promotion', async () => {
    const created = await createTemplate({ isDefault: true });
    await documentService.deleteTemplate(created.id, 1, actor);

    // Would violate `document_templates_one_default` if the delete had left
    // the flag set on the tombstone.
    const replacement = await createTemplate({ isDefault: true });
    expect(replacement.isDefault).toBe(true);
  });

  it('PDF-48: the row and its activity entry commit together', async () => {
    const created = await createTemplate({ name: 'Audited' });

    const entries = await db()('activity_log')
      .where({ tenant_id: actor.tenantId, entity_type: 'document_template', entity_id: created.id })
      .orderBy('id');

    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('created');
    expect(entries[0]!.actor_name).toBe('Test Actor');
  });

  it('PDF-49: a rolled-back write leaves neither the row nor its audit entry', async () => {
    const before = await db()('activity_log')
      .where({ tenant_id: actor.tenantId, entity_type: 'document_template' })
      .count<Array<{ count: string }>>('id as count');

    // A duplicate name throws inside the transaction, after the name check but
    // in the same unit of work the audit entry would have joined.
    await createTemplate({ name: 'Atomic' });
    await expect(createTemplate({ name: 'Atomic' })).rejects.toMatchObject({ statusCode: 409 });

    const after = await db()('activity_log')
      .where({ tenant_id: actor.tenantId, entity_type: 'document_template' })
      .count<Array<{ count: string }>>('id as count');

    // Exactly one entry was added — the successful create — not two.
    expect(Number(after[0]!.count) - Number(before[0]!.count)).toBe(1);
  });

  it('PDF-50: the list pages alphabetically, not newest-first', async () => {
    await createTemplate({ name: 'Zebra' });
    await createTemplate({ name: 'Alpha' });
    await createTemplate({ name: 'Mango' });

    const page = await documentService.listTemplates({ limit: 10 }, actor);
    const names = page.items.map((item) => item.name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names[0]).toBe('Alpha');
    // A one-directional feed always reports a null prevCursor.
    expect(page.prevCursor).toBeNull();
  });

  it('PDF-51: the cursor pages without repeating or skipping a row', async () => {
    for (const name of ['A one', 'B two', 'C three', 'D four', 'E five']) {
      await createTemplate({ name });
    }

    const first = await documentService.listTemplates({ limit: 2 }, actor);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await documentService.listTemplates(
      { limit: 2, cursor: first.nextCursor! },
      actor,
    );

    const seen = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('PDF-52: a soft-deleted template is absent from the list and 404s on read', async () => {
    const created = await createTemplate({ name: 'Gone' });
    await documentService.deleteTemplate(created.id, 1, actor);

    const page = await documentService.listTemplates({ limit: 50 }, actor);
    expect(page.items.map((item) => item.id)).not.toContain(created.id);

    await expect(documentService.getTemplate(created.id, actor)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('PDF-53: every permission is enforced by the service, not only by the route guard', async () => {
    const created = await createTemplate();

    const viewer = await actorWith(['documents.view']);
    await expect(documentService.getTemplate(created.id, viewer)).resolves.toBeDefined();

    const stranger = await actorWith(['leads.view']);
    await expect(documentService.getTemplate(created.id, stranger)).rejects.toMatchObject({
      statusCode: 403,
      permission: 'documents.view',
    });

    await expect(
      documentService.createTemplate({ name: uniqueName(), documentType: 'quotation' }, viewer),
    ).rejects.toMatchObject({ statusCode: 403, permission: 'documents.create' });

    await expect(documentService.deleteTemplate(created.id, 1, viewer)).rejects.toMatchObject({
      statusCode: 403,
      permission: 'documents.delete',
    });

    // Restore reuses the delete key — a viewer cannot use it as a back door.
    await expect(documentService.restoreTemplate(created.id, viewer)).rejects.toMatchObject({
      statusCode: 403,
      permission: 'documents.delete',
    });
  });

  it('PDF-54: an invalid layout is refused before any row is written', async () => {
    await expect(
      createTemplate({ name: 'Bad layout', layout: { blocks: [{ kind: 'party' }] } }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { field: 'layout', reason: 'missing_lines' },
    });

    const page = await documentService.listTemplates({ limit: 50 }, actor);
    expect(page.items.map((item) => item.name)).not.toContain('Bad layout');
  });
});
