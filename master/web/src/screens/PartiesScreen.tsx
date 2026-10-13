/**
 * Parties, on the panel that owns them.
 *
 * This screen did not exist until now, and its absence was the single most
 * consequential gap in the product: `POST /api/parties` has always worked, the
 * permission has always been in the catalogue, `master/tests/http-api.
 * integration.test.ts` has always proved a 201 — and `api.createParty` in this
 * panel's client had, since the repo was restructured, **zero callers**. An
 * administrator sitting at the PC that holds the database had no way to add a
 * customer; the only route was to walk to an Office Panel. The nearest screen
 * (`PartyAccessScreen`) even stated the omission as deliberate, and
 * `docs/TESTING_PLAN.md` §5 told the tester to do it here, which is how it came
 * back as a bug report.
 *
 * The form itself is `PartyFormModal` from `@orderbook/ui`, the same component
 * the Office Panel renders, injected with this panel's own api calls. Copying
 * the Office's version into `master/web/src/components/` was the obvious move
 * and is the one this repo has already been burned by — `PartyAccessScreen`
 * drifted in four places within a day of being duplicated and needed a
 * byte-parity test to hold it.
 *
 * **Paged, and honest about it.** The Master answers one page at a time (100
 * parties unless asked, never more than 500), so a screen that renders
 * `rows.length` as the party count is rendering a page size. This one keeps the
 * whole `Paginated<Party>` and reports `page.total`.
 *
 * **A party opens as a sub-screen** (back button, nested sidebar entry) drawn
 * by the shared `PartyDetailView`: a head card with New pending order and Edit,
 * the party's pending and final orders, its party-wise product names (with Add
 * name), and a folding details panel — contact, who can reach it, notes. The
 * shell holds which one is open (`openId`) so a palette hit can open it; a
 * party the loaded page does not hold is fetched. Access has two halves:
 * everybody sees their own grant (`myAccess`, which the server sends on every
 * party), and whoever holds `party.assign` or `party.accessAll` also sees who
 * the party is assigned to and Manage, to the Party access module, which owns
 * the editing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lead, Order, PartyAccessRow, Product } from '@orderbook/shared';

import {
  ApiError,
  api,
  type PartyDetailRecord,
  type PartyListRow,
  type PartyRecord,
} from '../api';
import { partyFormTransport } from '../partyFormTransport';
import { partyImportTransport } from '../transports';
import {
  Button,
  Combobox,
  ConfirmDialog,
  DataTable,
  EditorScreen,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  LoadMorePager,
  Modal,
  NO_PARTY_LIST_FILTERS,
  PartyDetailView,
  PartyFilterRow,
  PartyFormModal,
  PartyVisibilityMark,
  PartyImportControls,
  SkeletonTable,
  StatusPill,
  formatDate,
  presenceOf,
  rem,
  t,
  useDebounced,
  useFilterBar,
  useStoredSort,
  useSubNav,
  useToast,
  type DataTableColumn,
  useCommand,
  type PartyListFilters,
} from '@orderbook/ui';

/**
 * One page at a time, and Load more for the next — the Master's own default
 * for parties. It is not the ceiling: `catalog.service.ts`'s `PAGING` serves
 * up to 500 a page, and clamps a larger ask rather than refusing it.
 */
const PAGE_SIZE = 100;

interface Props {
  revision: number;
  /** Moves when a lead or order changes, so an open party's recent pending orders re-read. */
  recordsRevision: number;
  permissions: string[];
  /** The party open as a sub-screen; held by the shell so a search hit can open one. */
  openId: string | null;
  onOpenId: (id: string | null) => void;
  /** Opens a pending order in its own module. */
  onOpenLead: (id: string) => void;
  /** Opens a final order in its own module. */
  onOpenOrder: (id: string) => void;
  /** The Pending orders and Final orders lists. */
  onOpenLeadsList: () => void;
  onOpenOrdersList: () => void;
  /** The New pending order form, opened on this party; absent without `leads.create`. */
  onNewLead?: (party: PartyDetailRecord) => void;
  /** Goes to the Party access module, where a party's assignment is edited. */
  onOpenPartyAccess: () => void;
}

export function PartiesScreen({
  revision,
  recordsRevision,
  permissions,
  openId,
  onOpenId,
  onOpenLead,
  onOpenOrder,
  onOpenLeadsList,
  onOpenOrdersList,
  onNewLead,
  onOpenPartyAccess,
}: Props) {
  const toast = useToast();
  // The shell hands a fresh callback every render; the fetches below must not.
  const onOpenIdRef = useRef(onOpenId);
  onOpenIdRef.current = onOpenId;

  const [rows, setRows] = useState<PartyListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PartyDetailRecord | null>(null);
  const [deleting, setDeleting] = useState<PartyDetailRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // 1.4 D3 (R17): the Master sorts, so the order holds across pages; the choice is
  // kept per machine. The filters narrow the same query.
  const [sort, setSort] = useStoredSort('parties', { key: 'name', dir: 'asc' });
  const [listFilters, setListFilters] = useState<PartyListFilters>(NO_PARTY_LIST_FILTERS);
  const debouncedCity = useDebounced(listFilters.city);
  const debouncedState = useDebounced(listFilters.state);

  // The open party's own reads.
  const [fetched, setFetched] = useState<PartyDetailRecord | null>(null);
  const [records, setRecords] = useState<PartyRecord[] | null>(null);
  const [access, setAccess] = useState<PartyAccessRow | null>(null);
  const [pending, setPending] = useState<{ items: Lead[]; total: number } | null>(null);
  const [final, setFinal] = useState<{ items: Order[]; total: number } | null>(null);
  const [addingName, setAddingName] = useState(false);

  const canCreate = permissions.includes('parties.create');
  useCommand('party.new', canCreate ? () => setCreating(true) : null);
  const canEdit = permissions.includes('parties.edit');
  const canDelete = permissions.includes('parties.delete');
  const canViewLeads = permissions.includes('leads.view');
  const canViewOrders = permissions.includes('orders.view');
  // Either key opens the access screen: `party.assign` to redraw the map,
  // `party.accessAll` to read it.
  const canSeeAssignment =
    permissions.includes('party.assign') || permissions.includes('party.accessAll');

  // A new search is a new list, not more of the old one.
  useEffect(() => {
    setOffset(0);
  }, [debouncedSearch, sort, debouncedCity, debouncedState, listFilters.hasGst]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.parties(debouncedSearch || undefined, PAGE_SIZE, offset, {
        sort: sort.key,
        dir: sort.dir,
        city: debouncedCity.trim() || undefined,
        state: debouncedState.trim() || undefined,
        hasGst: presenceOf(listFilters.hasGst),
      });
      // Appended when paging forward, replaced when the search changed — the
      // offset reset above is what tells the two apart.
      setRows((current) => (offset === 0 ? page.items : [...current, ...page.items]));
      setTotal(page.total);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('parties.error.load'));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, offset, sort, debouncedCity, debouncedState, listFilters.hasGst]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  function refresh(): void {
    setOffset(0);
    setRows([]);
    void load();
  }

  const fromRows = openId ? (rows.find((party) => party.id === openId) ?? null) : null;
  const inRows = fromRows !== null;

  // The deep-link fallback: a party the loaded page does not hold (a search hit,
  // a link from another screen). Re-read on a party change so an edit shows.
  useEffect(() => {
    if (!openId || inRows) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    void api
      .party(openId)
      .then((party) => {
        if (!cancelled) setFetched(party);
      })
      .catch((caught) => {
        // Gone, or not this person's to see: back to the list, not a blank screen.
        if (!cancelled && caught instanceof ApiError && caught.code === 'not_found') {
          onOpenIdRef.current(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [openId, inRows, revision]);

  const open: PartyDetailRecord | null =
    fromRows ?? (fetched && fetched.id === openId ? fetched : null);
  const openPartyId = open?.id ?? null;

  // The party's own product records, with the catalogue model each stands for.
  useEffect(() => {
    setRecords(null);
    if (!openPartyId) return;
    let cancelled = false;
    void api
      .partyRecords(openPartyId)
      .then((loaded) => {
        if (!cancelled) setRecords(loaded);
      })
      .catch(() => {
        if (!cancelled) setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [openPartyId, revision]);

  // Who the party is assigned to — only for those who may read the assignment.
  useEffect(() => {
    setAccess(null);
    if (!openPartyId || !canSeeAssignment) return;
    let cancelled = false;
    void api
      .partyAccessFor(openPartyId)
      .then((row) => {
        if (!cancelled) setAccess(row);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openPartyId, canSeeAssignment, revision]);

  // The party's pending orders and final orders, newest first — one page of each, with the totals.
  useEffect(() => {
    setPending(null);
    setFinal(null);
    if (!openPartyId) return;
    let cancelled = false;
    if (canViewLeads) {
      void api
        .leads({ partyId: openPartyId, limit: 50 })
        .then((page) => {
          if (!cancelled) setPending({ items: page.items, total: page.total });
        })
        .catch(() => {
          if (!cancelled) setPending({ items: [], total: 0 });
        });
    }
    if (canViewOrders) {
      void api
        .orders({ partyId: openPartyId, limit: 50 })
        .then((page) => {
          if (!cancelled) setFinal({ items: page.items, total: page.total });
        })
        .catch(() => {
          if (!cancelled) setFinal({ items: [], total: 0 });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [openPartyId, canViewLeads, canViewOrders, recordsRevision]);

  async function remove(party: PartyDetailRecord): Promise<void> {
    setDeleteBusy(true);
    try {
      await api.deleteParty(party.id);
      setDeleting(null);
      onOpenId(null);
      toast.push(t('parties.deleted', { name: party.name }), { tone: 'ok' });
      refresh();
    } catch (caught) {
      // A delete the server refuses because something live still points at the
      // party is not a failure to report as "could not delete" — the operator
      // needs to know what to deal with first.
      if (caught instanceof ApiError && caught.isConflict) {
        const labels = caught.blockedBy
          .map((blocker) => (blocker as { label?: string }).label)
          .filter((label): label is string => Boolean(label));
        toast.push(
          labels.length > 0
            ? t('parties.deleteBlocked', { items: labels.slice(0, 3).join(', ') })
            : t('error.conflict.blockedByLiveReferences'),
          { tone: 'error' },
        );
      } else {
        toast.push(caught instanceof Error ? caught.message : t('parties.deleteFailed'), {
          tone: 'error',
        });
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  // The search stays on an open party (not over its edit form): typing goes back to the list, filtered.
  useFilterBar(
    open && editing ? null : (
      <>
        <div className="ob-search" style={{ width: rem(400) }}>
          <Input
            value={search}
            placeholder={t('catalog.parties.searchPlaceholder')}
            aria-label={t('catalog.parties.searchLabel')}
            data-screen-search
            onChange={(event) => {
              setSearch(event.target.value);
              if (open) onOpenId(null);
            }}
          />
        </div>
        {!open && (
          <>
        <span style={{ flex: 1 }} />
        <span className="ob-small">{t('parties.summary', { shown: rows.length, total })}</span>
        {/* Absent rather than disabled when the permission is missing — the house rule
            stated in PartyAccessScreen.tsx: a control nobody may use is not a control
            to be greyed, it is one not to render. */}
        <PartyImportControls
          transport={partyImportTransport}
          canExport={permissions.includes('parties.view') && permissions.includes('parties.export')}
          canImport={permissions.includes('parties.bulk')}
          onImported={refresh}
        />
        {canCreate && (
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
            {t('catalog.parties.new')}
          </Button>
        )}
          </>
        )}
      </>
    ),
  );

  useSubNav(
    'parties',
    open
      ? {
          parentId: 'parties',
          items: [{ id: 'parties.detail', label: open.name, icon: 'parties' }],
          activeId: 'parties.detail',
        }
      : null,
  );

  const columns: DataTableColumn<PartyListRow>[] = [
    {
      key: 'code',
      header: t('catalog.parties.column.code'),
      width: rem(100),
      sortable: true,
      render: (party) => (
        <span className="ob-mono" style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}>
          {party.partyCode}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('catalog.parties.column.name'),
      sortable: true,
      render: (party) => (
        <span className="ob-body-strong" style={{ fontSize: rem(13.5) }}>
          {party.name}
        </span>
      ),
    },
    {
      key: 'phone',
      header: t('catalog.parties.column.phone'),
      priority: 2,
      width: rem(130),
      sortable: true,
      render: (party) => <span className="ob-data">{party.phone ?? '—'}</span>,
    },
    {
      key: 'city',
      header: t('catalog.parties.column.city'),
      priority: 3,
      width: rem(110),
      sortable: true,
      render: (party) => party.city ?? '—',
    },
    {
      key: 'variants',
      header: t('catalog.parties.column.variants'),
      priority: 3,
      width: rem(140),
      sortable: true,
      render: (party) => {
        const count = party.recordCount ?? 0;
        return count > 0
          ? `${count} ${count === 1 ? t('unit.product') : t('unit.products')}`
          : '—';
      },
    },
    {
      // Only two of the three states are worth a pill: a party with no grant of
      // this person's is the ordinary case — everyone can reach it — so it draws
      // nothing rather than "Open" on almost every row.
      key: 'access',
      header: t('catalog.parties.column.access'),
      width: rem(110),
      render: (party) => (party.myAccess ? <AccessPill level={party.myAccess} /> : ''),
    },
    {
      // "Private" (one person holds it) or "Shared with N"; an open party draws nothing.
      key: 'visibility',
      header: t('catalog.parties.column.visibility'),
      width: rem(130),
      render: (party) => <PartyVisibilityMark count={party.accessCount} />,
    },
    {
      key: 'since',
      header: t('party.detail.since'),
      priority: 3,
      width: rem(110),
      sortable: true,
      // The date alone: a date and time ran 179 px in this 110 px column.
      render: (party) => formatDate(party.createdAt),
    },
  ];

  if (open) {
    // A view grant reads the party but may not work it: no new order, no edit, no names.
    const mayWork = open.myAccess !== 'view';
    const listed = rows.find((party) => party.id === open.id);
    return (
      <>
        <EditorScreen
          onBack={() => {
            onOpenId(null);
            return true;
          }}
          backLabel={t('action.backToList')}
        >
          <PartyDetailView
            party={open}
            pending={canViewLeads ? (pending?.items ?? null) : []}
            pendingTotal={pending?.total}
            final={canViewOrders ? (final?.items ?? null) : undefined}
            finalTotal={final?.total}
            records={records}
            accessCount={access ? access.assignees.length : (listed?.accessCount ?? 0)}
            assignees={canSeeAssignment ? (access?.assignees ?? null) : null}
            myAccess={open.myAccess ?? null}
            onNewOrder={onNewLead && mayWork ? () => onNewLead(open) : undefined}
            onEdit={canEdit && mayWork ? () => setEditing(open) : undefined}
            onDelete={canDelete && mayWork ? () => setDeleting(open) : undefined}
            onOpenLead={onOpenLead}
            onOpenOrder={onOpenOrder}
            onOpenPendingList={canViewLeads ? onOpenLeadsList : undefined}
            onOpenFinalList={canViewOrders ? onOpenOrdersList : undefined}
            onManageAccess={canSeeAssignment ? onOpenPartyAccess : undefined}
            onAddName={canEdit && mayWork ? () => setAddingName(true) : undefined}
          />
        </EditorScreen>

        <AddNameModal
          open={addingName}
          partyId={open.id}
          onClose={() => setAddingName(false)}
          onSaved={(product) => {
            setAddingName(false);
            toast.push(t('party.view.addName.saved', { product }), { tone: 'ok' });
            void api
              .partyRecords(open.id)
              .then(setRecords)
              .catch(() => undefined);
          }}
          onError={(message) => toast.push(message, { tone: 'error' })}
        />

        {partyModals()}
      </>
    );
  }

  if (error && rows.length === 0) {
    return <ErrorState title={t('parties.error.load')} description={error} onAction={refresh} />;
  }

  if (loading && rows.length === 0) return <SkeletonTable columns={columns} rows={8} />;

  return (
    <>
      <PartyFilterRow
        value={listFilters}
        onChange={setListFilters}
        extraActive={search.trim() !== ''}
        onClearAll={() => {
          setSearch('');
          setListFilters(NO_PARTY_LIST_FILTERS);
        }}
      />
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(party) => party.id}
        onRowOpen={(party) => onOpenId(party.id)}
        sort={sort}
        onSortChange={setSort}
        sortLocally={false}
        empty={
          search || listFilters.city || listFilters.state || listFilters.hasGst !== 'any' ? (
            <EmptyState title={t('catalog.parties.empty.filtered')} />
          ) : (
            <EmptyState
              title={t('catalog.parties.empty.title')}
              description={t('catalog.parties.empty.description')}
              actionLabel={canCreate ? t('catalog.parties.new') : undefined}
              onAction={canCreate ? () => setCreating(true) : undefined}
            />
          )
        }
      />

      <LoadMorePager
        hasMore={rows.length < total}
        loading={loading}
        onLoadMore={() => setOffset(rows.length)}
      />

      {partyModals()}
    </>
  );

  /** The create and edit forms and the delete confirmation: over the list and over a party alike. */
  function partyModals() {
    return (
      <>
        <PartyFormModal
          open={creating}
          transport={partyFormTransport}
          onClose={() => setCreating(false)}
          onCreated={(party) => {
            setCreating(false);
            toast.push(t('parties.created', { name: party.name }), { tone: 'ok' });
            refresh();
          }}
          onError={(message) => toast.push(message, { tone: 'error' })}
        />

        <PartyFormModal
          open={editing !== null}
          transport={partyFormTransport}
          party={editing}
          onClose={() => setEditing(null)}
          onUpdated={(name) => {
            setEditing(null);
            toast.push(t('parties.updated', { name }), { tone: 'ok' });
            refresh();
          }}
          onError={(message) => toast.push(message, { tone: 'error' })}
        />

        <ConfirmDialog
          open={deleting !== null}
          tone="danger"
          busy={deleteBusy}
          title={t('parties.delete.title', { name: deleting?.name ?? '' })}
          body={t('parties.delete.body')}
          confirmLabel={t('parties.delete.confirm')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (deleting) void remove(deleting);
          }}
        />
      </>
    );
  }
}

function AccessPill({ level }: { level: 'view' | 'manage' }) {
  return (
    <StatusPill tone={level === 'manage' ? 'accent' : 'default'}>
      {level === 'manage' ? t('partyAccess.level.manage') : t('partyAccess.level.view')}
    </StatusPill>
  );
}

/**
 * Add name: what this party calls one catalogue product. One name per product
 * (`upsertVariant` keys on party and product), so picking a product that
 * already has one replaces it.
 */
function AddNameModal({
  open,
  partyId,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  partyId: string;
  onClose: () => void;
  onSaved: (productName: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [product, setProduct] = useState<Product | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const term = useDebounced(query, 200);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setProduct(null);
      setName('');
    }
  }, [open]);

  useEffect(() => {
    if (!open || !term.trim()) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .pick<Product>('product', { term, limit: 20 })
      .then((page) => {
        if (!cancelled) setOptions(page.items);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, term]);

  async function save(): Promise<void> {
    if (!product || !name.trim()) return;
    setBusy(true);
    try {
      await api.upsertPartyRecord({ partyId, productId: product.id, alias: name.trim() });
      onSaved(product.name);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('party.view.addName.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('party.view.addName.title')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!product || !name.trim()}
            onClick={() => void save()}
          >
            {t('party.view.addName')}
          </Button>
        </>
      }
    >
      <FormField label={t('party.view.addName.product')} required>
        {() => (
          <Combobox<Product>
            autoFocus
            filter={false}
            loading={loading}
            ariaLabel={t('party.view.addName.product')}
            placeholder={product?.name ?? t('party.view.addName.productPlaceholder')}
            onQueryChange={setQuery}
            options={options.map((item) => ({
              key: item.id,
              label: item.name,
              hint: item.alias ?? undefined,
              value: item,
            }))}
            onSelect={(option) => setProduct(option.value)}
          />
        )}
      </FormField>
      {product && <p className="ob-small">{product.name}</p>}
      <FormField label={t('party.view.addName.name')} required>
        {(id) => (
          <Input
            id={id}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
          />
        )}
      </FormField>
    </Modal>
  );
}
