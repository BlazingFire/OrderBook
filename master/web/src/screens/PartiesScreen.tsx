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
 */

import { useCallback, useEffect, useState } from 'react';
import type { Party } from '@orderbook/shared';

import { ApiError, api } from '../api';
import { partyFormTransport } from '../partyFormTransport';
import {
  Button,
  ConfirmDialog,
  DataTable,
  type DataTableSort,
  EmptyState,
  ErrorState,
  Input,
  KeyValueList,
  Modal,
  PartyFormModal,
  SkeletonTable,
  formatDateTime,
  rem,
  t,
  useDebounced,
  useFilterBar,
  useToast,
  type DataTableColumn,
} from '@orderbook/ui';

/**
 * One page at a time, and Load more for the next — the Master's own default
 * for parties. It is not the ceiling: `catalog.service.ts`'s `PAGING` serves
 * up to 500 a page, and clamps a larger ask rather than refusing it.
 */
const PAGE_SIZE = 100;

interface Props {
  revision: number;
  permissions: string[];
}

export function PartiesScreen({ revision, permissions }: Props) {
  const toast = useToast();

  const [rows, setRows] = useState<Party[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);
  const [deleting, setDeleting] = useState<Party | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Client-side, over the pages already loaded — the Master's list route takes
  // no sort argument, and pretending otherwise would sort one page and call it
  // the book.
  const [sort, setSort] = useState<DataTableSort>({ key: 'name', dir: 'asc' });

  const canCreate = permissions.includes('parties.create');
  const canEdit = permissions.includes('parties.edit');
  const canDelete = permissions.includes('parties.delete');

  // A new search is a new list, not more of the old one.
  useEffect(() => {
    setOffset(0);
  }, [debouncedSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.parties(debouncedSearch || undefined, PAGE_SIZE, offset);
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
  }, [debouncedSearch, offset]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  function refresh(): void {
    setOffset(0);
    setRows([]);
    void load();
  }

  async function remove(party: Party): Promise<void> {
    setDeleteBusy(true);
    try {
      await api.deleteParty(party.id);
      setDeleting(null);
      setOpenId((current) => (current === party.id ? null : current));
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

  useFilterBar(
    <>
      <div className="ob-search" style={{ width: rem(400) }}>
        <Input
          value={search}
          placeholder={t('catalog.parties.searchPlaceholder')}
          aria-label={t('catalog.parties.searchLabel')}
          data-screen-search
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <span style={{ flex: 1 }} />
      <span className="ob-small">{t('parties.summary', { shown: rows.length, total })}</span>
      {/* Absent rather than disabled when the permission is missing — the house
          rule stated in PartyAccessScreen.tsx: a control nobody may use is not
          a control to be greyed, it is one not to render. */}
      {canCreate && (
        <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
          {t('catalog.parties.new')}
        </Button>
      )}
    </>,
  );

  const columns: DataTableColumn<Party>[] = [
    {
      key: 'code',
      header: t('catalog.parties.column.code'),
      width: rem(100),
      sortValue: (party) => party.partyCode,
      render: (party) => (
        <span className="ob-mono" style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}>
          {party.partyCode}
        </span>
      ),
    },
    {
      key: 'name',
      header: t('catalog.parties.column.name'),
      sortValue: (party) => party.name,
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
      sortValue: (party) => party.phone,
      render: (party) => <span className="ob-data">{party.phone ?? '—'}</span>,
    },
    {
      key: 'city',
      header: t('catalog.parties.column.city'),
      priority: 3,
      width: rem(110),
      sortValue: (party) => party.city,
      render: (party) => party.city ?? '—',
    },
    {
      key: 'since',
      header: t('party.detail.since'),
      priority: 3,
      width: rem(110),
      sortValue: (party) => party.createdAt,
      render: (party) => formatDateTime(party.createdAt),
    },
  ];

  const open = rows.find((party) => party.id === openId) ?? null;

  if (error && rows.length === 0) {
    return <ErrorState title={t('parties.error.load')} description={error} onAction={refresh} />;
  }

  if (loading && rows.length === 0) return <SkeletonTable columns={columns} rows={8} />;

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(party) => party.id}
        onRowOpen={(party) => setOpenId(party.id)}
        selectedId={openId ?? undefined}
        sort={sort}
        onSortChange={setSort}
        empty={
          search ? (
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

      {rows.length < total && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--s-12)' }}>
          <Button
            variant="secondary"
            busy={loading}
            onClick={() => setOffset(rows.length)}
          >
            {t('parties.loadMore')}
          </Button>
        </div>
      )}

      {/* A record opens centred over the list it came from — never a drawer,
          never an inline expanding row. */}
      <Modal
        open={open !== null}
        onClose={() => setOpenId(null)}
        size="lg"
        title={open?.name ?? ''}
        footer={
          <>
            {canDelete && open && (
              <Button variant="danger" onClick={() => setDeleting(open)}>
                {t('common.delete')}
              </Button>
            )}
            <span style={{ flex: 1 }} />
            <Button variant="secondary" onClick={() => setOpenId(null)}>
              {t('common.close')}
            </Button>
            {canEdit && open && (
              <Button
                variant="primary"
                onClick={() => {
                  setEditing(open);
                  setOpenId(null);
                }}
              >
                {t('party.detail.editAction')}
              </Button>
            )}
          </>
        }
      >
        {open && (
          <KeyValueList
            items={[
              { label: t('catalog.parties.column.code'), value: open.partyCode },
              { label: t('party.detail.phone'), value: open.phone ?? '—' },
              { label: t('party.field.altPhone'), value: open.altPhone ?? '—' },
              { label: t('party.detail.email'), value: open.email ?? '—' },
              { label: t('party.field.addressLine1'), value: open.addressLine1 ?? '—' },
              { label: t('party.field.addressLine2'), value: open.addressLine2 ?? '—' },
              { label: t('party.detail.city'), value: open.city ?? '—' },
              { label: t('party.field.state'), value: open.state ?? '—' },
              { label: t('party.field.pincode'), value: open.pincode ?? '—' },
              { label: t('party.detail.taxId'), value: open.gstNumber ?? '—' },
              { label: t('party.field.notes'), value: open.notes ?? '—' },
              { label: t('party.detail.since'), value: formatDateTime(open.createdAt) },
            ]}
          />
        )}
      </Modal>

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
