/**
 * The panel's local view of the world (docs/LEAD_GENERATION_FLOW.md §2, §4.1).
 *
 * Two layers:
 *  · the last **snapshot** the Master sent, persisted to disk so a panel that
 *    restarts while the Master is off still has something to show;
 *  · an **optimistic overlay** built from the outbox, so a lead saved thirty
 *    seconds ago appears on the board immediately rather than when the link
 *    returns.
 *
 * The overlay is derived, never stored. Rebuilding it from the outbox on every
 * read means there is exactly one source of truth for "what have we not sent
 * yet" — a cached overlay that drifted from the queue would show staff a lead
 * that no longer exists, or hide one that does.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  Lead,
  LineItem,
  Mutation,
  Party,
  Product,
  SyncSnapshot,
} from '@orderbook/shared';

import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { pending } from './outbox.store.js';

const log = createLogger('local-store');

let snapshot: SyncSnapshot | null = null;
let loaded = false;

export async function setSnapshot(next: SyncSnapshot): Promise<void> {
  snapshot = next;
  loaded = true;
  await persist(next);
}

export function getRawSnapshot(): SyncSnapshot | null {
  return snapshot;
}

/** Restore the last snapshot from disk, so an offline start still has data. */
export async function restore(): Promise<SyncSnapshot | null> {
  if (loaded) return snapshot;
  loaded = true;

  try {
    const raw = await fs.readFile(config.snapshotFile, 'utf8');
    snapshot = JSON.parse(raw) as SyncSnapshot;
    log.info('Restored the last snapshot from disk');
  } catch {
    snapshot = null;
  }

  return snapshot;
}

/**
 * What the browser should render: the server's snapshot with everything still
 * queued applied on top.
 */
export async function getView(): Promise<(SyncSnapshot & { pendingCount: number }) | null> {
  const base = snapshot ?? (await restore());
  if (!base) return null;

  const queued = await pending();
  if (queued.length === 0) return { ...base, pendingCount: 0 };

  const view: SyncSnapshot = {
    ...base,
    leads: [...base.leads],
    parties: [...base.parties],
    products: [...base.products],
  };

  for (const mutation of queued) applyOverlay(view, mutation);

  return { ...view, pendingCount: queued.length };
}

/**
 * Apply one queued mutation to the view.
 *
 * Only the kinds a person watches for are modelled. A queued stock adjustment,
 * for instance, is left off the view deliberately: showing an unconfirmed
 * quantity as though it were real stock would be worse than showing the last
 * figure the Master actually agreed to.
 */
function applyOverlay(view: SyncSnapshot, mutation: Mutation): void {
  switch (mutation.kind) {
    case 'lead.create':
      view.leads = [provisionalLead(view, mutation), ...view.leads];
      return;

    case 'lead.update':
      view.leads = view.leads.map((lead) =>
        lead.id === mutation.entityId ? { ...lead, ...pickLeadFields(mutation) } : lead,
      );
      return;

    case 'lead.setStage': {
      const stageId = String(mutation.payload.stageId ?? '');
      const stage = findStage(view, stageId);
      view.leads = view.leads.map((lead) =>
        lead.id === mutation.entityId
          ? {
              ...lead,
              stageId,
              stageName: stage?.name ?? lead.stageName,
              stageSequence: stage?.sequence ?? lead.stageSequence,
            }
          : lead,
      );
      return;
    }

    case 'party.create':
      view.parties = [provisionalParty(mutation), ...view.parties];
      return;

    case 'product.create':
      view.products = [provisionalProduct(mutation), ...view.products];
      return;

    default:
      return;
  }
}

/**
 * Build a lead that looks like one the Master would have returned.
 *
 * Everything it needs is already local: the payload has the lines, the snapshot
 * has the party, the product catalogue and the pipeline. Building it here is
 * what lets the board render a queued lead identically to a synced one — the
 * only visible difference is the pending badge the UI adds from `sync.hlc`
 * being empty.
 */
function provisionalLead(view: SyncSnapshot, mutation: Mutation): Lead {
  const payload = mutation.payload as {
    partyId?: string;
    ownerId?: string;
    sourcePlatform?: string | null;
    followUpDate?: string | null;
    partyWiseMode?: boolean;
    notes?: string | null;
    customFields?: Record<string, unknown>;
    items?: Array<Record<string, unknown>>;
  };

  const party = view.parties.find((candidate) => candidate.id === payload.partyId);
  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'lead');
  const stage = pipeline?.stages.find((candidate) => candidate.isDefault) ?? pipeline?.stages[0];

  const items = (payload.items ?? []).map((item, index) =>
    provisionalLine(view, mutation.entityId, item, index),
  );

  return {
    id: mutation.entityId,
    tenantId: party?.tenantId ?? '',
    partyId: payload.partyId ?? '',
    partyName: party?.name ?? 'Unknown party',
    ownerId: payload.ownerId ?? '',
    ownerName: null,
    stageId: stage?.id ?? '',
    stageName: stage?.name ?? 'New',
    stageSequence: stage?.sequence ?? 1,
    sourcePlatform: payload.sourcePlatform ?? null,
    followUpDate: payload.followUpDate ?? null,
    partyWiseMode: payload.partyWiseMode ?? false,
    notes: payload.notes ?? null,
    customFields: payload.customFields ?? {},
    incomplete: false,
    missingFields: [],
    convertedOrderId: null,
    convertedAt: null,
    totalAmount: items.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0),
    sourcePanelId: null,
    createdByUserId: null,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    // An empty `hlc` is the panel's marker for "not yet acknowledged"; the UI
    // reads it to draw the pending badge.
    sync: { version: 0, hlc: '', fieldHlc: {}, temporaryId: mutation.entityId },
    items,
    timeline: [],
  };
}

function provisionalLine(
  view: SyncSnapshot,
  parentId: string,
  item: Record<string, unknown>,
  index: number,
): LineItem {
  const product = view.products.find((candidate) => candidate.id === item.productId);

  const quantities = Array.isArray(item.quantities)
    ? (item.quantities as Array<{ colour: string; quantity: number }>).map((quantity, i) => ({
        id: `${parentId}-${index}-${i}`,
        colour: quantity.colour,
        quantity: Number(quantity.quantity) || 0,
      }))
    : [];

  const totalQuantity = quantities.reduce((sum, quantity) => sum + quantity.quantity, 0);
  const rate = (item.rate as number | null | undefined) ?? product?.rate ?? null;

  return {
    id: `${parentId}-line-${index}`,
    tenantId: product?.tenantId ?? '',
    parentType: 'lead',
    parentId,
    productId: String(item.productId ?? ''),
    productName: String(item.productName ?? product?.name ?? ''),
    alias: (item.alias as string | null) ?? product?.alias ?? null,
    rate,
    code: (item.code as string | null) ?? product?.productCode ?? null,
    sin: (item.sin as string | null) ?? product?.sin ?? null,
    size: (item.size as string | null) ?? product?.size ?? null,
    weightKg: (item.weightKg as number | null) ?? product?.weightKg ?? null,
    grade: (item.grade as string | null) ?? product?.grade ?? null,
    productType: (item.productType as string | null) ?? product?.productType ?? null,
    packaging: (item.packaging as string | null) ?? null,
    sequence: index + 1,
    fromPartyVariant: Boolean(item.fromPartyVariant),
    imagePath: null,
    notes: (item.notes as string | null) ?? null,
    quantities,
    totalQuantity,
    lineTotal: rate === null ? null : Math.round(rate * totalQuantity),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function provisionalParty(mutation: Mutation): Party {
  const payload = mutation.payload as Record<string, string | null>;

  return {
    id: mutation.entityId,
    tenantId: '',
    partyCode: 'pending',
    name: String(payload.name ?? ''),
    phone: payload.phone ?? null,
    altPhone: payload.altPhone ?? null,
    email: payload.email ?? null,
    addressLine1: payload.addressLine1 ?? null,
    addressLine2: payload.addressLine2 ?? null,
    city: payload.city ?? null,
    state: payload.state ?? null,
    pincode: payload.pincode ?? null,
    gstNumber: payload.gstNumber ?? null,
    notes: payload.notes ?? null,
    customFields: {},
    isActive: true,
    createdByUserId: null,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    sync: { version: 0, hlc: '', fieldHlc: {}, temporaryId: mutation.entityId },
  };
}

function provisionalProduct(mutation: Mutation): Product {
  const payload = mutation.payload as Record<string, never>;

  return {
    id: mutation.entityId,
    tenantId: '',
    productCode: String(payload.productCode ?? 'pending'),
    name: String(payload.name ?? ''),
    alias: payload.alias ?? null,
    categoryId: null,
    categoryName: payload.categoryName ?? null,
    size: payload.size ?? null,
    sin: payload.sin ?? null,
    grade: payload.grade ?? null,
    productType: payload.productType ?? null,
    weightKg: payload.weightKg ?? null,
    finish: null,
    series: payload.series ?? null,
    color: payload.color ?? null,
    thicknessMm: null,
    piecesPerBox: null,
    boxCoverageSqft: null,
    rate: payload.rate ?? null,
    pricePerSqft: null,
    hsnCode: null,
    parameters: {},
    customFields: {},
    isActive: true,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    sync: { version: 0, hlc: '', fieldHlc: {}, temporaryId: mutation.entityId },
  };
}

function pickLeadFields(mutation: Mutation): Partial<Lead> {
  const payload = mutation.payload as Partial<Lead>;
  const patch: Partial<Lead> = {};

  for (const field of mutation.fields) {
    if (field in payload) {
      Object.assign(patch, { [field]: payload[field as keyof Lead] });
    }
  }

  return patch;
}

function findStage(view: SyncSnapshot, stageId: string) {
  for (const pipeline of view.pipelines) {
    const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
    if (stage) return stage;
  }
  return null;
}

async function persist(value: SyncSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(config.snapshotFile), { recursive: true });
  await fs.writeFile(config.snapshotFile, JSON.stringify(value), { mode: 0o600 });
}

/** Test seam. */
export function resetLocalStore(): void {
  snapshot = null;
  loaded = false;
}
