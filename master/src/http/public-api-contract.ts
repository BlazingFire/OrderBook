/**
 * Every public route, declared once, as data.
 *
 * The router is built by walking this table against a `Record<operationId,
 * handler>`, so a route with no handler and a handler with no route are both
 * compile errors — the same tripwire shape `office/src/http/app.ts` gets from
 * its `Record<keyof SyncSnapshot, SnapshotPolicy>`. The OpenAPI document is
 * generated from the same table, so the published contract cannot drift from
 * what is actually mounted.
 *
 * **This lives in `master`, not `shared`.** `shared/src/index.ts` is a flat
 * `export *` barrel that both browser bundles consume, and both consumers of
 * this table are server-side. Putting it in `shared` would ship the whole
 * public API surface into two offline shop-floor bundles that never call it.
 *
 * What is deliberately absent is as load-bearing as what is here:
 *
 *  · **No `POST /leads`.** A lead is raised in the Office Panel; the Master
 *    cannot create one, and `data.routes.ts` says so by omission too. An API
 *    that could would make the rule documentation rather than structure.
 *  · **No `DELETE`, anywhere.** Deleting is a Recycle Bin operation with
 *    blockers, a restore path and a person accountable for it.
 *  · **No users, roles, panels or storage.** A key is for a shop's
 *    other software to read and correct catalogue data, not to administer the
 *    installation.
 */

import type { Permission } from '@orderbook/shared';

export interface PublicApiRoute {
  operationId: string;
  method: 'get' | 'post' | 'patch';
  /** Express path, with `:id` segments. */
  path: string;
  /** The permission the handler's service will demand. Declared so the doc can say. */
  permission: Permission | null;
  summary: string;
}

export const PUBLIC_API_ROUTES = [
  {
    operationId: 'getOpenApi',
    method: 'get',
    path: '/openapi.json',
    permission: null,
    summary: 'This API, as an OpenAPI document',
  },
  {
    operationId: 'whoami',
    method: 'get',
    path: '/whoami',
    permission: null,
    summary: 'What this key is and what it may do',
  },

  {
    operationId: 'listParties',
    method: 'get',
    path: '/parties',
    permission: 'parties.view',
    summary: 'List parties',
  },
  {
    operationId: 'createParty',
    method: 'post',
    path: '/parties',
    permission: 'parties.create',
    summary: 'Create a party',
  },
  {
    operationId: 'getParty',
    method: 'get',
    path: '/parties/:id',
    permission: 'parties.view',
    summary: 'One party',
  },
  {
    operationId: 'patchParty',
    method: 'patch',
    path: '/parties/:id',
    permission: 'parties.edit',
    summary: 'Change some fields of a party',
  },

  {
    operationId: 'listProducts',
    method: 'get',
    path: '/products',
    permission: 'products.view',
    summary: 'List products',
  },
  {
    operationId: 'createProduct',
    method: 'post',
    path: '/products',
    permission: 'products.create',
    summary: 'Create a product',
  },
  {
    operationId: 'getProduct',
    method: 'get',
    path: '/products/:id',
    permission: 'products.view',
    summary: 'One product',
  },
  {
    operationId: 'patchProduct',
    method: 'patch',
    path: '/products/:id',
    permission: 'products.edit',
    summary: 'Change some fields of a product',
  },

  {
    operationId: 'listStock',
    method: 'get',
    path: '/stock',
    permission: 'inventory.view',
    summary: 'Stock levels by product and colour',
  },
  {
    operationId: 'stockInbound',
    method: 'post',
    path: '/stock/inbound',
    permission: 'inventory.edit',
    summary: 'Record goods received',
  },
  {
    operationId: 'stockAdjust',
    method: 'post',
    path: '/stock/adjust',
    permission: 'stock.adjust',
    summary: 'Correct a stock figure',
  },

  {
    operationId: 'listLeads',
    method: 'get',
    path: '/leads',
    permission: 'leads.view',
    summary: 'List leads',
  },
  {
    operationId: 'getLead',
    method: 'get',
    path: '/leads/:id',
    permission: 'leads.view',
    summary: 'One lead',
  },

  {
    operationId: 'listOrders',
    method: 'get',
    path: '/orders',
    permission: 'orders.view',
    summary: 'List orders',
  },
  {
    operationId: 'getOrder',
    method: 'get',
    path: '/orders/:id',
    permission: 'orders.view',
    summary: 'One order',
  },
  {
    operationId: 'patchOrder',
    method: 'patch',
    path: '/orders/:id',
    permission: 'orders.edit',
    summary: 'Change some fields of an order',
  },
  {
    operationId: 'setOrderStage',
    method: 'post',
    path: '/orders/:id/stage',
    permission: 'orders.edit',
    summary: 'Move an order to another stage',
  },

  {
    operationId: 'search',
    method: 'get',
    path: '/search',
    permission: null,
    summary: 'Search products, parties and line items',
  },
  /*
   * The events feed is the activity log, not a webhook.
   *
   * `activity_log` is already append-only, monotonic, keyset-paged,
   * party-scoped, permission-gated and hash-chained — everything a delivery
   * system would have had to reinvent. Entries name what changed, so a consumer
   * follows with a GET that re-applies masking; a pushed payload could not.
   */
  {
    operationId: 'listEvents',
    method: 'get',
    path: '/events',
    permission: 'logs.view',
    summary: 'What changed, oldest cursor first',
  },
] as const satisfies readonly PublicApiRoute[];

export type PublicApiOperationId = (typeof PUBLIC_API_ROUTES)[number]['operationId'];

/** A minimal OpenAPI 3.1 document, generated from the table above. */
export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of PUBLIC_API_ROUTES) {
    // OpenAPI spells a path parameter `{id}`; Express spells it `:id`.
    const openApiPath = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const parameters = [...route.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    paths[openApiPath] ??= {};
    paths[openApiPath][route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.permission ? { 'x-orderbook-permission': route.permission } : {}),
      responses: { '200': { description: 'Success' } },
      ...(route.permission ? { security: [{ apiKey: [] }] } : {}),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OrderBook',
      version,
      description:
        'The Master Panel’s keyed API. Every response is masked and party-scoped for the key’s owner, exactly as the same read would be for that person in the browser.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'obk' },
      },
    },
    security: [{ apiKey: [] }],
    paths,
  };
}
