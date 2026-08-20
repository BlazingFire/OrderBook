/** Read-only browsing of parties and products; creation happens in Add Lead. */

import { useMemo, useState } from 'react';
import type { SyncSnapshot } from '@orderbook/shared';

import { formatMoney } from '../format';
import { Field } from '../components/Field';

export function CatalogScreen({ snapshot, view }: { snapshot: SyncSnapshot; view: 'parties' | 'products' }) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();

  const parties = useMemo(
    () =>
      snapshot.parties.filter(
        (party) =>
          !term ||
          party.name.toLowerCase().includes(term) ||
          party.partyCode.toLowerCase().includes(term) ||
          (party.phone ?? '').includes(term),
      ),
    [snapshot.parties, term],
  );

  const products = useMemo(
    () =>
      snapshot.products.filter(
        (product) =>
          !term ||
          product.name.toLowerCase().includes(term) ||
          product.productCode.toLowerCase().includes(term) ||
          (product.categoryName ?? '').toLowerCase().includes(term),
      ),
    [snapshot.products, term],
  );

  return (
    <div className="card">
      <Field label={view === 'parties' ? 'Search parties' : 'Search products'}>
        {(id) => (
          <input id={id} value={search} onChange={(event) => setSearch(event.target.value)} />
        )}
      </Field>

      {view === 'parties' ? (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Phone</th>
              <th>City</th>
              <th>GST</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => (
              <tr key={party.id}>
                <td>{party.partyCode}</td>
                <td>{party.name}</td>
                <td>{party.phone ?? '—'}</td>
                <td>{party.city ?? '—'}</td>
                <td>{party.gstNumber ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Finish</th>
              <th>Price / box</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>{product.productCode}</td>
                <td>{product.name}</td>
                <td>{product.categoryName ?? '—'}</td>
                <td>{product.size ?? '—'}</td>
                <td>{product.finish ?? '—'}</td>
                <td>{formatMoney(product.pricePerBox)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
