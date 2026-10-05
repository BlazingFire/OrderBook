/**
 * Export and restore, for the Settings screen's Storage card
 * (docs/7-STORAGE-BACKUP-RESTORE.md §2.2, §2.3, §5). Whole-data export only —
 * per-company selected export exists on the server (`api.ts` could add it
 * later) but has no picker UI yet, since this installation currently serves
 * one company and there is nowhere else in the product a company picker
 * exists to borrow from.
 */

import { useState } from 'react';
import type { BackupRestorePreview } from '@orderbook/shared';

import { api, ApiError } from '../api';
import { Button, FormField, Input, Modal, t, useToast, PasswordInput, SaveTextButton } from '@orderbook/ui';

export function StorageBackupActions() {
  const [exportOpen, setExportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  return (
    <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-12)' }}>
      <Button variant="secondary" onClick={() => setExportOpen(true)}>
        {t('backup.export.action')}
      </Button>
      <Button variant="secondary" onClick={() => setRestoreOpen(true)}>
        {t('backup.restore.action')}
      </Button>
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
      {restoreOpen && <RestoreModal onClose={() => setRestoreOpen(false)} />}
    </div>
  );
}

function ExportModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await api.exportStorage(passphrase);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.push(t('backup.export.done'), { tone: 'ok' });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('backup.export.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('backup.export.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('backup.restore.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => void handleExport()}
            disabled={passphrase.length < 10}
          >
            {t('backup.export.confirm')}
          </Button>
        </>
      }
    >
      <FormField
        label={t('backup.export.passphraseLabel')}
        hint={t('backup.export.passphraseHint')}
        error={error ?? undefined}
      >
        {(id) => (
          <PasswordInput
            id={id}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="new-password"
          />
        )}
      </FormField>
    </Modal>
  );
}

type RestoreStep = 'pick' | 'preview' | 'done';

function RestoreModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<RestoreStep>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupRestorePreview | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsWipeConfirm, setNeedsWipeConfirm] = useState(false);
  const [newPairingPassword, setNewPairingPassword] = useState<string | null>(null);

  async function handleFileChosen(chosen: File) {
    setFile(chosen);
    setError(null);
    setBusy(true);
    try {
      setPreview(await api.previewRestoreStorage(chosen));
      setStep('preview');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('backup.restore.readFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(confirmWipe: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.restoreStorage(file, passphrase, confirmWipe);
      setNewPairingPassword(result.newPairingPassword);
      setStep('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'backup_populated_data_directory') {
        setNeedsWipeConfirm(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : t('backup.restore.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('backup.restore.title')} footer={renderFooter()}>
      {step === 'pick' && (
        <FormField label={t('backup.restore.chooseFile')} error={error ?? undefined}>
          {(id) => (
            <input
              id={id}
              type="file"
              accept=".obbackup"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                if (chosen) void handleFileChosen(chosen);
              }}
            />
          )}
        </FormField>
      )}

      {step === 'preview' && preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
          <ul className="ob-small" style={{ margin: 0, paddingLeft: 'var(--s-16)' }}>
            {preview.summaryLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <FormField label={t('backup.restore.passphraseLabel')} error={error ?? undefined}>
            {(id) => (
              <PasswordInput
                id={id}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="current-password"
              />
            )}
          </FormField>
          {needsWipeConfirm && (
            <FormField label={t('backup.restore.confirmWipe')}>
              {(id) => (
                <Input
                  id={id}
                  value={confirmText}
                  placeholder={t('backup.restore.confirmWipeInput')}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
              )}
            </FormField>
          )}
        </div>
      )}

      {step === 'done' && newPairingPassword && (
        <>
          <p className="ob-body">
            {t('backup.restore.newPairingPassword', { password: newPairingPassword })}
          </p>
          <SaveTextButton
            title={t('saveText.title.pairingPassword')}
            slug="pairing-password"
            sections={[{ values: [{ label: t('saveText.label.pairingPassword'), value: newPairingPassword }] }]}
          />
        </>
      )}
    </Modal>
  );

  function renderFooter() {
    if (step === 'done') {
      return (
        <Button variant="primary" onClick={onClose}>
          {t('action.close')}
        </Button>
      );
    }
    if (step === 'preview') {
      return (
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('backup.restore.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!passphrase || (needsWipeConfirm && confirmText !== 'CONFIRM')}
            onClick={() => void handleRestore(needsWipeConfirm)}
          >
            {t('backup.restore.confirm')}
          </Button>
        </>
      );
    }
    return (
      <Button variant="ghost" onClick={onClose}>
        {t('backup.restore.cancel')}
      </Button>
    );
  }
}
