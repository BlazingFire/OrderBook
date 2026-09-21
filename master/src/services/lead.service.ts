/**
 * Leads. A lead no longer becomes an order by changing status — conversion
 * creates a separate Order record and the lead survives as history
 * (docs/LEAD_GENERATION_FLOW.md §3–§5).
 *
 * Validation, permission checks and change publication live here; SQL lives in
 * the repositories, and the rules that decide anything live in `domain/`.
 */

import { fieldFor, LEAD_COLUMNS } from '@orderbook/shared';
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
import { buildLineSnapshot, LineColourError, type LineDraft, type LineSnapshot } from '../domain/line-items.js';
import { clampPaging } from '../domain/paging.js';
import { resolvePartyScope, UNSCOPED_PARTY_ACCESS } from '../domain/party-scope.js';
import { assertStageMove, defaultStage, findStage, stageChangeMessage } from '../domain/pipeline.js';
import { assertParentsLive } from '../domain/recycle-bin.js';
import { db } from '../db/knex.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import * as activityLog from '../repositories/activity-log.repository.js';
import * as customFieldRepo from '../repositories/custom-field.repository.js';
import { nextHlc, resolveId } from '../repositories/identity.repository.js';
import * as leadRepo from '../repositories/lead.repository.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as variantRepo from '../repositories/party-variant.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import * as recycleBinRepo from '../repositories/recycle-bin.repository.js';
import * as timelineRepo from '../repositories/timeline.repository.js';
import { publishChange } from './change-bus.js';
import { requirePartyAccess } from './party-access.service.js';

const PAGING = { defaultLimit: 100, maxLimit: 500 };

export async function listLeads(
  query: LeadListQuery,
  actor: ActorContext,
): Promise<Paginated<Lead>> {
  requirePermission(actor, 'leads.view');

  const page = await leadRepo.listLeads(actor.tenantId, {
    ...query,
    ...clampPaging(query, PAGING),
    partyScope: resolvePartyScope(actor),
  });

  return page;
}

export async function getLead(id: string, actor: ActorContext): Promise<Lead> {
  requirePermission(actor, 'leads.view');

  // Scoped at the query, so a lead on somebody else's party is a 404 rather
  // than a 403 — on a read, confirming the record exists is itself the leak.
  const lead = await leadRepo.findLeadById(actor.tenantId, id, resolvePartyScope(actor));
  if (!lead) throw new NotFoundError('Lead');

  return lead;
}

export async function createLead(input: LeadInput, actor: ActorContext): Promise<Lead> {
  requirePermission(actor, 'leads.create');

  const ownerId = await resolveOwner(input.ownerId ?? null, actor);
  const stages = await pipelineRepo.stagesFor(actor.tenantId, 'lead');
  const definitions = await customFieldRepo.definitionsFor(actor.tenantId, 'lead');

  if (!input.partyId) throw new ValidationError('validation.lead.partyRequired');
  if (!input.items?.length) throw new ValidationError('validation.lead.itemsRequired');

  // A party created on the panel and used on a lead straight away is named by
  // its temporary id in the lead's payload, whichever order the two writes
  // arrive in. `id_map` keeps every temporary id resolvable, the same way the
  // sync service resolves a mutation's own `entityId`.
  const partyId = await resolveId(actor.tenantId, input.partyId);
  if (!(await partyRepo.findPartyById(actor.tenantId, partyId))) {
    throw new ValidationError('validation.lead.partyMissing');
  }

  // Party Access: a lead may only be raised against a party the caller manages.
  // Checked here rather than in the route because the Office Panel — which
  // raises nearly every lead — reaches this function over Socket.IO instead.
  await requirePartyAccess(partyId, 'manage', actor);

  await assertSourcePlatform(actor.tenantId, input.sourcePlatform ?? null);

  const customFields = normalizeCustomFields(input.customFields, definitions);
  const lines = await buildLines(actor.tenantId, partyId, input.items, {
    partyWiseMode: input.partyWiseMode ?? false,
  });

  const id = await db().transaction(async (trx) => {
    const hlc = await nextHlc(trx);

    const leadId = await leadRepo.insertLead(
      {
        tenantId: actor.tenantId,
        partyId,
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

  const lead = await leadRepo.findLeadById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
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

  return lead;
}

export async function updateLead(
  id: string,
  input: LeadUpdateInput,
  actor: ActorContext,
): Promise<Lead> {
  requirePermission(actor, 'leads.edit');

  const existing = await leadRepo.findLeadById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Lead');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

  if (existing.convertedOrderId) {
    throw new ValidationError('validation.lead.convertedLocked');
  }

  const definitions = await customFieldRepo.definitionsFor(actor.tenantId, 'lead');
  const patch: Record<string, unknown> = {};

  const partyId = input.partyId === undefined ? undefined : await resolveId(actor.tenantId, input.partyId);
  if (partyId !== undefined) {
    if (!(await partyRepo.findPartyById(actor.tenantId, partyId))) {
      throw new ValidationError('validation.lead.partyMissing');
    }
    // Both ends of the move: the old party was checked above, and moving a lead
    // *onto* a party you do not manage would otherwise be a way to write into
    // somebody else's book — or to smuggle a record out of your own.
    await requirePartyAccess(partyId, 'manage', actor);
    patch.party_id = partyId;
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
      : await buildLines(actor.tenantId, partyId ?? existing.partyId, input.items, {
          partyWiseMode: input.partyWiseMode ?? existing.partyWiseMode,
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

  const lead = await leadRepo.findLeadById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
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

  return lead;
}

export async function setStage(
  input: { id: string; stageId: string; remark?: string | null },
  actor: ActorContext,
): Promise<Lead> {
  requirePermission(actor, 'leads.edit');

  const existing = await leadRepo.findLeadById(actor.tenantId, input.id, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Lead');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

  if (existing.stageId === input.stageId) return existing;

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

  const lead = await leadRepo.findLeadById(actor.tenantId, input.id, UNSCOPED_PARTY_ACCESS);
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

  return lead;
}

export async function addRemark(
  input: { id: string; message: string },
  actor: ActorContext,
): Promise<Lead> {
  requirePermission(actor, 'leads.edit');

  const message = input.message?.trim();
  if (!message) throw new ValidationError('validation.remark.textRequired');

  const existing = await leadRepo.findLeadById(actor.tenantId, input.id, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Lead');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

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

  const lead = await leadRepo.findLeadById(actor.tenantId, input.id, UNSCOPED_PARTY_ACCESS);
  if (!lead) throw new NotFoundError('Lead');

  publishChange({ entity: 'lead', action: 'updated', id: input.id, payload: lead });
  return lead;
}

/**
 * Turn what a panel sent into stored lines — one per variant.
 *
 * The party's own product records are loaded once for the whole set rather
 * than per line, and only when the lead is in `partyWiseMode` — a lead that
 * is not in that mode must take catalogue values even where a party record
 * exists. The code and the weight come from the product's own variant, which
 * has to exist on the product the line names and still be on offer. A colour
 * is accepted only on a multi-colour product.
 */
async function buildLines(
  tenantId: string,
  partyId: string,
  drafts: LineDraft[],
  options: { partyWiseMode: boolean },
): Promise<LineSnapshot[]> {
  const partyVariants = options.partyWiseMode
    ? await variantRepo.listForParty(tenantId, partyId)
    : [];
  const partyVariantByProduct = new Map(partyVariants.map((variant) => [variant.productId, variant]));

  const lines: LineSnapshot[] = [];
  const products = new Map<string, Awaited<ReturnType<typeof productRepo.findProductById>>>();

  for (const [index, draft] of drafts.entries()) {
    if (!products.has(draft.productId)) {
      products.set(draft.productId, await productRepo.findProductById(tenantId, draft.productId));
    }
    const product = products.get(draft.productId) ?? null;
    if (!product) throw new ValidationError('validation.lead.productMissing');

    // A variant of another product, or one taken off the form, is refused
    // rather than silently re-pointed: the line's code and weight are the
    // variant's, and a wrong one would quote a different article.
    const variant = product.variants.find((candidate) => candidate.id === draft.variantId);
    if (!variant || !variant.isActive) throw new ValidationError('validation.lead.variantMissing');

    const partyVariant = partyVariantByProduct.get(product.id) ?? null;

    let line: LineSnapshot;
    try {
      line = buildLineSnapshot(
        draft,
        {
          id: product.id,
          name: product.name,
          categoryName: product.categoryName,
          alias: product.alias,
          size: product.size,
          multiColour: product.multiColour,
        },
        { id: variant.id, code: variant.code, label: variant.label, weightKg: variant.weightKg },
        partyVariant
          ? {
              alias: partyVariant.alias,
              size: partyVariant.size,
              productName: partyVariant.productName,
            }
          : null,
        index + 1,
      );
    } catch (error) {
      if (error instanceof LineColourError) {
        throw new ValidationError('validation.lead.colourUnexpected', { productName: product.name });
      }
      throw error;
    }

    if (line.quantity <= 0) {
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

function columnToField(column: string): string {
  return fieldFor(LEAD_COLUMNS, column);
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

  const existing = await leadRepo.findLeadById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS);
  if (!existing) throw new NotFoundError('Lead');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);

  if (existing.convertedOrderId) {
    throw new ConflictError('error.conflict.blockedByLiveReferences', {}, {
      blockedBy: [
        { entityType: 'order', id: existing.convertedOrderId, label: existing.convertedOrderId, reason: 'converted' },
      ] satisfies BinBlocker[],
    });
  }

  const lead = await db().transaction(async (trx) => {
    // Stamped before the row lock, not after: every other write path takes
    // `master_clock`'s lock before the entity row's lock, and taking them in
    // the opposite order here would deadlock (`40P01`) against one of those
    // the moment both race the same row — most concretely `convertLead`
    // above, which locks this same lead. Safe to take unconditionally — a
    // throw below rolls this stamp back with the rest of the transaction.
    const hlc = await nextHlc(trx);

    // Re-check under the row's lock: the `convertedOrderId` check above ran
    // outside any transaction, so a concurrent `convertLead` could otherwise
    // commit between that read and this delete, leaving a live order
    // pointing at a now-tombstoned lead. The lock makes the second caller
    // through this door (delete or convert) wait for the first, then see the
    // lead already converted.
    const locked = await leadRepo.lockLead(actor.tenantId, id, trx);
    if (!locked) throw new NotFoundError('Lead');
    if (locked.convertedOrderId) {
      throw new ConflictError('error.conflict.blockedByLiveReferences', {}, {
        blockedBy: [
          { entityType: 'order', id: locked.convertedOrderId, label: locked.convertedOrderId, reason: 'converted' },
        ] satisfies BinBlocker[],
      });
    }

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

  const existing = await leadRepo.findLeadById(actor.tenantId, id, UNSCOPED_PARTY_ACCESS, db(), { includeDeleted: true });
  if (!existing) throw new NotFoundError('Lead');

  // Read unscoped so an out-of-scope caller is refused with a 403 naming why,
  // not a 404 that reads as "somebody deleted it".
  await requirePartyAccess(existing.partyId, 'manage', actor);


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

export async function getDashboardCounts(actor: ActorContext) {
  const scope = resolvePartyScope(actor);
  const [leadCount, followUpsDueCount] = await Promise.all([
    leadRepo.countOpenLeads(actor.tenantId, scope),
    leadRepo.countFollowUpsDue(actor.tenantId, scope),
  ]);
  return { leadCount, followUpsDueCount };
}
