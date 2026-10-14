/**
 * Deleting one party on the Master — the Parties screen's dialog, and the
 * Delete data screen's search.
 *
 * Before it offers the button it reads what the delete would take with it
 * (`GET /api/parties/:id/delete-preview`). A party no order points at is the
 * plain delete. One with new or final orders is listed in full when the
 * company has switched on Delete related data, and the delete then sends the
 * number it listed so the Master refuses if that changed; with the switch off
 * the dialog says why it cannot go yet and offers no button. Everything goes to
 * the Recycle Bin.
 */

import { useEffect, useState } from 'react';
import type { PartyDeletePreview } from '@orderbook/shared';

import { ApiError, api } from '../api';
import { Button, Modal, rem, t, useToast } from '@orderbook/ui';

export interface PartyToDelete {
  id: string;
  name: string;
}

export function PartyDeleteDialog({
  party,
  onClose,
  onDeleted,
}: {
  /** The party asked about; null keeps the dialog closed. */
  party: PartyToDelete | null;
  onClose: () => void;
  onDeleted: (party: PartyToDelete) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Null while it is being read, or when the read failed: then the dialog is the
  // plain one, and the Master still refuses a party that orders point at.
  const [preview, setPreview] = useState<PartyDeletePreview | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setPreview(null);
    if (!party) return;
    let cancelled = false;
    setLoading(true);
    void api
      .partyDeletePreview(party.id)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [party]);

  const relatedCount = preview ? preview.pendingOrders.length + preview.finalOrders.length : 0;
  const blocked = preview !== null && relatedCount > 0 && !preview.relatedDeleteEnabled;
  const withRelated = preview !== null && relatedCount > 0 && preview.relatedDeleteEnabled;

  async function remove(target: PartyToDelete): Promise<void> {
    setBusy(true);
    try {
      await api.deleteParty(target.id, withRelated ? { expected: relatedCount } : undefined);
      onDeleted(target);
    } catch (caught) {
      // A delete the server refuses because something live still points at the
      // party is not a failure to report as "could not delete" — the operator
      // needs to know what to deal with first.
      if (caught instanceof ApiError && caught.isConflict && caught.blockedBy.length > 0) {
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
      // The orders moved meanwhile (or the read failed): read them again.
      if (caught instanceof ApiError && caught.isConflict) {
        void api.partyDeletePreview(target.id).then(setPreview, () => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={party !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      size="sm"
      title={t('parties.delete.title', { name: party?.name ?? '' })}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            busy={busy}
            disabled={loading || blocked}
            onClick={() => {
              if (party) void remove(party);
            }}
          >
            {withRelated
              ? t('parties.delete.related.confirm', { count: relatedCount })
              : t('parties.delete.confirm')}
          </Button>
        </>
      }
    >
      <PartyDeleteBody loading={loading} preview={preview} blocked={blocked} withRelated={withRelated} />
    </Modal>
  );
}

/**
 * The delete dialog's words: the plain line, or every order that goes with the
 * party (Delete related data on), or why it cannot go yet (off).
 */
function PartyDeleteBody({
  loading,
  preview,
  blocked,
  withRelated,
}: {
  loading: boolean;
  preview: PartyDeletePreview | null;
  blocked: boolean;
  withRelated: boolean;
}) {
  if (loading) return <p className="ob-body ob-confirm-body">{t('parties.delete.checking')}</p>;
  if (preview && blocked) {
    return (
      <p className="ob-body ob-confirm-body">
        {t('parties.delete.related.blocked', {
          pending: preview.pendingOrders.length,
          final: preview.finalOrders.length,
        })}
      </p>
    );
  }
  if (!preview || !withRelated) return <p className="ob-body ob-confirm-body">{t('parties.delete.body')}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      <p className="ob-body" style={{ margin: 0 }}>
        {t('parties.delete.related.intro')}
      </p>
      {preview.pendingOrders.length > 0 && (
        <RelatedList
          heading={t('parties.delete.related.pendingHeading', { count: preview.pendingOrders.length })}
          items={preview.pendingOrders.map((record) => ({ id: record.id, text: record.number }))}
        />
      )}
      {preview.finalOrders.length > 0 && (
        <RelatedList
          heading={t('parties.delete.related.finalHeading', { count: preview.finalOrders.length })}
          items={preview.finalOrders.map((record) => ({
            id: record.id,
            text: record.dispatched ? `${record.number} (${t('parties.delete.related.dispatched')})` : record.number,
          }))}
        />
      )}
      <p className="ob-small" style={{ margin: 0 }}>
        {t('parties.delete.related.restoreNote')}
      </p>
    </div>
  );
}

function RelatedList({ heading, items }: { heading: string; items: Array<{ id: string; text: string }> }) {
  return (
    <div>
      <h3 className="ob-label" style={{ margin: '0 0 var(--s-4)' }}>
        {heading}
      </h3>
      <ul
        className="ob-body ob-mono"
        style={{ margin: 0, paddingLeft: 'var(--s-16)', maxHeight: rem(160), overflowY: 'auto' }}
      >
        {items.map((item) => (
          <li key={item.id}>{item.text}</li>
        ))}
      </ul>
    </div>
  );
}

