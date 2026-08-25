/**
 * The Recycle Bin — every soft-deleted record across the nine entity types
 * `RECYCLE_BIN_ENTITIES` names (docs/backend-modules/04-API-CONTRACT.md §4).
 *
 * Two rules here come straight from the server's shape and are easy to get
 * subtly wrong:
 *
 * A branch is visible to a caller exactly when they hold that entity's own
 * DELETE key — the Bin mints no `recycleBin.restore` of its own, so it can
 * never become a back door onto something the caller may not delete. That one
 * predicate therefore decides both which types this screen offers as a filter
 * and which rows get a Restore button.
 *
 * `BinCounts` is a `Partial` record: a key the server did not send is not a
 * zero, so a number is rendered only where one actually arrived.
 */

import { useEffect, useState } from 'react';
import type { BinBlocker, BinCounts, BinEntry, RecycleBinEntityType } from '@orderbook/shared';
import { isRecycleBinEntityType, RECYCLE_BIN_ENTITIES, RESTORE_PERMISSION } from '@orderbook/shared';

import { api, ApiError } from '../api';
import { formatDateTime } from '../format';
import { t } from '../i18n/strings';
import { Button } from '../ui/Button';
import { LoadMorePager } from '../ui/CursorPager';
import { StatusPill } from '../ui/DataDisplay';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { useFilterBar } from '../ui/FilterBarSlot';
import { FormField, Input, Select } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { ConflictBanner, EmptyState, ErrorState, SkeletonRows } from '../ui/States';
import { useToast } from '../ui/Toast';

interface Props {
  /** The signed-in caller's own resolved permissions. */
  permissions: string[];
  /** Bumped by the live socket whenever data changes. */
  revision: number;
}

/** A blocker the Bin can actually act on: still-deleted, and a restorable type. */
type ParentBlocker = BinBlocker & { entityType: RecycleBinEntityType };

/** What the server refused a restore with, kept per-entry so the dialog can name it. */
interface Refusal {
  entry: BinEntry;
  /** The rename `suggestRestoredName` offered; absent when this was not a collision. */
  suggestion?: string;
  parents: ParentBlocker[];
  message: string;
}

/** Two entity types can share an id, so neither alone identifies a row. */
function rowKey(entry: BinEntry): string {
  return `${entry.entityType}:${entry.id}`;
}

/**
 * `blockedBy` arrives as unstructured JSON, and both 409s use it for opposite
 * questions — only a `parent_deleted` blocker names a record that restoring
 * first would unblock this one.
 */
function isParentBlocker(value: unknown): value is ParentBlocker {
  const blocker = value as Partial<BinBlocker> | null;
  return (
    typeof blocker === 'object' &&
    blocker !== null &&
    blocker.reason === 'parent_deleted' &&
    isRecycleBinEntityType(blocker.entityType) &&
    typeof blocker.id === 'string' &&
    typeof blocker.label === 'string'
  );
}

/** Folds a page's deleters into the picker's options without dropping earlier pages'. */
function withDeleters(known: Map<string, string>, items: BinEntry[]): Map<string, string> {
  const next = new Map(known);
  for (const item of items) {
    if (item.deletedBy) next.set(item.deletedBy, item.deletedByName ?? item.deletedBy);
  }
  return next;
}

/** A `1fr` cell clips rather than wraps, so a long value ends in an ellipsis and shows in full on hover. */
function Truncated({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={className}
      title={children}
      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {children}
    </span>
  );
}

export function RecycleBinScreen({ permissions, revision }: Props) {
  const toast = useToast();
  const canView = permissions.includes('recycleBin.view');
  const canViewAll = permissions.includes('recycleBin.viewAll');
  const canRestore = (type: RecycleBinEntityType): boolean =>
    permissions.includes(RESTORE_PERMISSION[type]);

  const [type, setType] = useState<RecycleBinEntityType | ''>('');
  const [search, setSearch] = useState('');
  const [deletedBy, setDeletedBy] = useState('');
  const [entries, setEntries] = useState<BinEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<BinCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // The deleters seen so far, so choosing one from the picker does not shrink
  // the list it was chosen from — the next page is filtered to that one person.
  const [deleters, setDeleters] = useState<Map<string, string>>(new Map());
  const [refresh, setRefresh] = useState(0);

  // A function, not an object: the first-page effect depends on the three
  // filter values individually, so it re-runs when one of them changes and
  // never merely because a fresh object was built during a re-render.
  const filters = () => ({
    types: type ? [type] : undefined,
    search: search.trim() || undefined,
    deletedBy: deletedBy || undefined,
  });

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const page = await api.recycleBin(filters());
        if (cancelled) return;
        setEntries(page.items);
        setNextCursor(page.nextCursor);
        setDeleters((known) => withDeleters(known, page.items));
      } catch (caught) {
        if (cancelled) return;
        // A failed fetch is not an empty bin: the rows are dropped and the
        // error takes the table's place rather than reading as "nothing here".
        setEntries([]);
        setNextCursor(null);
        setError(caught instanceof Error ? caught.message : t('recycleBin.error.load'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canView, type, search, deletedBy, revision, refresh]);

  useEffect(() => {
    if (!canView) return;
    // A counts failure is not a set of zeroes either — the numbers just stay off.
    void api.recycleBinCounts().then(setCounts).catch(() => setCounts(null));
  }, [canView, revision, refresh]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const page = await api.recycleBin({ ...filters(), cursor: nextCursor });
      setEntries((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setDeleters((known) => withDeleters(known, page.items));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t('recycleBin.error.load'));
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Both 409s are answerable, so neither is allowed to land in the error
   * banner: a collision carries the rename the server would accept, and a
   * still-deleted parent carries the records to put back first.
   */
  async function restore(
    entry: BinEntry,
    options?: { renameTo?: string; cascadeParents?: boolean },
  ): Promise<void> {
    setBusyId(rowKey(entry));
    setActionError(null);
    try {
      const result = await api.restoreFromBin({
        entityType: entry.entityType,
        id: entry.id,
        renameTo: options?.renameTo,
        cascadeParents: options?.cascadeParents,
      });
      setRefusal(null);
      toast.push(
        result.renamedTo
          ? t('recycleBin.toast.restoredAs', { label: entry.label, name: result.renamedTo })
          : t('recycleBin.toast.restored', { label: entry.label }),
      );
      setRefresh((count) => count + 1);
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict) {
        const parents = caught.blockedBy.filter(isParentBlocker);
        if (caught.suggestion !== undefined || parents.length > 0) {
          setRefusal({ entry, suggestion: caught.suggestion, parents, message: caught.message });
          return;
        }
      }
      setActionError(caught instanceof Error ? caught.message : t('recycleBin.error.restore'));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * The parents come back named but still deleted, so the offer is only real
   * if each one is put back first — in the order the server listed them, which
   * is already parent-before-child (a party ahead of the lead raised on it).
   *
   * Deliberately not one transaction: a failure part-way leaves the parents
   * restored and this record still in the Bin. Atomicity would need the server
   * to honour `cascadeParents`, which `restoreEntity` accepts on the way in
   * and passes to no entity service — the flag rides along on the retry so
   * nothing here changes on the day it starts being honoured.
   */
  async function restoreWithParents(refused: Refusal): Promise<void> {
    setBusyId(rowKey(refused.entry));
    setActionError(null);
    try {
      for (const parent of refused.parents) {
        await api.restoreFromBin({ entityType: parent.entityType, id: parent.id });
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t('recycleBin.error.restoreParent'));
      return;
    } finally {
      setBusyId(null);
    }
    await restore(refused.entry, { cascadeParents: true });
  }

  useFilterBar(
    canView ? (
      <>
        <div className="ob-search">
          <Input
            value={search}
            placeholder={t('recycleBin.search.placeholder')}
            aria-label={t('recycleBin.search.placeholder')}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          value={type}
          aria-label={t('recycleBin.filter.type')}
          onChange={(event) => setType(event.target.value as RecycleBinEntityType | '')}
        >
          <option value="">{t('recycleBin.filter.allTypes')}</option>
          {/* Only the branches this caller may see: a type they hold no delete
              key for returns an empty page rather than a refusal, which as a
              filter option would read as "none deleted". */}
          {RECYCLE_BIN_ENTITIES.filter(canRestore).map((branch) => {
            const label = t(`recycleBin.entity.${branch}`);
            const count = counts?.[branch];
            return (
              <option key={branch} value={branch}>
                {count === undefined ? label : t('recycleBin.filter.typeWithCount', { type: label, count })}
              </option>
            );
          })}
        </Select>
        {canViewAll && (
          <Select
            value={deletedBy}
            aria-label={t('recycleBin.filter.deletedBy')}
            onChange={(event) => setDeletedBy(event.target.value)}
          >
            <option value="">{t('recycleBin.filter.anyone')}</option>
            {[...deleters].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </>
    ) : null,
  );

  if (!canView) {
    return (
      <ErrorState
        title={t('recycleBin.denied.title')}
        description={t('recycleBin.denied.description', { permission: 'recycleBin.view' })}
      />
    );
  }

  const columns: DataTableColumn<BinEntry>[] = [
    {
      key: 'type',
      header: t('recycleBin.column.type'),
      width: '170px',
      render: (entry) => <StatusPill>{t(`recycleBin.entity.${entry.entityType}`)}</StatusPill>,
    },
    {
      key: 'label',
      header: t('recycleBin.column.label'),
      render: (entry) => <Truncated>{entry.label}</Truncated>,
    },
    {
      key: 'detail',
      header: t('recycleBin.column.detail'),
      render: (entry) => <Truncated className="ob-small">{entry.sublabel ?? '—'}</Truncated>,
    },
    {
      key: 'deletedAt',
      header: t('recycleBin.column.deletedAt'),
      width: '170px',
      render: (entry) => <span className="ob-small">{formatDateTime(entry.deletedAt)}</span>,
    },
    {
      key: 'deletedBy',
      header: t('recycleBin.column.deletedBy'),
      width: '170px',
      // An unattended Office Panel deletes with nobody attached, which is a
      // different fact from a name this screen could not resolve.
      render: (entry) =>
        entry.deletedByName ??
        (entry.deletedBy ? (
          <span className="ob-mono">{entry.deletedBy}</span>
        ) : (
          <span style={{ color: 'var(--fg-tertiary)' }}>{t('recycleBin.deletedBy.panel')}</span>
        )),
    },
    {
      key: 'actions',
      header: '',
      width: '120px',
      render: (entry) =>
        canRestore(entry.entityType) ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
            <Button
              variant="primary"
              size="sm"
              busy={busyId === rowKey(entry)}
              onClick={() => void restore(entry)}
            >
              {t('recycleBin.action.restore')}
            </Button>
          </div>
        ) : null,
    },
  ];

  const filtered = Boolean(type || search.trim() || deletedBy);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--s-12)' }}>
        <div>
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('recycleBin.title')}
          </h1>
          {/* Which of the two view permissions is in force decides how much of
              the company this list is, so it is stated rather than implied by
              a shorter list. */}
          <p className="ob-small" style={{ margin: 'var(--s-4) 0 0' }}>
            {canViewAll ? t('recycleBin.scope.everyone.hint') : t('recycleBin.scope.own.hint')}
          </p>
        </div>
        <StatusPill tone={canViewAll ? 'accent' : 'default'}>
          {canViewAll ? t('recycleBin.scope.everyone') : t('recycleBin.scope.own')}
        </StatusPill>
      </div>

      {actionError && <ConflictBanner>{actionError}</ConflictBanner>}

      {loading ? (
        <SkeletonRows columns={6} />
      ) : error ? (
        <ErrorState
          title={t('recycleBin.error.title')}
          description={error}
          actionLabel={t('action.retryNow')}
          onAction={() => setRefresh((count) => count + 1)}
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={entries}
            rowKey={rowKey}
            empty={
              <EmptyState
                title={filtered ? t('recycleBin.empty.filtered.title') : t('recycleBin.empty.title')}
                description={filtered ? undefined : t('recycleBin.empty.description')}
              />
            }
          />
          <LoadMorePager
            hasMore={nextCursor !== null}
            loading={loadingMore}
            onLoadMore={() => void loadMore()}
            label={t('recycleBin.action.loadMore')}
          />
        </>
      )}

      {refusal && (
        <RefusalDialog
          // Remounts per refused record, so the rename box always starts from
          // the suggestion for the record actually being restored.
          key={rowKey(refusal.entry)}
          refusal={refusal}
          canRestore={canRestore}
          busy={busyId === rowKey(refusal.entry)}
          // The page banner sits under this dialog's scrim, so a second
          // refusal has to say so where the operator is looking.
          error={actionError}
          onRename={(name) => void restore(refusal.entry, { renameTo: name })}
          onCascade={() => void restoreWithParents(refusal)}
          onClose={() => setRefusal(null)}
        />
      )}
    </div>
  );
}

/**
 * The two answerable refusals, in the dialog the operator is already looking
 * at. They are rendered independently rather than as an either/or: nothing in
 * the contract says a restore cannot collide *and* have a deleted parent.
 */
function RefusalDialog({
  refusal,
  canRestore,
  busy,
  error,
  onRename,
  onCascade,
  onClose,
}: {
  refusal: Refusal;
  canRestore: (type: RecycleBinEntityType) => boolean;
  busy: boolean;
  error: string | null;
  onRename: (name: string) => void;
  onCascade: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(refusal.suggestion ?? '');
  const parentsRestorable = refusal.parents.every((parent) => canRestore(parent.entityType));

  return (
    <Modal
      open
      onClose={onClose}
      title={t('recycleBin.refusal.title', { label: refusal.entry.label })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('action.close')}
          </Button>
          {refusal.suggestion !== undefined && (
            <Button
              variant="primary"
              busy={busy}
              disabled={!name.trim()}
              onClick={() => onRename(name.trim())}
            >
              {t('recycleBin.refusal.restoreAs')}
            </Button>
          )}
          {refusal.parents.length > 0 && parentsRestorable && (
            <Button variant="primary" busy={busy} onClick={onCascade}>
              {t('recycleBin.refusal.restoreParents')}
            </Button>
          )}
        </>
      }
    >
      {error && <ConflictBanner>{error}</ConflictBanner>}

      <p className="ob-small" style={{ margin: 0 }}>
        {refusal.message}
      </p>

      {refusal.suggestion !== undefined && (
        <FormField label={t('recycleBin.refusal.nameLabel')} hint={t('recycleBin.refusal.nameHint')}>
          {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />}
        </FormField>
      )}

      {refusal.parents.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
          <div className="ob-eyebrow">{t('recycleBin.refusal.parentsTitle')}</div>
          <ul className="ob-small" style={{ margin: 0, paddingLeft: 'var(--s-16)' }}>
            {refusal.parents.map((parent) => (
              <li key={`${parent.entityType}:${parent.id}`}>
                {t('recycleBin.refusal.parentLine', {
                  type: t(`recycleBin.entity.${parent.entityType}`),
                  label: parent.label,
                })}
              </li>
            ))}
          </ul>
          {!parentsRestorable && (
            <p className="ob-small" style={{ margin: 0, color: 'var(--state-conflict)' }}>
              {t('recycleBin.refusal.parentsNotYours')}
            </p>
          )}
        </section>
      )}
    </Modal>
  );
}
