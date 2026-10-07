/**
 * Products: the catalogue on the Master. The sub-product list, the Products
 * page and Brands are the shared screens in `ui/` (ports of the Office's
 * `CatalogScreen` / `MainProductsScreen`); this host loads the `CatalogueView`
 * they read and hands them the Master's transport.
 *
 * What it loads, and when it loads it again (each on its own revision, so a
 * lead edit reads nothing):
 *  - the option lists (brands, colours) when `option_list` moved;
 *  - the products (categories) and every sub product when the catalogue moved,
 *    `limit: 2000` being the cap the snapshot hands an Office panel.
 *
 * The three pages sit in `<Activity>` so switching between them keeps each
 * one's search, filters and open record, as `ScreenHost` does between modules.
 * Brands is always one of them: without `fields.view` it says so inside the
 * page, as the Office does.
 */

import { Activity, useEffect, useState } from 'react';
import type { OptionListItem, Product, ProductCategory } from '@orderbook/shared';
import {
  BusyMark,
  BrandsScreen,
  ConflictBanner,
  MainProductsScreen,
  SubProductsScreen,
  apiErrorText,
  type CatalogueView,
} from '@orderbook/ui';

import { api } from '../api';
import { catalogueTransport, optionListTransport } from '../transports';
import { DuplicatesScreen } from './DuplicatesScreen';
import { PhotoImportScreen } from './PhotoImportScreen';

export type ProductsPage = 'sub' | 'main' | 'brands' | 'duplicates' | 'photos';

interface Props {
  page: ProductsPage;
  permissions: readonly string[];
  /** Moves when a product, a product (category) or a bulk import changed. */
  catalogueRevision: number;
  /** Moves when an option list changed. */
  listsRevision: number;
}

export function ProductsScreen({
  page,
  permissions,
  catalogueRevision,
  listsRevision,
}: Props) {
  const canViewProducts = permissions.includes('products.view');

  const [optionLists, setOptionLists] = useState<OptionListItem[] | null>(null);
  const [categories, setCategories] = useState<ProductCategory[] | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by a bulk import so lists and brands refetch at once, without waiting for the socket. */
  const [importBump, setImportBump] = useState(0);

  // A later answer replaces an earlier one; a superseded one is dropped. The
  // previous data stays on screen while the next loads, so a list never blanks
  // for a refetch.
  useEffect(() => {
    let superseded = false;
    api
      .optionLists()
      .then((next) => {
        if (!superseded) setOptionLists(next);
      })
      .catch((caught) => {
        if (!superseded) setError(apiErrorText(caught, 'catalog.products.loadFailed'));
      });
    return () => {
      superseded = true;
    };
  }, [listsRevision, importBump]);

  useEffect(() => {
    let superseded = false;
    Promise.all([
      api.categories(),
      canViewProducts ? api.listProducts({ limit: 2000 }) : Promise.resolve(null),
    ])
      .then(([nextCategories, nextProducts]) => {
        if (superseded) return;
        setCategories(nextCategories);
        setProducts(nextProducts?.items ?? []);
        setError(null);
      })
      .catch((caught) => {
        if (!superseded) setError(apiErrorText(caught, 'catalog.products.loadFailed'));
      });
    return () => {
      superseded = true;
    };
  }, [catalogueRevision, canViewProducts, importBump]);

  if (!optionLists || !categories || !products) {
    return error ? <ConflictBanner>{error}</ConflictBanner> : <BusyMark />;
  }

  const view: CatalogueView = { permissions, optionLists, categories, products };

  return (
    <>
      {error && <ConflictBanner>{error}</ConflictBanner>}
      <Activity mode={page === 'sub' ? 'visible' : 'hidden'}>
        <SubProductsScreen
          view={view}
          transport={catalogueTransport}
          revision={catalogueRevision + importBump}
          onImported={() => setImportBump((current) => current + 1)}
        />
      </Activity>
      <Activity mode={page === 'main' ? 'visible' : 'hidden'}>
        <MainProductsScreen
          view={view}
          transport={catalogueTransport}
          revision={catalogueRevision + importBump}
        />
      </Activity>
      {page === 'duplicates' && permissions.includes('products.delete') && (
        <DuplicatesScreen revision={catalogueRevision + importBump} />
      )}
      {/* Kept mounted while hidden, so leaving the page does not drop an import that is running. */}
      {permissions.includes('products.edit') && (
        <Activity mode={page === 'photos' ? 'visible' : 'hidden'}>
          <PhotoImportScreen products={products} />
        </Activity>
      )}
      <Activity mode={page === 'brands' ? 'visible' : 'hidden'}>
        <BrandsScreen
          permissions={permissions}
          transport={optionListTransport}
          revision={listsRevision + importBump}
        />
      </Activity>
    </>
  );
}
