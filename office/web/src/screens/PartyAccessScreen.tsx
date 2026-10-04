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

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  Segmented,
  SkeletonTable,
  StatusPill,
  rem,
  t,
  type DataTableColumn,
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

/** The largest page the Master will serve; `PAGING.maxLimit` on its side. */
const PAGE_SIZE = 200;
const STACK = { display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' } as const;

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
  /**
   * What the Master says the filtered query matches, company-wide.
   *
   * Kept because `setRows(page.items)` used to throw it away and the summary
   * rendered `rows.length` as the total — and the screen asked for no `limit`,
   * so the Master clamped to its default of 50. A company with 200 parties saw
   * "12 of 50 parties are restricted", with 50 presented as the size of the
   * book. The number was never the total; it was the page.
   */
  const [total, setTotal] = useState(0);
  /**
   * Restricted parties company-wide, not in the page.
   *
   * Its own count query rather than `rows.filter(...)`: with paging, a filter
   * over the loaded rows answers a question about this page while looking like
   * an answer about the company. `limit: 1` because only `total` is wanted.
   */
  const [restrictedTotal, setRestrictedTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [people, setPeople] = useState<AssignablePerson[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [openParty, setOpenParty] = useState<PartyAccessRow | null>(null);

  // A changed filter is a new list, not more of the old one.
  useEffect(() => {
    setOffset(0);
  }, [search, restriction]);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const page = await api.partyAccess({
        search: search.trim() || undefined,
        restriction: restriction === 'all' ? undefined : restriction,
        limit: PAGE_SIZE,
        offset,
      });
      setRows((current) => (offset === 0 ? page.items : [...current, ...page.items]));
      setTotal(page.total);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('partyAccess.error.load'));
    } finally {
      setLoading(false);
    }
  }, [search, restriction, offset]);

  // Separate from the list query, and deliberately not refetched per page.
  useEffect(() => {
    void api
      .partyAccess({ search: search.trim() || undefined, restriction: 'restricted', limit: 1 })
      .then((page) => setRestrictedTotal(page.total))
      // A failed count is a number we cannot show, not a reason to fail the
      // screen the list query has already filled.
      .catch(() => setRestrictedTotal(0));
  }, [search, revision]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // Fetched once rather than with every filter change: this list only exists to
  // offer names in the editor. A failure here is not fatal — the table still
  // reads correctly, only the picker goes empty.
  useEffect(() => {
    if (!canAssign) return;
    void api
      .partyAccessPeople()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, [canAssign]);

  const columns = useMemo<DataTableColumn<PartyAccessRow>[]>(
    () => [
      {
        key: 'code',
        header: t('partyAccess.column.code'),
        width: '9rem',
        render: (row) => <span className="ob-mono">{row.partyCode}</span>,
      },
      { key: 'name', header: t('partyAccess.column.party'), render: (row) => row.partyName },
      {
        key: 'city',
        header: t('partyAccess.column.city'),
        priority: 3,
        width: '11rem',
        render: (row) => row.city ?? '—',
      },
      {
        key: 'access',
        header: t('partyAccess.column.access'),
        width: '9rem',
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
    ],
    [],
  );

  return (
    <div style={STACK}>
      <div style={{ ...ROW, justifyContent: 'space-between' }}>
        <h1 className="ob-title" style={{ margin: 0 }}>
          {t('partyAccess.title')}
        </h1>
        {permissions.includes('parties.export') ? (
          <ButtonLink href={api.partyAccessExportUrl()}>
            {t('partyAccess.action.export')}
          </ButtonLink>
        ) : null}
      </div>

      <p className="ob-small" style={{ margin: 0 }}>
        {t('partyAccess.intro')}
      </p>

      {!loading && !failure ? (
        <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
          {t('partyAccess.summary', { restricted: restrictedTotal, total })}
          {rows.length < total ? ` ${t('partyAccess.showing', { shown: rows.length })}` : ''}
        </p>
      ) : null}

      <div style={ROW}>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('partyAccess.searchPlaceholder')}
          aria-label={t('partyAccess.searchPlaceholder')}
          data-screen-search
          style={{ width: rem(260) }}
        />
        <Segmented<Restriction>
          value={restriction}
          onChange={onRestrictionChange}
          options={[
            { value: 'all', label: t('partyAccess.filter.all') },
            { value: 'restricted', label: t('partyAccess.filter.restricted') },
            { value: 'open', label: t('partyAccess.filter.open') },
          ]}
        />
      </div>

      {loading ? (
        <SkeletonTable columns={columns} />
      ) : failure ? (
        <ErrorState
          title={t('partyAccess.error.load')}
          description={failure}
          onAction={() => void load()}
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.partyId}
            onRowOpen={(row) => setOpenParty(row)}
            selectedId={openParty?.partyId}
            empty={<EmptyState title={t('partyAccess.empty')} />}
          />
          {rows.length < total ? (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Button variant="secondary" onClick={() => setOffset(rows.length)}>
                {t('parties.loadMore')}
              </Button>
            </div>
          ) : null}
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
            setOpenParty(null);
          }}
        />
      ) : null}
    </div>
  );
}

function AssigneeList({ assignees }: { assignees: PartyAccessAssignee[] }) {
  if (assignees.length === 0) {
    return <span className="ob-small">{t('partyAccess.everyone')}</span>;
  }

  return (
    <span>
      {assignees.map((person) => `${person.displayName} (${levelLabel(person.level)})`).join(', ')}
    </span>
  );
}
