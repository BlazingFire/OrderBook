/**
 * Automatic backup, for Settings → Storage & backup
 * (docs/7-STORAGE-BACKUP-RESTORE.md §8).
 *
 * The settings belong to this Master PC (`<dataDir>/auto-backup.json`,
 * `backup-scheduler.ts`), because the folder names one of its drives. Anyone
 * with `storage.backupAll` can read them from any PC; they are changed only on
 * the Master PC, so elsewhere the section shows how things stand and says so.
 */

import { useEffect, useState } from 'react';
import type { AutoBackupStatus } from '@orderbook/shared';

import { api, desktopBridge } from '../api';
import {
  Button,
  FieldError,
  FormField,
  Input,
  SettingsSection,
  Switch,
  apiErrorText,
  formatDateTime,
  t,
  useToast,
} from '@orderbook/ui';

export function AutoBackupSection({ onMasterPc }: { onMasterPc: boolean }) {
  const bridge = desktopBridge();
  const toast = useToast();
  const [status, setStatus] = useState<AutoBackupStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [folder, setFolder] = useState('');
  const [time, setTime] = useState('21:00');
  const [keepLast, setKeepLast] = useState('7');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function show(next: AutoBackupStatus): void {
    setStatus(next);
    setEnabled(next.enabled);
    setFolder(next.folder);
    setTime(next.time);
    setKeepLast(String(next.keepLast));
  }

  useEffect(() => {
    let cancelled = false;
    api
      .autoBackup()
      .then((next) => {
        if (!cancelled) show(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(apiErrorText(caught, 'error.requestFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function chooseFolder(): Promise<void> {
    const chosen = await bridge?.chooseDirectory?.({ title: t('backupAll.chooseFolderTitle') });
    if (chosen) setFolder(chosen);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      show(
        await api.saveAutoBackup({
          enabled,
          folder: folder.trim(),
          time,
          keepLast: Number(keepLast),
        }),
      );
      toast.push(t('autoBackup.saved'), { tone: 'ok' });
    } catch (caught) {
      setError(apiErrorText(caught, 'error.requestFailed'));
    } finally {
      setSaving(false);
    }
  }

  const lastRun = status?.lastRun ?? null;
  const lastRunText = !lastRun
    ? t('autoBackup.lastRun.never')
    : lastRun.ok
      ? t('autoBackup.lastRun.ok', { at: formatDateTime(lastRun.at), file: lastRun.fileName ?? '' })
      : t('autoBackup.lastRun.failed', {
          at: formatDateTime(lastRun.at),
          reason: lastRun.message
            ? t(lastRun.message.messageKey, lastRun.message.params)
            : t('backupAll.failed'),
        });

  return (
    <SettingsSection title={t('autoBackup.title')} description={t('autoBackup.help')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        {status && (
          <p className="ob-small" style={{ margin: 0 }}>
            {lastRunText}
          </p>
        )}
        {status?.enabled && !status.folderReachable && (
          <FieldError>{t('autoBackup.folderUnreachable')}</FieldError>
        )}

        {!onMasterPc ? (
          <p className="ob-small" style={{ margin: 0 }}>
            {status?.enabled
              ? t('autoBackup.onAt', { time: status.time, folder: status.folder })
              : t('autoBackup.off')}{' '}
            {t('autoBackup.masterPcOnly')}
          </p>
        ) : (
          status && (
            <>
              <Switch checked={enabled} onChange={setEnabled} label={t('autoBackup.enabled')} />
              <FormField label={t('autoBackup.folder')}>
                {(id) => (
                  <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
                    <Input
                      id={id}
                      value={folder}
                      placeholder={t('backupAll.folderPlaceholder')}
                      onChange={(event) => setFolder(event.target.value)}
                    />
                    {bridge?.chooseDirectory && (
                      <Button variant="secondary" onClick={() => void chooseFolder()}>
                        {t('backupAll.chooseFolder')}
                      </Button>
                    )}
                  </div>
                )}
              </FormField>
              <div style={{ display: 'flex', gap: 'var(--s-16)', flexWrap: 'wrap' }}>
                <FormField label={t('autoBackup.time')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  )}
                </FormField>
                <FormField label={t('autoBackup.keepLast')} hint={t('autoBackup.keepLastHint')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={60}
                      value={keepLast}
                      onChange={(event) => setKeepLast(event.target.value)}
                    />
                  )}
                </FormField>
              </div>
              <div>
                <Button variant="primary" busy={saving} onClick={() => void save()}>
                  {t('autoBackup.save')}
                </Button>
              </div>
            </>
          )
        )}
        {error && <FieldError>{error}</FieldError>}
      </div>
    </SettingsSection>
  );
}
