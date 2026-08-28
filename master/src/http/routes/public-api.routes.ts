/**
 * `/api/v1` — the same services the browser uses, behind a key instead of a
 * cookie.
 *
 * A separate versioned namespace rather than opening `dataRoutes` to keys, for
 * three reasons that are not stylistic: those handlers take a cookie, their
 * `paging()` accepts the browser's `scope=assigned` toggle, and their response
 * shapes carry no compatibility promise to anybody outside this repository.
 * This surface does.
 *
 * **When the API is switched off this router answers 404 itself and never calls
 * `next()`.** Falling through would land in `app.use('/api', dataRoutes)`,
 * whose `requireAuth` answers 401 — telling a caller "sign in" about a feature
 * that is turned off — and the SPA catch-all for non-API paths never matches an
 * `/api` path, so nothing else would answer.
 *
 * **PATCH is read-merge-write against an unmasked repository read.** The
 * services are full replaces that demand a name and a code, so a two-field
 * PATCH cannot reach them unmerged; and merging against a *masked* read would
 * let a key without `field.saleRate.view` silently write the catalogue price to
 * nothing, because the mask removes the key and the writer would treat it as
 * cleared. A body that names a field the key may not see is refused outright.
 */

import { Router, type Request, type Response } from 'express';
import type { ActivityLogQuery } from '@orderbook/shared';
import { hasPermission } from '@orderbook/shared';

import type { ActorContext } from '../../domain/actor.js';
import { appVersion } from '../../lib/app-version.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import * as partyRepo from '../../repositories/party.repository.js';
import * as productRepo from '../../repositories/product.repository.js';
import * as catalogService from '../../services/catalog.service.js';
import * as inventoryService from '../../services/inventory.service.js';
import * as leadService from '../../services/lead.service.js';
import * as orderService from '../../services/order.service.js';
import * as searchService from '../../services/search.service.js';
import * as logService from '../../services/log.service.js';
import { getSetting } from '../../services/settings.service.js';
import { asyncHandler } from '../async-handler.js';
import { apiActorFromRequest, requireApiKey } from '../middleware/require-api-key.js';
import {
  PUBLIC_API_ROUTES,
  buildOpenApiDocument,
  type PublicApiOperationId,
} from '../public-api-contract.js';
import { paging } from '../query.js';

type Handler = (req: Request, res: Response, actor: ActorContext) => Promise<void>;

/**
 * The fields a key may not write because it may not see them.
 *
 * Masking works by key absence, so the check has to be about the *request*
 * naming a field, not about the value being null — a caller who cannot read the
 * rate must be told no rather than quietly having their `rate: null` written.
 */
const RATE_FIELDS = ['rate', 'pricePerSqft'] as const;
const COST_FIELDS = ['purchaseRate'] as const;

function refuseMaskedFields(body: Record<string, unknown>, actor: ActorContext): void {
  const named = (fields: readonly string[]): string | undefined =>
    fields.find((field) => Object.prototype.hasOwnProperty.call(body, field));

  const rate = named(RATE_FIELDS);
  if (rate && !hasPermission(actor.permissions, 'field.saleRate.view')) {
    throw new ForbiddenError('field.saleRate.view');
  }

  const cost = named(COST_FIELDS);
  if (cost && !hasPermission(actor.permissions, 'field.purchaseRate.view')) {
    throw new ForbiddenError('field.purchaseRate.view');
  }
}

function body(req: Request): Record<string, unknown> {
  const value: unknown = req.body;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('validation.request.bodyRequired');
  }
  return value as Record<string, unknown>;
}

/**
 * Merge a patch over the record as it actually is.
 *
 * The base is the **unmasked** repository row, so the fields the caller did not
 * name keep the values they have — including the ones this key cannot read.
 * Only the keys the caller actually sent are taken from the patch, which is
 * what makes this a PATCH and not a replace.
 */
function merge<T extends Record<string, unknown>>(existing: T, patch: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) merged[key] = value;
  return merged as T;
}

const HANDLERS: Record<PublicApiOperationId, Handler> = {
  getOpenApi: async (_req, res) => {
    res.json(buildOpenApiDocument(appVersion()));
  },

  whoami: async (req, res, actor) => {
    res.json({
      keyId: req.apiKeyId ?? null,
      label: req.apiKeyLabel ?? null,
      ownerUserId: actor.userId,
      ownerName: actor.actorName,
      permissions: actor.permissions?.permissions ?? [],
      roleName: actor.permissions?.roleName ?? null,
    });
  },

  listParties: async (req, res, actor) => {
    res.json(await catalogService.listParties(paging(req.query), actor));
  },
  createParty: async (req, res, actor) => {
    const input = body(req);
    refuseMaskedFields(input, actor);
    res.status(201).json(await catalogService.createParty(input as never, actor));
  },
  getParty: async (req, res, actor) => {
    res.json(await catalogService.getParty(String(req.params.id), actor));
  },
  patchParty: async (req, res, actor) => {
    const patch = body(req);
    refuseMaskedFields(patch, actor);

    const existing = await partyRepo.findPartyById(actor.tenantId, String(req.params.id));
    if (!existing) throw new NotFoundError('Party');

    res.json(
      await catalogService.updateParty(
        existing.id,
        merge(existing as unknown as Record<string, unknown>, patch) as never,
        actor,
      ),
    );
  },

  listProducts: async (req, res, actor) => {
    res.json(await catalogService.listProducts(paging(req.query), actor));
  },
  createProduct: async (req, res, actor) => {
    const input = body(req);
    refuseMaskedFields(input, actor);
    res.status(201).json(await catalogService.createProduct(input as never, actor));
  },
  getProduct: async (req, res, actor) => {
    res.json(await catalogService.getProduct(String(req.params.id), actor));
  },
  patchProduct: async (req, res, actor) => {
    const patch = body(req);
    refuseMaskedFields(patch, actor);

    const existing = await productRepo.findProductById(actor.tenantId, String(req.params.id));
    if (!existing) throw new NotFoundError('Product');

    res.json(
      await catalogService.updateProduct(
        existing.id,
        merge(existing as unknown as Record<string, unknown>, patch) as never,
        actor,
      ),
    );
  },

  listStock: async (req, res, actor) => {
    res.json(
      await inventoryService.listStock(
        { ...paging(req.query), lowOnly: req.query.lowOnly === 'true' },
        actor,
      ),
    );
  },
  stockInbound: async (req, res, actor) => {
    res.status(201).json(await inventoryService.recordInbound(body(req) as never, actor));
  },
  stockAdjust: async (req, res, actor) => {
    res.status(201).json(await inventoryService.recordAdjustment(body(req) as never, actor));
  },

  listLeads: async (req, res, actor) => {
    res.json(await leadService.listLeads(paging(req.query), actor));
  },
  getLead: async (req, res, actor) => {
    res.json(await leadService.getLead(String(req.params.id), actor));
  },

  listOrders: async (req, res, actor) => {
    res.json(await orderService.listOrders(paging(req.query), actor));
  },
  getOrder: async (req, res, actor) => {
    res.json(await orderService.getOrder(String(req.params.id), actor));
  },
  patchOrder: async (req, res, actor) => {
    res.json(await orderService.updateOrder(String(req.params.id), body(req) as never, actor));
  },
  setOrderStage: async (req, res, actor) => {
    const input = body(req);
    res.json(
      await orderService.setStage(
        {
          id: String(req.params.id),
          stageId: String(input.stageId ?? ''),
          remark: typeof input.remark === 'string' ? input.remark : null,
        },
        actor,
      ),
    );
  },

  search: async (req, res, actor) => {
    res.json(
      await searchService.search(
        {
          term: String(req.query.q ?? ''),
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        },
        actor,
      ),
    );
  },

  listEvents: async (req, res, actor) => {
    const query: ActivityLogQuery = {
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      entityType: typeof req.query.entityType === 'string' ? req.query.entityType : undefined,
    };
    res.json(await logService.listLogs(query, actor));
  },
};

export const publicApiRoutes: Router = Router();

/**
 * The off switch, first.
 *
 * Read per request rather than cached in this module: the settings service owns
 * that cache and empties it on write, so turning the API off takes effect on the
 * next request instead of after a timeout — the same rule the password vault's
 * toggle follows, and for the same reason.
 */
publicApiRoutes.use(
  asyncHandler(async (req, res, next) => {
    // The document is the one thing a disabled API still refuses: a 404 for the
    // whole namespace is a simpler and truer answer than a contract for
    // endpoints that will not answer.
    const enabled = await isEnabled(req);
    if (!enabled) {
      res.status(404).json({ error: 'not_found', message: 'The public API is switched off' });
      return;
    }
    next();
  }),
);

publicApiRoutes.use(requireApiKey);

for (const route of PUBLIC_API_ROUTES) {
  const handler = HANDLERS[route.operationId];
  publicApiRoutes[route.method](
    route.path,
    asyncHandler(async (req: Request, res: Response) => {
      await handler(req, res, apiActorFromRequest(req));
    }),
  );
}

/**
 * Which tenant's switch to read, before there is an authenticated actor.
 *
 * There is exactly one tenant per installation — every table is scoped to it,
 * and pairing hands out that id — so reading the only row is honest here rather
 * than a shortcut. It has to happen before key authentication, because a
 * disabled API must not spend a database round trip on a presented token.
 */
async function isEnabled(req: Request): Promise<boolean> {
  const tenantId = req.user?.tenantId ?? (await onlyTenantId());
  if (!tenantId) return false;
  return getSetting(tenantId, 'externalApi.enabled');
}

let cachedTenantId: string | null = null;

async function onlyTenantId(): Promise<string | null> {
  if (cachedTenantId) return cachedTenantId;

  const { db } = await import('../../db/knex.js');
  const row = await db()('tenants').first<{ id: string } | undefined>('id');
  cachedTenantId = row?.id ?? null;
  return cachedTenantId;
}

/** Test seam: a restore replaces the tenant row. */
export function resetPublicApiTenantCache(): void {
  cachedTenantId = null;
}
