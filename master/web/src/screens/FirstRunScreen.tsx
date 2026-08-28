/**
 * First screen on a brand-new installation. Two forks
 * (docs/7-STORAGE-BACKUP-RESTORE.md §5.1): "Set up new site" generates this
 * Master's identity and shows the credentials — the only time the passwords
 * are ever visible, so that screen insists on an explicit acknowledgement
 * before moving on. "Restore from backup" reads an exported file instead and
 * comes up as the site that was backed up.
 */

import { useState } from 'react';
import type { BackupRestorePreview } from '@orderbook/shared';

import { api, ApiError, type FirstRunCredentials } from '../api';
import {
  Button,
  Card,
  FieldError,
  FormField,
  IdField,
  Input,
  Logo,
  OfflineBanner,
  t,
} from '@orderbook/ui';

interface Props {
  onComplete: () => void;
}

type Mode = 'choose' | 'setup' | 'restore';

export function FirstRunScreen({ onComplete }: Props) {
  const [mode, setMode] = useState<Mode>('choose');

  if (mode === 'restore')
    return <RestoreFlow onBack={() => setMode('choose')} onComplete={onComplete} />;
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
          maxWidth: 420,
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
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
            <Button variant="primary" onClick={() => setMode('setup')}>
              {t('firstRun.choose.newSite')}
            </Button>
            <Button variant="secondary" onClick={() => setMode('restore')}>
              {t('firstRun.choose.restore')}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SetupFlow({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [companyName, setCompanyName] = useState('');
  const [credentials, setCredentials] = useState<FirstRunCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setCredentials(await api.initialize(companyName));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('firstRun.error.default'));
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
          maxWidth: 640,
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

        <OfflineBanner>{t('firstRun.ready.writeDownWarning')}</OfflineBanner>

        <Card>
          <h2 className="ob-title" style={{ margin: '0 0 var(--s-12)' }}>
            {t('firstRun.ready.signInSection')}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-12)' }}>
            <LabeledValue label={t('firstRun.ready.usernameLabel')} value={credentials.username} />
            <LabeledValue label={t('firstRun.ready.passwordLabel')} value={credentials.password} />
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
          maxWidth: 420,
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

        {error && <FieldError>{error}</FieldError>}

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
      setError(err instanceof ApiError ? err.message : 'Could not read that file');
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
      setError(err instanceof ApiError ? err.message : 'Restore failed');
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
          maxWidth: 480,
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
