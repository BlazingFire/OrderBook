/**
 * Universal search (docs/LEAD_GENERATION_FLOW.md §9.6).
 *
 * One box across products, parties, and the line items of leads and orders. The
 * line-item hits are the interesting half: they search the **snapshot** text
 * frozen onto each line, so an old product name still finds the historical
 * leads and orders quoted under it — which a search of the live catalogue could
 * never do.
 *
 * Results carry a rank from Postgres, and the server has already dropped any
 * entity this user may not view.
 */

import { useEffect, useRef, useState } from 'react';
import type { SearchHit, SearchHitKind } from '@orderbook/shared';

import { rem } from '@orderbook/ui';

import { api } from '../api';

const KIND_LABEL: Record<SearchHitKind, string> = {
  product: 'Product',
  party: 'Party',
  lead_line: 'On a lead',
  order_line: 'On an order',
};

export function SearchBox({ onOpen }: { onOpen: (hit: SearchHit) => void }) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Debounced: a query per keystroke would put a full-text scan behind every
  // letter, and the index is fast enough that 200ms is imperceptible anyway.
  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }

    const timer = setTimeout(() => {
      void api
        .search(trimmed)
        .then((results) => {
          setHits(results);
          setOpen(true);
        })
        .catch(() => setHits([]));
    }, 200);

    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    function onClickAway(event: MouseEvent): void {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  return (
    <div ref={container} style={{ position: 'relative', width: rem(320) }}>
      <input
        value={term}
        placeholder="Search everything…"
        aria-label="Search products, parties, leads and orders"
        onChange={(event) => setTerm(event.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
      />

      {open && hits.length > 0 && (
        <div
          className="card"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 20,
            marginTop: 4,
            padding: 6,
            maxHeight: rem(360),
            overflowY: 'auto',
          }}
        >
          {hits.map((hit) => (
            <button
              key={`${hit.kind}-${hit.id}`}
              className="secondary"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                marginBottom: 2,
              }}
              onClick={() => {
                onOpen(hit);
                setOpen(false);
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <strong>{hit.title}</strong>
                <span className="chip">{KIND_LABEL[hit.kind]}</span>
              </div>
              {hit.subtitle && <div className="muted">{hit.subtitle}</div>}
            </button>
          ))}
        </div>
      )}

      {open && term.trim().length >= 2 && hits.length === 0 && (
        <div
          className="card"
          style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4 }}
        >
          <p className="muted" style={{ margin: 0 }}>
            Nothing matched “{term.trim()}”.
          </p>
        </div>
      )}
    </div>
  );
}
