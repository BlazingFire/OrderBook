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
import type { KeyboardEvent, MouseEvent } from 'react';
import type {
  AssignablePerson,
  PartyAccessAssignee,
  PartyAccessLevel,
  PartyAccessRow,
} from '@orderbook/shared';

import { api } from '../api';
import { PartyAccessEditor } from './PartyAccessEditor';
import {
  Button,
  ButtonLink,
  Combobox,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  LoadMorePager,
  Segmented,
  SkeletonTable,
  StatusPill,
  rem,
  t,
  useDebounced,
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

/** The table's own default row height, for when a row has not been measured. */
const ROW_PX = 32;

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
  const rowsRef = useRef<PartyAccessRow[]>([]);
  rowsRef.current = rows;
  /** What the Master says the filtered query matches, company-wide — not the page. */
  const [total, setTotal] = useState(0);
  /** The strip's numbers: the whole company's, whatever the search or filter says. */
  const [summary, setSummary] = useState<{
    total: number;
    restricted: number;
    open: number;
  } | null>(null);
  /** Bumped after a save: the counts changed, and nothing else tells this screen so yet. */
  const [summaryTick, setSummaryTick] = useState(0);
  const [people, setPeople] = useState<AssignablePerson[]>([]);
  const [search, setSearch] = useState('');
  /** `null` — anybody; otherwise only parties this person is assigned to. */
  const [person, setPerson] = useState<AssignablePerson | null>(null);
  const [sort, setSort] = useState<DataTableSort | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  /** A filter, a sort or a live update is being fetched while the old rows are still shown. */
  const [fetching, setFetching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [openParty, setOpenParty] = useState<PartyAccessRow | null>(null);
  /** Kept after the editor closes, so the row somebody just worked on stays marked. */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  /*
   * "Open" means nobody is assigned, so a person filter beside it can only be empty
   * by contradiction. Choosing Open — from the strip, the segmented control, the
   * sidebar or "Nobody" in the person list — drops the person. Derived first, so the
   * contradictory query is never sent; the effect then lets the state catch up.
   */
  const activePerson = restriction === 'open' ? null : person;
  useEffect(() => {
    if (restriction === 'open') setPerson(null);
  }, [restriction]);
  const personId = activePerson?.id;

  /*
   * One key for "which list is this". A new key is a new list, not more of the
   * old one: the page offset belongs to the key it was asked under, so a changed
   * filter or sort starts again at the top without a second effect to reset it.
   * A live update (`revision`) is deliberately *not* in it: it refreshes the rows
   * already loaded instead of throwing the scrolled-to pages away.
   */
  const filterKey = [term, restriction, personId ?? '', sort?.key ?? '', sort?.dir ?? ''].join('|');
  const [paging, setPaging] = useState({ key: filterKey, offset: 0 });
  const offset = paging.key === filterKey ? paging.offset : 0;
  const seen = useRef({ key: filterKey, revision });

  useEffect(() => {
    let live = true;
    const filterChanged = seen.current.key !== filterKey;
    const refresh = !filterChanged && seen.current.revision !== revision;
    seen.current = { key: filterKey, revision };
    const mode = refresh ? 'refresh' : offset === 0 ? 'replace' : 'append';

    setFailure(null);
    if (mode === 'append') setLoadingMore(true);
    else setFetching(true);

    const ask = (at: number) =>
      api.partyAccess({
        search: term || undefined,
        restriction: restriction === 'all' ? undefined : restriction,
        userId: personId,
        sort: sort?.key as SortKey | undefined,
        dir: sort?.dir,
        limit: PAGE_SIZE,
        offset: at,
      });

    void (async () => {
      try {
        if (mode === 'refresh') {
          // As many pages as are on screen now, so the list keeps its length.
          const pages = Math.max(1, Math.ceil(rowsRef.current.length / PAGE_SIZE));
          let items: PartyAccessRow[] = [];
          let count = 0;
          for (let page = 0; page < pages; page += 1) {
            const answer = await ask(page * PAGE_SIZE);
            if (!live) return;
            items = [...items, ...answer.items];
            count = answer.total;
          }
          setRows(items);
          setTotal(count);
        } else {
          const answer = await ask(offset);
          if (!live) return;
          setRows((current) => (mode === 'replace' ? answer.items : [...current, ...answer.items]));
          setTotal(answer.total);
        }
      } catch (caught) {
        // A live refresh that fails leaves the list as it was; a failed query does not.
        if (live && mode !== 'refresh') {
          setFailure(caught instanceof Error ? caught.message : t('partyAccess.error.load'));
        }
      } finally {
        if (live) {
          setLoading(false);
          setLoadingMore(false);
          setFetching(false);
        }
      }
    })();

    // A superseded request must not land on top of the newer one.
    return () => {
      live = false;
    };
    // `filterKey` stands for every filter above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, offset, retry, revision]);

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
  }, [revision, summaryTick]);

  // Fetched once rather than with every filter change: it feeds the editor's
  // picker and the toolbar's person filter, which a reader has too (the Master
  // serves names and roles to `party.accessAll` as well). A failure is not fatal.
  useEffect(() => {
    void api
      .partyAccessPeople()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, []);

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
        width: '6.5rem',
        sortable: true,
        render: (row) => (
          <span className="ob-mono ob-pa-ellipsis" title={row.partyCode}>
            {row.partyCode}
          </span>
        ),
      },
      {
        key: 'name',
        header: t('partyAccess.column.party'),
        width: '1.6fr',
        sortable: true,
        // The one control in the row that opens it, so a row is not a button with a
        // button inside it: Tab reaches it, Enter opens it, and a click anywhere else
        // in the row is handled once, on the table (`onTableClick`).
        render: (row) => (
          <button
            type="button"
            className="ob-pa-open"
            data-party-id={row.partyId}
            title={row.partyName}
          >
            {row.partyName}
          </button>
        ),
      },
      {
        key: 'city',
        header: t('partyAccess.column.city'),
        priority: 3,
        width: '8rem',
        sortable: true,
        render: (row) => (
          <span className="ob-pa-ellipsis" title={row.city ?? undefined}>
            {row.city ?? '—'}
          </span>
        ),
      },
      {
        key: 'access',
        header: t('partyAccess.column.access'),
        width: '7rem',
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
        // The column with the most to say.
        width: '2fr',
        render: (row) => <AssigneeList assignees={row.assignees} />,
      },
      // Absent for a reader: a button nobody may use is not a control to grey.
      ...(canAssign
        ? [
            {
              key: 'edit',
              header: '',
              width: '7rem',
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

  /** A click anywhere on a row opens it, as on every other list. */
  const onTableClick = (event: MouseEvent<HTMLDivElement>): void => {
    const row = (event.target as HTMLElement).closest('tr[data-row]');
    const id = row?.querySelector<HTMLElement>('[data-party-id]')?.dataset.partyId;
    const party = rows.find((item) => item.partyId === id);
    if (party) openEditor(party);
  };

  const control = (partyId: string): HTMLElement | undefined =>
    Array.from(tableRef.current?.querySelectorAll<HTMLElement>('[data-party-id]') ?? []).find(
      (element) => element.dataset.partyId === partyId,
    );

  /**
   * Up / Down move between rows. The table renders only a window of a long list, so
   * a row beyond it is not in the page yet: scroll that way until it is, then focus it.
   */
  const onTableKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const current = (event.target as HTMLElement).closest('tr[data-row]');
    const id = current?.querySelector<HTMLElement>('[data-party-id]')?.dataset.partyId;
    const index = rows.findIndex((item) => item.partyId === id);
    const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (index < 0 || !next) return;
    event.preventDefault();

    const here = control(next.partyId);
    if (here) {
      here.focus();
      return;
    }
    const pane = tableRef.current?.closest('.ob-pane');
    if (!pane) return;
    const step = ((current as HTMLElement).offsetHeight || ROW_PX) * 4;
    let tries = 0;
    const tick = (): void => {
      const found = control(next.partyId);
      if (found) {
        found.focus();
        return;
      }
      tries += 1;
      if (tries > 80) return;
      pane.scrollTop += event.key === 'ArrowDown' ? step : -step;
      window.setTimeout(tick, 16);
    };
    tick();
  };

  const stat = (value: Restriction, label: string, hint: string, count: number | undefined) => (
    <button
      type="button"
      className="ob-pa-stat"
      title={hint}
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
        {stat(
          'all',
          t('partyAccess.strip.total'),
          t('partyAccess.strip.totalHint'),
          summary?.total,
        )}
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

        {activePerson ? (
          <span className="ob-pa-chip">
            <span>
              {t('partyAccess.filter.person')}: {activePerson.displayName}
            </span>
            <button
              type="button"
              aria-label={t('partyAccess.filter.personClear', { name: activePerson.displayName })}
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
                // Somebody's parties are restricted ones: leave "Open" for it.
                if (restriction === 'open') onRestrictionChange('all');
              }}
            />
          </div>
        )}

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
          {/* Row clicks and keys are handled here, once: the table renders its own
              rows, and a row that was itself a button would hold the Edit button inside
              it. Dimmed while a filter, sort or live update is being fetched. */}
          <div
            ref={tableRef}
            className="ob-pa-table"
            aria-busy={fetching}
            data-fetching={fetching || undefined}
            onClick={onTableClick}
            onKeyDown={onTableKeyDown}
          >
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.partyId}
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
            onLoadMore={() => setPaging({ key: filterKey, offset: rows.length })}
          />
        </>
      )}

      {openParty ? (
        <PartyAccessEditor
          party={openParty}
          people={people}
          canEdit={canAssign}
          onClose={() => setOpenParty(null)}
          onSaved={(row) => {
            setRows((current) =>
              current.map((item) => (item.partyId === row.partyId ? row : item)),
            );
            setSelectedId(row.partyId);
            setSummaryTick((count) => count + 1);
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
 *
 * A grant held by somebody who is no longer active still counts — the party is
 * restricted, and only a reader with `party.accessAll` can see it — so it is shown,
 * muted and tagged, rather than left out and leaving a "Restricted" row that
 * appears to name nobody.
 */
function AssigneeList({ assignees }: { assignees: PartyAccessAssignee[] }) {
  if (assignees.length === 0) {
    return <span className="ob-small">{t('partyAccess.everyone')}</span>;
  }

  const full = assignees
    .map(
      (person) =>
        `${person.displayName} (${levelLabel(person.level)})${
          person.isActive === false ? ` — ${t('partyAccess.assignee.inactive')}` : ''
        }`,
    )
    .join(', ');
  const shown = assignees.slice(0, NAMES_SHOWN);
  const hidden = assignees.length - shown.length;

  return (
    <span className="ob-pa-assignees" title={full}>
      {shown.map((person, index) => {
        const inactive = person.isActive === false;
        return (
          <span
            key={person.userId}
            className={inactive ? 'ob-pa-assignee ob-pa-inactive' : 'ob-pa-assignee'}
          >
            {person.displayName}
            <span className="ob-pa-level">{levelLabel(person.level)}</span>
            {inactive ? (
              <span className="ob-pa-level ob-pa-inactive-tag">
                {t('partyAccess.assignee.inactive')}
              </span>
            ) : null}
            {index < shown.length - 1 || hidden > 0 ? ', ' : ''}
          </span>
        );
      })}
      {hidden > 0 ? (
        <span className="ob-pa-more">{t('partyAccess.more', { count: hidden })}</span>
      ) : null}
    </span>
  );
}
