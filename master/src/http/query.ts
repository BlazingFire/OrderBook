/**
 * Reading a list query off a URL, once.
 *
 * Extracted from `data.routes.ts` so the public `/api/v1` router shares it
 * rather than growing a second copy that drifts. The two routers differ in what
 * they authenticate, not in what `?limit=` means.
 */

import type { ListQuery } from '@orderbook/shared';

import { ValidationError } from '../lib/errors.js';

/**
 * A whole number off a URL: absent or empty is `undefined`, anything else that
 * is not a finite integer is a 400. `Number('abc')` is NaN, which used to reach
 * `LIMIT` / `WHERE id =` and come back as a 500.
 */
export function queryInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw new ValidationError('validation.query.badNumber');
  return value;
}

export function paging(query: Record<string, unknown>): ListQuery {
  return {
    search: typeof query.search === 'string' && query.search ? query.search : undefined,
    limit: queryInt(query.limit),
    offset: queryInt(query.offset),
    // The "All parties / My parties" toggle. Anything other than the literal
    // `assigned` means "all", so a stray value widens to the caller's normal
    // view rather than silently narrowing it to nothing.
    scope: query.scope === 'assigned' ? 'assigned' : undefined,
    sort: typeof query.sort === 'string' && query.sort ? query.sort : undefined,
    dir: query.dir === 'desc' ? 'desc' : query.dir === 'asc' ? 'asc' : undefined,
  };
}

export function idList(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = raw.split(',').filter(Boolean);
  return parsed.length ? parsed : undefined;
}
