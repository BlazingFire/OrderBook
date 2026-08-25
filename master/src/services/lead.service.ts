/**
 * Leads. A lead no longer becomes an order by changing status — conversion
 * creates a separate Order record and the lead survives as history
 * (docs/LEAD_GENERATION_FLOW.md §3–§5).
 *
 * Validation, permission checks and change publication live here; SQL lives in
 * the repositories, and the rules that decide anything live in `domain/`.
 */

import type {
  BinBlocker,
  BinRestoreResult,
  Lead,
  LeadInput,
  LeadListQuery,
  LeadUpdateInput,
  Paginated,
} from '@orderbook/shared';

import { actorUserId, requirePermission, type ActorContext } from '../domain/actor.js';
import { normalizeCustomFields } from '../domain/custom-fields.js';
import { assertOptionValueChange } from '../domain/field-values.js';
import { buildLineSnapshot, type LineDraft, type LineSnapshot } from '../domain/line-items.js';
import { clampPaging } from '../domain/paging.js';
import { assertStageMove, defaultStage, findStage, stageChangeMessage } from '../domain/pipeline.js';
import { assertParentsLive } from '../domain/recycle-bin.js';
import { canEditRates, canSeeRates, maskLead, withPermittedRate } from '../domain/visibility.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { nextHlc } from '../repositories/identity.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as recycleBinRepo from '../repositories/recycle-bin.repository.js';
import * as timelineRepo from '../repositories/timeline.repository.js';
import { publishChange } from './change-bus.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

export async function listLeads(
  query: LeadListQuery,
  actor: ActorContext,
): Promise<Paginated<Lead>> {
  requirePermission(actor, 'leads.view');

  const page = await leadRepo.listLeads(actor.tenantId, {
    ...query,
    ...clampPaging(query, PAGING),
  });

  const allowed = canSeeRates(actor);
  return { ...page, items: page.items.map((lead) => maskLead(lead, allowed)) };
}

export async function getLead(id: string, actor: ActorContext): Promise<Lead> {
  requirePermission(actor, 'leads.view');

  const lead = await leadRepo.findLeadById(actor.tenantId, id);
  if (!lead) throw new NotFoundError('Lead');

  return maskLead(lead, canSeeRates(actor));
}

export async function createLead(input: LeadInput, actor: ActorContext): Promise<Lead> {
  requirePermission(actor, 'leads.create');

  const ownerId = await resolveOwner(input.ownerId ?? null, actor);
  const stages = await pipelineRepo.stagesFor(actor.tenantId, 'lead');
  const definitions = await customFieldRepo.definitionsFor(actor.tenantId, 'lead');

  if (!input.partyId) throw new ValidationError('validation.lead.partyRequired');
  if (!input.items?.length) throw new ValidationError('validation.lead.itemsRequired');

  if (!(await partyRepo.findPartyById(actor.tenantId, input.partyId))) {
    throw new ValidationError('validation.lead.partyMissing');
  }

  await assertSourcePlatform(actor.tenantId, input.sourcePlatform ?? null);

  const customFields = normalizeCustomFields(input.customFields, definitions);
  const lines = await buildLines(actor.tenantId, input.partyId, input.items, {
    partyWiseMode: input.partyWiseMode ?? false,
    canEditRate: canEditRates(actor),
  });

  const id = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    const leadId = await leadRepo.insertLead(
      {
        tenantId: actor.tenantId,
        partyId: input.partyId,
        ownerId,
        stageId: defaultStage(stages).id,
        sourcePlatform: input.sourcePlatform ?? null,
        followUpDate: input.followUpDate ?? null,
        partyWiseMode: input.partyWiseMode ?? false,
        notes: input.notes?.trim() || null,
        customFields,
        sourcePanelId: actor.actorType === 'office_panel' ? actor.actorId : null,
        createdByUserId: actorUserId(actor),
        hlc,
        // Only the fields this create actually set are stamped. Marking every
        // field as "written at creation" would make the first edit of a field
        // nobody ever filled in look like a clash with the creator, and bury
        // the real conflicts in noise.
        fieldHlc: initialFieldHlc(input, hlc),
        temporaryId: null,
      },
      lines,
      trx,
    );

    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'lead',
        parentId: leadId,
        kind: 'system',
        message: 'Lead created',
        toStageId: defaultStage(stages).id,
        actorUserId: actorUserId(actor),
      },
      trx,
    );

    return leadId;
  });

  const lead = await leadRepo.findLeadById(actor.tenantId, id);
  if (!lead) throw new Error('Lead disappeared immediately after insert');

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'lead',
    entityId: lead.id,
    action: 'created',
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { itemCount: lead.items.length, incomplete: lead.incomplete },
  }, actor, db());
  publishChange({ entity: 'lead', action: 'created', id: lead.id, payload: lead });

  return maskLead(lead, canSeeRates(actor));
}

export async function updateLead(
  id: string,
  input: LeadUpdateInput,
  actor: ActorContext,
): Promise<Lead> {
  requirePermission(actor, 'leads.edit');

  const existing = await leadRepo.findLeadById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Lead');
  if (existing.convertedOrderId) {
    throw new ValidationError('validation.lead.convertedLocked');
  }

  const definitions = await customFieldRepo.definitionsFor(actor.tenantId, 'lead');
  const patch: Record<string, unknown> = {};

  if (input.partyId !== undefined) {
    if (!(await partyRepo.findPartyById(actor.tenantId, input.partyId))) {
      throw new ValidationError('validation.lead.partyMissing');
    }
    patch.party_id = input.partyId;
  }

  if (input.ownerId !== undefined) {
    patch.owner_id = await resolveOwner(input.ownerId, actor, existing.ownerId);
  }

  if (input.sourcePlatform !== undefined) {
    await assertSourcePlatform(actor.tenantId, input.sourcePlatform, existing.sourcePlatform);
    patch.source_platform = input.sourcePlatform;
  }

  if (input.followUpDate !== undefined) patch.follow_up_date = input.followUpDate;
  if (input.partyWiseMode !== undefined) patch.party_wise_mode = input.partyWiseMode;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

  if (input.customFields !== undefined) {
    patch.custom_fields = JSON.stringify(normalizeCustomFields(input.customFields, definitions));
  }

  const lines =
    input.items === undefined
      ? null
      : await buildLines(actor.tenantId, input.partyId ?? existing.partyId, input.items, {
          partyWiseMode: input.partyWiseMode ?? existing.partyWiseMode,
          canEditRate: canEditRates(actor),
        });

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc };
    for (const field of Object.keys(patch)) fieldHlc[columnToField(field)] = hlc;
    if (lines) fieldHlc.items = hlc;

    if (Object.keys(patch).length > 0) {
      await leadRepo.updateLeadColumns(actor.tenantId, id, patch, { hlc, fieldHlc }, trx);
    }
    if (lines) await leadRepo.replaceLeadLines(actor.tenantId, id, lines, trx);
  });

  const lead = await leadRepo.findLeadById(actor.tenantId, id);
  if (!lead) throw new NotFoundError('Lead');

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'lead',
    entityId: id,
    action: 'updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
  }, actor, db());
  publishChange({ entity: 'lead', action: 'updated', id, payload: lead });

  return maskLead(lead, canSeeRates(actor));
}

export async function setStage(
  input: { id: string; stageId: string; remark?: string | null },
  actor: ActorContext,
): Promise<Lead> {
  requirePermission(actor, 'leads.edit');

  const existing = await leadRepo.findLeadById(actor.tenantId, input.id);
  if (!existing) throw new NotFoundError('Lead');
  if (existing.stageId === input.stageId) return maskLead(existing, canSeeRates(actor));

  const stages = await pipelineRepo.stagesFor(actor.tenantId, 'lead');
  const from = findStage(stages, existing.stageId);
  const to = assertStageMove(stages, existing.stageId, input.stageId, {
    convertedOrderId: existing.convertedOrderId,
  });

  await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    await leadRepo.updateLeadColumns(
      actor.tenantId,
      input.id,
      { stage_id: to.id },
      { hlc, fieldHlc: { ...existing.sync.fieldHlc, stageId: hlc } },
      trx,
    );

    // The automatic entry is what makes the board's history readable; a typed
    // remark rides alongside it rather than replacing it.
    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'lead',
        parentId: input.id,
        kind: 'system',
        message: stageChangeMessage(from, to),
        fromStageId: from.id,
        toStageId: to.id,
        actorUserId: actorUserId(actor),
      },
      trx,
    );

    if (input.remark?.trim()) {
      await timelineRepo.appendEntry(
        {
          tenantId: actor.tenantId,
          parentType: 'lead',
          parentId: input.id,
          kind: 'remark',
          message: input.remark.trim(),
          actorUserId: actorUserId(actor),
        },
        trx,
      );
    }
  });

  const lead = await leadRepo.findLeadById(actor.tenantId, input.id);
  if (!lead) throw new NotFoundError('Lead');

  await activityLog.recordDetachedActivity({
    tenantId: actor.tenantId,
    entityType: 'lead',
    entityId: input.id,
    action: 'stage_changed',
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { from: from.name, to: to.name },
  }, actor, db());
  publishChange({ entity: 'lead', action: 'updated', id: input.id, payload: lead });

  return maskLead(lead, canSeeRates(actor));
}

export async function addRemark(
  input: { id: string; message: string },
  actor: ActorContext,
): Promise<Lead> {
  requirePermission(actor, 'leads.edit');

  const message = input.message?.trim();
  if (!message) throw new ValidationError('validation.remark.textRequired');

  const existing = await leadRepo.findLeadById(actor.tenantId, input.id);
  if (!existing) throw new NotFoundError('Lead');

  await db().transaction(async (trx) => {
    await timelineRepo.appendEntry(
      {
        tenantId: actor.tenantId,
        parentType: 'lead',
        parentId: input.id,
        kind: 'remark',
        message,
        actorUserId: actorUserId(actor),
      },
      trx,
    );
  });

  const lead = await leadRepo.findLeadById(actor.tenantId, input.id);
  if (!lead) throw new NotFoundError('Lead');

  publishChange({ entity: 'lead', action: 'updated', id: input.id, payload: lead });
  return maskLead(lead, canSeeRates(actor));
}

/**
 * Turn what a panel sent into stored lines.
 *
 * The party's variants are loaded once for the whole set rather than per line,
 * and only when the lead is in `partyWiseMode` — a lead that is not in that
 * mode must take catalogue values even where a variant exists.
 */
export async function buildLines(
  tenantId: string,
  partyId: string,
  drafts: LineDraft[],
  options: { partyWiseMode: boolean; canEditRate: boolean },
): Promise<LineSnapshot[]> {
  const variants = options.partyWiseMode
    ? await variantRepo.listForParty(tenantId, partyId)
    : [];
  const variantByProduct = new Map(variants.map((variant) => [variant.productId, variant]));

  const lines: LineSnapshot[] = [];

  for (const [index, draft] of drafts.entries()) {
    const product = await productRepo.findProductById(tenantId, draft.productId);
    if (!product) throw new ValidationError('validation.lead.productMissing');

    const variant = variantByProduct.get(product.id) ?? null;

    const line = buildLineSnapshot(
      // A rate this actor may not set never reaches the snapshot builder, which
      // takes the client's value in preference to the catalogue's by design.
      withPermittedRate(draft, options.canEditRate),
      {
        id: product.id,
        name: product.name,
        alias: product.alias,
        rate: product.rate ?? null,
        productCode: product.productCode,
        sin: product.sin,
        size: product.size,
        weightKg: product.weightKg,
        grade: product.grade,
        productType: product.productType,
      },
      variant
        ? {
            alias: variant.alias,
            rate: variant.rate ?? null,
            size: variant.size,
            sin: variant.sin,
            grade: variant.grade,
            productType: variant.productType,
            weightKg: variant.weightKg,
            productName: variant.productName,
          }
        : null,
      index + 1,
    );

    if (line.quantities.length === 0) {
      throw new ValidationError('validation.lead.quantityRequired', { productName: line.productName });
    }

    lines.push(line);
  }

  return lines;
}

/**
 * The per-field clock a newly created lead starts with.
 *
 * A field is stamped only when the create supplied a value for it: an unset
 * `followUpDate` has no writer, so the first panel to set one is not competing
 * with anybody.
 */
function initialFieldHlc(input: LeadInput, hlc: string): Record<string, string> {
  const written: Record<string, string> = {
    // Always chosen by the creator, even when they took the defaults.
    partyId: hlc,
    stageId: hlc,
    items: hlc,
  };

  if (input.ownerId) written.ownerId = hlc;
  if (input.sourcePlatform) written.sourcePlatform = hlc;
  if (input.followUpDate) written.followUpDate = hlc;
  if (input.partyWiseMode !== undefined) written.partyWiseMode = hlc;
  if (input.notes?.trim()) written.notes = hlc;
  if (input.customFields && Object.keys(input.customFields).length > 0) {
    written.customFields = hlc;
  }

  return written;
}

const COLUMN_TO_FIELD: Record<string, string> = {
  party_id: 'partyId',
  owner_id: 'ownerId',
  stage_id: 'stageId',
  source_platform: 'sourcePlatform',
  follow_up_date: 'followUpDate',
  party_wise_mode: 'partyWiseMode',
  notes: 'notes',
  custom_fields: 'customFields',
};

function columnToField(column: string): string {
  return COLUMN_TO_FIELD[column] ?? column;
}

/**
 * Owner defaults to the person creating the lead. Naming someone else is a
 * separate capability, because reassigning a colleague's record changes whose
 * numbers it lands in.
 */
async function resolveOwner(
  requested: string | null,
  actor: ActorContext,
  fallback?: string,
): Promise<string | null> {
  const current = fallback ?? actorUserId(actor);
  if (!requested || requested === current) return current;

  requirePermission(actor, 'record.reassignOwner');
  return requested;
}

async function assertSourcePlatform(
  tenantId: string,
  value: string | null,
  previous: string | null = null,
): Promise<void> {
  if (!value) return;

  // Rejected rather than passed through: sourcePlatform is a reporting
  // dimension, and a typo would quietly become its own category. Unchanged
  // from what the lead already carries is always allowed, even once the
  // option has since been removed from the list — a lead a panel has held
  // offline all afternoon must not fail to save because head office curated
  // the source list this morning.
  assertOptionValueChange(
    value,
    previous,
    await customFieldRepo.isValidOption(tenantId, 'lead.sourcePlatform', value),
    'validation.lead.sourceInvalid',
  );
}

/**
 * Refused once a lead has become an order — it is the order's history now,
 * not a record of its own, and "delete the order instead" is the honest
 * answer. Line items are never marked separately; they are only ever reached
 * through their parent, so the lead's own tombstone is what "cascades to its
 * line items" means here.
 */
export async function deleteLead(
  id: string,
  actor: ActorContext,
): Promise<{ id: string; deletedAt: string }> {
  requirePermission(actor, 'leads.delete');

  const existing = await leadRepo.findLeadById(actor.tenantId, id);
  if (!existing) throw new NotFoundError('Lead');

  if (existing.convertedOrderId) {
    throw new ConflictError('error.conflict.blockedByLiveReferences', {}, {
      blockedBy: [
        { entityType: 'order', id: existing.convertedOrderId, label: existing.convertedOrderId, reason: 'converted' },
      ] satisfies BinBlocker[],
    });
  }

  const lead = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await leadRepo.softDeleteLead(actor.tenantId, id, actorUserId(actor), { hlc, fieldHlc }, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'lead',
        entityId: id,
        action: 'deleted',
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
      actor,
      trx,
    );

    return row;
  });

  if (!lead) throw new NotFoundError('Lead');

  publishChange({ entity: 'lead', action: 'deleted', id, payload: lead });
  return { id: lead.id, deletedAt: lead.updatedAt };
}

export async function restoreLead(id: string, actor: ActorContext): Promise<BinRestoreResult> {
  requirePermission(actor, 'leads.delete');

  const existing = await leadRepo.findLeadById(actor.tenantId, id, db(), { includeDeleted: true });
  if (!existing) throw new NotFoundError('Lead');

  const party = await recycleBinRepo.findParentStatus(actor.tenantId, 'party', existing.partyId);
  assertParentsLive([
    {
      entityType: 'party',
      id: existing.partyId,
      label: party?.label ?? existing.partyId,
      isLive: party?.isLive ?? false,
    },
  ]);

  const lead = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);
    const fieldHlc = { ...existing.sync.fieldHlc, deletedAt: hlc };
    const row = await leadRepo.restoreLead(actor.tenantId, id, { hlc, fieldHlc }, trx);

    await activityLog.recordActivity(
      {
        tenantId: actor.tenantId,
        entityType: 'lead',
        entityId: id,
        action: 'restored',
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
      actor,
      trx,
    );

    return row;
  });

  if (!lead) throw new NotFoundError('Lead');

  publishChange({ entity: 'lead', action: 'restored', id, payload: lead });
  return { entityType: 'lead', id, alsoRestored: [] };
}

export async function getDashboardCounts(tenantId: string) {
  const [leadCount, followUpsDueCount] = await Promise.all([
    leadRepo.countOpenLeads(tenantId),
    leadRepo.countFollowUpsDue(tenantId),
  ]);
  return { leadCount, followUpsDueCount };
}
