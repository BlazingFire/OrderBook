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
import {
  Button,
  Card,
  DataTable,
  KeyValueList,
  StatusPill,
  formatDateTime,
  rem,
  t,
  type DataTableColumn,
} from '@orderbook/ui';

/** A party's own version of a catalogue model: what they call it, and how it ships to them. */
interface OwnRecordRow {
  key: string;
  product: string;
  ownName: string | null;
  alias: string | null;
  size: string | null;
  packaging: string | null;
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
  const recordRows: OwnRecordRow[] = view.partyVariants
    .filter((variant) => variant.partyId === party.id)
    .map((variant) => {
      const product = view.products.find((candidate) => candidate.id === variant.productId);
      return {
        key: variant.id,
        product: product?.name ?? '—',
        ownName: variant.productName,
        alias: variant.alias,
        size: variant.size,
        packaging: variant.packaging,
      };
    });

  /**
   * Party Access, read straight off the snapshot this panel already holds —
   * `partyGrants` is computed per-actor by the Master, so no fetch is needed
   * and no other person's grants are here to read.
   *
   * The absence of a grant is not "no access": an unassigned party is open to
   * everyone, which is why this reads the grant rather than inferring from its
   * absence. `undefined` means a Master too old to send the field at all.
   */
  const grant = (view.partyGrants ?? []).find((entry) => entry.partyId === party.id);

  const recentLeads = view.leads
    .filter((lead) => lead.partyId === party.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 5);

  const recordColumns: DataTableColumn<OwnRecordRow>[] = [
    { key: 'product', header: t('party.detail.records.product'), render: (row) => row.product },
    {
      key: 'ownName',
      header: t('party.detail.records.ownName'),
      render: (row) => <span className="ob-body-strong">{row.ownName ?? '—'}</span>,
    },
    { key: 'alias', header: t('product.field.alias'), width: rem(110), render: (row) => row.alias ?? '—' },
    { key: 'size', header: t('product.field.size'), width: rem(110), render: (row) => row.size ?? '—' },
    {
      key: 'packaging',
      header: t('orders.column.packaging'),
      width: rem(120),
      render: (row) => row.packaging ?? '—',
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
            {
              label: t('party.detail.phone'),
              value: <span className="ob-data">{party.phone ?? '—'}</span>,
            },
            { label: t('party.detail.city'), value: party.city ?? '—' },
            { label: t('party.detail.email'), value: party.email ?? '—' },
            {
              label: t('party.detail.taxId'),
              value: <span className="ob-mono">{party.gstNumber ?? '—'}</span>,
            },
            { label: t('party.detail.since'), value: formatDateTime(party.createdAt) },
          ]}
        />
        {party.notes && (
          <p className="ob-small" style={{ marginTop: 'var(--s-8)' }}>
            {party.notes}
          </p>
        )}
      </Card>

      <Card>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
          {t('party.detail.accessTitle')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          {grant ? (
            <StatusPill tone="accent">{t('partyAccess.restricted')}</StatusPill>
          ) : (
            <StatusPill>{t('partyAccess.open')}</StatusPill>
          )}
          <span className="ob-small">
            {grant
              ? t(
                  grant.level === 'manage'
                    ? 'party.detail.access.manage'
                    : 'party.detail.access.view',
                )
              : t('party.detail.access.open')}
          </span>
        </div>
      </Card>

      <div>
        <div className="ob-eyebrow" style={{ marginBottom: 'var(--s-8)' }}>
          {t('party.detail.recordsTitle')}
        </div>
        <DataTable
          columns={recordColumns}
          rows={recordRows}
          rowKey={(row) => row.key}
          empty={
            <p
              className="ob-small"
              style={{ margin: 0, padding: 'var(--s-16)', color: 'var(--fg-tertiary)' }}
            >
              {t('party.detail.records.none')}
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
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--s-10)',
                  padding: 'var(--s-6) var(--s-8)',
                }}
              >
                <span
                  className="ob-mono"
                  style={{ fontSize: rem(11.5), color: 'var(--fg-secondary)' }}
                >
                  {lead.id}
                </span>
                <span className="ob-small">{lead.stageName}</span>
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
