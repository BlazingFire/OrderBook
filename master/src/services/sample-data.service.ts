/**
 * Sample data for a demo or a fresh development Master: parties, products
 * with photos, stock, leads at every stage, orders in progress and
 * dispatched, remarks, party-wise records, party access, custom fields and a
 * few records in the Recycle Bin — six months of a small tile trade
 * (`domain/sample-data.ts` holds the dataset).
 *
 * Every record is written **through the same services the panels call**, as
 * one of the three test users. That is the point of the exercise: the
 * activity log, the timelines, the stock ledger and the reservations come
 * out exactly as they would from real use, because they came from the real
 * code path. The one thing the services cannot do is write history — every
 * row they insert is stamped `now()` — so the seed runs its events in date
 * order and, after each one, moves the timestamps that event created back to
 * the date it was meant to happen on. Nothing else is touched by hand.
 *
 * Reached from the /api/developer routes (no screen since 5a32106) and from
 * `npm run seed:sample`; both behind the developer gate or a terminal, like the other developer tools.
 */

import type {
  FieldListKey,
  LineItemInput,
  SampleDataCounts,
  SeedSampleDataResult,
} from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import {
  createRandom,
  DEFAULT_MAX_STOCK_LEVEL,
  DEFAULT_MIN_STOCK_LEVEL,
  DEFAULT_OPENING_PIECES,
  DEFAULT_REORDER_LEVEL,
  SAMPLE_CUSTOM_FIELDS,
  SAMPLE_DELETIONS,
  SAMPLE_LEADS,
  SAMPLE_MARKER_PARTY_KEY,
  SAMPLE_OPENING_STOCK,
  SAMPLE_OPTION_VALUES,
  SAMPLE_PARTIES,
  SAMPLE_PARTY_ASSIGNMENTS,
  SAMPLE_PARTY_VARIANTS,
  SAMPLE_PRODUCTS,
  SAMPLE_STOCK_ARRIVALS,
  SAMPLE_STOCK_COUNTS,
  SAMPLE_SUB_PRODUCTS,
  SAMPLE_WINDOW_DAYS,
  type SampleLead,
  type SampleUser,
} from '../domain/sample-data.js';
import { UNSCOPED_PARTY_ACCESS } from '../domain/party-scope.js';
import { db } from '../db/knex.js';
import { ValidationError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { renderTileSwatch } from '../lib/tile-swatch.js';
import * as partyRepo from '../repositories/party.repository.js';
import * as pipelineRepo from '../repositories/pipeline.repository.js';
import * as productRepo from '../repositories/product.repository.js';
import { permissionSetForRole } from '../repositories/role.repository.js';
import { resolveDefaultTenantId } from '../repositories/tenant.repository.js';
import * as catalog from './catalog.service.js';
import { readCatalogueFile, seedCatalogue } from './catalogue-seed.service.js';
import { seedDummyUsers } from './developer.service.js';
import * as fields from './fields.service.js';
import { uploadImage } from './image.service.js';
import * as inventory from './inventory.service.js';
import * as leads from './lead.service.js';
import * as orders from './order.service.js';
import * as partyAccess from './party-access.service.js';

const log = createLogger('sample-data');

export interface SeedSampleDataOptions {
  /** "Today" for the generated history. Defaults to the wall clock; tests pin it. */
  now?: Date;
  /** Product photos go through sharp and take a few seconds; a test may skip them. */
  images?: boolean;
}

interface ScheduledEvent {
  at: Date;
  run: () => Promise<void>;
}

/** Ids minted while a lead's history runs, read by the events scheduled after. */
interface LeadProgress {
  leadId: string | null;
  orderId: string | null;
}

/**
 * Seed the sample dataset. Seeds (or re-arms) the three test users first —
 * the records need somebody to have created them, and a fresh install needs
 * somebody to sign in as — and refuses to run twice on one Master.
 */
export async function seedSampleData(
  options: SeedSampleDataOptions = {},
): Promise<SeedSampleDataResult> {
  // Refused before anything is touched: seeding the users re-arms passwords
  // and ends sessions, which a press that is going to be refused must not do.
  // The tenant exists from the migrations, set up or not.
  const tenantId = await resolveDefaultTenantId();
  if (await sampleDataPresent(tenantId)) {
    throw new ValidationError('validation.developer.sampleDataPresent');
  }

  const seededUsers = await seedDummyUsers();

  const now = options.now ?? new Date();
  const withImages = options.images ?? true;
  const actors = await loadActors(tenantId);
  const clock = createClock(now);
  const counts = emptyCounts();
  const events: ScheduledEvent[] = [];
  const schedule = (at: Date, run: () => Promise<void>): void => {
    events.push({ at, run });
  };

  // Resolved as the events run; every later event looks ids up here.
  const partyIds = new Map<string, string>();
  /** Sample key → the ids a line, a stock movement or a party record needs. */
  const variantIds = new Map<string, { variantId: string; productId: string }>();
  // The printed swatches, so a photo is drawn in its sub product's colour.
  const colourHex = new Map(
    (await readCatalogueFile()).colours.map((colour) => [colour.name, colour.hex]),
  );

  // --- Day 0–1: the company sets itself up — lists, fields, catalogue -------

  let optionSequence = 0;
  for (const listKey of Object.keys(SAMPLE_OPTION_VALUES) as FieldListKey[]) {
    for (const value of SAMPLE_OPTION_VALUES[listKey]) {
      schedule(clock.at(0, optionSequence++), async () => {
        await fields.createValue(
          { listKey, value: value.value, label: value.value, hex: value.hex ?? null },
          actors.admin,
        );
        counts.optionValues += 1;
      });
    }
  }

  SAMPLE_CUSTOM_FIELDS.forEach((definition, index) => {
    schedule(clock.at(0, 60 + index), async () => {
      await fields.createDefinition(
        {
          entity: definition.entity,
          key: definition.key,
          label: definition.label,
          fieldType: definition.fieldType,
          options: definition.options,
        },
        actors.admin,
      );
      counts.customFields += 1;
    });
  });

  // The product master is the SWISWARE catalogue, loaded whole on day one
  // as the administrator. Additive, so a Master that already holds it
  // simply reports it as present.
  schedule(clock.at(1, 0), async () => {
    const loaded = await seedCatalogue({ actor: actors.admin });
    counts.products += loaded.subProducts;

    // Every sub product the demo refers to, resolved once by (product code,
    // printed name) — the codes themselves are generated by the load.
    const keys = new Set<string>();
    for (const product of SAMPLE_PRODUCTS)
      for (const key of Object.keys(product.weights)) keys.add(key);
    for (const line of SAMPLE_LEADS.flatMap((lead) => lead.lines)) keys.add(line.code);
    for (const variant of SAMPLE_PARTY_VARIANTS) keys.add(variant.code);
    for (const entry of [...SAMPLE_STOCK_ARRIVALS, ...SAMPLE_STOCK_COUNTS]) keys.add(entry.code);
    keys.add(SAMPLE_DELETIONS.productCode);
    for (const key of keys) {
      const where = SAMPLE_SUB_PRODUCTS[key];
      const hit = where
        ? await productRepo.findLiveSubProductByCodeAndName(
            tenantId,
            where.product,
            where.subProduct,
          )
        : null;
      if (!hit) throw new Error(`Sample sub product "${key}" is not in the SWISWARE catalogue`);
      variantIds.set(key, hit);
    }
  });

  // Then what the business enters into the master for the sub products it
  // trades in: an alias, and illustrative weights on the ones it quotes.
  SAMPLE_PRODUCTS.forEach((product, index) => {
    schedule(clock.at(1, 10 + index * 3), async () => {
      for (const [key, weightKg] of Object.entries(product.weights)) {
        const productId = requireVariant(variantIds, key).productId;
        const existing = await productRepo.findProductById(tenantId, productId);
        if (!existing)
          throw new Error(`Sample sub product "${key}" vanished after the catalogue load`);

        await catalog.updateProduct(
          productId,
          {
            name: existing.name,
            alias: product.alias ?? null,
            customFields: { launchYear: product.launchYear },
            variants: existing.variants.map((variant) => ({
              id: variant.id,
              code: variant.code,
              label: variant.label,
              weightKg,
              sequence: variant.sequence,
            })),
          },
          actors.admin,
        );
      }
    });

    if (withImages) {
      schedule(clock.at(1, 11 + index * 3), async () => {
        const [firstCode] = Object.keys(product.weights);
        const productId = requireVariant(variantIds, firstCode as string).productId;
        const existing = await productRepo.findProductById(tenantId, productId);
        const colour = existing?.variants.find((variant) => variant.label)?.label ?? 'White';
        try {
          const fileBuffer = await renderTileSwatch({
            baseHex: colourHex.get(colour) ?? '#F4F4F0',
            pattern: product.pattern,
            seed: 7 + index,
          });
          await uploadImage(
            {
              productId,
              fileBuffer,
              crop: {
                cropX: 0,
                cropY: 0,
                cropWidth: 800,
                cropHeight: 800,
                rotationDeg: 0,
                caption: `${product.model} — ${colour}`,
              },
            },
            actors.admin,
          );
          counts.images += 1;
        } catch (error) {
          // A photo is decoration; a machine whose rasteriser cannot draw one
          // still gets the rest of the dataset.
          log.warn(`Skipping the sample photo for ${product.model}: ${(error as Error).message}`);
        }
      });
    }
  });

  // --- Day 2–4: the party book, party-wise records, and who may see whom ----

  SAMPLE_PARTIES.forEach((party, index) => {
    // Builders and architects are the management user's accounts; dealers the
    // administrator's — so the log shows more than one person at work.
    const actor =
      party.dealerType === 'Dealer' || party.dealerType === 'Retail'
        ? actors.admin
        : actors.management;
    schedule(clock.at(2 + (index % 3), index * 2), async () => {
      const created = await catalog.createParty(
        {
          name: party.name,
          phone: party.phone,
          altPhone: party.altPhone ?? null,
          email: party.email ?? null,
          addressLine1: party.addressLine1,
          addressLine2: party.addressLine2 ?? null,
          city: party.city,
          state: party.state,
          pincode: party.pincode,
          gstNumber: party.gstNumber ?? null,
          notes: party.notes ?? null,
          customFields: { dealerType: party.dealerType, creditDays: party.creditDays },
        },
        actor,
      );
      partyIds.set(party.key, created.id);
      counts.parties += 1;
    });
  });

  SAMPLE_PARTY_VARIANTS.forEach((variant, index) => {
    schedule(clock.at(5, index * 4), async () => {
      await catalog.upsertVariant(
        {
          partyId: requireId(partyIds, variant.party, 'party'),
          productId: requireVariant(variantIds, variant.code).productId,
          alias: variant.alias ?? null,
          packaging: variant.packaging ?? null,
        },
        actors.admin,
      );
      counts.partyVariants += 1;
    });
  });

  SAMPLE_PARTY_ASSIGNMENTS.forEach((assignment, index) => {
    schedule(clock.at(5, 40 + index * 3), async () => {
      const partyId = requireId(partyIds, assignment.party, 'party');
      const party = await catalog.getParty(partyId, actors.admin);
      await partyAccess.replaceAssignments(
        partyId,
        {
          entries: assignment.entries.map((entry) => ({
            userId: actors[entry.user].userId ?? '',
            level: entry.level,
          })),
          expectedVersion: party.sync.version,
        },
        actors.admin,
      );
      counts.partyAssignments += assignment.entries.length;
    });
  });

  // --- Day 6–9: opening stock and the stock bands ---------------------------

  let stockSequence = 0;
  for (const product of SAMPLE_PRODUCTS) {
    for (const code of Object.keys(product.weights)) {
      const pieces = SAMPLE_OPENING_STOCK[code] ?? DEFAULT_OPENING_PIECES;
      const slot = stockSequence++;
      schedule(clock.at(6 + (slot % 4), slot), async () => {
        const { variantId } = requireVariant(variantIds, code);
        await inventory.recordInbound(
          { variantId, quantityBoxes: pieces, note: 'Opening stock' },
          actors.management,
        );
        counts.stockMovements += 1;
        await inventory.setReorderLevel(
          {
            variantId,
            reorderLevel: DEFAULT_REORDER_LEVEL,
            minStockLevel: DEFAULT_MIN_STOCK_LEVEL,
            maxStockLevel: DEFAULT_MAX_STOCK_LEVEL,
          },
          actors.management,
        );
      });
    }
  }

  SAMPLE_STOCK_ARRIVALS.forEach((arrival, index) => {
    schedule(clock.at(arrival.day, index), async () => {
      await inventory.recordInbound(
        {
          variantId: requireVariant(variantIds, arrival.code).variantId,
          quantityBoxes: arrival.pieces,
          note: arrival.note,
        },
        actors.management,
      );
      counts.stockMovements += 1;
    });
  });

  SAMPLE_STOCK_COUNTS.forEach((count, index) => {
    schedule(clock.at(count.day, 30 + index), async () => {
      await inventory.recordAdjustment(
        {
          variantId: requireVariant(variantIds, count.code).variantId,
          quantityBoxes: count.countedPieces,
          note: count.note,
        },
        actors.management,
      );
      counts.stockMovements += 1;
    });
  });

  // --- The leads, each with its own history ---------------------------------

  const random = createRandom(2026);
  const progress: LeadProgress[] = SAMPLE_LEADS.map(() => ({ leadId: null, orderId: null }));

  SAMPLE_LEADS.forEach((lead, index) => {
    scheduleLeadHistory(lead, progress[index] as LeadProgress, {
      actors,
      clock,
      now,
      random,
      counts,
      schedule,
      partyIds,
      variantIds,
    });
  });

  // --- The last day: what went to the Recycle Bin ---------------------------

  schedule(clock.at(SAMPLE_WINDOW_DAYS - 1, 80), async () => {
    await catalog.deleteParty(
      requireId(partyIds, SAMPLE_DELETIONS.party, 'party'),
      actors.management,
    );
    counts.deleted += 1;
  });
  schedule(clock.at(SAMPLE_WINDOW_DAYS - 1, 81), async () => {
    await catalog.deleteProduct(
      requireVariant(variantIds, SAMPLE_DELETIONS.productCode).productId,
      actors.management,
    );
    counts.deleted += 1;
  });
  schedule(clock.at(SAMPLE_WINDOW_DAYS - 1, 82), async () => {
    const leadId = progress[SAMPLE_DELETIONS.leadIndex]?.leadId;
    if (!leadId) return;
    await leads.deleteLead(leadId, actors.management);
    counts.deleted += 1;
  });

  // --- Run it, oldest first, moving each event's timestamps back ------------

  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  const backdate = createBackdater(tenantId);

  for (const event of events) {
    // Two seconds of slack between the wall clock and the database's `now()`:
    // both read the same system clock, but a transaction's `now()` is its
    // start time, which can precede this line by the time a pool checkout took.
    const since = new Date(Date.now() - 2_000);
    await event.run();
    await backdate(since, event.at);
  }

  log.info(
    `Sample data seeded: ${counts.parties} parties, ${counts.products} products, ${counts.leads} leads, ${counts.orders} orders`,
  );

  return {
    users: seededUsers.users,
    pairingPassword: seededUsers.pairingPassword,
    companyName: seededUsers.companyName,
    counts,
    from: isoDate(clock.at(0, 0)),
    to: isoDate(now),
  };
}

// --- One lead's history ----------------------------------------------------

interface LeadContext {
  actors: Record<SampleUser, ActorContext>;
  clock: SampleClock;
  now: Date;
  random: () => number;
  counts: SampleDataCounts;
  schedule: (at: Date, run: () => Promise<void>) => void;
  partyIds: Map<string, string>;
  variantIds: Map<string, { variantId: string; productId: string }>;
}

/**
 * New → Quoted → Negotiating → Won/Lost, with the remarks spread along the
 * way and, for a won lead, the conversion and whatever the order then did.
 * Every step is a few days after the last, jittered so the board does not
 * show thirty leads that all moved on a Tuesday.
 */
function scheduleLeadHistory(lead: SampleLead, progress: LeadProgress, ctx: LeadContext): void {
  const { actors, clock, random, counts, schedule } = ctx;
  const owner = actors[lead.owner];
  // Order-side work needs `orders.edit` / `orders.dispatch`, which the office
  // tier does not hold — somebody senior picks those up, as they would. The
  // administrator rather than the management user, because an office user's
  // parties may be assigned to them alone, and only `party.accessAll` (an
  // admin key by default) reaches an order on a party one is not assigned to.
  const supervisor = lead.owner === 'office' ? actors.admin : owner;
  const remarks = [...(lead.remarks ?? [])];
  const jitter = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  let day = lead.day;
  // Raised at some point in the working day, not on the stroke of ten.
  let minute = jitter(0, 420);

  schedule(clock.at(day, minute), async () => {
    const created = await leads.createLead(
      {
        partyId: requireId(ctx.partyIds, lead.party, 'party'),
        sourcePlatform: lead.source,
        followUpDate:
          lead.followUpInDays === undefined ? null : isoDate(addDays(ctx.now, lead.followUpInDays)),
        partyWiseMode: lead.partyWise ?? false,
        notes: lead.notes ?? null,
        customFields: {
          ...(lead.priority ? { priority: lead.priority } : {}),
          ...(lead.siteLocation ? { siteLocation: lead.siteLocation } : {}),
        },
        items: lead.lines.map((line): LineItemInput => {
          const ids = requireVariant(ctx.variantIds, line.code);
          return {
            productId: ids.productId,
            variantId: ids.variantId,
            quantity: line.quantity,
            packaging: line.packaging,
            colour: line.colour ?? null,
            notes: line.notes ?? null,
          };
        }),
      },
      owner,
    );
    progress.leadId = created.id;
    counts.leads += 1;
  });

  const moveLead = (stageName: string, remark: string | null) => {
    schedule(clock.at(day, minute), async () => {
      if (!progress.leadId) return;
      const stage = await stageByName(owner.tenantId, 'lead', stageName);
      await leads.setStage({ id: progress.leadId, stageId: stage.id, remark }, owner);
      if (remark) counts.remarks += 1;
    });
  };

  const remarkOnLead = (message: string) => {
    schedule(clock.at(day, minute), async () => {
      if (!progress.leadId) return;
      await leads.addRemark({ id: progress.leadId, message }, owner);
      counts.remarks += 1;
    });
  };

  const path: string[] =
    lead.outcome.kind === 'open'
      ? lead.outcome.stage === 'New'
        ? []
        : lead.outcome.stage === 'Quoted'
          ? ['Quoted']
          : ['Quoted', 'Negotiating']
      : lead.outcome.kind === 'lost'
        ? ['Quoted', 'Negotiating', 'Lost']
        : ['Quoted', 'Negotiating', 'Won'];

  // The closing stage carries the closing remark — why it was lost, or the
  // confirmation that won it; the earlier ones take the remarks in order.
  const closing =
    lead.outcome.kind === 'lost'
      ? lead.outcome.remark
      : lead.outcome.kind === 'won'
        ? (remarks.pop() ?? null)
        : null;

  for (const stageName of path) {
    day += jitter(1, 3);
    minute = jitter(0, 200);
    const terminal = stageName === 'Lost' || stageName === 'Won';
    moveLead(stageName, terminal ? closing : (remarks.shift() ?? null));
  }

  // Remarks the stage moves did not use up land as plain remarks afterwards.
  for (const leftover of remarks) {
    day += jitter(1, 2);
    minute = jitter(0, 200);
    remarkOnLead(leftover);
  }

  if (lead.outcome.kind !== 'won') return;

  const outcome = lead.outcome;
  const wonDay = day;

  // Converted the same day it was won, a little later.
  minute += 15;
  schedule(clock.at(day, minute), async () => {
    if (!progress.leadId) return;
    const order = await orders.convertLead(
      {
        leadId: progress.leadId,
        dispatchAddressLabel: outcome.dispatchAddress,
        expectedDispatchDate: isoDate(clock.at(wonDay + 7, 0)),
      },
      owner,
    );
    progress.orderId = order.id;
    counts.orders += 1;

    if (outcome.transport || outcome.vehicle) {
      await orders.updateOrder(
        order.id,
        {
          customFields: {
            ...(outcome.transport ? { transport: outcome.transport } : {}),
            ...(outcome.vehicle ? { vehicleNumber: outcome.vehicle } : {}),
          },
        },
        supervisor,
      );
    }
  });

  const orderPath = outcome.order;
  switch (orderPath.kind) {
    case 'inProgress':
      return;
    case 'postponed':
      day += jitter(3, 6);
      schedule(clock.at(day, jitter(0, 200)), async () => {
        if (!progress.orderId) return;
        const stage = await stageByName(owner.tenantId, 'order', 'Postpone');
        await orders.setStage(
          { id: progress.orderId, stageId: stage.id, remark: orderPath.remark },
          supervisor,
        );
        counts.remarks += 1;
      });
      return;
    case 'cancelled':
      day += jitter(4, 8);
      schedule(clock.at(day, jitter(0, 200)), async () => {
        if (!progress.orderId) return;
        const stage = await stageByName(owner.tenantId, 'order', 'Cancelled');
        await orders.setStage(
          { id: progress.orderId, stageId: stage.id, remark: orderPath.remark },
          supervisor,
        );
        counts.remarks += 1;
      });
      return;
    case 'dispatched':
    default:
      day = orderPath.onDay ?? wonDay + orderPath.afterDays;
      schedule(clock.at(day, jitter(0, 200)), async () => {
        if (!progress.orderId) return;
        await orders.dispatchOrder({ orderId: progress.orderId, note: orderPath.note }, supervisor);
        counts.dispatched += 1;
      });
  }
}

// --- Helpers ---------------------------------------------------------------

interface SampleClock {
  /**
   * A moment on `day` of the window, during business hours, `minute` minutes
   * into it — never later than "now", so nothing lands in the future.
   */
  at(day: number, minute: number): Date;
}

function createClock(now: Date): SampleClock {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - SAMPLE_WINDOW_DAYS);
  // 04:30 UTC is 10:00 in Asia/Kolkata, the timezone the reports bucket by.
  start.setUTCHours(4, 30, 0, 0);

  return {
    at(day, minute) {
      const at = new Date(start);
      at.setUTCDate(at.getUTCDate() + day);
      at.setUTCMinutes(at.getUTCMinutes() + minute);
      return at.getTime() >= now.getTime() ? new Date(now.getTime() - 60_000) : at;
    },
  };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyCounts(): SampleDataCounts {
  return {
    parties: 0,
    products: 0,
    images: 0,
    optionValues: 0,
    customFields: 0,
    partyVariants: 0,
    partyAssignments: 0,
    stockMovements: 0,
    leads: 0,
    orders: 0,
    dispatched: 0,
    remarks: 0,
    deleted: 0,
  };
}

function requireId(ids: Map<string, string>, key: string, kind: string): string {
  const id = ids.get(key);
  if (!id) throw new Error(`Sample ${kind} "${key}" was referenced before it was created`);
  return id;
}

function requireVariant(
  ids: Map<string, { variantId: string; productId: string }>,
  code: string,
): { variantId: string; productId: string } {
  const found = ids.get(code);
  if (!found) throw new Error(`Sample variant "${code}" was referenced before the catalogue was loaded`);
  return found;
}

/**
 * Whether this dataset is already here: the first sample party's phone
 * number is on a live party. (The products are the real catalogue, which a
 * Master may hold without ever having been seeded with the demo.)
 */
async function sampleDataPresent(tenantId: string): Promise<boolean> {
  const marker = SAMPLE_PARTIES.find((party) => party.key === SAMPLE_MARKER_PARTY_KEY);
  if (!marker) return false;
  const page = await partyRepo.listParties(tenantId, {
    search: marker.phone,
    limit: 5,
    offset: 0,
    scope: UNSCOPED_PARTY_ACCESS,
  });
  return page.items.some((party) => party.phone === marker.phone);
}

async function stageByName(
  tenantId: string,
  kind: 'lead' | 'order',
  name: string,
): Promise<{ id: string }> {
  const stages = await pipelineRepo.stagesFor(tenantId, kind);
  const stage = stages.find((candidate) => candidate.name === name && !candidate.isArchived);
  if (!stage) throw new Error(`The ${kind} pipeline has no "${name}" stage to seed into`);
  return stage;
}

/**
 * The three test users as actors, each carrying their role's live permission
 * set — so an office-tier action the seed attempts is refused the same way
 * the panel would refuse it, rather than slipping through as "system".
 */
async function loadActors(tenantId: string): Promise<Record<SampleUser, ActorContext>> {
  const rows = await db()('users')
    .where({ tenant_id: tenantId })
    .whereNull('deleted_at')
    .whereIn('username', ['admin', 'management', 'office'])
    .select<Array<{ id: string; username: string; display_name: string; role_id: string | null }>>(
      'id',
      'username',
      'display_name',
      'role_id',
    );

  const actors: Partial<Record<SampleUser, ActorContext>> = {};
  for (const row of rows) {
    actors[row.username as SampleUser] = {
      tenantId,
      actorType: 'user',
      actorId: row.id,
      userId: row.id,
      permissions: await permissionSetForRole(tenantId, row.role_id),
      deviceCode: null,
      actorName: row.display_name,
    };
  }

  for (const user of ['admin', 'management', 'office'] as const) {
    if (!actors[user]) throw new Error(`Test user "${user}" is missing after seeding`);
  }
  return actors as Record<SampleUser, ActorContext>;
}

/**
 * Move every timestamp an event just wrote back to when the event "happened".
 *
 * `since` is a moment just before the event ran, so `>= since` selects
 * exactly the rows that event inserted or touched: everything older was
 * already moved into the past by an earlier pass. Tenant-scoped like every
 * other query, even though a seed only ever runs on one company.
 *
 * The activity log is append-only by trigger (`activity_log_no_update`,
 * 20260303), which is exactly right for an audit trail and exactly wrong for
 * one being written as history. The trigger comes down and goes back up
 * inside the same transaction as the update — the way
 * `20260310000000_activity_log_actor_name.ts` backfilled a column — so no
 * failure between the two can leave the guard off. The chain itself covers a
 * row's content and sequence, not `created_at` (`activity_log_row_hash`),
 * so it verifies afterwards; the integration test checks that it does.
 */
function createBackdater(tenantId: string): (since: Date, at: Date) => Promise<void> {
  const columns: Record<string, string[]> = {
    activity_log: ['created_at'],
    timeline_entries: ['created_at'],
    stock_movements: ['created_at'],
    stock_reservations: ['created_at', 'settled_at'],
    inventory_stock: ['updated_at'],
    line_items: ['created_at', 'updated_at'],
    leads: ['created_at', 'updated_at', 'converted_at', 'deleted_at'],
    orders: ['created_at', 'updated_at', 'dispatched_at', 'deleted_at'],
    parties: ['created_at', 'updated_at', 'deleted_at'],
    products: ['created_at', 'updated_at', 'deleted_at'],
    product_variants: ['created_at', 'updated_at', 'deleted_at'],
    product_categories: ['created_at'],
    product_images: ['uploaded_at'],
    party_product_variants: ['created_at', 'updated_at'],
    party_access: ['created_at'],
    option_lists: ['created_at', 'updated_at'],
    custom_field_definitions: ['created_at', 'updated_at'],
  };

  return async (since, at) => {
    await db().transaction(async (trx) => {
      await trx.raw('ALTER TABLE activity_log DISABLE TRIGGER activity_log_no_update');

      // One statement per table: each column moves only where it is recent,
      // and a row is touched only when at least one of them is.
      for (const [table, names] of Object.entries(columns)) {
        await trx(table)
          .where({ tenant_id: tenantId })
          .where((builder) => {
            for (const name of names) void builder.orWhere(name, '>=', since);
          })
          .update(
            Object.fromEntries(
              names.map((name) => [
                name,
                trx.raw('CASE WHEN ?? >= ? THEN ?::timestamptz ELSE ?? END', [
                  name,
                  since,
                  at,
                  name,
                ]),
              ]),
            ),
          );
      }

      await trx.raw('ALTER TABLE activity_log ENABLE TRIGGER activity_log_no_update');
    });
  };
}
