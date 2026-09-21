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

import { maskLineItem } from '@orderbook/shared';
import type {
  Lead,
  LineItem,
  Mutation,
  Party,
  Product,
  SyncDeltaCursor,
  SyncSnapshot,
} from '@orderbook/shared';

import { paths } from '../config/paths.js';
import { createLogger } from '../lib/logger.js';
import { outboxRevision, pending } from './outbox.store.js';

const log = createLogger('local-store');

let snapshot: SyncSnapshot | null = null;
let cursor: SyncDeltaCursor | null = null;
let loaded = false;

/**
 * Bumped whenever the snapshot changes at all, including in place.
 *
 * `setSnapshot` stores the object it is handed and `applyChange` mutates that
 * same object, so identity is useless as a change signal — a memo keyed on the
 * reference would never invalidate. This counter is what the view memo keys on
 * instead.
 */
let revision = 0;

/**
 * Store the snapshot, and — in the **same disk write** — the cursor that
 * describes it.
 *
 * The pair has to be written together. A cursor saved separately can survive a
 * crash that the snapshot it refers to did not, and the panel would then ask
 * for the changes after a position it never actually reached: it would look
 * caught up while silently missing every row in between.
 */
export async function setSnapshot(
  next: SyncSnapshot,
  nextCursor: SyncDeltaCursor | null = null,
): Promise<void> {
  snapshot = next;
  cursor = nextCursor;
  loaded = true;
  revision += 1;
  await persist();
}

export function getRawSnapshot(): SyncSnapshot | null {
  return snapshot;
}

/** What this panel already has, for the Master to answer with a delta. */
export function getCursor(): SyncDeltaCursor | null {
  return cursor;
}

/**
 * Note that the in-memory snapshot moved on, without writing to disk yet.
 *
 * Replayed and live changes mutate the snapshot object in place, so memory is
 * current while disk is stale — `persistCurrent` is what closes that, on a
 * trailing edge rather than once per row.
 */
export function noteApplied(seq: number | undefined, bootId: string | null): void {
  // Always bumped, even with no cursor to record: the view memo keys on this,
  // and a change applied against a Master too old to send a boot id still
  // changed what the browser should be shown.
  revision += 1;

  if (seq === undefined || !bootId) return;
  cursor = { bootId, lastSeq: seq };
}

/** Write whatever is in memory now. Debounced by the caller, not here. */
export async function persistCurrent(): Promise<void> {
  if (!snapshot) return;
  await persist();
}

/** Restore the last snapshot from disk, so an offline start still has data. */
export async function restore(): Promise<SyncSnapshot | null> {
  if (loaded) return snapshot;
  loaded = true;

  try {
    const raw = await fs.readFile(paths().snapshotFile, 'utf8');
    const parsed = JSON.parse(raw) as StoredSnapshot | SyncSnapshot;

    // A file written before the cursor existed is a bare snapshot. Reading it
    // as one — rather than failing, or worse, treating its absent cursor as
    // position zero — is what lets a panel upgrade without re-syncing.
    if (isStored(parsed)) {
      snapshot = parsed.snapshot;
      cursor = parsed.cursor;
    } else {
      snapshot = parsed;
      cursor = null;
    }

    revision += 1;
    log.info('Restored the last snapshot from disk');
  } catch {
    snapshot = null;
    cursor = null;
  }

  return snapshot;
}

/** The on-disk shape. `version` is what tells it apart from a bare snapshot. */
interface StoredSnapshot {
  version: 2;
  snapshot: SyncSnapshot;
  cursor: SyncDeltaCursor | null;
}

function isStored(value: StoredSnapshot | SyncSnapshot): value is StoredSnapshot {
  return (value as StoredSnapshot).version === 2;
}

/**
 * What the browser should render: the server's snapshot with everything still
 * queued applied on top.
 */
export async function getView(): Promise<(SyncSnapshot & { pendingCount: number }) | null> {
  const base = snapshot ?? (await restore());
  if (!base) return null;

  const queued = await pending();

  /*
   * Memoised on the two revisions the view is derived from.
   *
   * This is built and stringified on every SSE push and on every
   * `/api/snapshot`, and rebuilding it is a full copy of three collections plus
   * a replay of the queue. Keyed on counters rather than on object identity
   * because `setSnapshot` stores the object it is handed and `applyChange`
   * mutates that same object — a memo keyed on the reference would never
   * invalidate.
   */
  const key = `${revision}:${outboxRevision()}`;
  if (memo && memo.key === key) return memo.view;

  const view = queued.length === 0 ? { ...base, pendingCount: 0 } : buildView(base, queued);
  memo = { key, view };
  return view;
}

let memo: { key: string; view: SyncSnapshot & { pendingCount: number } } | null = null;

function buildView(
  base: SyncSnapshot,
  queued: Mutation[],
): SyncSnapshot & { pendingCount: number } {
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
    provisionalLine(view, mutation.entityId, item, index, payload.partyWiseMode ? payload.partyId : undefined),
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
    totalWeightKg:
      Math.round(items.reduce((sum, line) => sum + (line.lineWeightKg ?? 0), 0) * 1000) / 1000,
    linesWithoutWeight: items.filter((line) => line.lineWeightKg === null).length,
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
  /** Set when the lead is party-wise: the party's own variant rate wins, as on the Master. */
  variantPartyId?: string,
): LineItem {
  const product = view.products.find((candidate) => candidate.id === item.productId);
  // The product variant is where the code, the colour text and the weight
  // come from; the party's own rate record is where a party-wise price comes
  // from. Two different things that used to share one name.
  const variant = product?.variants.find((candidate) => candidate.id === item.variantId);
  const partyRate = variantPartyId
    ? view.partyVariants.find(
        (candidate) => candidate.partyId === variantPartyId && candidate.productId === item.productId,
      )
    : undefined;

  const quantity = Number(item.quantity) || 0;
  const weightKg = (item.weightKg as number | null | undefined) ?? variant?.weightKg ?? null;

  // Absence has to survive the optimistic overlay. When the person who queued
  // this line cannot see rates, the product they picked came to this panel with
  // no `rate` key at all — materialising `rate: null` here would turn "hidden"
  // into "this line is free", which is precisely the distinction §6 is about.
  const rateHidden =
    item.rate === undefined && product !== undefined && !('rate' in (product as object));
  // `rateUnset` stops the catalogue fallback here too, or the board would show
  // a price for a line the counter deliberately left to be quoted. Otherwise the
  // same ladder as `buildLineSnapshot` on the Master — sent rate, party variant,
  // catalogue — so a queued lead shows the figure the ack will confirm.
  const rate = item.rateUnset
    ? null
    : ((item.rate as number | null | undefined) ?? partyRate?.rate ?? product?.rate ?? null);

  const line: LineItem = {
    id: `${parentId}-line-${index}`,
    tenantId: product?.tenantId ?? '',
    parentType: 'lead',
    parentId,
    productId: String(item.productId ?? ''),
    variantId: String(item.variantId ?? ''),
    productName: String(item.productName ?? product?.name ?? ''),
    categoryName: (item.categoryName as string | null) ?? product?.categoryName ?? null,
    alias: (item.alias as string | null) ?? product?.alias ?? null,
    rate,
    code: (item.code as string | null) ?? variant?.code ?? null,
    variantLabel: (item.variantLabel as string | null) ?? variant?.label ?? null,
    sin: (item.sin as string | null) ?? product?.sin ?? null,
    size: (item.size as string | null) ?? product?.size ?? null,
    weightKg,
    grade: (item.grade as string | null) ?? product?.grade ?? null,
    productType: (item.productType as string | null) ?? product?.productType ?? null,
    packaging: (item.packaging as string | null) ?? null,
    sequence: index + 1,
    fromPartyVariant: Boolean(item.fromPartyVariant),
    imagePath: null,
    notes: (item.notes as string | null) ?? null,
    quantity,
    lineWeightKg: weightKg === null ? null : Math.round(weightKg * quantity * 1000) / 1000,
    lineTotal: rate === null ? null : Math.round(rate * quantity),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Same helper the Master masks with, so the two cannot disagree about what
  // "hidden" looks like on the wire.
  return maskLineItem(line, !rateHidden);
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
  const variants = Array.isArray(payload.variants)
    ? (payload.variants as Array<Record<string, unknown>>)
    : [];

  return {
    id: mutation.entityId,
    tenantId: '',
    name: String(payload.name ?? ''),
    alias: payload.alias ?? null,
    categoryId: String(payload.categoryId ?? ''),
    categoryName: String(payload.categoryName ?? ''),
    size: payload.size ?? null,
    sin: payload.sin ?? null,
    grade: payload.grade ?? null,
    productType: payload.productType ?? null,
    hasVariants: Boolean(payload.hasVariants),
    // The Master mints the variant ids; until it answers, these rows carry
    // placeholder ids for display. The lead screen leaves a still-provisional
    // product alone for exactly that reason.
    variants: variants.map((variant, index) => ({
      id: typeof variant.id === 'string' ? variant.id : `${mutation.entityId}-v${index + 1}`,
      productId: mutation.entityId,
      code: String(variant.code ?? ''),
      label: typeof variant.label === 'string' && variant.label ? variant.label : null,
      weightKg: typeof variant.weightKg === 'number' ? variant.weightKg : null,
      sequence: typeof variant.sequence === 'number' ? variant.sequence : index + 1,
      isActive: true,
    })),
    finish: null,
    series: payload.series ?? null,
    thicknessMm: null,
    piecesPerBox: null,
    boxCoverageSqft: null,
    rate: payload.rate ?? null,
    pricePerSqft: null,
    hsnCode: null,
    // The attributes a person can actually type into the offline Add Product
    // form. The rest stay null until the Master answers — a provisional row is
    // what was typed, not a guess at what the catalogue will hold.
    mrp: payload.mrp ?? null,
    purchaseRate: payload.purchaseRate ?? null,
    gstRatePct: payload.gstRatePct ?? null,
    uom: String(payload.uom ?? 'box'),
    barcode: payload.barcode ?? null,
    brand: payload.brand ?? null,
    shade: payload.shade ?? null,
    calibre: payload.calibre ?? null,
    waterAbsorptionPct: null,
    peiRating: null,
    edgeType: payload.edgeType ?? null,
    surfaceTexture: payload.surfaceTexture ?? null,
    application: payload.application ?? null,
    originPlant: payload.originPlant ?? null,
    parameters: {},
    customFields: {},
    isActive: true,
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt,
    sync: { version: 0, hlc: '', fieldHlc: {}, temporaryId: mutation.entityId },
    // A product created offline has no images yet — images are online-only
    // (`7-IMAGE-PIPELINE.md` port notes), so this can never be non-empty for
    // a still-provisional record.
    images: [],
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

async function persist(): Promise<void> {
  if (!snapshot) return;

  const stored: StoredSnapshot = { version: 2, snapshot, cursor };
  await fs.mkdir(path.dirname(paths().snapshotFile), { recursive: true });
  await fs.writeFile(paths().snapshotFile, JSON.stringify(stored), { mode: 0o600 });
}

/** Test seam. */
export function resetLocalStore(): void {
  snapshot = null;
  cursor = null;
  loaded = false;
  revision += 1;
  memo = null;
}
