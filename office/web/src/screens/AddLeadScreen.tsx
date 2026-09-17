/**
 * Office adapter for the shared new-lead screen.
 *
 * The screen itself lives in `ui/src/NewLeadScreen.tsx` and only speaks the
 * transport below. This file translates that into what this panel has: the
 * live pick endpoints (falling back to the cached snapshot when the link is
 * down, like the legacy screen did through the same `api.pick`), the
 * snapshot's option lists and party variants, and the offline outbox for the
 * save — so a lead still queues locally with a temporary id and appears on the
 * board immediately when the Master is switched off.
 *
 * The legacy 1937-line screen is kept at
 * `scratchpad/AddLeadScreen-legacy.tsx` (session scratch, not the repo) until
 * this flow is proven on a real counter; nothing imports it.
 */

import { useMemo, useState } from 'react';
import type {
  Party,
  PartyProductVariant,
  Product,
  ProductCategory,
  ProductVariantPick,
} from '@orderbook/shared';

import { api, type LocalView } from '../api';
import { NewLeadScreen, t, useResetGuard, type NewLeadTransport, useConfirm } from '@orderbook/ui';

interface Props {
  view: LocalView;
  /** Bumped by the shell each time the form is asked for; see the focus effect. */
  focusNonce: number;
  /** Carries the queued lead's temporary id, so the shell can name it. */
  onSaved: (id: string) => void;
  onCancel: () => void;
}

export function AddLeadScreen({ view, focusNonce, onSaved, onCancel }: Props) {
  const [dirty, setDirty] = useState(false);
  // The guard lives in the mounted adapter, not the shared screen: the
  // screen holds the draft and reports whether one exists; the shell's reset
  // asks through the gate this registers.
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
      optionLists: async () => view.optionLists,
      variantsForParty: (partyId) =>
        new Map(
          view.partyVariants
            .filter((variant) => variant.partyId === partyId)
            .map((variant): [string, PartyProductVariant] => [
              variant.productId,
              {
                id: variant.id,
                tenantId: variant.tenantId,
                partyId: variant.partyId,
                productId: variant.productId,
                productName: variant.productName,
                alias: variant.alias,
                rate: variant.rate,
                size: variant.size,
                sin: variant.sin,
                grade: variant.grade,
                productType: variant.productType,
                weightKg: variant.weightKg,
                packaging: variant.packaging,
                createdAt: variant.createdAt,
                updatedAt: variant.updatedAt,
                sync: variant.sync,
              },
            ]),
        ),
      partyWise: (partyId) => view.partyVariants.some((variant) => variant.partyId === partyId),
      createLead: async (input) => {
        const queued = await api.createLead(input);
        return { id: queued.id };
      },
    }),
    [view],
  );

  return (
    <NewLeadScreen
      focusNonce={focusNonce}
      transport={transport}
      onSaved={onSaved}
      onCancel={onCancel}
      onDirtyChange={setDirty}
    />
  );
}
