/**
 * The Party Access editor: one party's whole grant set, in a modal.
 *
 * Split out of `PartyAccessScreen.tsx` so the list and the editor can change independently.
 * Like the screen, **this file is byte-identical to its twin** (`master/web/src/screens/` and
 * `office/web/src/screens/`), and `master/tests/party-access-screen-parity.test.ts` fails
 * otherwise: the two panels keep separate copies of `ui/` and of their `api` client, so a
 * screen that imports `{ api, ApiError }` can only be shared by being duplicated.
 */

import { useCallback, useMemo, useState } from 'react';
import type {
  AssignablePerson,
  PartyAccessEntry,
  PartyAccessLevel,
  PartyAccessRow,
} from '@orderbook/shared';

import { api, ApiError } from '../api';
import {
  Avatar,
  Button,
  Combobox,
  ConflictBanner,
  EmptyState,
  ErrorState,
  Modal,
  Segmented,
  StatusPill,
  rem,
  t,
  useFormBaseline,
  useUnsavedWork,
} from '@orderbook/ui';

export interface PartyAccessEditorProps {
  /** The party and its grants as the list loaded them; `version` guards the save. */
  party: PartyAccessRow;
  /** Everyone who can be assigned (`/api/party-access/people`); empty while loading, or without `party.assign`. */
  people: AssignablePerson[];
  /** `party.assign`. False is the read-only view: levels as pills, nothing to add, remove or save. */
  canEdit: boolean;
  /** The Master's row after a successful save. The editor does not close itself; the host does, on this. */
  onSaved: (row: PartyAccessRow) => void;
  /** The editor wants to close (Cancel, Close, Esc, the scrim) and has nothing unsaved left to lose. */
  onClose: () => void;
}

const ROW = { display: 'flex', alignItems: 'center', gap: 'var(--s-8)' } as const;

function levelLabel(level: PartyAccessLevel): string {
  return level === 'manage' ? t('partyAccess.level.manage') : t('partyAccess.level.view');
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
export function PartyAccessEditor({ party, people, canEdit, onClose, onSaved }: PartyAccessEditorProps) {
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
    canEdit && baseline.dirty(entries)
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
        canEdit ? (
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
                {canEdit ? (
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

        {canEdit ? (
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
