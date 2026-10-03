/**
 * The order pipeline — a separate workflow from the lead's
 * (docs/LEAD_GENERATION_FLOW.md §5.1, §6).
 *
 * Dispatch is the one action that closes an order out: it stamps the order and
 * moves it to Dispatched. No stock is touched, because OrderBook keeps none.
 *
 * Rendered as a table, not a board (6-UI-DESIGN.md, Orders.dc.html): dispatch
 * and stage tracking reads better as a sortable list than a kanban column for
 * this screen. Opening an order replaces the table with its detail — a
 * sub-screen with one way back in a fixed place, and its own entry nested
 * under Orders in the sidebar while it is open. The table is not unmounted
 * while that shows, so its filters and scroll position survive the round trip.
 */

import { useEffect, useRef, useState } from 'react';
import { matchesRecordSearch, shownColour } from '@orderbook/shared';
import type {
  ChatRecordChip,
  NoteKind,
  Order,
  PartyScopeFilter,
  PipelineStage,
  SyncSnapshot,
} from '@orderbook/shared';

import { api, desktopBridge, type LocalView } from '../api';
import { presenceChannel } from '../presence';
import {
  AvatarStack,
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
  OrderNoteScreen,
  RecordNumber,
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
  useRecordPresence,
  useSubNav,
  useToast,
  type PillTone,
  type PrintroomTransport,
} from '@orderbook/ui';
import type { DataTableColumn } from '@orderbook/ui';

interface Props {
  view: LocalView;
  /** The order showing as a sub-screen, held by the shell so the Dashboard can open one. */
  openId: string | null;
  onOpenId: (id: string | null) => void;
  canDispatch: boolean;
  /** `orders.export`: may open the Filling and Dispatch notes. */
  canExport: boolean;
  /** `orders.edit`: may set the vehicle number on the Dispatch note. */
  canEdit: boolean;
  onError: (message: string) => void;
  /** The signed-in person, left out of who else is on the open order. */
  userId?: string | null;
  /** The stage showing, or null for all — chosen here or from the sidebar's sub-pages. */
  stageId: string | null;
  onStageChange: (stageId: string | null) => void;
  /** Present only for somebody who may share records in chat (`chat.use` and `chat.shareRecords`). */
  onShareInChat?: (chip: ChatRecordChip) => void;
  /** Present only for somebody who may send to the Printroom (`print.send`): the note screen offers it. */
  printroom?: PrintroomTransport;
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
  canExport,
  canEdit,
  onError,
  stageId: stageFilter,
  onStageChange: setStageFilter,
  onShareInChat,
  printroom,
  userId,
}: Props) {
  const toast = useToast();
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const [search, setSearch] = useState('');
  const colourHex = useColourHex(view.optionLists);
  const pipeline = view.pipelines.find((candidate) => candidate.kind === 'order');
  const stages = sortedStages(pipeline);
  const orders = onMyParties(view.orders, scope === 'assigned' ? view.partyGrants : undefined);
  const inView = view.orders.find((order) => order.id === openId) ?? null;
  // An order this panel's view does not hold (a chat chip, a bell entry) is asked of the Master.
  const [fetched, setFetched] = useState<Order | null>(null);
  const onOpenIdRef = useRef(onOpenId);
  onOpenIdRef.current = onOpenId;
  const inViewNow = inView !== null;
  useEffect(() => {
    if (!openId || inViewNow) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    void api.order(openId).then(
      (order) => {
        if (!cancelled) setFetched(order);
      },
      () => {
        if (cancelled) return;
        toast.push(t('nav.recordNotAvailable'), { tone: 'info' });
        onOpenIdRef.current(null);
      },
    );
    return () => {
      cancelled = true;
    };
    // `toast` is a stable context value; the open id and whether the view holds it decide this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, inViewNow]);
  const openOrder = inView ?? (fetched && fetched.id === openId ? fetched : null);
  /** The note showing over the open order — for that order only, so opening another starts at its detail. */
  const [note, setNote] = useState<{ id: string; kind: NoteKind } | null>(null);
  const noteKind = note && note.id === openOrder?.id ? note.kind : null;
  /**
   * Vehicle numbers this panel has sent, by order. A write here is queued and
   * the order in the snapshot does not change until the Master sends it back —
   * never, while offline — so reopening the note would print the old number.
   */
  const [sentVehicles, setSentVehicles] = useState<Record<string, string | null>>({});
  const noteOrder =
    openOrder && noteKind && openOrder.id in sentVehicles
      ? { ...openOrder, vehicleNumber: sentVehicles[openOrder.id] }
      : openOrder;

  useFilterBar(
    pipeline && !openOrder ? (
      <>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('orders.search.placeholder')}
          aria-label={t('orders.search.label')}
          data-screen-search
          style={{ width: rem(320) }}
        />
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
          items: [
            {
              id: noteKind ? 'orders.note' : 'orders.detail',
              label: openOrder.partyName,
              icon: 'orders',
            },
          ],
          activeId: noteKind ? 'orders.note' : 'orders.detail',
        }
      : null,
  );

  // Who else has the open order up (a provisional one is never announced).
  const presence = useRecordPresence(
    presenceChannel,
    openOrder ? { recordKind: 'order', recordId: openOrder.id } : null,
  );

  if (openOrder && noteOrder && noteKind) {
    return (
      <OrderNoteScreen
        key={openOrder.id}
        record={noteOrder}
        source="order"
        party={view.parties.find((candidate) => candidate.id === openOrder.partyId) ?? null}
        initialKind={noteKind}
        canEditVehicle={canEdit && !openOrder.dispatchedAt}
        onSaveVehicle={async (vehicleNumber) => {
          await api.updateOrder(openOrder.id, { vehicleNumber });
          setSentVehicles((current) => ({ ...current, [openOrder.id]: vehicleNumber }));
        }}
        onBack={() => setNote(null)}
        desktop={desktopBridge() ?? undefined}
        printroom={printroom}
      />
    );
  }

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
                    leadId: openOrder.poNumber ?? openOrder.leadId,
                  })
                : t('orders.detail.subtitleNoLead', { id: openOrder.id })}
            </span>
          </>
        }
        actions={
          <>
            <AvatarStack entries={presence.entries} selfUserId={userId} />
            {onShareInChat && (
              <Button icon="chat" onClick={() => onShareInChat({ kind: 'order', id: openOrder.id })}>
                {t('chat.share.button')}
              </Button>
            )}
            {canExport && (
              <>
                <Button onClick={() => setNote({ id: openOrder.id, kind: 'filling' })}>{t('orderNote.filling')}</Button>
                <Button onClick={() => setNote({ id: openOrder.id, kind: 'dispatch' })}>{t('orderNote.dispatch')}</Button>
              </>
            )}
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

  const filteredOrders = (
    stageFilter ? orders.filter((order) => order.stageId === stageFilter) : orders
  ).filter((order) => matchesRecordSearch(order, search));

  const columns: DataTableColumn<Order>[] = [
    {
      key: 'id',
      header: t('orders.column.order'),
      width: rem(190),
      // The pending order's PO number: a final order has none of its own.
      render: (order) => <RecordNumber record={order} />,
    },
    {
      key: 'party',
      header: t('orders.column.party'),
      render: (order) => order.partyName,
    },
    {
      key: 'ref',
      header: t('order.list.col.ref'),
      priority: 3,
      width: rem(130),
      // Only beside a PO number; without one the id is already the first column.
      render: (order) =>
        order.poNumber ? (
          <span className="ob-mono ob-small" style={{ color: 'var(--fg-tertiary)' }}>
            {order.id}
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
  /*
   * The override as this screen last sent it — or as the order held it when
   * the screen opened, before anything was sent. Leaving the field is what
   * saves it, and a blur writes only when the field no longer says this.
   *
   * Every blur used to queue a write whether anything had changed or not: a
   * Tab through the form was an order update, and one that could put back a
   * figure another panel had changed since this one opened the order.
   *
   * Not `order.totalWeightKgOverride`. On this panel a write is queued, and
   * the order on screen does not move until the Master sends the change back
   * — never, while the panel is offline. Compared with the order, 150 → 175 →
   * 150 dropped the second write as "unchanged" and left 175 queued under a
   * field saying 150. A ref, not state, and set as a send starts, so an edit
   * typed while that send is on its way is compared with what it sent.
   */
  const sentOverride = useRef(order.totalWeightKgOverride);
  /** The typed override as the order would hold it; NaN when the text is not a number. */
  const overrideValue = override === '' ? null : Number(override);
  const overrideInvalid = overrideValue !== null && Number.isNaN(overrideValue);
  const [busy, setBusy] = useState(false);


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

  function saveOverride(): void {
    // "1.2.3" survives the character filter and is no number. Sent, it would
    // arrive as `null` (JSON has no NaN) and quietly clear the override; the
    // field says it is wrong instead and nothing is written.
    if (overrideInvalid || overrideValue === sentOverride.current) return;
    const before = sentOverride.current;
    const value = overrideValue;
    sentOverride.current = value;
    void run(async () => {
      try {
        await api.updateOrder(order.id, { totalWeightKgOverride: value });
      } catch (caught) {
        // Not queued, so the next blur tries again — unless a later send has
        // already taken its place.
        if (sentOverride.current === value) sentOverride.current = before;
        throw caught;
      }
    }, t('orders.error.saveWeight'));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <Card>
        <Section title={t('orders.detail.products')}>
          <div className="ob-tablewrap">
            <table className="ob-table ob-table--flat">
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
                      {/* Not when it only repeats the name (CATALOGUE_MODEL §2). */}
                      {item.variantLabel && shownColour(item.variantLabel, item.productName) ? (
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

          <FormField
            label={t('orders.detail.weightOverrideLabel')}
            // In words as well as the red edge: nothing is saved while it
            // shows, and closing the order drops what was typed.
            error={overrideInvalid ? t('orders.detail.weightOverrideInvalid') : undefined}
          >
            {(id) => (
              <NumberInput
                id={id}
                value={override}
                invalid={overrideInvalid}
                onChange={(event) => setOverride(event.target.value.replace(/[^0-9.]/g, ''))}
                placeholder={t('orders.detail.weightOverridePlaceholder')}
                onBlur={saveOverride}
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
                    t('orders.error.move'),
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
              {t('orders.detail.dispatchNote')}
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
                }, t('orders.error.dispatch'))
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
