/**
 * PartyDetail — the view-only body of the 520px drawer Catalog/Parties opens
 * on a row click (`Parties.dc.html`'s detail drawer — the other half of the
 * QA review's "no way to open an existing record" gap; the Parties table had
 * no `onRowOpen` at all before this).
 *
 * The rate-override table reads `view.partyVariants` filtered to this party,
 * matched against `view.products` for the catalogue figure it is compared
 * to — the same `PartyProductVariant[]` the list column already counts
 * (`CatalogScreen.tsx`'s `variants` column), just rendered as rows instead
 * of a count. Recent leads reads `view.leads` filtered by `partyId`, which
 * `Lead` carries directly, so this is real data — not a second fetch.
 *
 * Leads are listed but not opened from here: `CatalogScreen` is never handed
 * a way to navigate to the Lead board (its only App.tsx wiring is
 * `view`/`tab`), so making a row look clickable without anywhere to send it
 * would be a dead control. Same reasoning drops the mockup's "Quote in a
 * lead" / "New lead for this party" buttons — both need the Add-Lead flow,
 * which this screen has no route to.
 *
 * Editing reuses `PartyDrawer`'s edit mode via `onEdit`, added alongside
 * this component specifically so this button would not be a dead end.
 */

import type { Party } from '@orderbook/shared';

import type { LocalView } from '../api';
import { formatDateTime, formatMoney } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { KeyValueList } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';

const RATE_PERMISSION = 'field.saleRate.view';

interface RateRow {
  key: string;
  product: string;
  catalogueRate: number | null | undefined;
  ownRate: number | null | undefined;
}

export function PartyDetail({
  party,
  view,
  onEdit,
}: {
  party: Party;
  view: LocalView;
  onEdit: () => void;
}) {
  const rateRows: RateRow[] = view.partyVariants
    .filter((variant) => variant.partyId === party.id)
    .map((variant) => {
      const product = view.products.find((candidate) => candidate.id === variant.productId);
      return {
        key: variant.id,
        product: variant.productName ?? product?.name ?? '—',
        catalogueRate: product?.rate,
        ownRate: variant.rate,
      };
    });

  const recentLeads = view.leads
    .filter((lead) => lead.partyId === party.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 5);

  const rateColumns: DataTableColumn<RateRow>[] = [
    { key: 'product', header: t('party.detail.rates.product'), render: (row) => row.product },
    {
      key: 'catalogue',
      header: t('party.detail.rates.catalogue'),
      width: '110px',
      align: 'right',
      render: (row) => (
        <span style={{ color: 'var(--fg-tertiary)', textDecoration: 'line-through' }}>
          {formatMoney(row.catalogueRate ?? null)}
        </span>
      ),
      redactedReason: (row) => (row.catalogueRate === undefined ? RATE_PERMISSION : undefined),
    },
    {
      key: 'own',
      header: t('party.detail.rates.own'),
      width: '110px',
      align: 'right',
      render: (row) => <span className="ob-body-strong">{formatMoney(row.ownRate ?? null)}</span>,
      redactedReason: (row) => (row.ownRate === undefined ? RATE_PERMISSION : undefined),
    },
  ];

  return (
    <>
      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
          {t('party.detail.contact')}
        </div>
        <KeyValueList
          items={[
            { label: t('party.detail.phone'), value: <span className="ob-data">{party.phone ?? '—'}</span> },
            { label: t('party.detail.city'), value: party.city ?? '—' },
            { label: t('party.detail.email'), value: party.email ?? '—' },
            { label: t('party.detail.taxId'), value: <span className="ob-mono">{party.gstNumber ?? '—'}</span> },
            { label: t('party.detail.since'), value: formatDateTime(party.createdAt) },
          ]}
        />
        {party.notes && (
          <p className="ob-small" style={{ marginTop: 'var(--s-8)' }}>
            {party.notes}
          </p>
        )}
      </Card>

      <div>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
          {t('party.detail.ratesTitle')}
        </div>
        <DataTable
          columns={rateColumns}
          rows={rateRows}
          rowKey={(row) => row.key}
          empty={
            <p className="ob-small" style={{ margin: 0, padding: 'var(--s-16)', color: 'var(--fg-tertiary)' }}>
              {t('party.detail.rates.none')}
            </p>
          }
        />
      </div>

      <div>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
          {t('party.detail.leadsTitle')}
        </div>
        {recentLeads.length === 0 ? (
          <p className="ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {t('party.detail.leads.none')}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            {recentLeads.map((lead) => (
              <div
                key={lead.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-10)', padding: 'var(--s-6) var(--s-8)' }}
              >
                <span className="ob-mono" style={{ fontSize: 11.5, color: 'var(--fg-secondary)' }}>
                  {lead.id}
                </span>
                <span className="ob-small">{lead.stageName}</span>
                <span style={{ flex: 1 }} />
                <span className="ob-data">{lead.totalAmount !== undefined ? formatMoney(lead.totalAmount) : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <Button variant="secondary" size="sm" icon="edit" onClick={onEdit}>
          {t('party.detail.editAction')}
        </Button>
      </div>
    </>
  );
}
