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
 * This is also the Master Panel's first parties list. It has never had one:
 * parties are created and edited on the Office Panel's Catalog screen, and this
 * screen deliberately does not duplicate that — it edits access, not the party.
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
  Modal,
  Segmented,
  SkeletonTable,
  StatusPill,
  t,
  type DataTableColumn,
} from '@orderbook/ui';

interface Props {
  permissions: string[];
  /** Bumped by the live socket whenever data changes. */
  revision: number;
}

type Restriction = 'all' | 'open' | 'restricted';

const ROW = { display: 'flex', alignItems: 'center', gap: 'var(--s-8)' } as const;
const STACK = { display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' } as const;

function levelLabel(level: PartyAccessLevel): string {
  return level === 'manage' ? t('partyAccess.level.manage') : t('partyAccess.level.view');
}

export function PartyAccessScreen({ permissions, revision }: Props) {
  const canAssign = permissions.includes('party.assign');

  const [rows, setRows] = useState<PartyAccessRow[]>([]);
  const [people, setPeople] = useState<AssignablePerson[]>([]);
  const [search, setSearch] = useState('');
  const [restriction, setRestriction] = useState<Restriction>('all');
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [openParty, setOpenParty] = useState<PartyAccessRow | null>(null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const page = await api.partyAccess({
        search: search.trim() || undefined,
        restriction: restriction === 'all' ? undefined : restriction,
      });
      setRows(page.items);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('partyAccess.error.load'));
    } finally {
      setLoading(false);
    }
  }, [search, restriction]);

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
          {t('partyAccess.summary', {
            restricted: rows.filter((row) => row.isRestricted).length,
            total: rows.length,
          })}
        </p>
      ) : null}

      <div style={ROW}>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('partyAccess.searchPlaceholder')}
          aria-label={t('partyAccess.searchPlaceholder')}
        />
        <Segmented<Restriction>
          value={restriction}
          onChange={setRestriction}
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
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.partyId}
          openOn="click"
          onRowOpen={(row) => setOpenParty(row)}
          selectedId={openParty?.partyId}
          empty={<EmptyState title={t('partyAccess.empty')} />}
        />
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

  const shown = assignees.slice(0, 4);
  const overflow = assignees.length - shown.length;

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)' }}>
      {shown.map((person) => (
        <span key={person.userId} title={`${person.displayName} · ${levelLabel(person.level)}`}>
          <Avatar name={person.displayName} avatar={person.avatar} size="sm" />
        </span>
      ))}
      {overflow > 0 ? (
        <span className="ob-small">{t('partyAccess.more', { count: overflow })}</span>
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

  const save = async (): Promise<void> => {
    setSaving(true);
    setFailure(null);
    try {
      onSaved(
        await api.savePartyAccess(party.partyId, { entries, expectedVersion: party.version }),
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict) setStale(true);
      setFailure(caught instanceof Error ? caught.message : t('partyAccess.error.save'));
    } finally {
      setSaving(false);
    }
  };

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
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
