/**
 * First screen on a brand-new installation. Three forks
 * (docs/7-STORAGE-BACKUP-RESTORE.md §5.1): "Set up new site" asks the owner to
 * type the two Server Master accounts (suggested `master` and
 * `master-backup`), generates this Master's identity and shows the connection
 * details — the only time the pairing password is ever visible, so that screen
 * insists on an explicit acknowledgement before moving on. No `admin` account
 * is created. "Magic restore" brings back a backup-everything zip from a drive
 * (records, photos and pairing), so the Offices find this PC by themselves.
 * "Restore an encrypted backup" reads a version 1 `.obbackup` file instead.
 * All three run only on the Master PC.
 */

import { useState } from 'react';
import type { ArchivePreview, BackupRestorePreview } from '@orderbook/shared';

import { api, ApiError, desktopBridge, type FirstRunCredentials } from '../api';
import { ArchivePreviewFacts, BackupJobProgress } from '../components/BackupAllSection';
import { DataDirCard } from '../components/DataDirCard';
import { isJobFinished, useBackupJob } from '../components/useBackupJob';
import {
  accountDrafts,
  accountDraftsError,
  ServerMasterAccountFields,
  toAccountInputs,
  type AccountDraft,
} from './ServerMasterSetupFlow';
import {
  Button,
  Card,
  FieldError,
  FormField,
  IdField,
  Input,
  Logo,
  OfflineBanner,
  apiErrorText,
  rem,
  t,
} from '@orderbook/ui';

interface Props {
  onComplete: () => void;
  /** Setup and restore are refused off the Master PC, so a LAN browser only gets a notice. */
  onMasterPc: boolean;
}

type Mode = 'choose' | 'setup' | 'magic' | 'restore';

export function FirstRunScreen({ onComplete, onMasterPc }: Props) {
  const [mode, setMode] = useState<Mode>('choose');

  if (mode === 'restore')
    return <RestoreFlow onBack={() => setMode('choose')} onComplete={onComplete} />;
  if (mode === 'magic')
    return <MagicRestoreFlow onBack={() => setMode('choose')} onComplete={onComplete} />;
  if (mode === 'setup')
    return <SetupFlow onBack={() => setMode('choose')} onComplete={onComplete} />;

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--s-20)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: rem(420),
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-20)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--s-8)',
          }}
        >
          <Logo size={32} />
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('firstRun.setup.title')}
          </h1>
        </div>
        {!onMasterPc ? (
          <Card>
            <p style={{ margin: 0 }}>{t('firstRun.choose.masterPcOnly')}</p>
          </Card>
        ) : (
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
              <Button variant="primary" onClick={() => setMode('setup')}>
                {t('firstRun.choose.newSite')}
              </Button>
              <Button variant="secondary" onClick={() => setMode('magic')}>
                {t('firstRun.choose.magicRestore')}
              </Button>
              <Button variant="ghost" onClick={() => setMode('restore')}>
                {t('firstRun.choose.restore')}
              </Button>
            </div>
          </Card>
        )}

        {/* Before the company exists is the one moment this folder can be moved
            by pressing a button: it is empty, so there is nothing to lose. */}
        <DataDirCard />
      </div>
    </div>
  );
}

function SetupFlow({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [companyName, setCompanyName] = useState('');
  const [drafts, setDrafts] = useState<AccountDraft[]>(() => accountDrafts(2));
  const [credentials, setCredentials] = useState<FirstRunCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    const problem = accountDraftsError(drafts);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setCredentials(await api.initialize(companyName, toAccountInputs(drafts)));
      // The passwords were typed here; nothing should keep them once set up.
      setDrafts(accountDrafts(2));
    } catch (caught) {
      setError(apiErrorText(caught, 'firstRun.error.default'));
    } finally {
      setBusy(false);
    }
  }

  if (credentials) {
    const addressValue = credentials.lanIps.length
      ? credentials.lanIps.map((ip) => `${ip}:${credentials.port}`).join('  •  ')
      : t('firstRun.ready.noAddress', { port: credentials.port });

    return (
      <div
        style={{
          maxWidth: rem(640),
          margin: '0 auto',
          padding: 'var(--s-40) var(--s-16)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-20)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--s-8)',
          }}
        >
          <Logo size={32} />
          <h1 className="ob-display" style={{ margin: 0 }}>
            {t('firstRun.ready.title')}
          </h1>
        </div>

        <OfflineBanner>{t('firstRun.ready.writeDownPairing')}</OfflineBanner>

        <Card>
          <h2 className="ob-title" style={{ margin: '0 0 var(--s-4)' }}>
            {t('firstRun.ready.signInSection')}
          </h2>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('firstRun.serverMaster.readyHelp')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
            {credentials.accounts.map((account, index) => (
              <LabeledValue
                key={account.username}
                label={
                  index === 0 ? t('firstRun.serverMaster.main') : t('firstRun.serverMaster.backup')
                }
                value={account.username}
              />
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="ob-title" style={{ margin: '0 0 var(--s-4)' }}>
            {t('firstRun.ready.panelsSection')}
          </h2>
          <p className="ob-small" style={{ marginTop: 0 }}>
            {t('firstRun.ready.panelsHelp')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
            <LabeledValue
              label={
                credentials.lanIps.length > 1
                  ? t('firstRun.ready.addressesLabel')
                  : t('firstRun.ready.addressLabel')
              }
              value={addressValue}
            />
            <LabeledValue
              label={t('firstRun.ready.masterIdLabel')}
              value={credentials.masterUniqueId}
            />
            <LabeledValue
              label={t('firstRun.ready.pairingPasswordLabel')}
              value={credentials.pairingPassword}
            />
          </div>
        </Card>

        <Button variant="primary" size="lg" onClick={onComplete}>
          {t('firstRun.ready.continue')}
        </Button>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--s-20)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: rem(480),
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-20)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--s-8)',
          }}
        >
          <Logo size={32} />
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('firstRun.setup.title')}
          </h1>
          <p className="ob-small" style={{ margin: 0, textAlign: 'center' }}>
            {t('firstRun.setup.description')}
          </p>
        </div>

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
            <FormField label={t('firstRun.setup.companyName')}>
              {(id) => (
                <Input
                  id={id}
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder={t('firstRun.setup.companyNamePlaceholder')}
                />
              )}
            </FormField>
            <h2 className="ob-title" style={{ margin: 0 }}>
              {t('firstRun.serverMaster.title')}
            </h2>
            <p className="ob-small" style={{ margin: 0 }}>
              {t('firstRun.serverMaster.help')}
            </p>
            <ServerMasterAccountFields drafts={drafts} onChange={setDrafts} />
            {error && <FieldError>{error}</FieldError>}
            <Button variant="primary" busy={busy} onClick={() => void generate()}>
              {busy ? t('firstRun.setup.generating') : t('firstRun.setup.generate')}
            </Button>
            <Button variant="ghost" onClick={onBack}>
              {t('firstRun.choose.back')}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * Magic restore: a backup-everything zip, by its path on this PC (the shell's
 * file chooser fills it in). The preview comes from the zip's manifest; the
 * restore runs as the Master's one job, followed through the setup route that
 * keeps answering while the database is rebuilt. When it is done, Continue
 * reads the setup status again and the usual sign-in shows.
 */
function MagicRestoreFlow({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const bridge = desktopBridge();
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { job, follow } = useBackupJob(() => api.setupArchiveJob());
  const running = !isJobFinished(job);
  const done = job?.kind === 'restore' && job.phase === 'done';
  const sealed = preview ? preview.sealed.secretSettings + preview.sealed.connectorCredentials : 0;

  async function read(file: string): Promise<void> {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.setupPreviewArchive(file));
    } catch (caught) {
      setError(apiErrorText(caught, 'backup.restore.readFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(): Promise<void> {
    const chosen = await bridge?.chooseFile?.({
      title: t('backupAll.chooseFileTitle'),
      extensions: ['zip'],
    });
    if (!chosen) return;
    setPath(chosen);
    await read(chosen);
  }

  async function restore(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      follow(await api.setupRestoreArchive(path.trim()));
    } catch (caught) {
      setError(apiErrorText(caught, 'backup.restore.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--s-20)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: rem(520),
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-20)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--s-8)',
          }}
        >
          <Logo size={32} />
          <h1 className="ob-title" style={{ margin: 0 }}>
            {done ? t('magicRestore.doneTitle') : t('magicRestore.title')}
          </h1>
          {!done && (
            <p className="ob-small" style={{ margin: 0, textAlign: 'center' }}>
              {t('magicRestore.help')}
            </p>
          )}
        </div>

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
            {done ? (
              <>
                <p className="ob-body" style={{ margin: 0 }}>
                  {t('magicRestore.doneBody')}
                </p>
                {preview && sealed > 0 && (
                  <OfflineBanner>
                    {t('backupAll.sealedNotice', {
                      settings: preview.sealed.secretSettings,
                      connectors: preview.sealed.connectorCredentials,
                    })}
                  </OfflineBanner>
                )}
                <Button variant="primary" size="lg" onClick={onComplete}>
                  {t('firstRun.ready.continue')}
                </Button>
              </>
            ) : (
              <>
                <FormField label={t('magicRestore.pathLabel')}>
                  {(id) => (
                    <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
                      <Input
                        id={id}
                        value={path}
                        placeholder={t('magicRestore.pathPlaceholder')}
                        disabled={running}
                        onChange={(event) => {
                          setPath(event.target.value);
                          setPreview(null);
                        }}
                      />
                      {bridge?.chooseFile && (
                        <Button
                          variant="secondary"
                          disabled={running}
                          onClick={() => void chooseFile()}
                        >
                          {t('magicRestore.chooseFile')}
                        </Button>
                      )}
                    </div>
                  )}
                </FormField>

                {preview ? (
                  <>
                    <ArchivePreviewFacts preview={preview} />
                    <Button
                      variant="primary"
                      busy={busy}
                      disabled={running}
                      onClick={() => void restore()}
                    >
                      {t('magicRestore.start')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    busy={busy}
                    disabled={!path.trim()}
                    onClick={() => void read(path.trim())}
                  >
                    {t('magicRestore.read')}
                  </Button>
                )}

                {job && <BackupJobProgress job={job} />}
                {error && <FieldError>{error}</FieldError>}

                {!running && (
                  <Button variant="ghost" onClick={onBack}>
                    {t('firstRun.choose.back')}
                  </Button>
                )}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

type RestoreStep = 'pick' | 'preview' | 'done';

function RestoreFlow({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [step, setStep] = useState<RestoreStep>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupRestorePreview | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPairingPassword, setNewPairingPassword] = useState<string | null>(null);

  async function handleFileChosen(chosen: File) {
    setFile(chosen);
    setError(null);
    setBusy(true);
    try {
      setPreview(await api.previewRestoreSetup(chosen));
      setStep('preview');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('backup.restore.readFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.restoreSetup(file, passphrase);
      setNewPairingPassword(result.newPairingPassword);
      setStep('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('backup.restore.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--s-20)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: rem(480),
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-20)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--s-8)',
          }}
        >
          <Logo size={32} />
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('backup.restore.title')}
          </h1>
        </div>

        {error && <FieldError>{error}</FieldError>}

        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
            {step === 'pick' && (
              <FormField label={t('backup.restore.chooseFile')}>
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
              <>
                <ul className="ob-small" style={{ margin: 0, paddingLeft: 'var(--s-16)' }}>
                  {preview.summaryLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <FormField label={t('backup.restore.passphraseLabel')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      autoComplete="current-password"
                    />
                  )}
                </FormField>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!passphrase}
                  onClick={() => void handleRestore()}
                >
                  {t('backup.restore.confirm')}
                </Button>
              </>
            )}

            {step === 'done' && newPairingPassword && (
              <>
                <OfflineBanner>
                  {t('backup.restore.newPairingPassword', { password: newPairingPassword })}
                </OfflineBanner>
                <Button variant="primary" size="lg" onClick={onComplete}>
                  {t('firstRun.ready.continue')}
                </Button>
              </>
            )}

            {step !== 'done' && (
              <Button variant="ghost" onClick={onBack}>
                {t('firstRun.choose.back')}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** A read-only credential value, shown once with a copy affordance (§9 IdField). */
function LabeledValue({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <span className="ob-label">{label}</span>
      <div
        style={{
          padding: 'var(--s-8) var(--s-12)',
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--r-sm)',
        }}
      >
        <IdField value={value} />
      </div>
    </div>
  );
}
