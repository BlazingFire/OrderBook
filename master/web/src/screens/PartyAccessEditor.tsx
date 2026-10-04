/**
 * The Party Access editor: one party's whole grant set, in a modal.
 *
 * Split out of `PartyAccessScreen.tsx` so the list and the editor can change independently.
 * Like the screen, **this file is byte-identical to its twin** (`master/web/src/screens/` and
 * `office/web/src/screens/`), and `master/tests/party-access-screen-parity.test.ts` fails
 * otherwise: the two panels keep separate copies of `ui/` and of their `api` client, so a
 * screen that imports `{ api, ApiError }` can only be shared by being duplicated.
 *
 * What it does, in the order a person meets it:
 *  - the header says which party and whether it is open to everyone or restricted, live;
 *  - the explainer under it changes with that state;
 *  - the people on the party are rows: face, full name, role, a View / Manage switch and Remove;
 *    somebody who can no longer sign in is marked "Inactive user" and stays until removed;
 *  - **Add a person** is a typeahead (name or role); **Add several people** is a checklist; **Copy
 *    access from another party** brings over the people who can see that one;
 *  - Save is off until something changed, shows it is busy, and says so inline when it fails;
 *    closing with unsaved work asks first (inside this dialog, never in a second one);
 *  - a save that raced another administrator's is refused with a banner that reloads the stored
 *    state, because the editor replaces the party's **whole** grant set, never one add or remove
 *    (a permission set is approved as a whole, and the server takes the same view).
 *
 * Without `canEdit` (a reader with `party.accessAll`) none of the controls exist: absent, not
 * greyed (`AccessScreen.tsx`'s convention).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssignablePerson,
  PartyAccessEntry,
  PartyAccessLevel,
  PartyAccessRow,
  UserAvatar,
} from '@orderbook/shared';

import { api, ApiError } from '../api';
import {
  Avatar,
  Button,
  Combobox,
  ConflictBanner,
  EmptyState,
  Modal,
  MultiPicker,
  Segmented,
  StatusPill,
  rem,
  t,
  translator,
  useFormBaseline,
  useUnsavedWork,
  type ComboboxOption,
  type MultiPickerOption,
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

/** What the editor knows about a person it may have to draw: from the picker list or from a grant. */
interface Known {
  displayName: string;
  roleName: string;
  avatar: UserAvatar | null | undefined;
}

type Panel = 'bulk' | 'copy' | null;

/** The footer keeps this height whether it shows Save or the discard question, so the dialog does not jump. */
const FOOT_MIN = rem(44);
const ROW = { display: 'flex', alignItems: 'center', gap: 'var(--s-8)' } as const;
/** How many parties the copy picker asks for at a time; it narrows as the person types. */
const COPY_PAGE = 20;
/** Typing in the copy picker waits this long before asking the Master. */
const COPY_DEBOUNCE_MS = 250;

function levelLabel(level: PartyAccessLevel): string {
  return level === 'manage' ? t('partyAccess.level.manage') : t('partyAccess.level.view');
}

/** The grant set as one comparable value: order never matters to the server, so it does not to "dirty". */
function canonical(entries: readonly PartyAccessEntry[]): PartyAccessEntry[] {
  return entries
    .map((entry) => ({ userId: entry.userId, level: entry.level }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });

export function PartyAccessEditor({ party, people, canEdit, onClose, onSaved }: PartyAccessEditorProps) {
  /** The party as the Master last said it: the list's row, or what a reload fetched. */
  const [stored, setStored] = useState(party);
  const [entries, setEntries] = useState<PartyAccessEntry[]>(() => canonical(party.assignees));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  /** What the last action did, spoken to a screen reader and shown under the controls. */
  const [message, setMessage] = useState<string | null>(null);
  const [extra, setExtra] = useState<ReadonlyMap<string, Known>>(new Map());
  const baseline = useFormBaseline(canonical(party.assignees));
  const addRef = useRef<HTMLInputElement>(null);
  const quietFocus = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);

  // --- Who is who ---------------------------------------------------------

  const known = useMemo(() => {
    const map = new Map<string, Known>();
    for (const grant of stored.assignees) {
      map.set(grant.userId, { displayName: grant.displayName, roleName: grant.roleName, avatar: grant.avatar });
    }
    for (const [userId, info] of extra) map.set(userId, info);
    for (const person of people) {
      map.set(person.id, { displayName: person.displayName, roleName: person.roleName, avatar: person.avatar });
    }
    return map;
  }, [stored.assignees, extra, people]);

  const inactive = useMemo(
    () => new Set(stored.assignees.filter((grant) => !grant.isActive).map((grant) => grant.userId)),
    [stored.assignees],
  );

  const nameOf = useCallback((userId: string): string => known.get(userId)?.displayName ?? userId, [known]);

  const chosen = useMemo(() => new Set(entries.map((entry) => entry.userId)), [entries]);

  /** Everyone who can still be added: live, and not already on the party. */
  const unassigned = useMemo(
    () => people.filter((person) => !chosen.has(person.id)).sort((a, b) => byName(a.displayName, b.displayName)),
    [people, chosen],
  );

  /** The rows: live people by name, then the inactive ones by name. */
  const ordered = useMemo(
    () =>
      [...entries].sort((a, b) => {
        const flag = Number(inactive.has(a.userId)) - Number(inactive.has(b.userId));
        return flag || byName(nameOf(a.userId), nameOf(b.userId));
      }),
    [entries, inactive, nameOf],
  );

  const dirty = canEdit && baseline.dirty(canonical(entries));
  const opensEveryone = canEdit && entries.length === 0 && stored.assignees.length > 0;
  const hasInactive = ordered.some((entry) => inactive.has(entry.userId));

  // --- Editing the draft --------------------------------------------------

  const say = useCallback((text: string) => setMessage(text), []);

  const add = useCallback(
    (additions: readonly PartyAccessEntry[], info: ReadonlyMap<string, Known> = new Map()) => {
      setEntries((current) => {
        const have = new Set(current.map((entry) => entry.userId));
        return [...current, ...additions.filter((entry) => !have.has(entry.userId))];
      });
      if (info.size > 0) setExtra((current) => new Map([...current, ...info]));
    },
    [],
  );

  const setLevel = (userId: string, level: PartyAccessLevel) => {
    setEntries((current) => current.map((item) => (item.userId === userId ? { ...item, level } : item)));
    say(t('partyAccess.editor.levelSet', { name: nameOf(userId), level: levelLabel(level) }));
  };

  const remove = (userId: string) => {
    const at = ordered.findIndex((entry) => entry.userId === userId);
    setEntries((current) => current.filter((item) => item.userId !== userId));
    say(t('partyAccess.editor.removed', { name: nameOf(userId) }));
    // Keep the keyboard where the row was: the next row's Remove, else the field that adds.
    window.requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLElement>('[data-remove]');
      const next = buttons?.[Math.min(at, (buttons?.length ?? 1) - 1)];
      if (next) next.focus();
      else {
        // The last row went: the keyboard goes to the add field, which must not pop its list open.
        quietFocus.current = document.activeElement !== addRef.current;
        addRef.current?.focus();
        quietFocus.current = false;
      }
    });
  };

  const addOne = (option: ComboboxOption<string>) => {
    add([{ userId: option.value, level: 'view' }]);
    say(t('partyAccess.editor.added', { name: option.label, level: levelLabel('view') }));
  };

  /** Close a panel and hand the keyboard back to the field that adds people. */
  const closePanel = () => {
    setPanel(null);
    window.requestAnimationFrame(() => {
      // Handing the keyboard back must not pop the list open over what was just done.
      quietFocus.current = document.activeElement !== addRef.current;
      addRef.current?.focus();
      quietFocus.current = false;
    });
  };

  // --- Reload, save, close ------------------------------------------------

  const reload = async (): Promise<void> => {
    try {
      const row = await api.partyAccessFor(party.partyId);
      setStored(row);
      setEntries(canonical(row.assignees));
      baseline.mark(canonical(row.assignees));
      setStale(false);
      setFailure(null);
      setPanel(null);
      say(t('partyAccess.editor.reloaded'));
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : t('partyAccess.error.save'));
    }
  };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setFailure(null);
    try {
      const row = await api.savePartyAccess(party.partyId, {
        entries: canonical(entries),
        expectedVersion: stored.version,
      });
      setStored(row);
      baseline.mark(canonical(row.assignees));
      onSaved(row);
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
    dirty ? { label: t('updates.saveAll.partyAccess', { name: party.partyName }), save } : null,
  );

  /** Close, unless that would throw work away: then ask, in this dialog. */
  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirming(true);
    else onClose();
  };

  return (
    <Modal
      open
      // While the question is up, Escape (and the scrim) answer it with "keep editing".
      onClose={confirming ? () => setConfirming(false) : requestClose}
      size="lg"
      title={party.partyName}
      subtitle={
        <span style={{ ...ROW, flexWrap: 'wrap', gap: 'var(--s-8)' }}>
          <span className="ob-mono">{party.partyCode}</span>
          {party.city ? <span>{party.city}</span> : null}
          {entries.length === 0 ? (
            <StatusPill>{t('partyAccess.editor.stateOpen')}</StatusPill>
          ) : (
            <StatusPill tone="accent">
              {translator().tCount('partyAccess.editor.stateRestricted', entries.length)}
            </StatusPill>
          )}
        </span>
      }
      footer={
        confirming ? (
          <div
            role="alertdialog"
            aria-label={t('partyAccess.editor.discardTitle')}
            style={{ ...ROW, justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', minHeight: FOOT_MIN }}
          >
            <span style={{ minWidth: 0 }}>
              <strong>{t('partyAccess.editor.discardTitle')}</strong>{' '}
              <span className="ob-small">{t('partyAccess.editor.discardBody', { name: party.partyName })}</span>
            </span>
            <span style={ROW}>
              <Button variant="primary" autoFocus onClick={() => setConfirming(false)}>
                {t('partyAccess.editor.keepEditing')}
              </Button>
              <Button variant="danger" onClick={onClose}>
                {t('partyAccess.editor.discard')}
              </Button>
            </span>
          </div>
        ) : canEdit ? (
          <div style={{ ...ROW, justifyContent: 'space-between', width: '100%', minHeight: FOOT_MIN }}>
            <span
              className="ob-small"
              role="status"
              style={{ color: dirty ? 'var(--fg-primary)' : 'var(--fg-tertiary)' }}
            >
              {dirty ? (
                <>
                  <span aria-hidden="true" style={{ color: 'var(--state-offline)' }}>
                    ●{' '}
                  </span>
                  {t('partyAccess.editor.unsaved')}
                </>
              ) : (
                t('partyAccess.editor.noChanges')
              )}
            </span>
            <span style={{ ...ROW, gap: 'var(--s-6)' }}>
              <Button variant="ghost" onClick={requestClose} disabled={saving}>
                {t('partyAccess.action.cancel')}
              </Button>
              <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>
                {t('partyAccess.action.save')}
              </Button>
            </span>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)', minHeight: rem(440) }}>
        {stale ? (
          <ConflictBanner
            action={
              <Button variant="secondary" size="sm" onClick={() => void reload()}>
                {t('partyAccess.reload')}
              </Button>
            }
          >
            {t('partyAccess.staleSave')}
          </ConflictBanner>
        ) : null}

        {failure && !stale ? (
          <div className="ob-banner ob-banner--conflict" role="alert">
            <span style={{ flex: 1 }}>
              <strong>{t('partyAccess.error.save')}</strong> {failure}
            </span>
          </div>
        ) : null}

        <p className="ob-small" style={{ margin: 0 }}>
          {canEdit
            ? entries.length === 0
              ? t('partyAccess.explainOpen')
              : t('partyAccess.explainRestricted')
            : entries.length === 0
              ? t('partyAccess.editor.readOnlyOpen')
              : t('partyAccess.editor.readOnlyRestricted')}
        </p>

        {opensEveryone ? (
          <div className="ob-banner ob-banner--offline" role="status">
            <span style={{ flex: 1 }}>
              <strong>{t('partyAccess.editor.openWarningTitle')}</strong>{' '}
              {t('partyAccess.editor.openWarningBody', { name: party.partyName })}
            </span>
          </div>
        ) : null}

        {canEdit ? (
          <>
            <div style={{ ...ROW, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
                <Combobox<string>
                  inputRef={addRef}
                  quietFocusRef={quietFocus}
                  ariaLabel={t('partyAccess.editor.addLabel')}
                  placeholder={t('partyAccess.editor.addPlaceholder')}
                  emptyLabel={
                    people.length === 0 ? t('partyAccess.editor.noPeople') : t('partyAccess.editor.allAssigned')
                  }
                  options={unassigned.map((person) => ({
                    key: person.id,
                    label: person.displayName,
                    hint: person.roleName,
                    value: person.id,
                    leading: <Avatar name={person.displayName} avatar={person.avatar} size="xs" />,
                  }))}
                  onSelect={addOne}
                />
              </div>
              <Button
                variant={panel === 'bulk' ? 'primary' : 'secondary'}
                aria-expanded={panel === 'bulk'}
                onClick={() => setPanel(panel === 'bulk' ? null : 'bulk')}
              >
                {t('partyAccess.editor.bulkButton')}
              </Button>
              <Button
                variant={panel === 'copy' ? 'primary' : 'secondary'}
                aria-expanded={panel === 'copy'}
                onClick={() => setPanel(panel === 'copy' ? null : 'copy')}
              >
                {t('partyAccess.editor.copyButton')}
              </Button>
            </div>

            {panel === 'bulk' ? (
              <BulkPanel
                options={unassigned}
                onAdd={(userIds, level) => {
                  add(userIds.map((userId) => ({ userId, level })));
                  say(translator().tCount('partyAccess.editor.bulkDone', userIds.length, { level: levelLabel(level) }));
                  closePanel();
                }}
                onClose={closePanel}
              />
            ) : null}

            {panel === 'copy' ? (
              <CopyPanel
                partyId={party.partyId}
                onCopy={(source) => {
                  const live = source.assignees.filter((grant) => grant.isActive);
                  const leftOut = source.assignees.length - live.length;
                  const fresh = live.filter((grant) => !chosen.has(grant.userId));
                  const notes: string[] = [];
                  if (source.assignees.length === 0) {
                    notes.push(t('partyAccess.editor.copyNothing', { party: source.partyName }));
                  } else if (fresh.length === 0) {
                    notes.push(t('partyAccess.editor.copyAlreadyHere', { party: source.partyName }));
                  } else {
                    add(
                      fresh.map((grant) => ({ userId: grant.userId, level: grant.level })),
                      new Map(
                        fresh.map((grant) => [
                          grant.userId,
                          { displayName: grant.displayName, roleName: grant.roleName, avatar: grant.avatar },
                        ]),
                      ),
                    );
                    notes.push(translator().tCount('partyAccess.editor.copied', fresh.length, { party: source.partyName }));
                  }
                  if (leftOut > 0) notes.push(translator().tCount('partyAccess.editor.copyLeftOut', leftOut));
                  say(notes.join(' '));
                  closePanel();
                }}
                onClose={closePanel}
              />
            ) : null}
          </>
        ) : null}

        <div
          className="ob-small"
          role="status"
          aria-live="polite"
          style={{ minHeight: '1.25em', color: 'var(--fg-secondary)' }}
        >
          {message}
        </div>

        {entries.length === 0 ? (
          <EmptyState title={t('partyAccess.noAssignees')} />
        ) : (
          <ul
            ref={listRef}
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-6)',
            }}
          >
            {ordered.map((entry) => {
              const info = known.get(entry.userId);
              const name = nameOf(entry.userId);
              const gone = inactive.has(entry.userId);
              return (
                <li
                  key={entry.userId}
                  data-user={entry.userId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: canEdit ? 'auto minmax(0, 1fr) auto auto' : 'auto minmax(0, 1fr) auto',
                    alignItems: 'center',
                    gap: 'var(--s-12)',
                    padding: 'var(--s-6) var(--s-8)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--r-md)',
                    background: 'var(--bg-surface)',
                  }}
                >
                  <Avatar name={name} avatar={info?.avatar} size="sm" />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span
                      title={name}
                      style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {name}
                    </span>
                    <span
                      className="ob-small"
                      title={info?.roleName}
                      style={{
                        color: 'var(--fg-tertiary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {gone ? (
                        <>
                          <StatusPill tone="offline">{t('partyAccess.editor.deactivated')}</StatusPill>{' '}
                        </>
                      ) : null}
                      {info?.roleName}
                    </span>
                  </span>
                  {canEdit ? (
                    <>
                      <Segmented<PartyAccessLevel>
                        label={t('partyAccess.editor.levelFor', { name })}
                        value={entry.level}
                        onChange={(level) => setLevel(entry.userId, level)}
                        options={[
                          { value: 'view', label: t('partyAccess.level.view') },
                          { value: 'manage', label: t('partyAccess.level.manage') },
                        ]}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        data-remove
                        aria-label={t('partyAccess.editor.removeFor', { name })}
                        onClick={() => remove(entry.userId)}
                      >
                        {t('partyAccess.remove')}
                      </Button>
                    </>
                  ) : (
                    <StatusPill>{levelLabel(entry.level)}</StatusPill>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {hasInactive ? (
          <p className="ob-small" style={{ margin: 0, color: 'var(--fg-tertiary)' }}>
            {t('partyAccess.editor.deactivatedHelp')}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

const PANEL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-8)',
  padding: 'var(--s-12)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  background: 'var(--bg-canvas)',
} as const;

/**
 * "Add several people": a checklist of everyone who can still be added, and the level they will
 * all get. Escape closes it when nothing is typed (the picker claims the key first when it is).
 */
function BulkPanel({
  options,
  onAdd,
  onClose,
}: {
  options: AssignablePerson[];
  onAdd: (userIds: string[], level: PartyAccessLevel) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<PartyAccessLevel>('view');

  const rows = useMemo<MultiPickerOption[]>(
    () =>
      options.map((person) => ({
        key: person.id,
        label: person.displayName,
        hint: person.roleName,
        leading: <Avatar name={person.displayName} avatar={person.avatar} size="xs" />,
      })),
    [options],
  );

  return (
    <div
      role="group"
      aria-label={t('partyAccess.editor.bulkTitle')}
      style={PANEL_STYLE}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <strong>{t('partyAccess.editor.bulkTitle')}</strong>
      <MultiPicker
        autoFocus
        options={rows}
        selected={selected}
        onChange={setSelected}
        ariaLabel={t('partyAccess.editor.bulkTitle')}
        searchPlaceholder={t('partyAccess.editor.bulkSearch')}
        emptyLabel={t('partyAccess.editor.allAssigned')}
      />
      <div style={{ ...ROW, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span style={ROW}>
          <span className="ob-small">{t('partyAccess.editor.bulkLevel')}</span>
          <Segmented<PartyAccessLevel>
            label={t('partyAccess.editor.bulkLevel')}
            value={level}
            onChange={setLevel}
            options={[
              { value: 'view', label: t('partyAccess.level.view') },
              { value: 'manage', label: t('partyAccess.level.manage') },
            ]}
          />
        </span>
        <span style={ROW}>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button variant="primary" disabled={selected.size === 0} onClick={() => onAdd([...selected], level)}>
            {translator().tCount('partyAccess.editor.bulkAdd', selected.size)}
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * "Copy access from another party": search the parties (the Master does the searching, so a
 * book of thousands is no heavier than a book of ten), pick one, and its people come over.
 * Nothing is saved by this: it only fills the draft.
 */
function CopyPanel({
  partyId,
  onCopy,
  onClose,
}: {
  partyId: string;
  onCopy: (source: PartyAccessRow) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PartyAccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        api
          .partyAccess({ search: query.trim() || undefined, limit: COPY_PAGE + 1, sort: 'name' })
          .then((page) => {
            if (!live) return;
            setFound(page.items.filter((row) => row.partyId !== partyId).slice(0, COPY_PAGE));
            setError(null);
          })
          .catch((caught: unknown) => {
            if (live) setError(caught instanceof Error ? caught.message : t('partyAccess.editor.copyError'));
          })
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      // The first page, on open, needs no wait.
      query === '' ? 0 : COPY_DEBOUNCE_MS,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, partyId]);

  const options = useMemo<ComboboxOption<PartyAccessRow>[]>(
    () =>
      found.map((row) => ({
        key: row.partyId,
        label: row.partyName,
        value: row,
        hint: [
          row.partyCode,
          row.city,
          row.assignees.length === 0
            ? t('partyAccess.editor.copyOpenHint')
            : t('partyAccess.editor.copyPeopleHint', { count: row.assignees.length }),
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    [found],
  );

  return (
    <div
      role="group"
      aria-label={t('partyAccess.editor.copyTitle')}
      style={PANEL_STYLE}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <strong>{t('partyAccess.editor.copyTitle')}</strong>
      <span className="ob-small">{t('partyAccess.editor.copyHelp')}</span>
      <Combobox<PartyAccessRow>
        autoFocus
        filter={false}
        loading={loading}
        options={options}
        ariaLabel={t('partyAccess.editor.copyTitle')}
        placeholder={t('partyAccess.editor.copySearch')}
        onQueryChange={setQuery}
        onSelect={(option) => onCopy(option.value)}
      />
      {error ? (
        <span className="ob-small" role="alert" style={{ color: 'var(--state-conflict)' }}>
          {t('partyAccess.editor.copyError')}: {error}
        </span>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onClose}>
          {t('action.cancel')}
        </Button>
      </div>
    </div>
  );
}
