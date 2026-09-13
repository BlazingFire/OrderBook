/**
 * The Blocks palette behind the PDF designer: one document block in, placed
 * elements out.
 *
 * A palette row is a single `DocumentBlock` through the converter the stored
 * templates already go through (`blocksToElements`), so a dropped Header prints
 * what a stored Header prints — there is deliberately no second set of
 * coordinates to drift. The converter stacks from the margin origin, so the
 * bundle is shifted to the drop point and re-id'd for this layout.
 */

import type {
  DocumentBlock,
  DocumentBlockKind,
  DocumentElement,
  PageGeometry,
} from '@orderbook/shared';
import { blocksToElements } from '@orderbook/shared';

export const DESIGNER_BLOCKS: readonly DocumentBlockKind[] = [
  'header',
  'party',
  'lines',
  'totals',
  'terms',
  'signature',
];

export function blockOf(kind: DocumentBlockKind): DocumentBlock {
  switch (kind) {
    case 'header':
      return { kind: 'header', align: 'left' };
    case 'party':
      return { kind: 'party' };
    case 'lines':
      return { kind: 'lines', groupByProduct: false };
    case 'totals':
      return { kind: 'totals', showBoxCount: true };
    case 'terms':
      return { kind: 'terms', text: '' };
    case 'signature':
      return { kind: 'signature', label: 'Authorised signatory' };
  }
}

export function bundleForBlock(
  kind: DocumentBlockKind,
  geometry: PageGeometry,
  options: { hasLogo?: boolean; hasSignature?: boolean } = {},
): DocumentElement[] {
  const stamp = Date.now().toString(36);
  return blocksToElements([blockOf(kind)], geometry, options).map((element, index) => ({
    ...element,
    id: `${kind}-${stamp}-${index}`,
  }));
}
