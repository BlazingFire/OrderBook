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
    offset: Number.isFinite(query.offset) ? Math.max(query.offset as number, 0) : 0,
  };
}

export function clampLimit(limit: number | undefined, limits: PagingLimits): number {
  // NaN (a socket payload, or a caller that skipped the HTTP parse) is "not asked".
  const asked = Number.isFinite(limit) ? (limit as number) : limits.defaultLimit;
  return Math.min(Math.max(Math.floor(asked), 1), limits.maxLimit);
}
