/** Read-only browsing of parties and products; creation happens in Add Lead. */

import { useMemo, useState } from 'react';

import type { LocalView } from '../api';
import { Field } from '../components/Field';
import { StockByColour } from '../components/StockCell';
import { formatMoney } from '../format';

export function CatalogScreen({
  view,
  tab,
}: {
  view: LocalView;
  tab: 'parties' | 'products';
}) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();

  const parties = useMemo(
    () =>
      view.parties.filter(
        (party) =>
          !term ||
          party.name.toLowerCase().includes(term) ||
          party.partyCode.toLowerCase().includes(term) ||
          (party.phone ?? '').includes(term),
      ),
    [view.parties, term],
  );

  const products = useMemo(
    () =>
      view.products.filter(
        (product) =>
          !term ||
          product.name.toLowerCase().includes(term) ||
          product.productCode.toLowerCase().includes(term) ||
          (product.alias ?? '').toLowerCase().includes(term) ||
          (product.categoryName ?? '').toLowerCase().includes(term),
      ),
    [view.products, term],
  );

  return (
    <div className="card">
      <Field label={tab === 'parties' ? 'Search parties' : 'Search products'}>
        {(id) => (
          <input id={id} value={search} onChange={(event) => setSearch(event.target.value)} />
        )}
      </Field>

      {tab === 'parties' ? (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Phone</th>
              <th>City</th>
              <th>Own rates</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const variants = view.partyVariants.filter(
                (variant) => variant.partyId === party.id,
              ).length;

              return (
                <tr key={party.id}>
                  <td>{party.partyCode}</td>
                  <td>
                    {party.name}
                    {!party.sync.hlc && (
                      <span className="chip pending" style={{ marginLeft: 6 }}>
                        not synced
                      </span>
                    )}
                  </td>
                  <td>{party.phone ?? '—'}</td>
                  <td>{party.city ?? '—'}</td>
                  <td>{variants > 0 ? `${variants} product${variants === 1 ? '' : 's'}` : '—'}</td>
                </tr>
              );
            })}
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
              <th>Grade</th>
              <th>Rate / box</th>
              <th>Stock by colour</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>{product.productCode}</td>
                <td>
                  {product.name}
                  {product.alias && <div className="muted">{product.alias}</div>}
                </td>
                <td>{product.productType ?? product.categoryName ?? '—'}</td>
                <td>{product.size ?? '—'}</td>
                <td>{product.grade ?? '—'}</td>
                {/* `rate` is absent, not null, when the role cannot see it. */}
                <td className="num">
                  {product.rate === undefined ? (
                    <span className="muted">hidden</span>
                  ) : (
                    formatMoney(product.rate)
                  )}
                </td>
                <td>
                  <StockByColour productId={product.id} stock={view.stock} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
