/**
 * A party, opened: who it is, its orders, what it calls the catalogue's
 * products, and — in a side panel that folds away — its contact details, who
 * can reach it, and its notes.
 *
 * Presentational only. The panel that renders it fetches (the Master asks its
 * own API, an Office reads its snapshot) and hands the rows in; every action is
 * a callback, and one the caller does not pass is not drawn — a control nobody
 * may use is not greyed, it is absent (the house rule from `PartyAccessScreen`).
 *
 * The orders table is pending orders or final orders, one at a time, with both
 * counts on the switch. Each row says how many products and how many pieces the
 * order carries — pcs, never boxes (Box is a packaging type, not a unit).
 */

import { useState } from 'react';
import type { Lead, Order, Party, PartyProductVariant } from '@orderbook/shared';

import { Button, IconButton } from './Button.js';
import { copyText } from './clipboard.js';
import { StatusPill } from './DataDisplay.js';
import { DataTable, type DataTableColumn } from './DataTable.js';
import { formatDate, formatDateTime } from './format.js';
import { t } from './i18n.js';
import { Icon } from './icons.js';
import { Popover } from './Popover.js';
import { recordNumberText } from './RecordNumber.js';
import { SkeletonTable } from './States.js';

export type PartyRecordRow = PartyProductVariant & { catalogueName: string | null };

export interface PartyAssignee {
  userId: string;
  displayName: string;
  level: 'view' | 'manage';
}

export interface PartyDetailViewProps {
  party: Party;
  /** Pending orders, newest first; null while loading. */
  pending: Lead[] | null;
  pendingTotal?: number;
  /** Final orders, newest first; null while loading; omit where the reader may not see them. */
  final?: Order[] | null;
  finalTotal?: number;
  records: PartyRecordRow[] | null;
  /** How many people hold a grant on the party; 0 is a party open to everyone. */
  accessCount: number;
  /** Who the party is assigned to — null where the reader may not see the assignment. */
  assignees: PartyAssignee[] | null;
  /** The reader's own grant; null on an open party. */
  myAccess: 'view' | 'manage' | null;
  onNewOrder?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onOpenLead?: (id: string) => void;
  onOpenOrder?: (id: string) => void;
  onOpenPendingList?: () => void;
  onOpenFinalList?: () => void;
  onManageAccess?: () => void;
  onAddName?: () => void;
}

type OrdersTab = 'pending' | 'final';

/** One row of the orders table: a pending order or a final one, read the same way. */
interface OrderRow {
  id: string;
  number: string;
  status: string;
  createdAt: string;
  products: number;
  pcs: number;
  owner: string | null;
  /** The follow-up date on a pending order; the expected dispatch on a final one. */
  due: string | null;
}

function rowOf(record: Lead | Order, due: string | null): OrderRow {
  return {
    id: record.id,
    number: recordNumberText(record),
    status: record.stageName,
    createdAt: record.createdAt,
    products: new Set(record.items.map((item) => item.productId)).size,
    pcs: record.items.reduce((sum, item) => sum + item.quantity, 0),
    owner: record.ownerName,
    due,
  };
}

/** Today's date as the follow-up column stores it, `YYYY-MM-DD`, in local time. */
function todayIso(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "Today", "Tomorrow", "Overdue · 01-10-2026", or the date. */
export function followUpLabel(
  date: string | null,
  now: Date = new Date(),
): { text: string; overdue: boolean } {
  if (!date) return { text: '—', overdue: false };
  const day = date.slice(0, 10);
  const days = Math.round(
    (Date.parse(`${day}T00:00:00`) - Date.parse(`${todayIso(now)}T00:00:00`)) / 86_400_000,
  );
  const shown = formatDate(`${day}T00:00:00`);
  if (days < 0) return { text: t('party.view.overdue', { date: shown }), overdue: true };
  if (days === 0) return { text: t('party.view.today'), overdue: false };
  if (days === 1) return { text: t('party.view.tomorrow'), overdue: false };
  return { text: shown, overdue: false };
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.trim().slice(0, 2);
  return letters.toUpperCase();
}

export function PartyDetailView(props: PartyDetailViewProps) {
  const { party, accessCount } = props;
  const [tab, setTab] = useState<OrdersTab>('pending');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const place = [party.city, party.state].filter(Boolean).join(', ');
  const showFinal = props.final !== undefined;
  const shownTab: OrdersTab = showFinal ? tab : 'pending';
  const rows: OrderRow[] | null =
    shownTab === 'pending'
      ? (props.pending?.map((lead) => rowOf(lead, lead.followUpDate)) ?? null)
      : (props.final?.map((order) => rowOf(order, order.expectedDispatchDate)) ?? null);
  const openRow = shownTab === 'pending' ? props.onOpenLead : props.onOpenOrder;
  const openList = shownTab === 'pending' ? props.onOpenPendingList : props.onOpenFinalList;

  const missing = [
    [party.phone, t('party.field.phone')],
    [party.altPhone, t('party.field.altPhone')],
    [party.email, t('party.field.email')],
    [party.addressLine1, t('party.field.addressLine1')],
    [party.pincode, t('party.field.pincode')],
    [party.gstNumber, t('party.detail.taxId')],
  ]
    .filter(([value]) => !value)
    .map(([, label]) => label as string);

  const contact = [
    { label: t('party.field.phone'), value: party.phone },
    { label: t('party.field.altPhone'), value: party.altPhone },
    { label: t('party.field.email'), value: party.email },
    {
      label: t('party.field.addressLine1'),
      value: [party.addressLine1, party.addressLine2].filter(Boolean).join(', ') || null,
    },
    { label: t('party.field.city'), value: party.city },
    { label: t('party.field.state'), value: party.state },
    { label: t('party.field.pincode'), value: party.pincode },
    { label: t('party.detail.taxId'), value: party.gstNumber },
  ].filter((item): item is { label: string; value: string } => Boolean(item.value));

  const columns: DataTableColumn<OrderRow>[] = [
    {
      key: 'number',
      header: t('party.view.col.order'),
      render: (row) => <span className="ob-mono ob-partyview-link">{row.number}</span>,
    },
    {
      key: 'status',
      header: t('party.view.col.status'),
      width: '8rem',
      render: (row) => <StatusPill>{row.status}</StatusPill>,
    },
    {
      key: 'created',
      header: t('party.view.col.created'),
      width: '8rem',
      render: (row) => <span className="ob-data">{formatDate(row.createdAt)}</span>,
    },
    {
      key: 'products',
      header: t('party.view.col.products'),
      width: '6.5rem',
      align: 'right',
      render: (row) => <span className="ob-data">{row.products}</span>,
    },
    {
      key: 'pcs',
      header: t('party.view.col.pcs'),
      width: '5.5rem',
      align: 'right',
      render: (row) => <span className="ob-data">{row.pcs}</span>,
    },
    {
      key: 'owner',
      header: t('party.view.col.owner'),
      width: '8rem',
      priority: 2,
      render: (row) => row.owner ?? '—',
    },
    {
      key: 'due',
      header: shownTab === 'pending' ? t('party.view.col.followUp') : t('party.view.col.dispatch'),
      width: '11rem',
      render: (row) => {
        const label = followUpLabel(row.due);
        return (
          <span className={label.overdue ? 'ob-partyview-overdue' : undefined}>{label.text}</span>
        );
      },
    },
  ];

  const recordColumns: DataTableColumn<PartyRecordRow>[] = [
    {
      key: 'product',
      header: t('party.detail.records.product'),
      render: (record) => record.catalogueName ?? '—',
    },
    {
      key: 'ownName',
      header: t('party.detail.records.ownName'),
      render: (record) => (
        <span className="ob-body-strong">{record.productName ?? record.alias ?? '—'}</span>
      ),
    },
    {
      key: 'size',
      header: t('product.field.size'),
      width: '7rem',
      render: (record) => record.size ?? '—',
    },
    {
      key: 'packaging',
      header: t('orders.column.packaging'),
      width: '8rem',
      render: (record) => record.packaging ?? '—',
    },
  ];

  return (
    <div className="ob-partyview">
      <header className="ob-partyview-card ob-partyview-head">
        <div className="ob-partyview-avatar" aria-hidden="true">
          {initialsOf(party.name)}
        </div>
        <div className="ob-partyview-who">
          <div className="ob-partyview-titlerow">
            <h1 className="ob-title">{party.name}</h1>
            <button
              type="button"
              className="ob-partyview-code"
              title={copied ? t('party.view.copied') : t('party.view.copyCode')}
              onClick={() => {
                void copyText(party.partyCode).then((ok) => {
                  setCopied(ok);
                  if (ok) window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <span className="ob-mono">{party.partyCode}</span>
              <Icon name={copied ? 'check' : 'copy'} size={13} />
            </button>
            {accessCount > 0 && (
              <span className="ob-partyview-restricted">
                <Icon name="lock" size={13} />
                {accessCount === 1
                  ? t('party.view.restrictedOne')
                  : t('party.view.restrictedCount', { count: accessCount })}
              </span>
            )}
          </div>
          <div className="ob-small ob-partyview-sub">
            {[place, t('party.view.since', { date: formatDate(party.createdAt) })]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="ob-partyview-actions">
          {props.onNewOrder && (
            <Button variant="primary" icon="plus" onClick={props.onNewOrder}>
              {t('party.view.newOrder')}
            </Button>
          )}
          {props.onEdit && (
            <Button variant="secondary" icon="edit" onClick={props.onEdit}>
              {t('party.detail.editAction')}
            </Button>
          )}
          {props.onDelete && (
            <span style={{ position: 'relative' }}>
              <IconButton
                icon="more"
                variant="bordered"
                label={t('party.view.more')}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              />
              <Popover open={menuOpen} onClose={() => setMenuOpen(false)}>
                <div className="ob-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="ob-menu-item ob-menu-item--danger"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onDelete?.();
                    }}
                  >
                    {t('parties.delete.confirm')}
                  </button>
                </div>
              </Popover>
            </span>
          )}
        </div>
      </header>

      <div className={`ob-partyview-grid${detailsOpen ? '' : ' ob-partyview-grid--folded'}`}>
        <div className="ob-partyview-main">
          <section className="ob-partyview-card">
            <div className="ob-partyview-cardhead">
              <span className="ob-eyebrow">{t('party.view.orders')}</span>
              <div className="ob-seg" role="group" aria-label={t('party.view.orders')}>
                <button
                  type="button"
                  aria-pressed={shownTab === 'pending'}
                  onClick={() => setTab('pending')}
                >
                  {t('party.view.pending')}{' '}
                  <span className="ob-partyview-count">
                    {props.pendingTotal ?? props.pending?.length ?? 0}
                  </span>
                </button>
                {showFinal && (
                  <button
                    type="button"
                    aria-pressed={shownTab === 'final'}
                    onClick={() => setTab('final')}
                  >
                    {t('party.view.final')}{' '}
                    <span className="ob-partyview-count">
                      {props.finalTotal ?? props.final?.length ?? 0}
                    </span>
                  </button>
                )}
              </div>
              <span style={{ flex: 1 }} />
              {openList && (
                <button type="button" className="ob-partyview-textbtn" onClick={openList}>
                  {shownTab === 'pending'
                    ? t('party.view.openPending')
                    : t('party.view.openFinal')}
                </button>
              )}
            </div>
            {rows === null ? (
              <SkeletonTable columns={columns} rows={2} />
            ) : (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                onRowOpen={openRow ? (row) => openRow(row.id) : undefined}
                empty={
                  <p className="ob-small ob-partyview-none">
                    {shownTab === 'pending'
                      ? t('party.detail.leads.none')
                      : t('party.view.final.none')}
                  </p>
                }
              />
            )}
          </section>

          <section className="ob-partyview-card ob-partyview-names">
            <div className="ob-partyview-cardhead">
              <span className="ob-eyebrow">{t('party.view.names')}</span>
              <span className="ob-small ob-partyview-hint">{t('party.view.names.hint')}</span>
              <span style={{ flex: 1 }} />
              {props.onAddName && (
                <Button variant="secondary" size="sm" icon="plus" onClick={props.onAddName}>
                  {t('party.view.addName')}
                </Button>
              )}
            </div>
            {props.records === null ? (
              <SkeletonTable columns={recordColumns} rows={2} />
            ) : props.records.length === 0 ? (
              <div className="ob-partyview-empty">
                <span className="ob-partyview-emptyicon">
                  <Icon name="products" size={20} />
                </span>
                <h3>{t('party.view.names.none')}</h3>
                <p className="ob-small">{t('party.view.names.noneHint')}</p>
              </div>
            ) : (
              <DataTable columns={recordColumns} rows={props.records} rowKey={(row) => row.id} />
            )}
          </section>
        </div>

        {detailsOpen ? (
          <aside className="ob-partyview-card ob-partyview-side" aria-label={t('party.view.details')}>
            <div className="ob-partyview-cardhead">
              <span className="ob-eyebrow">{t('party.view.details')}</span>
              <span style={{ flex: 1 }} />
              {props.onEdit && (
                <IconButton icon="edit" label={t('party.detail.editAction')} onClick={props.onEdit} />
              )}
              <IconButton
                icon="expand"
                label={t('party.view.hideDetails')}
                onClick={() => setDetailsOpen(false)}
              />
            </div>

            <div className="ob-partyview-section">
              <h4>{t('party.detail.contact')}</h4>
              <dl className="ob-partyview-kv">
                {contact.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
              {missing.length > 0 && (
                <div className="ob-partyview-missing">
                  <strong>{t('party.view.missing', { count: missing.length })}</strong>
                  <p className="ob-small">{missing.join(', ')}</p>
                  {props.onEdit && (
                    <Button variant="secondary" size="sm" icon="plus" onClick={props.onEdit}>
                      {t('party.view.addDetails')}
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="ob-partyview-section">
              <div className="ob-partyview-sectionhead">
                <h4>{t('party.detail.accessTitle')}</h4>
                {props.onManageAccess && (
                  <button
                    type="button"
                    className="ob-partyview-textbtn"
                    onClick={props.onManageAccess}
                  >
                    {t('party.view.manage')}
                  </button>
                )}
              </div>
              <p className="ob-small">
                {accessCount > 0 ? t('party.view.restrictedText') : t('party.view.openText')}
              </p>
              {props.myAccess && !props.assignees && (
                <p className="ob-small">
                  {props.myAccess === 'manage'
                    ? t('party.detail.access.manage')
                    : t('party.detail.access.view')}
                </p>
              )}
              {props.assignees && props.assignees.length > 0 && (
                <div className="ob-partyview-people">
                  {props.assignees.map((person) => (
                    <span key={person.userId} className="ob-partyview-person">
                      <span className="ob-partyview-initial" aria-hidden="true">
                        {person.displayName.slice(0, 1).toUpperCase()}
                      </span>
                      {person.displayName}
                      <StatusPill tone={person.level === 'manage' ? 'accent' : 'default'}>
                        {person.level === 'manage'
                          ? t('partyAccess.level.manage')
                          : t('partyAccess.level.view')}
                      </StatusPill>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="ob-partyview-section">
              <div className="ob-partyview-sectionhead">
                <h4>{t('party.field.notes')}</h4>
                {props.onEdit && (
                  <button type="button" className="ob-partyview-textbtn" onClick={props.onEdit}>
                    {party.notes ? t('party.view.editNote') : t('party.view.addNote')}
                  </button>
                )}
              </div>
              <p className="ob-small ob-partyview-notes">
                {party.notes ?? t('party.view.noNotes')}
              </p>
            </div>

            <div className="ob-partyview-section">
              <dl className="ob-partyview-kv">
                <div>
                  <dt>{t('catalog.parties.column.code')}</dt>
                  <dd className="ob-mono">{party.partyCode}</dd>
                </div>
                <div>
                  <dt>{t('party.view.added')}</dt>
                  <dd>{formatDateTime(party.createdAt)}</dd>
                </div>
              </dl>
            </div>
          </aside>
        ) : (
          <aside className="ob-partyview-card ob-partyview-rail">
            <IconButton
              icon="collapse"
              label={t('party.view.showDetails')}
              onClick={() => setDetailsOpen(true)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
