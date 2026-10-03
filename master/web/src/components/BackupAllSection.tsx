/**
 * "Back up everything to a drive", for Settings → Storage & backup
 * (docs/7-STORAGE-BACKUP-RESTORE.md §3).
 *
 * Server Masters only (`storage.backupAll`), and the routes behind it answer
 * only on the Master PC, so off it the section is just a notice. The folder is
 * picked with the shell's native chooser, which reaches USB drives; a typed
 * path works too, for a browser on the Master PC with no shell. The backup
 * and a restore each run as the Master's one job and are followed with
 * `useBackupJob`.
 *
 * A restore from here replaces every record, so after the preview it needs
 * CONFIRM typed and the master key. Everyone is signed out by it, this window
 * included, so it ends on a button that reloads into sign-in.
 */

import { useEffect, useRef, useState } from 'react';
import type { ArchiveListEntry, ArchivePreview, BackupJobStatus } from '@orderbook/shared';

import { api, desktopBridge } from '../api';
import { useMasterKeyPrompt } from './MasterKeyPrompt';
import { isJobFinished, phaseLabel, useBackupJob } from './useBackupJob';
import {
  Button,
  FieldError,
  FormField,
  Input,
  KeyValueList,
  OfflineBanner,
  ProgressBar,
  SettingsSection,
  apiErrorText,
  formatBytes,
  formatDateTime,
  t,
} from '@orderbook/ui';

/** The progress of a running job, or how it ended. */
export function BackupJobProgress({ job }: { job: BackupJobStatus }) {
  if (job.phase === 'failed') {
    const key = job.message?.messageKey;
    return (
      <FieldError>
        {key ? t(key, job.message?.params) : t('backupAll.failed')}
        {key === 'error.validation.backupFat32TooLarge' && (
          <div>{t('backupAll.fat32TooLarge')}</div>
        )}
        {key === 'error.validation.backupInsufficientSpace' && (
          <div>{t('backupAll.insufficientSpace')}</div>
        )}
      </FieldError>
    );
  }
  const value = job.phase === 'done' ? 1 : job.total > 0 ? job.done / job.total : null;
  return <ProgressBar value={value} label={phaseLabel(job.phase)} />;
}

/** What an archive holds, from its manifest, before anything is restored. */
export function ArchivePreviewFacts({ preview }: { preview: ArchivePreview }) {
  const sealed = preview.sealed.secretSettings + preview.sealed.connectorCredentials;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      <KeyValueList
        items={[
          { label: t('magicRestore.company'), value: preview.company || '—' },
          { label: t('magicRestore.created'), value: formatDateTime(preview.createdAt) },
          { label: t('magicRestore.version'), value: preview.appVersion },
          { label: t('magicRestore.records'), value: t('magicRestore.counts', preview.counts) },
          { label: t('magicRestore.photos'), value: String(preview.photos) },
          { label: t('magicRestore.size'), value: formatBytes(preview.totalBytes) },
        ]}
      />
      {sealed > 0 && (
        <p className="ob-small" style={{ margin: 0 }}>
          {t('backupAll.sealedNotice', {
            settings: preview.sealed.secretSettings,
            connectors: preview.sealed.connectorCredentials,
          })}
        </p>
      )}
    </div>
  );
}

export function BackupAllSection({ onMasterPc }: { onMasterPc: boolean }) {
  if (!onMasterPc) {
    return (
      <SettingsSection title={t('backupAll.title')}>
        <p className="ob-small" style={{ margin: 0 }}>
          {t('backupAll.notMasterPc')}
        </p>
      </SettingsSection>
    );
  }
  return <BackupAllControls />;
}

function BackupAllControls() {
  const bridge = desktopBridge();
  const [folder, setFolder] = useState('');
  const [archives, setArchives] = useState<ArchiveListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** The archive being restored, from its preview until the job ends. */
  const [target, setTarget] = useState<{ path: string; preview: ArchivePreview } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const restoring = useRef(false);
  const masterKey = useMasterKeyPrompt();

  // A restore is followed through the setup route, which still answers while
  // the restore holds the API and after it has signed everyone out.
  const { job, follow } = useBackupJob(() =>
    restoring.current ? api.setupArchiveJob() : api.archiveJob(),
  );
  const busy = !isJobFinished(job);

  // The automatic backup's folder is the usual drive; start from it.
  useEffect(() => {
    let cancelled = false;
    api
      .autoBackup()
      .then((status) => {
        if (!cancelled && status.folder) setFolder((current) => current || status.folder);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = folder.trim();
  const finishedBackup = job?.kind === 'backup' && job.phase === 'done';

  // The list follows the folder, and is read again after a backup lands in it.
  useEffect(() => {
    if (!trimmed) {
      setArchives(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .listArchives(trimmed)
        .then((rows) => {
          if (!cancelled) setArchives(rows);
        })
        .catch(() => {
          if (!cancelled) setArchives(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, finishedBackup]);

  async function chooseFolder(): Promise<void> {
    const chosen = await bridge?.chooseDirectory?.({ title: t('backupAll.chooseFolderTitle') });
    if (chosen) setFolder(chosen);
  }

  async function startBackup(): Promise<void> {
    setStarting(true);
    setError(null);
    try {
      restoring.current = false;
      follow(await api.startArchiveBackup(trimmed));
    } catch (caught) {
      setError(apiErrorText(caught, 'backupAll.failed'));
    } finally {
      setStarting(false);
    }
  }

  async function preview(path: string): Promise<void> {
    setError(null);
    setConfirmText('');
    try {
      setTarget({ path, preview: await api.previewArchive(path) });
    } catch (caught) {
      setError(apiErrorText(caught, 'backup.restore.readFailed'));
    }
  }

  async function chooseFile(): Promise<void> {
    const chosen = await bridge?.chooseFile?.({
      title: t('backupAll.chooseFileTitle'),
      extensions: ['zip'],
    });
    if (chosen) await preview(chosen);
  }

  async function restore(): Promise<void> {
    if (!target) return;
    const token = await masterKey.ask();
    if (!token) return;
    setStarting(true);
    setError(null);
    try {
      restoring.current = true;
      follow(await api.restoreArchive(target.path, token));
    } catch (caught) {
      restoring.current = false;
      setError(apiErrorText(caught, 'backup.restore.failed'));
    } finally {
      setStarting(false);
    }
  }

  const restoreDone = job?.kind === 'restore' && job.phase === 'done';

  return (
    <SettingsSection title={t('backupAll.title')} description={t('backupAll.help')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
        <OfflineBanner>{t('backupAll.keepSafe')}</OfflineBanner>

        <FormField label={t('backupAll.folderLabel')}>
          {(id) => (
            <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
              <Input
                id={id}
                value={folder}
                placeholder={t('backupAll.folderPlaceholder')}
                disabled={busy}
                onChange={(event) => setFolder(event.target.value)}
              />
              {bridge?.chooseDirectory && (
                <Button variant="secondary" disabled={busy} onClick={() => void chooseFolder()}>
                  {t('backupAll.chooseFolder')}
                </Button>
              )}
            </div>
          )}
        </FormField>

        <div>
          <Button
            variant="primary"
            busy={starting && !target}
            disabled={!trimmed || busy}
            onClick={() => void startBackup()}
          >
            {t('backupAll.start')}
          </Button>
        </div>

        {job && <BackupJobProgress job={job} />}
        {finishedBackup && job.fileName && (
          <p className="ob-small" style={{ margin: 0 }}>
            {t('backupAll.done', { file: job.fileName })}
          </p>
        )}
        {error && <FieldError>{error}</FieldError>}

        {restoreDone ? (
          <OfflineBanner
            action={
              <Button variant="primary" onClick={() => window.location.reload()}>
                {t('backupAll.restore.signIn')}
              </Button>
            }
          >
            {t('backupAll.restore.doneSignIn')}
          </OfflineBanner>
        ) : target ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
            <h3 className="ob-title" style={{ margin: 0 }}>
              {t('backupAll.restore.title')}
            </h3>
            <ArchivePreviewFacts preview={target.preview} />
            <p className="ob-small" style={{ margin: 0 }}>
              {t('backupAll.restore.warning')}
            </p>
            <FormField label={t('backupAll.restore.typeConfirm')}>
              {(id) => (
                <Input
                  id={id}
                  value={confirmText}
                  disabled={busy}
                  placeholder={t('backup.restore.confirmWipeInput')}
                  onChange={(event) => setConfirmText(event.target.value)}
                />
              )}
            </FormField>
            <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
              <Button
                variant="primary"
                busy={starting}
                disabled={confirmText !== 'CONFIRM' || busy}
                onClick={() => void restore()}
              >
                {t('backup.restore.confirm')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
                {t('backup.restore.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
            <div className="ob-eyebrow">{t('backupAll.list.title')}</div>
            {archives && archives.length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {archives.map((archive) => (
                  <li
                    key={archive.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--s-12)',
                      padding: 'var(--s-4) 0',
                    }}
                  >
                    <span
                      className="ob-body"
                      style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
                    >
                      {archive.fileName}
                    </span>
                    <span className="ob-small">{formatDateTime(archive.modifiedAt)}</span>
                    <span className="ob-small">{formatBytes(archive.bytes)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void preview(archive.path)}
                    >
                      {t('backupAll.restore.action')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ob-small" style={{ margin: 0 }}>
                {t('backupAll.list.empty')}
              </p>
            )}
            {bridge?.chooseFile && (
              <div>
                <Button variant="secondary" disabled={busy} onClick={() => void chooseFile()}>
                  {t('backupAll.restore.fromFile')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {masterKey.prompt}
    </SettingsSection>
  );
}
