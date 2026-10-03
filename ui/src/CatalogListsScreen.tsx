/**
 * Lists (1.4 D3, R3–R5): the company's grades, packaging types and brands.
 *
 * One sidebar module with a page for each list, on both panels. Each page is
 * the shared `OptionListEditor` on one managed option list, so adding,
 * renaming, reordering and retiring (to the Recycle Bin, with the "used by"
 * counts) behave as on Fields. Editing needs `catalog.lists.manage`; anyone
 * who can read the lists (`fields.view`) sees them read-only.
 */

import type { CatalogListKey } from '@orderbook/shared';

import { t } from './i18n.js';
import { OptionListEditor, type OptionListTransport } from './OptionListEditor.js';
import { EmptyState } from './States.js';
import { useSubNav } from './SubNavSlot.js';

export type CatalogListsPage = 'grades' | 'packaging' | 'brands';

export const CATALOG_LISTS_PAGES: readonly CatalogListsPage[] = ['grades', 'packaging', 'brands'];

const LIST_KEY: Record<CatalogListsPage, CatalogListKey> = {
  grades: 'line.grade',
  packaging: 'line.packaging',
  brands: 'product.brand',
};

export function isCatalogListsPage(value: string): value is CatalogListsPage {
  return (CATALOG_LISTS_PAGES as readonly string[]).includes(value);
}

export function CatalogListsScreen({
  permissions,
  transport,
  revision,
  page,
}: {
  permissions: readonly string[];
  /** The Fields endpoints the shared editor reads and writes through. */
  transport: OptionListTransport;
  revision?: number;
  page: CatalogListsPage;
}) {
  // No record opens here; say so, or a detail open on a sibling page would
  // stay highlighted in the sidebar while this one shows.
  useSubNav('lists', null);

  // Every read the editor makes needs `fields.view`; without it the editor
  // would sit on a load error whose Retry can never succeed.
  if (!permissions.includes('fields.view')) {
    return (
      <EmptyState
        title={t('lists.noAccess.title')}
        description={t('lists.noAccess.description', { permission: 'fields.view' })}
      />
    );
  }

  return (
    <OptionListEditor
      key={page}
      listKey={LIST_KEY[page]}
      canManage={permissions.includes('catalog.lists.manage')}
      transport={transport}
      revision={revision}
    />
  );
}
