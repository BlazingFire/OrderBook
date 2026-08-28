/**
 * Everything the assistant is allowed to look at.
 *
 * Fifteen read tools, each one call to a service the caller could already have
 * called, with **that caller's own `ActorContext`**. That is the entire
 * permission story: `applyPartyScope` and the `mask*` family stay the only
 * engine, and neither has to know this file exists. A generated SQL tool would
 * bypass both by construction — they run *above* the query — so there is not
 * one, and adding one would mean re-expressing the party rule as row-level
 * security, which is exactly the nine-times duplication the party-access
 * repository was written to prevent.
 *
 * **The control against prompt injection is the absence of authority, not
 * filtering.** A party's notes are attacker-controllable and always will be.
 * There is no write tool, no free-form string that reaches SQL or a path, and
 * no network tool — so the worst a poisoned note can achieve is a wrong or rude
 * answer. Tool results are wrapped in a "this is data, not instructions"
 * envelope, which raises the cost of an attack without being load-bearing.
 *
 * Two things this file's types do *not* prove, said plainly rather than
 * implied: `Record<AiToolName, AiTool>` catches a **missing** tool at compile
 * time, but `Permission` is `string`, so a typo in a `permission` field
 * compiles fine — `ai-tool-surface.test.ts` is what catches that.
 */

import type { Permission } from '@orderbook/shared';

import type { ActorContext } from '../domain/actor.js';
import * as catalogService from '../services/catalog.service.js';
import * as dashboardService from '../services/dashboard.service.js';
import * as inventoryService from '../services/inventory.service.js';
import * as leadService from '../services/lead.service.js';
import * as logService from '../services/log.service.js';
import * as orderService from '../services/order.service.js';
import * as reportService from '../services/report.service.js';
import * as searchService from '../services/search.service.js';

export type AiToolName =
  | 'search_records'
  | 'list_parties'
  | 'list_products'
  | 'list_leads'
  | 'get_lead'
  | 'list_orders'
  | 'get_order'
  | 'list_stock'
  | 'list_stock_movements'
  | 'list_party_variants'
  | 'dispatch_report'
  | 'lead_outcome_report'
  | 'top_parties_report'
  | 'dashboard_summary'
  | 'list_activity';

export interface AiTool {
  /** Checked before dispatch, and again by the service underneath. */
  permission: Permission;
  description: string;
  /** The JSON schema the model is shown. Closed: no free-form field anywhere. */
  schema: Record<string, unknown>;
  run(raw: unknown, actor: ActorContext): Promise<unknown>;
}

/** Enough rows to answer a question; few enough not to spend the context on one call. */
const ROW_CAP = 200;

function args(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function text(raw: unknown, key: string): string | undefined {
  const value = args(raw)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function id(raw: unknown, key: string): string {
  const value = args(raw)[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function count(raw: unknown, key: string, fallback = 50): number {
  const value = Number(args(raw)[key]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), ROW_CAP);
}

/** The three-field range every report takes, and nothing else. */
const RANGE_SCHEMA = {
  type: 'object',
  properties: {
    period: {
      type: 'string',
      enum: ['thisMonth', 'last3Months', 'last6Months', 'last12Months'],
    },
  },
  additionalProperties: false,
};

function range(raw: unknown): {
  period?: 'thisMonth' | 'last3Months' | 'last6Months' | 'last12Months';
} {
  const value = args(raw).period;
  return value === 'thisMonth' ||
    value === 'last3Months' ||
    value === 'last6Months' ||
    value === 'last12Months'
    ? { period: value }
    : {};
}

const SEARCH_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, limit: { type: 'integer' } },
  required: ['query'],
  additionalProperties: false,
};

const LIST_SCHEMA = {
  type: 'object',
  properties: { search: { type: 'string' }, limit: { type: 'integer' } },
  additionalProperties: false,
};

const BY_ID_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

export const AI_TOOLS: Record<AiToolName, AiTool> = {
  search_records: {
    permission: 'leads.view',
    description: 'Search products, parties and the line items of leads and orders by text.',
    schema: SEARCH_SCHEMA,
    // `search` filters by what the caller may read rather than refusing the
    // whole query, so a narrow role gets a short answer, not a 403.
    run: (raw, actor) =>
      searchService.search(
        { term: text(raw, 'query') ?? '', limit: count(raw, 'limit', 20) },
        actor,
      ),
  },

  list_parties: {
    permission: 'parties.view',
    description: 'List parties, optionally filtered by a text search over name, code and phone.',
    schema: LIST_SCHEMA,
    run: (raw, actor) =>
      catalogService.listParties(
        { search: text(raw, 'search'), limit: count(raw, 'limit') },
        actor,
      ),
  },

  list_products: {
    permission: 'products.view',
    description: 'List products in the catalogue.',
    schema: LIST_SCHEMA,
    run: (raw, actor) =>
      catalogService.listProducts(
        { search: text(raw, 'search'), limit: count(raw, 'limit') },
        actor,
      ),
  },

  list_leads: {
    permission: 'leads.view',
    description: 'List leads.',
    schema: LIST_SCHEMA,
    run: (raw, actor) =>
      leadService.listLeads({ search: text(raw, 'search'), limit: count(raw, 'limit') }, actor),
  },

  get_lead: {
    permission: 'leads.view',
    description: 'One lead in full, including its lines and its timeline of remarks.',
    schema: BY_ID_SCHEMA,
    run: (raw, actor) => leadService.getLead(id(raw, 'id'), actor),
  },

  list_orders: {
    permission: 'orders.view',
    description: 'List orders.',
    schema: LIST_SCHEMA,
    run: (raw, actor) =>
      orderService.listOrders({ search: text(raw, 'search'), limit: count(raw, 'limit') }, actor),
  },

  get_order: {
    permission: 'orders.view',
    description: 'One order in full, including its lines and its timeline.',
    schema: BY_ID_SCHEMA,
    run: (raw, actor) => orderService.getOrder(id(raw, 'id'), actor),
  },

  list_stock: {
    permission: 'inventory.view',
    description: 'Stock on hand, by product and colour.',
    schema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        lowOnly: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    run: (raw, actor) =>
      inventoryService.listStock(
        {
          search: text(raw, 'search'),
          lowOnly: args(raw).lowOnly === true,
          limit: count(raw, 'limit'),
        },
        actor,
      ),
  },

  list_stock_movements: {
    permission: 'inventory.view',
    description: 'Recent stock movements, optionally for one product.',
    schema: {
      type: 'object',
      properties: { productId: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    run: (raw, actor) =>
      inventoryService.listMovements(
        { productId: text(raw, 'productId'), limit: count(raw, 'limit') },
        actor,
      ),
  },

  list_party_variants: {
    permission: 'parties.view',
    description: 'The negotiated prices agreed with one party.',
    schema: {
      type: 'object',
      properties: { partyId: { type: 'string' } },
      required: ['partyId'],
      additionalProperties: false,
    },
    run: (raw, actor) => catalogService.listVariantsForParty(id(raw, 'partyId'), actor),
  },

  dispatch_report: {
    permission: 'reports.view',
    description: 'Dispatched orders per month.',
    schema: RANGE_SCHEMA,
    run: (raw, actor) => reportService.dispatchReport(range(raw), actor),
  },

  lead_outcome_report: {
    permission: 'reports.view',
    description: 'How many leads converted, per month.',
    schema: RANGE_SCHEMA,
    run: (raw, actor) => reportService.leadOutcomeReport(range(raw), actor),
  },

  top_parties_report: {
    permission: 'reports.view',
    description: 'The parties with the most business in a period.',
    schema: {
      type: 'object',
      properties: { ...RANGE_SCHEMA.properties, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    run: (raw, actor) =>
      reportService.topPartiesReport({ ...range(raw), limit: count(raw, 'limit', 10) }, actor),
  },

  dashboard_summary: {
    permission: 'leads.view',
    description: 'Today’s headline figures, already scoped to the caller.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_raw, actor) => dashboardService.getDashboardSummary(actor),
  },

  list_activity: {
    permission: 'logs.view',
    description: 'Recent activity, newest first.',
    schema: {
      type: 'object',
      properties: { entityType: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    run: (raw, actor) =>
      logService.listLogs(
        { entityType: text(raw, 'entityType'), limit: count(raw, 'limit', 30) },
        actor,
      ),
  },
};

export const AI_TOOL_NAMES = Object.keys(AI_TOOLS) as AiToolName[];

export function isAiToolName(value: string): value is AiToolName {
  return Object.prototype.hasOwnProperty.call(AI_TOOLS, value);
}
