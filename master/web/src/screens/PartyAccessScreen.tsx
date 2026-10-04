/**
 * Party Access — who may see and manage each party.
 *
 * The rule the whole screen turns on: **a party with nobody assigned is open to
 * everyone.** Assigning the first person is what makes a party restricted, and
 * removing the last one opens it again. The Access column says which of the two
 * a party is in, because that is the question an administrator is actually
 * asking when they open this list.
 *
 * Two levels per person. *View* is a window — the party and its leads and
 * orders are visible and nothing about them can be changed. *Manage* adds
 * raising a lead against the party, editing its records, converting and
 * dispatching. Both are still bounded by the person's own role: manage access
 * to a party does not hand somebody `leads.create`.
 *
 * `party.assign` writes, `party.accessAll` reads. A reader gets the same table
 * with no editor — a control somebody can never use is absent, not greyed
 * (`AccessScreen.tsx`'s convention).
 *
 * It shows parties, but it is not the parties list. Both panels have one of
 * those — the Office Panel's Catalog screen and the Master's `PartiesScreen`,
 * which share one form (`PartyFormModal` in `ui/`). This screen deliberately
 * does not duplicate either: it edits access, not the party.
 *
 * **This file is byte-identical to `office/web/src/screens/PartyAccessScreen.tsx`
 * and must stay that way** — `master/tests/party-access-screen-parity.test.ts`
 * fails otherwise. The two panels keep separate copies of `ui/` and of their
 * `api` client, so a screen can only be shared by being duplicated; making the
 * duplicate exact is what stops the next edit landing on one copy only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  AssignablePerson,
  PartyAccessAssignee,
  PartyAccessEntry,
  PartyAccessLevel,
  PartyAccessRow,
} from '@orderbook/shared';

import { api, ApiError } from '../api';
import {
  Avatar,
  Button,
  ButtonLink,
  Combobox,
  ConflictBanner,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  LoadMorePager,
  Modal,
  Segmented,
  SkeletonTable,
  StatusPill,
  rem,
  t,
  useDebounced,
  useFormBaseline,
  useUnsavedWork,
  type DataTableColumn,
  type DataTableSort,
} from '@orderbook/ui';

interface Props {
  permissions: string[];
  /** Bumped by the live socket whenever data changes. */
  revision: number;
  /** Which slice is showing — chosen here or from the sidebar's sub-pages. */
  restriction: Restriction;
  onRestrictionChange: (restriction: Restriction) => void;
}

export type Restriction = 'all' | 'open' | 'restricted';

const ROW = { display: 'flex', alignItems: 'center', gap: 'var(--s-8)' } as const;
const STACK = { display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' } as const;

/** The largest page the Master will serve; `PAGING.maxLimit` on its side. */
const PAGE_SIZE = 200;

/** A keystroke becomes a request this long after the last one. */
const SEARCH_DEBOUNCE_MS = 250;

/** How many names the Assigned-to cell spells out before it says "+N more". */
const NAMES_SHOWN = 3;

type SortKey = 'code' | 'name' | 'city' | 'access';

function levelLabel(level: PartyAccessLevel): string {
  return level === 'manage' ? t('partyAccess.level.manage') : t('partyAccess.level.view');
}

export function PartyAccessScreen({
  permissions,
  revision,
  restriction,
  onRestrictionChange,
}: Props) {
  const canAssign = permissions.includes('party.assign');

  const [rows, setRows] = useState<PartyAccessRow[]>([]);
  /** What the Master says the filtered query matches, company-wide — not the page. */
  const [total, setTotal] = useState(0);
  /** The strip's numbers: the whole company's, whatever the search or filter says. */
  const [summary, setSummary] = useState<{ total: number; restricted: number; open: number } | null>(
    null,
  );
  const [people, setPeople] = useState<AssignablePerson[]>([]);
  const [search, setSearch] = useState('');
  /** `null` — anybody; otherwise only parties this person is assigned to. */
  const [person, setPerson] = useState<AssignablePerson | null>(null);
  const [sort, setSort] = useState<DataTableSort | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [openParty, setOpenParty] = useState<PartyAccessRow | null>(null);
  /** Kept after the editor closes, so the row somebody just worked on stays marked. */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  const personId = person?.id;

  /*
   * One key for "which list is this". A new key is a new list, not more of the
   * old one: the page offset belongs to the key it was asked under, so a changed
   * filter, a sort or a live update starts again at the top without a second
   * effect to reset it (and without a second fetch for the reset to cause).
   */
  const listKey = [
    term,
    restriction,
    personId ?? '',
    sort?.key ?? '',
    sort?.dir ?? '',
    revision,
  ].join('|');
  const [paging, setPaging] = useState({ key: listKey, offset: 0 });
  const offset = paging.key === listKey ? paging.offset : 0;

  useEffect(() => {
    let live = true;
    setFailure(null);
    if (offset > 0) setLoadingMore(true);

    api
      .partyAccess({
        search: term || undefined,
        restriction: restriction === 'all' ? undefined : restriction,
        userId: personId,
        sort: sort?.key as SortKey | undefined,
        dir: sort?.dir,
        limit: PAGE_SIZE,
        offset,
      })
      .then((page) => {
        if (!live) return;
        setRows((current) => (offset === 0 ? page.items : [...current, ...page.items]));
        setTotal(page.total);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setFailure(caught instanceof Error ? caught.message : t('partyAccess.error.load'));
      })
      .finally(() => {
        if (!live) return;
        setLoading(false);
        setLoadingMore(false);
      });

    // A superseded request must not land on top of the newer one.
    return () => {
      live = false;
    };
    // `listKey` stands for every filter above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, offset, retry]);

  // The strip's numbers are the company's: no search, no filter, no page.
  useEffect(() => {
    let live = true;
    api
      .partyAccessSummary()
      .then((counts) => {
        if (live) setSummary(counts);
      })
      // A number we cannot show is not a reason to fail the list beside it.
      .catch(() => {
        if (live) setSummary(null);
      });
    return () => {
      live = false;
    };
  }, [revision]);

  // Fetched once rather than with every filter change: it feeds the editor's
  // picker and the toolbar's person filter. A failure is not fatal.
  useEffect(() => {
    if (!canAssign) return;
    void api
      .partyAccessPeople()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, [canAssign]);

  const filtered = restriction !== 'all' || personId !== undefined || term !== '';

  const clearFilters = (): void => {
    setSearch('');
    setPerson(null);
    onRestrictionChange('all');
  };

  const openEditor = useCallback((row: PartyAccessRow): void => {
    setSelectedId(row.partyId);
    setOpenParty(row);
  }, []);

  const columns = useMemo<DataTableColumn<PartyAccessRow>[]>(
    () => [
      {
        key: 'code',
        header: t('partyAccess.column.code'),
        width: '9rem',
        sortable: true,
        render: (row) => <span className="ob-mono">{row.partyCode}</span>,
      },
      {
        key: 'name',
        header: t('partyAccess.column.party'),
        sortable: true,
        render: (row) => row.partyName,
      },
      {
        key: 'city',
        header: t('partyAccess.column.city'),
        priority: 3,
        width: '11rem',
        sortable: true,
        render: (row) => row.city ?? '—',
      },
      {
        key: 'access',
        header: t('partyAccess.column.access'),
        width: '9rem',
        sortable: true,
        render: (row) =>
          row.isRestricted ? (
            <StatusPill tone="accent">{t('partyAccess.restricted')}</StatusPill>
          ) : (
            <StatusPill>{t('partyAccess.open')}</StatusPill>
          ),
      },
      {
        key: 'assignees',
        header: t('partyAccess.column.assignedTo'),
        render: (row) => <AssigneeList assignees={row.assignees} />,
      },
      // Absent for a reader: a button nobody may use is not a control to grey.
      ...(canAssign
        ? [
            {
              key: 'edit',
              header: '',
              width: '8rem',
              align: 'right' as const,
              render: (row: PartyAccessRow) => (
                <Button
                  size="sm"
                  variant="secondary"
                  className="ob-row-action"
                  aria-label={`${t('partyAccess.action.edit')}: ${row.partyName}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openEditor(row);
                  }}
                >
                  {t('partyAccess.action.edit')}
                </Button>
              ),
            },
          ]
        : []),
    ],
    [canAssign, openEditor],
  );

  /** Up / Down move between rows; Enter (the table's own) opens one. */
  const onTableKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const row = (event.target as HTMLElement).closest('tr[data-row]');
    if (!row) return;
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    if (next instanceof HTMLElement && next.matches('tr[data-row]')) next.focus();
  };

  const stat = (value: Restriction, label: string, hint: string, count: number | undefined) => (
    <button
      type="button"
      className="ob-pa-stat"
      aria-pressed={restriction === value}
      onClick={() => onRestrictionChange(value)}
    >
      <span className="ob-pa-stat-label">{label}</span>
      <span className="ob-pa-stat-count">{count ?? '—'}</span>
      <span className="ob-pa-stat-hint">{hint}</span>
    </button>
  );

  const personOptions = useMemo(
    () => [
      { key: '__nobody__', label: t('partyAccess.filter.nobody'), value: null },
      ...people.map((item) => ({
        key: item.id,
        label: `${item.displayName} (${item.roleName})`,
        value: item as AssignablePerson | null,
      })),
    ],
    [people],
  );

  return (
    <div style={STACK}>
      <div style={{ ...ROW, justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('partyAccess.title')}
          </h1>
          <p className="ob-small" style={{ margin: 0, maxWidth: rem(640) }}>
            {t('partyAccess.intro')}
          </p>
        </div>
        {permissions.includes('parties.export') ? (
          <ButtonLink href={api.partyAccessExportUrl()}>
            {t('partyAccess.action.export')}
          </ButtonLink>
        ) : null}
      </div>

      <div className="ob-pa-strip" role="group" aria-label={t('partyAccess.strip.label')}>
        {stat('all', t('partyAccess.strip.total'), t('partyAccess.strip.totalHint'), summary?.total)}
        {stat(
          'restricted',
          t('partyAccess.strip.restricted'),
          t('partyAccess.strip.restrictedHint'),
          summary?.restricted,
        )}
        {stat('open', t('partyAccess.strip.open'), t('partyAccess.strip.openHint'), summary?.open)}
      </div>

      <div style={{ ...ROW, flexWrap: 'wrap' }}>
        <div className="ob-pa-search">
          <Input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search) {
                event.preventDefault();
                setSearch('');
              }
            }}
            placeholder={t('partyAccess.searchPlaceholder')}
            aria-label={t('partyAccess.searchPlaceholder')}
            data-screen-search
          />
          {search ? (
            <button
              type="button"
              className="ob-pa-search-clear"
              aria-label={t('partyAccess.search.clear')}
              onClick={() => {
                setSearch('');
                searchRef.current?.focus();
              }}
            >
              ×
            </button>
          ) : null}
        </div>

        <Segmented<Restriction>
          value={restriction}
          onChange={onRestrictionChange}
          options={[
            { value: 'all', label: t('partyAccess.filter.all') },
            { value: 'restricted', label: t('partyAccess.filter.restricted') },
            { value: 'open', label: t('partyAccess.filter.open') },
          ]}
        />

        {canAssign ? (
          person ? (
            <span className="ob-pa-chip">
              <span>
                {t('partyAccess.filter.person')}: {person.displayName}
              </span>
              <button
                type="button"
                aria-label={t('partyAccess.filter.personClear', { name: person.displayName })}
                onClick={() => setPerson(null)}
              >
                ×
              </button>
            </span>
          ) : (
            <div className="ob-pa-person">
              <Combobox
                options={personOptions}
                placeholder={t('partyAccess.filter.personPlaceholder')}
                onSelect={(option) => {
                  if (option.value === null) {
                    onRestrictionChange('open');
                    return;
                  }
                  setPerson(option.value);
                  // Somebody's parties are restricted ones by definition.
                  if (restriction === 'open') onRestrictionChange('all');
                }}
              />
            </div>
          )
        ) : null}

        <span style={{ flex: 1 }} />
        {!loading && !failure ? (
          <span className="ob-small" role="status" style={{ color: 'var(--fg-tertiary)' }}>
            {t('partyAccess.count', { shown: rows.length, total })}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="ob-pa-table">
          <SkeletonTable columns={columns} />
        </div>
      ) : failure ? (
        <ErrorState
          title={t('partyAccess.error.load')}
          description={failure}
          onAction={() => setRetry((count) => count + 1)}
        />
      ) : (
        <>
          {/* Row keyboard handling lives on this wrapper: the table renders its
              own rows and a row cannot be handed a handler. */}
          <div className="ob-pa-table" onKeyDown={onTableKeyDown}>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.partyId}
              onRowOpen={openEditor}
              selectedId={selectedId}
              sort={sort}
              onSortChange={setSort}
              sortLocally={false}
              empty={
                <EmptyState
                  title={
                    term
                      ? t('partyAccess.empty.search', { term })
                      : filtered
                        ? t('partyAccess.empty')
                        : t('partyAccess.empty.none')
                  }
                  actionLabel={filtered ? t('partyAccess.empty.clear') : undefined}
                  onAction={filtered ? clearFilters : undefined}
                />
              }
            />
          </div>
          <LoadMorePager
            hasMore={rows.length < total}
            loading={loadingMore}
            onLoadMore={() => setPaging({ key: listKey, offset: rows.length })}
          />
        </>
      )}

      {openParty ? (
        <AccessEditor
          party={openParty}
          people={people}
          canAssign={canAssign}
          onClose={() => setOpenParty(null)}
          onSaved={(row) => {
            setRows((current) =>
              current.map((item) => (item.partyId === row.partyId ? row : item)),
            );
            setSelectedId(row.partyId);
            setOpenParty(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Who a party is assigned to: the first few names with their level, then
 * "+N more". Two lines at most, so a row never grows without bound; the whole
 * list is the tooltip, so nothing is only ever readable by opening the editor.
 */
function AssigneeList({ assignees }: { assignees: PartyAccessAssignee[] }) {
  if (assignees.length === 0) {
    return <span className="ob-small">{t('partyAccess.everyone')}</span>;
  }

  const full = assignees
    .map((person) => `${person.displayName} (${levelLabel(person.level)})`)
    .join(', ');
  const shown = assignees.slice(0, NAMES_SHOWN);
  const hidden = assignees.length - shown.length;

  return (
    <span className="ob-pa-assignees" title={full}>
      {shown.map((person, index) => (
        <span key={person.userId} className="ob-pa-assignee">
          {person.displayName}
          <span className="ob-pa-level">{levelLabel(person.level)}</span>
          {index < shown.length - 1 || hidden > 0 ? ', ' : ''}
        </span>
      ))}
      {hidden > 0 ? (
        <span className="ob-pa-more">{t('partyAccess.more', { count: hidden })}</span>
      ) : null}
    </span>
  );
}

/**
 * The editor replaces the party's **whole** grant set, never a single add or
 * remove.
 *
 * That is not a UI shortcut — a permission set is approved as a whole, and the
 * server takes the same view (`party-access.service.ts`). It is also what makes
 * `expectedVersion` meaningful here: the version guards the set, so a save that
 * raced another administrator's is refused with the stored state offered for
 * reload rather than silently merged into a combination neither approved.
 */
function AccessEditor({
  party,
  people,
  canAssign,
  onClose,
  onSaved,
}: {
  party: PartyAccessRow;
  people: AssignablePerson[];
  canAssign: boolean;
  onClose: () => void;
  onSaved: (row: PartyAccessRow) => void;
}) {
  const [entries, setEntries] = useState<PartyAccessEntry[]>(
    party.assignees.map((person) => ({ userId: person.userId, level: person.level })),
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const baseline = useFormBaseline(
    party.assignees.map((person) => ({ userId: person.userId, level: person.level })),
  );

  const nameFor = useCallback(
    (userId: string): string =>
      people.find((person) => person.id === userId)?.displayName ??
      party.assignees.find((person) => person.userId === userId)?.displayName ??
      userId,
    [people, party.assignees],
  );

  /**
   * The picker's list and the party's existing assignees are two different
   * shapes carrying the same person, so both are consulted — somebody already
   * assigned is *absent* from `people` (it offers only the unassigned).
   */
  const avatarFor = useCallback(
    (userId: string) =>
      people.find((person) => person.id === userId)?.avatar ??
      party.assignees.find((person) => person.userId === userId)?.avatar ??
      null,
    [people, party.assignees],
  );

  const unassigned = useMemo(
    () =>
      people
        .filter((person) => !entries.some((entry) => entry.userId === person.id))
        .map((person) => ({
          key: person.id,
          label: `${person.displayName} (${person.roleName})`,
          value: person.id,
        })),
    [people, entries],
  );

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setFailure(null);
    try {
      onSaved(
        await api.savePartyAccess(party.partyId, { entries, expectedVersion: party.version }),
      );
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict) setStale(true);
      setFailure(caught instanceof Error ? caught.message : t('partyAccess.error.save'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  // "Save all and update": who may see a party, changed and not yet saved, is
  // saved if the Master accepts it. Only for somebody who may assign.
  useUnsavedWork(
    'party-access',
    canAssign && baseline.dirty(entries)
      ? { label: t('updates.saveAll.partyAccess', { name: party.partyName }), save }
      : null,
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={party.partyName}
      subtitle={party.partyCode}
      footer={
        canAssign ? (
          <div
            style={{
              display: 'flex',
              gap: 'var(--s-6)',
              justifyContent: 'flex-end',
              width: '100%',
            }}
          >
            <Button variant="ghost" onClick={onClose}>
              {t('partyAccess.action.cancel')}
            </Button>
            <Button variant="primary" busy={saving} onClick={() => void save()}>
              {t('partyAccess.action.save')}
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="ghost" onClick={onClose}>
              {t('action.close')}
            </Button>
          </div>
        )
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-12)',
          minHeight: rem(440),
        }}
      >
        {stale ? (
          <ConflictBanner
            action={
              <Button variant="ghost" onClick={onClose}>
                {t('partyAccess.reload')}
              </Button>
            }
          >
            {t('partyAccess.staleSave')}
          </ConflictBanner>
        ) : null}

        {failure && !stale ? (
          <ErrorState title={t('partyAccess.error.save')} description={failure} />
        ) : null}

        <p className="ob-small" style={{ margin: 0 }}>
          {entries.length === 0 ? t('partyAccess.explainOpen') : t('partyAccess.explainRestricted')}
        </p>

        {entries.length === 0 ? (
          <EmptyState title={t('partyAccess.noAssignees')} />
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-6)',
            }}
          >
            {entries.map((entry) => (
              <li key={entry.userId} style={ROW}>
                <Avatar name={nameFor(entry.userId)} avatar={avatarFor(entry.userId)} size="sm" />
                <span style={{ flex: 1 }}>{nameFor(entry.userId)}</span>
                {canAssign ? (
                  <>
                    <Segmented<PartyAccessLevel>
                      value={entry.level}
                      onChange={(level) =>
                        setEntries((current) =>
                          current.map((item) =>
                            item.userId === entry.userId ? { ...item, level } : item,
                          ),
                        )
                      }
                      options={[
                        { value: 'view', label: t('partyAccess.level.view') },
                        { value: 'manage', label: t('partyAccess.level.manage') },
                      ]}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setEntries((current) =>
                          current.filter((item) => item.userId !== entry.userId),
                        )
                      }
                    >
                      {t('partyAccess.remove')}
                    </Button>
                  </>
                ) : (
                  <StatusPill>{levelLabel(entry.level)}</StatusPill>
                )}
              </li>
            ))}
          </ul>
        )}

        {canAssign ? (
          <Combobox
            options={unassigned}
            placeholder={t('partyAccess.addPerson')}
            onSelect={(option) =>
              setEntries((current) => [...current, { userId: option.value, level: 'view' }])
            }
          />
        ) : null}
      </div>
    </Modal>
  );
}
