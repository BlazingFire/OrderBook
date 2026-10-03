/**
 * Reading a list query off a URL, once.
 *
 * Extracted from `data.routes.ts` so the public `/api/v1` router shares it
 * rather than growing a second copy that drifts. The two routers differ in what
 * they authenticate, not in what `?limit=` means.
 */

import type { ListQuery } from '@orderbook/shared';

export function paging(query: Record<string, unknown>): ListQuery {
  return {
    search: typeof query.search === 'string' && query.search ? query.search : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
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
