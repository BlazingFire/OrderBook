/**
 * Duplicate products — the wire shapes of the Master's duplicate finder and
 * the one rule for "the same name or code".
 *
 * The owner's words: a Product is a category, a Sub product is a model
 * (`docs/catalogue/CATALOGUE_MODEL.md` §1). Both levels can hold duplicates:
 * two Products of one brand that differ only in case, spacing or punctuation
 * (`Wash Basin` / `Wash-basin`), and two sub products of one Product that do.
 */

import type { RecordId } from './entities.js';

export const DUPLICATE_LEVELS = ['product', 'subProduct'] as const;
export type DuplicateLevel = (typeof DUPLICATE_LEVELS)[number];

export function isDuplicateLevel(value: unknown): value is DuplicateLevel {
  return (DUPLICATE_LEVELS as readonly unknown[]).includes(value);
}

/**
 * What made two rows one group. A group can match on both. `near-name` and
 * `code-variant` are suspects (A8/A9), never auto-deleted: the finder refuses
 * a resolve whose group matched only on a suspect.
 */
export type DuplicateMatch = 'name' | 'code' | 'near-name' | 'code-variant';

/**
 * Why a member cannot be deleted now:
 * - `liveReferences`: a live pending order or order has a line on it;
 * - `subProducts`: a Product that still holds live sub products.
 */
export type DuplicateBlock = 'liveReferences' | 'subProducts';

export interface DuplicateMember {
  id: RecordId;
  name: string;
  /** A Product's code, or a sub product's variant codes joined by `, `. */
  code: string | null;
  /** The sub product's size; null on a Product. */
  size: string | null;
  /** A sub product's Product name; null on a Product. */
  productName: string | null;
  /** Live sub products under a Product; 0 on a sub product. */
  subProductCount: number;
  /** Live lead/order lines quoting a sub product; 0 on a Product. */
  lineCount: number;
  createdAt: string;
  /** Null when it can be deleted. */
  blockedBy: DuplicateBlock | null;
}

export interface DuplicateGroup {
  /** Stable across calls while the members are the same. */
  key: string;
  level: DuplicateLevel;
  brand: string | null;
  matchedOn: DuplicateMatch[];
  /** Oldest first: the likeliest one to keep leads. */
  members: DuplicateMember[];
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
}

/** Keep one member of a group and put the rest into the Recycle Bin. */
export interface DuplicateResolveInput {
  level: DuplicateLevel;
  keepId: RecordId;
  deleteIds: RecordId[];
}

export interface DuplicateResolveResult {
  deleted: RecordId[];
  /** A member that could not go, and why — the others still did. */
  refused: Array<{ id: RecordId; blockedBy: DuplicateBlock }>;
}

/**
 * The key two rows are compared by: lower case, accents folded, and every
 * character that is not a letter or digit dropped — so `Wash Basin`,
 * `wash-basin` and `WASH  BASIN.` are one name, and `OPT-0001` and `opt0001`
 * one code. Empty when nothing is left; an empty key never groups.
 */
export function duplicateKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Edit distance for short catalogue names (A8). Capped inputs: names here are
 * a few dozen characters, and callers compare within one brand scope.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let current = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j]! + 1, current + 1, prev[j - 1]! + cost);
      prev[j - 1] = current;
      current = next;
    }
    prev[b.length] = current;
  }
  return prev[b.length]!;
}

/** Two normalized names that differ by a likely typo (A8): same length class, distance ≤ 2. */
export function isNearName(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  if (Math.max(a.length, b.length) < 4) return false;
  return levenshtein(a, b) <= 2;
}

/**
 * Two codes that differ only by separators, case or zero padding (A9):
 * `OPT-0001` vs `OPT0001` vs `opt-001`. The digit run must agree once leading
 * zeros are stripped, and the letter run must agree exactly.
 */
export function isCodeVariant(a: string, b: string): boolean {
  if (!a || !b) return false;
  const split = (code: string): [string, string] => {
    const letters = code.replace(/[^a-z]/gi, '').toLowerCase();
    const digits = code.replace(/[^0-9]/g, '').replace(/^0+/, '');
    return [letters, digits];
  };
  const [lettersA, digitsA] = split(a);
  const [lettersB, digitsB] = split(b);
  return lettersA !== '' && lettersA === lettersB && digitsA !== '' && digitsA === digitsB && a !== b;
}
