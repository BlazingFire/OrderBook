/**
 * Products -> Duplicates: the same Product or sub product written twice.
 *
 * The Master finds the groups (`GET /api/duplicates`); here staff choose which
 * copy to keep and delete the rest. A delete is the ordinary soft delete into
 * the Recycle Bin, so it is undone from there and every Office hears about it
 * through the usual change events. A copy that cannot go (a live pending order
 * or order quotes it, or a Product still holds sub products) says why and is
 * left alone; the other copies still go.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DuplicateGroup, DuplicateMember } from '@orderbook/shared';
import {
  BusyMark,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  apiErrorText,
  formatDateTime,
  t,
  useToast,
} from '@orderbook/ui';

import { api } from '../api';

interface Props {
  /** Moves when the catalogue changed, here or on another PC. */
  revision: number;
}

/** The copy to keep unless staff choose another: the oldest. */
function defaultKeep(group: DuplicateGroup): string {
  return (group.members[0] as DuplicateMember).id;
}

function MemberDetail({ member, level }: { member: DuplicateMember; level: DuplicateGroup['level'] }) {
  const parts =
    level === 'product'
      ? [member.code]
      : [member.productName, member.code, member.size];
  return (
    <span className="ob-dup__detail">
      {parts.filter(Boolean).join(' · ')}
      {parts.some(Boolean) ? ' · ' : ''}
      {t('duplicates.addedOn', { date: formatDateTime(member.createdAt) })}
    </span>
  );
}

function blockedText(member: DuplicateMember): string | null {
  if (member.blockedBy === 'liveReferences') {
    return t('duplicates.blocked.liveReferences', { count: member.lineCount });
  }
  if (member.blockedBy === 'subProducts') {
    return t('duplicates.blocked.subProducts', { count: member.subProductCount });
  }
  return null;
}

export function DuplicatesScreen({ revision }: Props) {
  const toast = useToast();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The copy chosen to keep, per group; absent means the oldest. */
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<DuplicateGroup | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGroups((await api.duplicates()).groups);
      setError(null);
    } catch (caught) {
      setError(apiErrorText(caught, 'duplicates.loadFailed'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const keptIn = (group: DuplicateGroup): string => {
    const chosen = keep[group.key];
    return chosen && group.members.some((member) => member.id === chosen)
      ? chosen
      : defaultKeep(group);
  };
  const deletable = (group: DuplicateGroup): DuplicateMember[] =>
    group.members.filter((member) => member.id !== keptIn(group) && !member.blockedBy);

  const resolve = async (group: DuplicateGroup) => {
    setBusy(true);
    try {
      const result = await api.resolveDuplicates({
        level: group.level,
        keepId: keptIn(group),
        deleteIds: group.members.map((member) => member.id).filter((id) => id !== keptIn(group)),
      });
      if (result.deleted.length > 0) {
        toast.push(t('duplicates.done', { count: result.deleted.length }), { tone: 'ok' });
      }
      if (result.refused.length > 0) {
        toast.push(t('duplicates.refused', { count: result.refused.length }), { tone: 'error' });
      }
    } catch (caught) {
      toast.push(apiErrorText(caught, 'duplicates.loadFailed'), { tone: 'error' });
    } finally {
      setBusy(false);
      setConfirming(null);
      await load();
    }
  };

  if (error && !groups) {
    return <ErrorState title={error} onAction={() => void load()} />;
  }
  if (!groups) return <BusyMark />;

  return (
    <div className="ob-dup">
      <header className="ob-dup__head">
        <h2>{t('duplicates.title')}</h2>
        <p>{t('duplicates.description')}</p>
      </header>

      {groups.length === 0 ? (
        <EmptyState
          title={t('duplicates.empty.title')}
          description={t('duplicates.empty.description')}
        />
      ) : (
        groups.map((group) => {
          const kept = keptIn(group);
          const removable = deletable(group);
          return (
            <section key={group.key} className="ob-card ob-card--pad ob-dup__group">
              <div className="ob-dup__title">
                <strong>{t(`duplicates.level.${group.level}`)}</strong>
                {group.brand && <span>{group.brand}</span>}
                {group.matchedOn.map((kind) => (
                  <span key={kind} className="ob-dup__chip">
                    {t(`duplicates.match.${kind}`)}
                  </span>
                ))}
              </div>

              <ul className="ob-dup__members">
                {group.members.map((member, index) => {
                  const blocked = blockedText(member);
                  return (
                    <li key={member.id} className={member.id === kept ? 'is-kept' : undefined}>
                      <label>
                        <input
                          type="radio"
                          className="ob-radio"
                          name={group.key}
                          checked={member.id === kept}
                          onChange={() => setKeep((current) => ({ ...current, [group.key]: member.id }))}
                        />
                        <span className="ob-dup__name">{member.name}</span>
                        {index === 0 && <span className="ob-dup__chip">{t('duplicates.oldest')}</span>}
                      </label>
                      <MemberDetail member={member} level={group.level} />
                      {blocked && member.id !== kept && <em className="ob-dup__blocked">{blocked}</em>}
                    </li>
                  );
                })}
              </ul>

              <Button
                variant="danger"
                disabled={removable.length === 0 || busy}
                title={removable.length === 0 ? t('duplicates.nothingToDelete') : undefined}
                onClick={() => setConfirming(group)}
              >
                {t('duplicates.delete')}
              </Button>
            </section>
          );
        })
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={t('duplicates.confirm.title')}
        body={
          confirming
            ? t('duplicates.confirm.body', {
                keep: confirming.members.find((member) => member.id === keptIn(confirming))?.name ?? '',
                count: deletable(confirming).length,
              })
            : undefined
        }
        confirmLabel={t('duplicates.delete')}
        tone="danger"
        busy={busy}
        onConfirm={() => confirming && void resolve(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
