/**
 * The order pipeline — a separate workflow from the lead's
 * (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * The one action here that moves real stock is Dispatch: it consumes the
 * order's reservations and writes the signed ledger entries. Everything before
 * that only holds stock aside.
 *
 * Rendered as a table, not a board (6-UI-DESIGN.md, Orders.dc.html): dispatch
 * and stage tracking reads better as a sortable list than a kanban column for
 * this screen. Opening an order replaces the table with its detail — a
 * sub-screen with one way back in a fixed place, and its own entry nested
 * under Orders in the sidebar while it is open. The table is not unmounted
 * while that shows, so its filters and scroll position survive the round trip.
 */

import { useState } from 'react';
import type {
  Order,
  PartyScopeFilter,
  PipelineStage,
  ReservationStatus,
  SyncSnapshot,
} from '@orderbook/shared';

import { api, type LocalView } from '../api';
import {
  Button,
  Card,
  ColourName,
  DataTable,
  EditorScreen,
  EmptyState,
  FilterChip,
  FilterDivider,
  FormField,
  Input,
  NumberInput,
  Section,
  Segmented,
  Select,
  StatusPill,
  Timeline,
  formatDateTime,
  formatKg,
  rem,
  t,
  useColourHex,
  useFilterBar,
  useSubNav,
  type PillTone,
} from '@orderbook/ui';
import type { DataTableColumn } from '@orderbook/ui';

interface Props {
  view: LocalView;
  /** The order showing as a sub-screen, held by the shell so the Dashboard can open one. */
  openId: string | null;
  onOpenId: (id: string | null) => void;
  canDispatch: boolean;
  onError: (message: string) => void;
  /** The stage showing, or null for all — chosen here or from the sidebar's sub-pages. */
  stageId: string | null;
  onStageChange: (stageId: string | null) => void;
}

const DISPATCH_PERMISSION = 'orders.dispatch';

function sortedStages(pipeline: LocalView['pipelines'][number] | undefined): PipelineStage[] {
  return [...(pipeline?.stages ?? [])].sort((a, b) => a.sequence - b.sequence);
}

function stageTone(order: Order, stages: PipelineStage[]): PillTone {
  if (order.dispatchedAt) return 'ok';
  const stage = stages.find((candidate) => candidate.id === order.stageId);
  if (stage?.isTerminal) return 'ok';
  if (stage?.isDefault) return 'accent';
  return 'default';
}

function totalPieces(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.quantity, 0);
}

function displayWeightKg(order: Order): number {
  return order.weightSource === 'manual' && order.totalWeightKgOverride !== null
    ? order.totalWeightKgOverride
    : order.totalWeightKg;
}

const RESERVATION_TONE: Record<ReservationStatus, PillTone> = {
  active: 'accent',
  consumed: 'ok',
  released: 'default',
};

/**
 * "My parties" — the leads or orders on parties explicitly assigned to the
 * signed-in person.
 *
 * A narrowing of what is already on screen, never a widening: the snapshot the
 * Master built for this person has already dropped everything they may not see,
 * so this only hides the *unassigned* parties they can reach like everyone
 * else. `partyGrants` absent (an older Master) leaves the list untouched.
 */
function onMyParties<T extends { partyId: string }>(
  rows: T[],
  grants: SyncSnapshot['partyGrants'],
): T[] {
  if (!grants) return rows;
  const mine = new Set(grants.map((grant) => grant.partyId));
  return rows.filter((row) => mine.has(row.partyId));
}

export function OrderBoardScreen({
  view,
  openId,
  onOpenId,
  canDispatch,
  onError,
  stageId: stageFilter,
  onStageChange: setStageFilter,
}: Props) {
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const colourHex = useColourHex(view.optionLists);
  // Absent means an older Master, which sends every figure — read as "on".
  const freeToSell = view.features?.freeToSell ?? true;

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'order');
  const stages = sortedStages(pipeline);
  const orders = onMyParties(view.orders, scope === 'assigned' ? view.partyGrants : undefined);
  const openOrder = orders.find((order) => order.id === openId) ?? null;

  useFilterBar(
    pipeline && !openOrder ? (
      <>
        <Segmented
          options={[
            { value: 'all' as const, label: t('partyAccess.scope.all') },
            { value: 'assigned' as const, label: t('partyAccess.scope.assigned') },
          ]}
          value={scope}
          onChange={setScope}
        />
        <FilterDivider />
        <FilterChip
          active={stageFilter === null}
          count={orders.length}
          onClick={() => setStageFilter(null)}
        >
          {t('orders.filter.allStages')}
        </FilterChip>
        {stages.map((stage) => (
          <FilterChip
            key={stage.id}
            active={stageFilter === stage.id}
            count={orders.filter((order) => order.stageId === stage.id).length}
            onClick={() => setStageFilter(stage.id)}
          >
            {stage.name}
          </FilterChip>
        ))}
        <FilterDivider />
        <span style={{ flex: 1 }} />
        <span className="ob-small">{t('orders.filter.note')}</span>
      </>
    ) : null,
  );

  useSubNav(
    'orders',
    openOrder
      ? {
          parentId: 'orders',
          items: [{ id: 'orders.detail', label: openOrder.partyName, icon: 'orders' }],
          activeId: 'orders.detail',
        }
      : null,
  );

  if (openOrder) {
    return (
      <EditorScreen
        title={openOrder.partyName}
        meta={
          <>
            <StatusPill tone={stageTone(openOrder, stages)}>{openOrder.stageName}</StatusPill>
            {openOrder.dispatchedAt && (
              <StatusPill tone="ok">{t('orders.badge.dispatched')}</StatusPill>
            )}
            <span className="ob-small">
              {openOrder.leadId
                ? t('orders.detail.subtitleWithLead', {
                    id: openOrder.id,
                    leadId: openOrder.leadId,
                  })
                : t('orders.detail.subtitleNoLead', { id: openOrder.id })}
            </span>
          </>
        }
        onBack={() => {
          onOpenId(null);
          return true;
        }}
        backLabel={t('action.backToList')}
      >
        <OrderDetailBody
          order={openOrder}
          stages={stages}
          canDispatch={canDispatch}
          freeToSell={freeToSell}
          onClose={() => onOpenId(null)}
          onError={onError}
          colourHex={colourHex}
        />
      </EditorScreen>
    );
  }

  if (!pipeline) {
    return (
      <Card>
        <p className="ob-small">{t('orders.waitingPipeline')}</p>
      </Card>
    );
  }

  const filteredOrders = stageFilter
    ? orders.filter((order) => order.stageId === stageFilter)
    : orders;

  const columns: DataTableColumn<Order>[] = [
    {
      key: 'id',
      header: t('orders.column.order'),
      width: rem(120),
      render: (order) => (
        <span className="ob-mono" style={{ color: 'var(--fg-secondary)' }}>
          {order.id}
        </span>
      ),
    },
    {
      key: 'party',
      header: t('orders.column.party'),
      render: (order) => order.partyName,
    },
    {
      key: 'lead',
      header: t('orders.column.fromLead'),
      priority: 3,
      width: rem(150),
      render: (order) =>
        order.leadId ? (
          <span className="ob-mono" style={{ color: 'var(--fg-tertiary)' }}>
            {order.leadId}
          </span>
        ) : (
          <span style={{ color: 'var(--fg-tertiary)' }}>—</span>
        ),
    },
    {
      key: 'boxes',
      header: t('orders.column.qty'),
      priority: 2,
      width: rem(80),
      align: 'right',
      render: (order) => totalPieces(order).toLocaleString('en-IN'),
    },
    {
      key: 'weight',
      header: t('orders.column.weight'),
      priority: 3,
      width: rem(100),
      align: 'right',
      render: (order) => (
        <span
          style={{
            color: order.weightSource === 'manual' ? 'var(--fg-secondary)' : 'var(--fg-primary)',
          }}
        >
          {displayWeightKg(order).toLocaleString('en-IN')} {t('orders.unit.kg')}
          {order.weightSource === 'manual' ? '*' : ''}
        </span>
      ),
    },
    {
      key: 'stage',
      header: t('orders.column.stage'),
      width: rem(110),
      render: (order) => <StatusPill tone={stageTone(order, stages)}>{order.stageName}</StatusPill>,
    },
    {
      key: 'sync',
      header: t('orders.column.sync'),
      width: rem(90),
      render: (order) => (
        <span
          className="ob-micro"
          style={{ color: order.sync.hlc ? 'var(--fg-tertiary)' : 'var(--state-offline)' }}
        >
          {order.sync.hlc ? t('orders.sync.synced') : t('orders.sync.pending')}
        </span>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={filteredOrders}
        rowKey={(order) => order.id}
        onRowOpen={(order) => onOpenId(order.id)}
        empty={
          orders.length === 0 ? (
            <EmptyState
              title={t('orders.empty.title')}
              description={t('orders.empty.description')}
            />
          ) : (
            <EmptyState title={t('orders.empty.filteredTitle')} />
          )
        }
      />
    </>
  );
}

function OrderDetailBody({
  order,
  stages,
  canDispatch,
  freeToSell,
  onClose,
  onError,
  colourHex,
}: {
  order: Order;
  stages: PipelineStage[];
  canDispatch: boolean;
  /** Off, the reservations that hold this order's stock are not a thing on screen. */
  freeToSell: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  colourHex: (colour: string) => string | undefined;
}) {
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(
    order.totalWeightKgOverride === null ? '' : String(order.totalWeightKgOverride),
  );
  const [busy, setBusy] = useState(false);

  const active = order.reservations.filter((reservation) => reservation.status === 'active');

  async function run(action: () => Promise<unknown>, failure: string): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Card>
        <Section title={t('orders.detail.products')}>
          <div className="ob-tablewrap">
            <table className="ob-table">
              <thead>
                <tr>
                  <th>{t('orders.column.code')}</th>
                  <th>{t('orders.column.product')}</th>
                  <th>{t('orders.column.variant')}</th>
                  <th>{t('orders.column.colour')}</th>
                  <th>{t('orders.column.packaging')}</th>
                  <th>{t('orders.column.grade')}</th>
                  <th className="num">{t('orders.column.qty')}</th>
                  <th className="num">{t('orders.column.lineWeight')}</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td className="ob-mono">{item.code ?? '—'}</td>
                    <td>
                      {item.productName}
                      <div className="ob-small">
                        {[item.categoryName, item.size].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      {item.variantLabel ? (
                        <ColourName name={item.variantLabel} hex={colourHex(item.variantLabel)} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {/* The colour chosen on a multi-colour line — frozen like the rest of the line. */}
                      {item.colour ? <ColourName name={item.colour} hex={colourHex(item.colour)} /> : '—'}
                    </td>
                    <td>{item.packaging ?? '—'}</td>
                    <td>{item.grade ?? '—'}</td>
                    <td className="num">{item.quantity.toLocaleString('en-IN')}</td>
                    <td className="num">
                      {/* The weight frozen on the line when it was raised — a later
                          edit to the variant's weight does not move it. */}
                      {item.lineWeightKg === null ? (
                        <StatusPill tone="offline">{t('product.weight.missing')}</StatusPill>
                      ) : (
                        formatKg(item.lineWeightKg)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </Card>

      {freeToSell && (
      <Card>
        <Section title={t('orders.detail.reservations')}>
          {order.reservations.length === 0 ? (
            <p className="ob-small">{t('orders.detail.noReservations')}</p>
          ) : (
            <div className="ob-tablewrap">
              <table className="ob-table">
                <thead>
                  <tr>
                    <th>{t('orders.column.code')}</th>
                    <th>{t('orders.column.product')}</th>
                    <th>{t('orders.column.variant')}</th>
                    <th className="num">{t('orders.column.qty')}</th>
                    <th>{t('orders.column.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {order.reservations.map((reservation) => (
                    <tr key={reservation.id}>
                      <td className="ob-mono">{reservation.variantCode}</td>
                      <td>{reservation.productName}</td>
                      <td>
                        {reservation.variantLabel ? (
                          <ColourName
                            name={reservation.variantLabel}
                            hex={colourHex(reservation.variantLabel)}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num">{reservation.quantity.toLocaleString('en-IN')}</td>
                      <td>
                        <StatusPill tone={RESERVATION_TONE[reservation.status]}>
                          {t(`orders.reservation.status.${reservation.status}`)}
                        </StatusPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </Card>
      )}

      <Card>
        <Section title={t('orders.detail.weight')}>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('orders.detail.weightComputed', {
              value: order.totalWeightKg.toLocaleString('en-IN'),
            })}
          </p>
          {order.linesWithoutWeight > 0 && (
            <p className="ob-small" style={{ marginTop: 0 }}>
              <StatusPill tone="offline">
                {t(
                  order.linesWithoutWeight === 1
                    ? 'orders.detail.linesWithoutWeightOne'
                    : 'orders.detail.linesWithoutWeight',
                  { count: order.linesWithoutWeight },
                )}
              </StatusPill>
            </p>
          )}

          <FormField label={t('orders.detail.weightOverrideLabel')}>
            {(id) => (
              <NumberInput
                id={id}
                value={override}
                onChange={(event) => setOverride(event.target.value.replace(/[^0-9.]/g, ''))}
                placeholder={t('orders.detail.weightOverridePlaceholder')}
                onBlur={() =>
                  void run(
                    () =>
                      api.updateOrder(order.id, {
                        totalWeightKgOverride: override === '' ? null : Number(override),
                      }),
                    'Could not save the weight',
                  )
                }
              />
            )}
          </FormField>

          <p className="ob-small" style={{ marginBottom: 0 }}>
            {t('orders.detail.weightShowing', { source: order.weightSource })}
          </p>
        </Section>
      </Card>

      <Card>
        <Section title={t('orders.detail.stage')}>
          <FormField label={t('orders.detail.stageLabel')}>
            {(id) => (
              <Select
                id={id}
                value={order.stageId}
                disabled={busy || Boolean(order.dispatchedAt)}
                onChange={(event) =>
                  void run(
                    () => api.setOrderStage(order.id, event.target.value),
                    'Could not move the order',
                  )
                }
              >
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </Section>
      </Card>

      <Card>
        <Section title={t('orders.detail.history')}>
          <Timeline
            entries={order.timeline.map((entry) => ({
              id: entry.id,
              label: entry.message,
              when: formatDateTime(entry.createdAt),
            }))}
          />
        </Section>
      </Card>

      {order.dispatchedAt ? (
        <Card style={{ background: 'var(--state-ok-tint)' }}>
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-primary)' }}>
            {t('orders.detail.dispatchedBanner', { when: formatDateTime(order.dispatchedAt) })}
          </p>
        </Card>
      ) : (
        <Card>
          <Section title={t('orders.detail.dispatch')}>
            <p className="ob-small" style={{ marginTop: 0 }}>
              {t('orders.detail.dispatchNote', { count: active.length })}
            </p>

            <FormField label={t('orders.detail.dispatchNoteLabel')}>
              {(id) => (
                <Input
                  id={id}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t('orders.detail.dispatchNotePlaceholder')}
                />
              )}
            </FormField>

            <Button
              variant="primary"
              busy={busy}
              disabled={busy || !canDispatch}
              onClick={() =>
                void run(async () => {
                  await api.dispatchOrder(order.id, note.trim() || null);
                  onClose();
                }, 'Could not dispatch the order')
              }
            >
              {t('orders.detail.dispatchButton')}
            </Button>

            {!canDispatch && (
              <p className="ob-small" style={{ marginBottom: 0, marginTop: 'var(--s-8)' }}>
                {t('orders.detail.noDispatchPermission', { permission: DISPATCH_PERMISSION })}
              </p>
            )}
          </Section>
        </Card>
      )}
    </div>
  );
}
