/**
 * "Connect to a different Master": leave the one this PC is paired with.
 *
 * Two questions, because the second is about work that could be lost:
 *  1. "Leave this Master?" says what happens (the saved data and the offline sign-in
 *     list are forgotten, the PC can pair again).
 *  2. Only when something was made here and never sent, the Office server refuses
 *     (`pending_changes`) and this asks again, with the count and three answers:
 *     keep the work on this PC (sent if it joins the same Master again, set aside if
 *     a different one), discard it, or cancel.
 *
 * Used on the sign-in screen (the Master may be gone, so no sign-in is needed), in the
 * "not recognised" banner, and in Settings for somebody who manages panels.
 */

import { useState } from 'react';

import { api, ApiError } from '../api';
import { Button, Modal, apiErrorText, t, useConfirm, type ButtonVariant } from '@orderbook/ui';

interface Props {
  company: string | null;
  /** Called once the PC has left, so the screen can ask the server who it is now. */
  onDone: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export function ConnectionUnpair({ company, onDone, variant = 'ghost', size = 'sm' }: Props) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [unsent, setUnsent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function leave(pending?: 'keep' | 'discard') {
    setBusy(true);
    setError(null);
    try {
      await api.unpair(pending);
      setUnsent(null);
      onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'pending_changes') {
        setUnsent(Number((caught.details as { count?: number }).count) || 0);
      } else {
        setError(apiErrorText(caught, 'connection.errorFallback'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const confirmed = await confirm({
      title: t('connection.unpair.title'),
      body: t('connection.unpair.body', { company: company ?? t('connection.scan.defaultName') }),
      confirmLabel: t('connection.unpair.confirm'),
      tone: 'danger',
    });
    if (confirmed) await leave();
  }

  return (
    <>
      <Button variant={variant} size={size} busy={busy} onClick={() => void start()}>
        {t('connection.unpair.action')}
      </Button>
      {error ? (
        <span className="ob-small" role="alert" style={{ color: 'var(--danger, inherit)' }}>
          {error}
        </span>
      ) : null}

      <Modal
        open={unsent !== null}
        onClose={() => setUnsent(null)}
        title={t('connection.unpair.pendingTitle')}
        footer={
          <div
            style={{
              display: 'flex',
              gap: 'var(--s-8)',
              justifyContent: 'flex-end',
              width: '100%',
            }}
          >
            <Button variant="ghost" onClick={() => setUnsent(null)}>
              {t('action.cancel')}
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void leave('discard')}>
              {t('connection.unpair.discard')}
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void leave('keep')}>
              {t('connection.unpair.keep')}
            </Button>
          </div>
        }
      >
        <p className="ob-body">{t('connection.unpair.pendingBody', { count: unsent ?? 0 })}</p>
      </Modal>
    </>
  );
}
