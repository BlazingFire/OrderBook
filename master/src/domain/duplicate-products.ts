/**
 * Which products are the same product written twice. Pure: rows in, groups
 * out — the service reads the database and the route carries the answer.
 *
 * Two rows are duplicates when they share a name or a code after
 * `duplicateKey` (case, spacing and punctuation ignored):
 *  - Products (categories): the same brand and the same name, or the same
 *    brand and the same code;
 *  - sub products: the same Product and the same name, or the same brand and
 *    one of their variant codes. A name alone is not enough across Products —
 *    numbered designs (`1111`, `41`) legitimately recur under different ones.
 *
 * Groups join up: A~B by name and B~C by code is one group of three.
 */

import {
  duplicateKey,
  type DuplicateGroup,
  type DuplicateLevel,
  type DuplicateMatch,
  type DuplicateMember,
} from '@orderbook/shared';

export interface DuplicateCandidate {
  id: string;
  name: string;
  /** A Product's code, or a sub product's variant codes. */
  codes: string[];
  brand: string | null;
  /** The Product a sub product sits in; null for a Product. */
  categoryId: string | null;
  productName: string | null;
  size: string | null;
  subProductCount: number;
  lineCount: number;
  createdAt: string;
}

export function findDuplicateGroups(
  level: DuplicateLevel,
  candidates: readonly DuplicateCandidate[],
): DuplicateGroup[] {
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    parent[index] = root;
    return root;
  };

  // token -> the members that carry it; a token with two or more is a match.
  const tokens = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const brand = duplicateKey(candidate.brand);
    const name = duplicateKey(candidate.name);
    const scope = level === 'subProduct' ? (candidate.categoryId ?? '') : brand;
    const own: string[] = [];
    if (name) own.push(`name|${scope}|${name}`);
    for (const code of candidate.codes) {
      const key = duplicateKey(code);
      if (key) own.push(`code|${brand}|${key}`);
    }
    for (const token of new Set(own)) {
      const holders = tokens.get(token) ?? [];
      holders.push(index);
      tokens.set(token, holders);
    }
  });

  const matches = new Map<number, Set<DuplicateMatch>>();
  for (const [token, holders] of tokens) {
    if (holders.length < 2) continue;
    const kind: DuplicateMatch = token.startsWith('name|') ? 'name' : 'code';
    const root = find(holders[0] as number);
    for (const holder of holders.slice(1)) parent[find(holder)] = root;
    for (const holder of holders) {
      matches.set(holder, (matches.get(holder) ?? new Set()).add(kind));
    }
  }

  const byRoot = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    if (!matches.has(index)) return;
    const root = find(index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), index]);
  });

  const groups: DuplicateGroup[] = [];
  for (const indexes of byRoot.values()) {
    const rows = indexes
      .map((index) => candidates[index] as DuplicateCandidate)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const matchedOn = new Set<DuplicateMatch>();
    for (const index of indexes) for (const kind of matches.get(index) ?? []) matchedOn.add(kind);

    groups.push({
      key: `${level}:${rows.map((row) => row.id).sort().join('+')}`,
      level,
      brand: rows.find((row) => row.brand)?.brand ?? null,
      matchedOn: (['name', 'code'] as const).filter((kind) => matchedOn.has(kind)),
      members: rows.map((row) => toMember(level, row)),
    });
  }

  return groups.sort(
    (a, b) =>
      (a.brand ?? '').localeCompare(b.brand ?? '') ||
      (a.members[0]?.name ?? '').localeCompare(b.members[0]?.name ?? ''),
  );
}

function toMember(level: DuplicateLevel, row: DuplicateCandidate): DuplicateMember {
  return {
    id: row.id,
    name: row.name,
    code: row.codes.length > 0 ? row.codes.join(', ') : null,
    size: row.size,
    productName: row.productName,
    subProductCount: row.subProductCount,
    lineCount: row.lineCount,
    createdAt: row.createdAt,
    blockedBy:
      level === 'product'
        ? row.subProductCount > 0
          ? 'subProducts'
          : null
        : row.lineCount > 0
          ? 'liveReferences'
          : null,
  };
}
