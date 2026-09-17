/**
 * Master adapter for the shared new-lead screen.
 *
 * The Master's own UI is online by definition — it is the machine that owns
 * the database — so the transport here is thin: `api.pick` for the searches,
 * `api.optionLists` once, per-party variants fetched lazily and cached per
 * party (that endpoint answers one party at a time), and the new
 * `POST /api/leads` for the save. The same service the Office panels reach
 * over the socket answers it, so behaviour cannot diverge between panels.
 */

import { useMemo, useRef, useState } from 'react';
import type {
  Party,
  PartyProductVariant,
  Product,
  ProductCategory,
  ProductVariantPick,
} from '@orderbook/shared';

import { api } from '../api';
import {
  NewLeadScreen as SharedNewLeadScreen,
  t,
  useResetGuard,
  type NewLeadTransport,
  useConfirm,
} from '@orderbook/ui';

interface Props {
  focusNonce: number;
  onSaved: (id: string) => void;
  onCancel: () => void;
}

export function NewLeadScreen({ focusNonce, onSaved, onCancel }: Props) {
  const [dirty, setDirty] = useState(false);
  /*
   * A themed, translated confirm rather than `window.confirm`, which in
   * Electron renders the bare Chromium prompt and blocks the renderer while it
   * is up. `useResetGuard` takes a promise for exactly this reason.
   */
  const confirmDiscard = useConfirm();
  useResetGuard(
    dirty
      ? () =>
          confirmDiscard({
            title: t('lead.add.discardConfirm'),
            confirmLabel: t('lead.add.discard'),
            tone: 'danger',
          })
      : null,
  );

  const variantCache = useRef(new Map<string, Map<string, PartyProductVariant>>());

  const transport = useMemo<NewLeadTransport>(
    () => ({
      pickParty: async (term, signal) => {
        const page = await api.pick<Party>('party', { term, signal });
        return page.items;
      },
      pickCategory: async (term, signal) => {
        const page = await api.pick<ProductCategory>('category', { term, signal });
        return page.items;
      },
      pickModels: async (categoryId, term, signal) => {
        const page = await api.pick<Product>('product', { term, categoryId, signal });
        return page.items;
      },
      pickVariants: async (productCode) => {
        try {
          const page = await api.pick<ProductVariantPick>('variant', { term: productCode });
          return page.items;
        } catch {
          return [];
        }
      },
      optionLists: () => api.optionLists(),
      variantsForParty: (partyId) => variantCache.current.get(partyId) ?? new Map(),
      partyWise: (partyId) => (variantCache.current.get(partyId)?.size ?? 0) > 0,
      createLead: async (input) => {
        const lead = await api.createLead(input);
        for (const item of lead.items) {
          if (!item.fromPartyVariant) continue;
          const known = variantCache.current.get(lead.partyId);
          if (!known) void refreshVariants(lead.partyId);
        }
        return { id: lead.id };
      },
    }),
    [],
  );

  async function refreshVariants(partyId: string): Promise<void> {
    try {
      const rows = await api.partyVariants(partyId);
      variantCache.current.set(partyId, new Map(rows.map((row) => [row.productId, row])));
    } catch {
      // No variants known for this party; the catalogue fills every line.
    }
  }

  return (
    <SharedNewLeadScreen
      focusNonce={focusNonce}
      transport={{
        ...transport,
        pickParty: async (term, signal) => {
          const rows = await transport.pickParty(term, signal);
          // Warm the variant cache for the parties on screen, so picking one
          // already knows its own rates when the first model is added.
          for (const row of rows.slice(0, 6)) {
            if (!variantCache.current.has(row.id)) void refreshVariants(row.id);
          }
          return rows;
        },
      }}
      onSaved={onSaved}
      onCancel={onCancel}
      onDirtyChange={setDirty}
    />
  );
}
