/**
 * Products: the catalogue on the Master. The sub-product list, the Products
 * page and Brands are the shared screens in `ui/` (ports of the Office's
 * `CatalogScreen` / `MainProductsScreen`); this host loads the `CatalogueView`
 * they read and hands them the Master's transport.
 *
 * What it loads, and when it loads it again (each on its own revision, so a
 * stock movement does not re-read the catalogue and a lead edit reads nothing):
 *  - the option lists (brands, colours) when `option_list` moved;
 *  - the products (categories) and every sub product when the catalogue moved,
 *    `limit: 2000` being the cap the snapshot hands an Office panel;
 *  - free stock when stock or a reservation moved, and only with
 *    `inventory.view`, as the snapshot does - without it the free-stock column
 *    reads a dash.
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
import { catalogueTransport } from '../transports';
import { optionListTransport } from './FieldsScreen';

export type ProductsPage = 'sub' | 'main' | 'brands';

interface Props {
  page: ProductsPage;
  permissions: readonly string[];
  /** Moves when a product, a product (category) or a bulk import changed. */
  catalogueRevision: number;
  /** Moves when stock or a reservation changed. */
  stockRevision: number;
  /** Moves when an option list changed. */
  listsRevision: number;
}

type Stock = CatalogueView['stock'];

const NO_STOCK: Stock = [];

export function ProductsScreen({
  page,
  permissions,
  catalogueRevision,
  stockRevision,
  listsRevision,
}: Props) {
  const canViewProducts = permissions.includes('products.view');
  const canViewStock = permissions.includes('inventory.view');

  const [optionLists, setOptionLists] = useState<OptionListItem[] | null>(null);
  const [categories, setCategories] = useState<ProductCategory[] | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [stock, setStock] = useState<Stock>(NO_STOCK);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by a bulk import so lists, brands and stock refetch at once, without waiting for the socket. */
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

  useEffect(() => {
    if (!canViewStock) {
      setStock(NO_STOCK);
      return;
    }
    let superseded = false;
    api
      .stock({ limit: 2000 })
      .then((levels) => {
        if (!superseded) setStock(levels);
      })
      .catch(() => {
        // Free stock is a nicety on this screen: a dash, not a failed page.
        if (!superseded) setStock(NO_STOCK);
      });
    return () => {
      superseded = true;
    };
  }, [stockRevision, canViewStock, importBump]);

  if (!optionLists || !categories || !products) {
    return error ? <ConflictBanner>{error}</ConflictBanner> : <BusyMark />;
  }

  const view: CatalogueView = { permissions, optionLists, categories, products, stock };

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
