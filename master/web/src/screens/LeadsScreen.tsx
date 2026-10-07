/**
 * Pending Orders (leads) on the Master: the owner's list of every one, and each
 * one in full.
 *
 * Mirrors the Office Panel's lead screen (`office/web/src/screens/
 * LeadBoardScreen.tsx`) over this panel's HTTP client. The list searches on the
 * server and pages 500 at a time; its stage chips count the rows loaded, which
 * is why they never claim a total they do not hold. Opening a row replaces the
 * list with the record as a sub-screen — a back button in a fixed place and its
 * own entry nested under Pending Orders in the sidebar — and every action
 * (stage, note, convert, delete, PDF) lives there, not in a row.
 *
 * **Delete** is `leads.delete`: a soft delete into the Recycle Bin, refused with
 * a 409 `blockedBy` when something live still points at the record, which is
 * shown as the reason rather than as a generic failure.
 */

import { useEffect, useRef, useState } from 'react';
import { shownColour } from '@orderbook/shared';
import type {
  ChatRecordChip,
  Lead,
  StageCounts,
  LineItem,
  NoteKind,
  OptionListItem,
  Party,
  PartyScopeFilter,
  PipelineStage,
} from '@orderbook/shared';

import { ApiError, api, desktopBridge } from '../api';
import { presenceChannel } from '../presence';
import { leadRecordTransport } from '../transports';
import { LeadEntry } from './LeadEntry';
import {
  AvatarStack,
  BOARD_SHOWN,
  Button,
  ButtonLink,
  ConfirmDialog,
  ConflictBanner,
  DataTable,
  EditorScreen,
  EmptyState,
  FilterChip,
  FilterDivider,
  IconButton,
  Input,
  LeadRecordView,
  PageBar,
  pageWindow,
  usePageSize,
  OrderNoteScreen,
  RecordNumber,
  Segmented,
  SkeletonTable,
  StatusPill,
  stageTone,
  formatDateTime,
  formatKg,
  recordNumberText,
  rem,
  t,
  useDebounced,
  useFilterBar,
  useBoardPresence,
  useRecordPresence,
  useSubNav,
  useToast,
  type DataTableColumn,
  type PrintroomTransport,
  NoteButtons,
} from '@orderbook/ui';


interface Props {
  /** Bumped by the live socket whenever lead, order or party data changes. */
  revision: number;
  /** The lead pipeline's stages, in order — read once by the shell. */
  stages: PipelineStage[];
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  /** `leads.packagingRequiredOnConvert`, already coalesced by the shell. */
  packagingRequired: boolean;
  /** Which list is showing — chosen from the sidebar's sub-pages. */
  view: 'list' | 'converted';
  /** The lead showing as a sub-screen, held by the shell so a search hit can open one. */
  openId: string | null;
  onOpenId: (id: string | null) => void;
  /** Takes the person to the final order a lead became. */
  onOpenOrder: (orderId: string) => void;
  /** Present only for somebody who may share records in chat (`chat.use` and `chat.shareRecords`). */
  onShareInChat?: (chip: ChatRecordChip) => void;
  /** Present only for somebody who may send to the Printroom (`print.send`): the note screen offers it. */
  printroom?: PrintroomTransport;
  /** `leads.create`: the empty state offers New pending order. */
  canCreate: boolean;
  onNewLead: () => void;
  /** `parties.create`, for the edit form's party list. */
  canCreateParty: boolean;
  /** Moves when what the edit form's view is built from changes. */
  leadEntryRevision: number;
  /** The signed-in person, left out of who else is on the open record. */
  userId: string;
}

/**
 * A table row is one line tall and clips what overflows, so a record's lines
 * are summarised onto that line with the full list on hover.
 *
 * The cell sits in a `1fr` grid track, so the summary has a zero flex basis: a
 * `nowrap` run of text that keeps its intrinsic width widens the track, and
 * since each row is its own grid, that row's later columns would then stand out
 * of line with every other row's.
 */
function summariseItems(items: LineItem[]): { text: string; title: string } {
  const lines = items.map((item) => {
    const main = item.categoryName ? `${item.categoryName} › ` : '';
    // The colour chosen on a multi-colour line rides beside the variant's own;
    // the variant's is dropped when it only repeats the name (CATALOGUE_MODEL §2).
    const variant = [shownColour(item.variantLabel, item.productName), item.colour]
      .filter(Boolean)
      .join(' · ');
    const variantText = variant ? ` [${variant}]` : '';
    const meta = [item.packaging, item.grade].filter(Boolean).join(' · ');
    const pack = meta ? ` · ${meta}` : '';
    const short = `${main}${item.productName}${variantText} ×${item.quantity}${pack}`;
    const full = [main + item.productName + variantText, item.code, item.packaging, item.grade]
      .filter(Boolean)
      .join(' · ');
    return { short, full };
  });
  return {
    text: lines.map((line) => line.short).join(', '),
    title: lines.map((line) => line.full).join('\n'),
  };
}

function leadPieces(lead: Lead): number {
  return lead.items.reduce((sum, item) => sum + item.quantity, 0);
}

export function LeadsScreen({
  revision,
  stages,
  permissions,
  packagingRequired,
  view,
  openId,
  onOpenId,
  onOpenOrder,
  onShareInChat,
  printroom,
  canCreate,
  onNewLead,
  canCreateParty,
  leadEntryRevision,
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
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [rows, setRows] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  /** What `rows` was loaded for, so a new view or search shows a skeleton and a refetch does not. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [pageSize, setPageSize] = usePageSize('leads');
  /** The page the person is on, and the view it belongs to: a new view, search, filter or size starts at the first. */
  const [paging, setPaging] = useState<{ key: string; page: number }>({ key: '', page: 0 });
  const [fetching, setFetching] = useState(false);
  /** Per-stage counts under the search and "my parties", whatever stage chip or page is showing. */
  const [stageCounts, setStageCounts] = useState<StageCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optionLists, setOptionLists] = useState<OptionListItem[]>([]);
  /** The open lead when it is not in `rows` — a search hit, or one past the loaded page. */
  const [fetched, setFetched] = useState<Lead | null>(null);
  const [party, setParty] = useState<Party | null>(null);
  /** The Filling or Dispatch note open over a pending order, when there is one. */
  const [note, setNote] = useState<{ id: string; kind: NoteKind } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** The lead being edited in the form, when it is not the record view. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const canEdit = permissions.includes('leads.edit');
  const canConvert = permissions.includes('lead.convert');
  const canDelete = permissions.includes('leads.delete');
  const canPreviewPdf = permissions.includes('leads.export');
  const canViewParties = permissions.includes('parties.view');

  const loadKey = `${view}|${scope}|${term}|${stageFilter ?? ''}|${pageSize}`;
  const pageNumber = paging.key === loadKey ? paging.page : 0;

  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    void api
      .leads({
        limit: pageSize,
        offset: pageNumber * pageSize,
        scope,
        search: term || undefined,
        // The stage chip narrows on the Master, so it holds across every page and not only this one.
        stageIds: stageFilter ? [stageFilter] : undefined,
        convertedOnly: view === 'converted',
      })
      .then((page) => {
        if (cancelled) return;
        setRows(page.items);
        setTotal(page.total);
        setLoadedFor(loadKey);
        setError(null);
        // Records were removed while this page was open: land on the last page that still exists.
        if (page.items.length === 0 && page.total > 0 && pageNumber > 0) {
          setPaging({ key: loadKey, page: pageWindow(page.total, pageNumber, pageSize).page });
        }
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : t('leadsOrders.error.load'));
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, scope, term, stageFilter, revision, loadKey, pageNumber, pageSize]);

  useEffect(() => {
    let cancelled = false;
    void api
      .leadStageCounts({ scope, search: term || undefined, convertedOnly: view === 'converted' })
      .then((counts) => {
        if (!cancelled) setStageCounts(counts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [view, scope, term, revision]);

  // Colour chips on the lines resolve through the option lists.
  useEffect(() => {
    if (!openId) return;
    void api
      .optionLists()
      .then(setOptionLists)
      .catch(() => undefined);
  }, [openId, revision]);

  const fromRows = openId ? (rows.find((lead) => lead.id === openId) ?? null) : null;
  const inRows = fromRows !== null;

  // The deep-link fallback: a record the loaded page does not hold.
  useEffect(() => {
    if (!openId || inRows) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    void api
      .lead(openId)
      .then((lead) => {
        if (!cancelled) setFetched(lead);
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

  const openLead = fromRows ?? (fetched && fetched.id === openId ? fetched : null);

  // The party card: only with `parties.view`; otherwise the name alone.
  const openPartyId = openLead?.partyId ?? null;
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

  // An error shown for one record is not the next one's, nor is its edit.
  useEffect(() => {
    setError(null);
    setEditingId(null);
    // A note opened from the list's row action arrives with its record; keep it.
    setNote((current) => (current && current.id === openId ? current : null));
  }, [openId]);

  const noteKind = note && note.id === openLead?.id ? note.kind : null;

  const open = view === 'list';
  // The Master already narrowed `rows` to the stage chip, so every page honours it.
  const shown = rows;

  useFilterBar(
    openLead ? null : (
      <>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('leads.search.placeholder')}
          aria-label={t('leads.search.label')}
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
        {open && (
          <>
            <FilterDivider />
            <FilterChip
              active={stageFilter === null}
              count={stageCounts?.total}
              onClick={() => setStageFilter(null)}
            >
              {t('lead.board.filter.all')}
            </FilterChip>
            {stages.map((stage) => (
              <FilterChip
                key={stage.id}
                active={stageFilter === stage.id}
                count={stageCounts ? (stageCounts.counts[stage.id] ?? 0) : undefined}
                onClick={() => setStageFilter(stage.id)}
              >
                {stage.name}
              </FilterChip>
            ))}
            <span style={{ flex: 1 }} />
            <span className="ob-small">{t('lead.board.convertedNote')}</span>
          </>
        )}
      </>
    ),
  );

  useSubNav(
    'leads',
    openLead
      ? {
          parentId: 'leads',
          items: [
            {
              id: noteKind ? 'leads.note' : 'leads.detail',
              label: openLead.partyName,
              icon: 'leads',
            },
          ],
          activeId: noteKind ? 'leads.note' : 'leads.detail',
        }
      : null,
  );

  // Who else has the open lead up, and whether they are editing it.
  const presence = useRecordPresence(
    presenceChannel,
    openLead ? { recordKind: 'lead', recordId: openLead.id } : null,
    openLead !== null && editingId === openLead.id,
  );

  // Who has each card or row open (R22), for the faces on it.
  const faces = useBoardPresence(presenceChannel, 'lead');
  const others = <AvatarStack entries={presence.entries} selfUserId={userId} />;

  /**
   * A refused delete is usually not a failure to report as one. The server
   * answers 409 with `blockedBy` naming what still points at the record, and
   * the operator needs that, not "could not delete".
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
    if (!openLead) return;
    setDeleting(true);
    try {
      await api.deleteLead(openLead.id);
      setConfirmingDelete(false);
      setRows((current) => current.filter((lead) => lead.id !== openLead.id));
      onOpenId(null);
    } catch (caught) {
      setError(deleteFailureMessage(caught));
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const columns: DataTableColumn<Lead>[] = [
    {
      key: 'id',
      header: t('lead.list.col.lead'),
      width: rem(190),
      render: (lead) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)' }}>
          <RecordNumber record={lead} />
          {lead.incomplete && (
            <StatusPill tone="conflict">{t('leadsOrders.leads.incomplete')}</StatusPill>
          )}
        </span>
      ),
    },
    {
      key: 'viewing',
      header: t('presence.board.column'),
      // Wide enough for its uppercase header at 157 %, which at 76 ran into Party.
      width: rem(96),
      render: (lead) => (
        <AvatarStack
          entries={faces.get(lead.id) ?? []}
          selfUserId={userId}
          max={BOARD_SHOWN}
          size="xs"
        />
      ),
    },
    { key: 'party', header: t('lead.list.col.party'), render: (lead) => lead.partyName },
    {
      key: 'products',
      header: t('lead.list.col.products'),
      priority: 2,
      render: (lead) => {
        const summary = summariseItems(lead.items);
        return (
          <span
            className="ob-small"
            title={summary.title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary.text}
          </span>
        );
      },
    },
    {
      key: 'stage',
      header: t('lead.list.col.stage'),
      width: rem(130),
      render: (lead) =>
        lead.convertedOrderId ? (
          <StatusPill tone="ok">{t('leadsOrders.leads.converted')}</StatusPill>
        ) : (
          lead.stageName
        ),
    },
    {
      key: 'source',
      header: t('lead.list.col.source'),
      priority: 3,
      width: rem(110),
      render: (lead) => lead.sourcePlatform ?? '—',
    },
    {
      key: 'qty',
      header: t('lead.list.col.qty'),
      priority: 2,
      width: rem(80),
      align: 'right',
      render: (lead) => String(leadPieces(lead)),
    },
    {
      key: 'weight',
      header: t('lead.list.col.weight'),
      priority: 3,
      width: rem(110),
      align: 'right',
      // The sum over the lines that have a weight; the asterisk says some do
      // not, so the figure is a floor rather than the load.
      render: (lead) => (
        <span
          title={
            lead.linesWithoutWeight > 0
              ? t('leadsOrders.linesWithoutWeight', { count: lead.linesWithoutWeight })
              : undefined
          }
        >
          {formatKg(lead.totalWeightKg)}
          {lead.linesWithoutWeight > 0 ? '*' : ''}
        </span>
      ),
    },
    {
      key: 'followUp',
      header: t('lead.list.col.followUp'),
      priority: 3,
      width: rem(110),
      render: (lead) => lead.followUpDate ?? '—',
    },
    {
      key: 'created',
      header: t('leadsOrders.leads.column.created'),
      priority: 3,
      width: rem(160),
      render: (lead) => <span className="ob-small">{formatDateTime(lead.createdAt)}</span>,
    },
    {
      key: 'notes',
      header: t('orderNote.column.notes'),
      priority: 2,
      width: rem(232),
      render: (lead) =>
        lead.convertedOrderId ? null : (
          <NoteButtons
            onNote={(kind) => {
              setNote({ id: lead.id, kind });
              onOpenId(lead.id);
            }}
          />
        ),
    },
  ];

  // The note of a pending order. Its vehicle number is for the sheet only: a
  // lead has no vehicle column, so nothing is saved (`OrderNoteScreen`).
  if (openLead && noteKind) {
    return (
      <OrderNoteScreen
        key={openLead.id}
        record={openLead}
        source="lead"
        party={party}
        initialKind={noteKind}
        canEditVehicle
        onSaveVehicle={async () => undefined}
        onBack={() => setNote(null)}
        desktop={desktopBridge() ?? undefined}
        printroom={printroom}
      />
    );
  }

  if (openLead && editingId === openLead.id) {
    return (
      <EditorScreen
        title={openLead.partyName}
        meta={<RecordNumber record={openLead} small />}
        actions={others}
        onBack={() => {
          setEditingId(null);
          return true;
        }}
        backLabel={t('action.cancel')}
      >
        <LeadEntry
          key={openLead.id}
          revision={leadEntryRevision}
          canCreateParty={canCreateParty}
          lead={openLead}
          remoteChange={presence.lastWrite}
          onSaved={(_id, saved) => {
            if (saved) {
              setRows((current) => current.map((lead) => (lead.id === saved.id ? saved : lead)));
              setFetched((current) => (current && current.id === saved.id ? saved : current));
            }
            setEditingId(null);
            toast.push(t('lead.edit.saved', { id: recordNumberText(saved ?? openLead) }));
          }}
          onCancel={() => setEditingId(null)}
        />
      </EditorScreen>
    );
  }

  if (openLead) {
    return (
      <>
        <EditorScreen
          title={openLead.partyName}
          meta={
            <>
              {openLead.convertedOrderId ? (
                <StatusPill tone="ok">{t('lead.badge.converted')}</StatusPill>
              ) : (
                <StatusPill
                  tone={stageTone(
                    stages.find((stage) => stage.id === openLead.stageId),
                  )}
                >
                  {openLead.stageName}
                </StatusPill>
              )}
              <RecordNumber record={openLead} small />
            </>
          }
          actions={
            <>
              {others}
              {onShareInChat && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="chat"
                  onClick={() => onShareInChat({ kind: 'lead', id: openLead.id })}
                >
                  {t('chat.share.button')}
                </Button>
              )}
              {canEdit && !openLead.convertedOrderId && (
                <Button variant="secondary" size="sm" onClick={() => setEditingId(openLead.id)}>
                  {t('lead.edit.action')}
                </Button>
              )}
              {/* Viewing the record is the right to print its note (1.4 R10); only for a
                  pending order: once converted, the final order carries the notes. */}
              {!openLead.convertedOrderId && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setNote({ id: openLead.id, kind: 'filling' })}
                  >
                    {t('orderNote.filling')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setNote({ id: openLead.id, kind: 'dispatch' })}
                  >
                    {t('orderNote.dispatch')}
                  </Button>
                </>
              )}
              {/* Opens beside the app: the Electron shell allows this one URL a
                  window of its own (CATALOGUE_MODEL §8). */}
              {canPreviewPdf && (
                <ButtonLink
                  href={`/api/leads/${encodeURIComponent(openLead.id)}/pdf`}
                  target="_blank"
                  variant="secondary"
                  size="sm"
                >
                  {t('lead.previewPdf')}
                </ButtonLink>
              )}
              {/* Absent, not greyed, without the permission — the house rule. */}
              {canDelete && (
                <IconButton
                  icon="trash"
                  label={t('leadsOrders.delete.lead')}
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
          <LeadRecordView
            // A new mount per record, so a half-typed note is never the next one's.
            key={openLead.id}
            lead={openLead}
            stages={stages}
            optionLists={optionLists}
            packagingRequired={packagingRequired}
            party={party}
            canEdit={canEdit}
            canConvert={canConvert}
            transport={leadRecordTransport}
            onConverted={(order) => {
              toast.push(
                t('lead.board.convertedToast', {
                  qty: leadPieces(openLead),
                  orderId: recordNumberText(order),
                }),
              );
              onOpenOrder(order.id);
            }}
            onOpenOrder={onOpenOrder}
            onError={setError}
          />
        </EditorScreen>
        <ConfirmDialog
          open={confirmingDelete}
          tone="danger"
          busy={deleting}
          title={t('leadsOrders.delete.lead.title', { id: recordNumberText(openLead) })}
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
            rowKey={(lead) => lead.id}
            onRowOpen={(lead) => onOpenId(lead.id)}
            empty={
              filtering ? (
                <EmptyState title={t('common.noMatches')} />
              ) : (
                <EmptyState
                  title={
                    view === 'converted'
                      ? t('leadsOrders.leads.empty.converted.title')
                      : t('leadsOrders.leads.empty.open.title')
                  }
                  description={
                    view === 'converted'
                      ? undefined
                      : t('leadsOrders.leads.empty.open.description')
                  }
                  actionLabel={canCreate && view !== 'converted' ? t('action.newLead') : undefined}
                  onAction={onNewLead}
                />
              )
            }
          />
          <PageBar
            total={total}
            page={pageNumber}
            pageSize={pageSize}
            loading={fetching}
            onPage={(next) => setPaging({ key: loadKey, page: next })}
            onPageSize={setPageSize}
          />
        </>
      )}
    </div>
  );
}
