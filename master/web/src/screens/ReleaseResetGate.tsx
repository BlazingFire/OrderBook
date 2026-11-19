/**
 * 1.5.9's written warning and confirmation (owner, 2026-11-19; `release-reset.service.ts`).
 *
 * Shown to an administrator while this company's reset is pending: what is deleted and what is
 * kept, with numbers; that a full backup is saved first; then a tick and their own password
 * before "Back up and delete". "Later" closes it for this sitting; the app runs on the migrated
 * catalogue meanwhile, and it opens again next time.
 */

import { useEffect, useState } from 'react';
import type { ReleaseResetStatus } from '@orderbook/shared';

import { api } from '../api';
import {
  Button,
  Checkbox,
  ConflictBanner,
  FieldError,
  FormField,
  Modal,
  PasswordInput,
  apiErrorText,
  t,
  useToast,
} from '@orderbook/ui';

export function ReleaseResetGate({ enabled }: { enabled: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState<ReleaseResetStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    api
      .releaseResetStatus()
      .then((next) => {
        if (!gone) setStatus(next);
      })
      // Not knowing is not a reason to stop anybody working: the warning simply does not open.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [enabled]);

  if (!enabled || dismissed || status?.state !== 'pending') return null;

  const ready = understood && password.length > 0 && !busy;

  async function confirm(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.confirmReleaseReset({ understood, confirmPassword: password });
      setPassword('');
      setStatus((current) => (current ? { ...current, state: 'done', backupPath: result.backupPath } : current));
      toast.push(t('releaseReset.done', { path: result.backupPath }), { tone: 'ok' });
    } catch (caught) {
      setError(t('releaseReset.failed', { error: apiErrorText(caught, 'releaseReset.failed') }));
    } finally {
      setBusy(false);
    }
  }

  const { removes, keeps } = status;
  const item = (text: string) => <li key={text}>{text}</li>;

  return (
    <Modal
      open
      onClose={busy ? () => undefined : () => setDismissed(true)}
      size="md"
      title={t('releaseReset.title', { release: status.release })}
      footer={
        <>
          <span className="ob-small" style={{ flex: 1, color: 'var(--fg-secondary)' }}>
            {t('releaseReset.laterHint')}
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => setDismissed(true)}>
            {t('releaseReset.later')}
          </Button>
          <Button variant="danger" busy={busy} disabled={!ready} onClick={() => void confirm()}>
            {busy ? t('releaseReset.running') : t('releaseReset.confirm')}
          </Button>
        </>
      }
    >
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <ConflictBanner>{t('releaseReset.lead')}</ConflictBanner>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-16)' }}>
          <section>
            <h3 className="ob-eyebrow">{t('releaseReset.removesTitle')}</h3>
            <ul style={{ margin: 0, paddingInlineStart: '1.2em' }}>
              {item(t('releaseReset.removes.newOrders', { count: removes.newOrders }))}
              {item(t('releaseReset.removes.finalOrders', { count: removes.finalOrders }))}
              {item(t('releaseReset.removes.subProducts', { count: removes.subProducts }))}
              {item(t('releaseReset.removes.mainProducts', { count: removes.mainProducts }))}
              {item(t('releaseReset.removes.photos', { count: removes.photos }))}
            </ul>
          </section>
          <section>
            <h3 className="ob-eyebrow">{t('releaseReset.keepsTitle')}</h3>
            <ul style={{ margin: 0, paddingInlineStart: '1.2em' }}>
              {item(t('releaseReset.keeps.parties', { count: keeps.parties }))}
              {item(t('releaseReset.keeps.users', { count: keeps.users }))}
              {item(t('releaseReset.keeps.rest'))}
            </ul>
          </section>
        </div>
        <p className="ob-small" style={{ margin: 0 }}>
          {t('releaseReset.backupNote')} {t('releaseReset.offices')}
        </p>
        <Checkbox
          checked={understood}
          onChange={setUnderstood}
          disabled={busy}
          label={t('releaseReset.understood')}
        />
        <FormField label={t('releaseReset.password')}>
          {(id) => (
            <PasswordInput
              id={id}
              value={password}
              autoComplete="current-password"
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </FormField>
        {error && <FieldError>{error}</FieldError>}
      </form>
    </Modal>
  );
}
