/**
 * Final Orders on the Master: the owner's list of every order, and each one in
 * full.
 *
 * Mirrors the Office Panel's order screen (`office/web/src/screens/
 * OrderBoardScreen.tsx`) over this panel's HTTP client. The list searches on the
 * server and pages 500 at a time; its stage chips filter the rows loaded, and
 * follow the sidebar's stage pages, so the count on a chip is never a total it
 * does not hold. Opening a row replaces the list with the order as a
 * sub-screen, and every action (stage, weight, dispatch, notes, delete) lives
 * there, not in a row.
 *
 * **Delete** is `orders.delete`: a soft delete into the Recycle Bin, refused
 * with a 409 `blockedBy` when a dispatch still hangs on the order,
 * which is shown as the reason rather than as a generic failure.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  ChatRecordChip,
  NoteKind,
  OptionListItem,
  Order,
  Party,
  PartyScopeFilter,
  PipelineStage,
} from '@orderbook/shared';

import { ApiError, api, desktopBridge } from '../api';
import { presenceChannel } from '../presence';
import { orderRecordTransport } from '../transports';
import {
  AvatarStack,
  BOARD_SHOWN,
  Button,
  ConfirmDialog,
  ConflictBanner,
  DataTable,
  EditorScreen,
  EmptyState,
  FilterChip,
  FilterDivider,
  IconButton,
  Input,
  LoadMorePager,
  OrderNoteScreen,
  OrderRecordView,
  RecordNumber,
  Segmented,
  SkeletonTable,
  StatusPill,
  recordNumberText,
  rem,
  t,
  useDebounced,
  useFilterBar,
  useBoardPresence,
  useRecordPresence,
  useSubNav,
  type DataTableColumn,
  type PillTone,
  type PrintroomTransport,
  useToast,
  NoteButtons,
} from '@orderbook/ui';

const PAGE_SIZE = 500;

interface Props {
  /** Bumped by the live socket whenever lead, order or party data changes. */
  revision: number;
  /** The order pipeline's stages, in order — read once by the shell. */
  stages: PipelineStage[];
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  /** The stage showing, or null for all — chosen here or from the sidebar's stage pages. */
  stageId: string | null;
  onStageChange: (stageId: string | null) => void;
  /** The order showing as a sub-screen, held by the shell so a search hit can open one. */
  openId: string | null;
  onOpenId: (id: string | null) => void;
  /** Takes the person to the pending order a final order came from. */
  onOpenLead: (leadId: string) => void;
  /** Present only for somebody who may share records in chat (`chat.use` and `chat.shareRecords`). */
  onShareInChat?: (chip: ChatRecordChip) => void;
  /** Present only for somebody who may send to the Printroom (`print.send`): the note screen offers it. */
  printroom?: PrintroomTransport;
  /** The signed-in person, left out of who else is on the open record. */
  userId: string;
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

export function OrdersScreen({
  revision,
  stages,
  permissions,
  stageId: stageFilter,
  onStageChange,
  openId,
  onOpenId,
  onOpenLead,
  onShareInChat,
  printroom,
  userId,
}: Props) {
  const toast = useToast();
  // The shell hands a fresh callback every render; the fetch below must not.
  const onOpenIdRef = useRef(onOpenId);
  onOpenIdRef.current = onOpenId;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [scope, setScope] = useState<PartyScopeFilter>('all');
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim());
  const [rows, setRows] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  /** What `rows` was loaded for, so a new search shows a skeleton and a refetch does not. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionLists, setOptionLists] = useState<OptionListItem[]>([]);
  /** The open order when it is not in `rows` — a search hit, or one past the loaded page. */
  const [fetched, setFetched] = useState<Order | null>(null);
  const [party, setParty] = useState<Party | null>(null);
  const [note, setNote] = useState<{ id: string; kind: NoteKind } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const canEdit = permissions.includes('orders.edit');
  const canDispatch = permissions.includes('orders.dispatch');
  const canDelete = permissions.includes('orders.delete');
  const canViewParties = permissions.includes('parties.view');

  const loadKey = `${scope}|${term}`;

  useEffect(() => {
    let cancelled = false;
    void api
      .orders({ limit: PAGE_SIZE, scope, search: term || undefined })
      .then((page) => {
        if (cancelled) return;
        setRows(page.items);
        setTotal(page.total);
        setLoadedFor(loadKey);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : t('leadsOrders.error.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [scope, term, revision, loadKey]);

  async function loadMore(): Promise<void> {
    setLoadingMore(true);
    try {
      const page = await api.orders({
        limit: PAGE_SIZE,
        offset: rows.length,
        scope,
        search: term || undefined,
      });
      setRows((current) => {
        const seen = new Set(current.map((order) => order.id));
        return [...current, ...page.items.filter((order) => !seen.has(order.id))];
      });
      setTotal(page.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('leadsOrders.error.load'));
    } finally {
      setLoadingMore(false);
    }
  }

  // Colour chips on the lines resolve through the option lists.
  useEffect(() => {
    if (!openId) return;
    void api
      .optionLists()
      .then(setOptionLists)
      .catch(() => undefined);
  }, [openId, revision]);

  const fromRows = openId ? (rows.find((order) => order.id === openId) ?? null) : null;
  const inRows = fromRows !== null;

  // The deep-link fallback: a record the loaded page does not hold.
  useEffect(() => {
    if (!openId || inRows) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    void api
      .order(openId)
      .then((order) => {
        if (!cancelled) setFetched(order);
      })
      .catch((caught) => {
        // Gone, or not this person's to see: back to the list, and say so.
        if (!cancelled && caught instanceof ApiError && (caught.code === 'not_found' || caught.code === 'forbidden')) {
          toastRef.current.push(t('nav.recordNotAvailable'), { tone: 'info' });
          onOpenIdRef.current(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [openId, inRows, revision]);

  const openOrder = fromRows ?? (fetched && fetched.id === openId ? fetched : null);

  /** A saved order replaces its copy, so the screen shows what the server now holds. */
  function patchOrder(saved: Order): void {
    setRows((current) => current.map((order) => (order.id === saved.id ? saved : order)));
    setFetched((current) => (current?.id === saved.id ? saved : current));
  }

  // The note's header: city, phone and GSTIN. Without `parties.view` the note
  // still prints, with the party's name from the order and no meta line.
  const openPartyId = openOrder?.partyId ?? null;
  useEffect(() => {
    setParty(null);
    if (!openPartyId || !canViewParties) return;
    let cancelled = false;
    void api
      .party(openPartyId)
      .then((loaded) => {
        if (!cancelled) setParty(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openPartyId, canViewParties]);

  // An error or note shown for one record is not the next one's.
  useEffect(() => {
    setError(null);
    // A note opened from the list's row action arrives with its record; keep it.
    setNote((current) => (current && current.id === openId ? current : null));
  }, [openId]);

  const noteKind = note && note.id === openOrder?.id ? note.kind : null;
  const shown = stageFilter ? rows.filter((order) => order.stageId === stageFilter) : rows;

  useFilterBar(
    openOrder ? null : (
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
          count={rows.length}
          onClick={() => onStageChange(null)}
        >
          {t('orders.filter.allStages')}
        </FilterChip>
        {stages.map((stage) => (
          <FilterChip
            key={stage.id}
            active={stageFilter === stage.id}
            count={rows.filter((order) => order.stageId === stage.id).length}
            onClick={() => onStageChange(stage.id)}
          >
            {stage.name}
          </FilterChip>
        ))}
        <FilterDivider />
        <span style={{ flex: 1 }} />
        <span className="ob-small">{t('orders.filter.note')}</span>
      </>
    ),
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

  // Who else has the open order up. The order's own form edits only its weight
  // and vehicle in place, so this screen beats as viewing.
  const presence = useRecordPresence(
    presenceChannel,
    openOrder ? { recordKind: 'order', recordId: openOrder.id } : null,
  );

  // Who has each card or row open (R22), for the faces on it.
  const faces = useBoardPresence(presenceChannel, 'order');

  /**
   * A refused delete is usually not a failure to report as one. The server
   * answers 409 with `blockedBy` naming what still points at the record —
   * a dispatch — and the operator needs that, not "could not
   * delete".
   */
  function deleteFailureMessage(caught: unknown): string {
    if (caught instanceof ApiError && caught.isConflict) {
      const labels = caught.blockedBy
        .map((blocker) => (blocker as { label?: string }).label)
        .filter((label): label is string => Boolean(label));
      return labels.length > 0
        ? t('leadsOrders.delete.blocked', { items: labels.slice(0, 3).join(', ') })
        : t('error.conflict.blockedByLiveReferences');
    }
    return caught instanceof Error ? caught.message : t('leadsOrders.delete.failed');
  }

  async function confirmDelete(): Promise<void> {
    if (!openOrder) return;
    setDeleting(true);
    try {
      await api.deleteOrder(openOrder.id);
      setConfirmingDelete(false);
      setRows((current) => current.filter((order) => order.id !== openOrder.id));
      onOpenId(null);
    } catch (caught) {
      setError(deleteFailureMessage(caught));
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const columns: DataTableColumn<Order>[] = [
    {
      key: 'id',
      header: t('orders.column.order'),
      width: rem(190),
      // The pending order's PO number: a final order has none of its own.
      render: (order) => <RecordNumber record={order} />,
    },
    {
      key: 'viewing',
      header: t('presence.board.column'),
      width: rem(76),
      render: (order) => (
        <AvatarStack
          entries={faces.get(order.id) ?? []}
          selfUserId={userId}
          max={BOARD_SHOWN}
          size="xs"
        />
      ),
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
          <span className="ob-mono ob-small">{order.id}</span>
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
      width: rem(110),
      align: 'right',
      // A manually entered weight is marked: it is the one number here nobody derived.
      render: (order) => (
        <span
          title={order.weightSource === 'manual' ? t('leadsOrders.orders.weightManual') : undefined}
          style={{
            color: order.weightSource === 'manual' ? 'var(--fg-secondary)' : 'var(--fg-primary)',
          }}
        >
          {displayWeightKg(order).toLocaleString('en-IN')} {t('leadsOrders.unit.kg')}
          {order.weightSource === 'manual' ? '*' : ''}
        </span>
      ),
    },
    {
      key: 'stage',
      header: t('orders.column.stage'),
      width: rem(130),
      render: (order) => <StatusPill tone={stageTone(order, stages)}>{order.stageName}</StatusPill>,
    },
    {
      key: 'notes',
      header: t('orderNote.column.notes'),
      priority: 2,
      width: rem(220),
      render: (order) => (
        <NoteButtons
          onNote={(kind) => {
            setNote({ id: order.id, kind });
            onOpenId(order.id);
          }}
        />
      ),
    },
  ];

  if (openOrder && noteKind) {
    return (
      <OrderNoteScreen
        // A new mount per note, so the vehicle field starts from that order's.
        key={openOrder.id}
        record={openOrder}
        source="order"
        party={party}
        initialKind={noteKind}
        canEditVehicle={canEdit && !openOrder.dispatchedAt}
        onSaveVehicle={async (vehicleNumber) => {
          patchOrder(await api.updateOrder(openOrder.id, { vehicleNumber }));
        }}
        onBack={() => setNote(null)}
        desktop={desktopBridge() ?? undefined}
        printroom={printroom}
      />
    );
  }

  if (openOrder) {
    return (
      <>
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
              {openOrder.leadId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenLead(openOrder.leadId as string)}
                >
                  {t('orders.column.fromLead')}
                </Button>
              )}
              {onShareInChat && (
                <Button icon="chat" onClick={() => onShareInChat({ kind: 'order', id: openOrder.id })}>
                  {t('chat.share.button')}
                </Button>
              )}
              {/* Viewing the order is the right to print its note (1.4 R10). */}
              <Button onClick={() => setNote({ id: openOrder.id, kind: 'filling' })}>
                {t('orderNote.filling')}
              </Button>
              <Button onClick={() => setNote({ id: openOrder.id, kind: 'dispatch' })}>
                {t('orderNote.dispatch')}
              </Button>
              {/* Absent, not greyed, without the permission — the house rule. */}
              {canDelete && (
                <IconButton
                  icon="trash"
                  label={t('leadsOrders.delete.order')}
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(true)}
                />
              )}
            </>
          }
          onBack={() => {
            onOpenId(null);
            return true;
          }}
          backLabel={t('action.backToList')}
        >
          {error && <ConflictBanner>{error}</ConflictBanner>}
          <OrderRecordView
            // A new mount per order, so a half-typed weight is never the next one's.
            key={openOrder.id}
            order={openOrder}
            stages={stages}
            optionLists={optionLists}
            canEdit={canEdit}
            canDispatch={canDispatch}
            transport={orderRecordTransport}
            onDispatched={patchOrder}
            onError={setError}
          />
        </EditorScreen>
        <ConfirmDialog
          open={confirmingDelete}
          tone="danger"
          busy={deleting}
          title={t('leadsOrders.delete.order.title', { id: recordNumberText(openOrder) })}
          body={t('leadsOrders.delete.body')}
          confirmLabel={t('common.delete')}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void confirmDelete()}
        />
      </>
    );
  }

  const filtering = term !== '' || stageFilter !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      {error && <ConflictBanner>{error}</ConflictBanner>}

      {loadedFor !== loadKey ? (
        <SkeletonTable columns={columns} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={shown}
            rowKey={(order) => order.id}
            onRowOpen={(order) => onOpenId(order.id)}
            empty={
              filtering ? (
                <EmptyState title={t('common.noMatches')} />
              ) : (
                <EmptyState
                  title={t('leadsOrders.orders.empty.title')}
                  description={t('leadsOrders.orders.empty.description')}
                />
              )
            }
          />
          <LoadMorePager
            hasMore={rows.length < total}
            loading={loadingMore}
            onLoadMore={() => void loadMore()}
          />
        </>
      )}
    </div>
  );
}
