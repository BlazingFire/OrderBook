/**
 * List-endpoint paging rules. Callers may ask for any page size; the clamp is
 * what guarantees a panel can never pull an unbounded result set over the LAN.
 */

export interface PagingLimits {
  defaultLimit: number;
  maxLimit: number;
}

export function clampPaging(
  query: { limit?: number; offset?: number },
  limits: PagingLimits,
): { limit: number; offset: number } {
  return {
    limit: clampLimit(query.limit, limits),
    offset: Math.max(query.offset ?? 0, 0),
  };
}

export function clampLimit(limit: number | undefined, limits: PagingLimits): number {
  return Math.min(Math.max(limit ?? limits.defaultLimit, 1), limits.maxLimit);
}
