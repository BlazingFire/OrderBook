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
 * this screen.
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
  Modal,
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
  formatMoney,
  rem,
  t,
  useColourHex,
  useFilterBar,
  type PillTone,
} from '@orderbook/ui';
import type { DataTableColumn } from '@orderbook/ui';

interface Props {
  view: LocalView;
  canDispatch: boolean;
  onError: (message: string) => void;
}

const SALE_RATE_PERMISSION = 'field.saleRate.view';
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

function totalBoxes(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.totalQuantity, 0);
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

export function OrderBoardScreen({ view, canDispatch, onError }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const colourHex = useColourHex(view.optionLists);

  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'order');
  const stages = sortedStages(pipeline);
  const orders = onMyParties(view.orders, scope === 'assigned' ? view.partyGrants : undefined);
  const openOrder = orders.find((order) => order.id === openId) ?? null;

  useFilterBar(
    pipeline ? (
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

  function closeDetail(): void {
    setOpenId(null);
    setExpanded(false);
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
      header: t('orders.column.boxes'),
      priority: 2,
      width: rem(80),
      align: 'right',
      render: (order) => totalBoxes(order).toLocaleString('en-IN'),
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
      key: 'amount',
      header: t('orders.column.amount'),
      width: rem(110),
      align: 'right',
      render: (order) => formatMoney(order.totalAmount ?? null),
      redactedReason: (order) =>
        order.totalAmount === undefined ? SALE_RATE_PERMISSION : undefined,
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
        onRowOpen={(order) => setOpenId(order.id)}
        openOn="click"
        selectedId={openOrder?.id}
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

      <Modal
        open={Boolean(openOrder)}
        onClose={closeDetail}
        size="lg"
        expanded={expanded}
        onToggleExpand={() => setExpanded((value) => !value)}
        label={openOrder?.partyName}
        title={
          openOrder ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-8)' }}>
              {openOrder.partyName}
              {openOrder.dispatchedAt && (
                <StatusPill tone="ok">{t('orders.badge.dispatched')}</StatusPill>
              )}
            </span>
          ) : (
            ''
          )
        }
        subtitle={
          openOrder
            ? openOrder.leadId
              ? t('orders.detail.subtitleWithLead', { id: openOrder.id, leadId: openOrder.leadId })
              : t('orders.detail.subtitleNoLead', { id: openOrder.id })
            : undefined
        }
      >
        {openOrder && (
          <OrderDetailBody
            order={openOrder}
            stages={stages}
            canDispatch={canDispatch}
            onClose={closeDetail}
            onError={onError}
            colourHex={colourHex}
          />
        )}
      </Modal>
    </>
  );
}

function OrderDetailBody({
  order,
  stages,
  canDispatch,
  onClose,
  onError,
  colourHex,
}: {
  order: Order;
  stages: PipelineStage[];
  canDispatch: boolean;
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
                  <th>{t('orders.column.product')}</th>
                  <th>{t('orders.column.packaging')}</th>
                  <th>{t('orders.column.colours')}</th>
                  <th className="num">{t('orders.column.boxes')}</th>
                  <th className="num">{t('orders.detail.lineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.productName}
                      <div className="ob-small">{item.code}</div>
                    </td>
                    <td>{item.packaging ?? '—'}</td>
                    <td>
                      {item.quantities.map((quantity) => (
                        <div key={quantity.id} className="ob-small">
                          {quantity.colour} × {quantity.quantity}
                        </div>
                      ))}
                    </td>
                    <td className="num">{item.totalQuantity.toLocaleString('en-IN')}</td>
                    <td className="num">
                      {item.lineTotal === undefined ? (
                        <span
                          className="ob-redacted"
                          title={`Missing permission: ${SALE_RATE_PERMISSION}`}
                          aria-label="Hidden"
                        />
                      ) : (
                        formatMoney(item.lineTotal)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </Card>

      <Card>
        <Section title={t('orders.detail.reservations')}>
          {order.reservations.length === 0 ? (
            <p className="ob-small">{t('orders.detail.noReservations')}</p>
          ) : (
            <div className="ob-tablewrap">
              <table className="ob-table">
                <thead>
                  <tr>
                    <th>{t('orders.column.product')}</th>
                    <th>{t('orders.column.colour')}</th>
                    <th className="num">{t('orders.column.boxes')}</th>
                    <th>{t('orders.column.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {order.reservations.map((reservation) => (
                    <tr key={reservation.id}>
                      <td>{reservation.productName}</td>
                      <td>
                        <ColourName name={reservation.colour} hex={colourHex(reservation.colour)} />
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

      <Card>
        <Section title={t('orders.detail.weight')}>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('orders.detail.weightComputed', {
              value: order.totalWeightKg.toLocaleString('en-IN'),
            })}
          </p>

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
