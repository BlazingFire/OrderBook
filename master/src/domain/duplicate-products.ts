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
  isCodeVariant,
  isNearName,
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
  const exactPairs = new Set<string>();
  for (const [token, holders] of tokens) {
    if (holders.length < 2) continue;
    const kind: DuplicateMatch = token.startsWith('name|') ? 'name' : 'code';
    const root = find(holders[0] as number);
    for (const holder of holders.slice(1)) {
      parent[find(holder)] = root;
      const pair = [holders[0], holder].sort((a, b) => (a as number) - (b as number)).join(':');
      exactPairs.add(pair);
    }
    for (const holder of holders) {
      matches.set(holder, (matches.get(holder) ?? new Set()).add(kind));
    }
  }

  // Suspects (A8/A9): pairs that are not exact matches but look like typos.
  // Same scope rules as exact matches: names within one Product (or one
  // brand for Products), codes within one brand.
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const pair = `${i}:${j}`;
      if (exactPairs.has(pair)) continue;
      const a = candidates[i] as DuplicateCandidate;
      const b = candidates[j] as DuplicateCandidate;
      if (duplicateKey(a.brand) !== duplicateKey(b.brand)) continue;
      if (level === 'subProduct' && (a.categoryId ?? '') !== (b.categoryId ?? '')) continue;
      const nameA = duplicateKey(a.name);
      const nameB = duplicateKey(b.name);
      let kind: DuplicateMatch | null = null;
      if (isNearName(nameA, nameB)) kind = 'near-name';
      if (!kind) {
        const codesA = a.codes.map(duplicateKey).filter(Boolean);
        const codesB = new Set(b.codes.map(duplicateKey).filter(Boolean));
        if (codesA.some((code) => codesB.has(code))) {
          // Exact code matches are already grouped above; skip.
        } else if (
          a.codes.some((left) => b.codes.some((right) => isCodeVariant(left, right)))
        ) {
          kind = 'code-variant';
        }
      }
      if (!kind) continue;
      const root = find(i);
      parent[find(j)] = root;
      matches.set(i, (matches.get(i) ?? new Set()).add(kind));
      matches.set(j, (matches.get(j) ?? new Set()).add(kind));
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
      matchedOn: (['name', 'code', 'near-name', 'code-variant'] as const).filter((kind) =>
        matchedOn.has(kind),
      ),
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
