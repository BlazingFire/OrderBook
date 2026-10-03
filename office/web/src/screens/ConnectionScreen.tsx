/**
 * The Office Panel's first screen. Shows whether this PC is on the network at
 * all, then offers the two ways to reach a Master.
 *
 * Auto connection is presented first and recommended; manual exists for
 * networks where broadcast traffic is blocked.
 */

import { useState, type FormEvent } from 'react';
import type { BackupRestorePreview } from '@orderbook/shared';

import { api, ApiError, type ConnectionInfo, type DiscoveredMaster } from '../api';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  FieldError,
  FormField,
  Input,
  Segmented,
  StatusPill,
  rem,
  t,
  type DataTableColumn,
  PasswordInput,
} from '@orderbook/ui';

interface Props {
  connection: ConnectionInfo;
  onConnected: () => void;
}

export function ConnectionScreen({ connection, onConnected }: Props) {
  const [mode, setMode] = useState<'auto' | 'manual' | 'restore'>('auto');

  const [restoreStep, setRestoreStep] = useState<'pick' | 'preview' | 'done'>('pick');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePreview, setRestorePreview] = useState<BackupRestorePreview | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function handleRestoreFileChosen(chosen: File) {
    setRestoreFile(chosen);
    setRestoreError(null);
    setRestoreBusy(true);
    try {
      setRestorePreview(await api.previewRestoreConnection(chosen));
      setRestoreStep('preview');
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : t('connection.errorFallback'));
    } finally {
      setRestoreBusy(false);
    }
  }

  async function handleRestore() {
    if (!restoreFile) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      await api.restoreConnection(restoreFile, restorePassphrase, false);
      setRestoreStep('done');
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : t('connection.errorFallback'));
    } finally {
      setRestoreBusy(false);
    }
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<DiscoveredMaster[] | null>(null);

  const [host, setHost] = useState('');
  const [port, setPort] = useState('4100');
  const [pairingPassword, setPairingPassword] = useState('');
  const [panelName, setPanelName] = useState(connection.panelName);

  async function connectAutomatically() {
    setBusy(true);
    setError(null);
    try {
      await api.pairAuto(panelName);
      onConnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('connection.errorFallback'));
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const result = await api.scan();
      setFound(result.masters);
      // Prefill the manual form from whatever answered, so the operator rarely
      // has to type an address even when using manual mode.
      const first = result.masters[0];
      if (first) {
        setHost(first.lanIp);
        setPort(String(first.httpPort));
      }
    } catch {
      setError(t('connection.scanErrorFallback'));
    } finally {
      setBusy(false);
    }
  }

  async function connectManually(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.pairManual({
        host: host.trim(),
        port: Number(port) || 4100,
        pairingPassword: pairingPassword.trim(),
        panelName,
      });
      onConnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('connection.errorFallback'));
    } finally {
      setBusy(false);
    }
  }

  const masterColumns: DataTableColumn<DiscoveredMaster>[] = [
    {
      key: 'name',
      header: t('connection.scan.col.master'),
      render: (master) => master.companyName ?? t('connection.scan.defaultName'),
    },
    {
      key: 'address',
      header: t('connection.scan.col.address'),
      width: rem(160),
      render: (master) => (
        <span className="ob-mono">
          {master.lanIp}:{master.httpPort}
        </span>
      ),
    },
    {
      key: 'accepting',
      header: t('connection.scan.col.accepting'),
      width: rem(130),
      render: (master) => (
        <StatusPill tone={master.acceptingPairing ? 'ok' : 'default'}>
          {master.acceptingPairing
            ? t('connection.scan.acceptingYes')
            : t('connection.scan.acceptingNo')}
        </StatusPill>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: rem(620), margin: 'var(--s-40) auto', padding: '0 var(--s-16)' }}>
      <h1 className="ob-display" style={{ marginBottom: 'var(--s-16)' }}>
        {t('connection.title')}
      </h1>

      <Card style={{ marginBottom: 'var(--s-16)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
          <StatusPill tone={connection.hasNetworkLink ? 'ok' : 'offline'}>
            {connection.hasNetworkLink
              ? t('connection.status.connected')
              : t('connection.status.disconnected')}
          </StatusPill>
        </div>
        {connection.hasNetworkLink ? (
          <p className="ob-small" style={{ marginTop: 'var(--s-6)' }}>
            {t('connection.status.thisPc', {
              addresses: connection.interfaces.map((entry) => entry.address).join(', '),
            })}
          </p>
        ) : (
          <p className="ob-small" style={{ marginTop: 'var(--s-6)' }}>
            {t('connection.status.hint')}
          </p>
        )}
        {/* Before pairing the code comes from this PC's name; pairing replaces
            it with one derived from the id the Master issues. */}
        {connection.deviceCode && (
          <p className="ob-small" style={{ marginTop: 'var(--s-6)' }}>
            {`${t('signin.deviceCode')} · `}
            <span className="ob-mono">{connection.deviceCode}</span>
            {!connection.isPaired && ` · ${t('connection.deviceCodeProvisional')}`}
          </p>
        )}
      </Card>

      {error && <FieldError>{error}</FieldError>}

      <div style={{ margin: 'var(--s-16) 0' }}>
        <Segmented
          options={[
            { value: 'auto' as const, label: t('connection.mode.auto') },
            { value: 'manual' as const, label: t('connection.mode.manual') },
            { value: 'restore' as const, label: t('backup.restore.title') },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>

      {mode === 'restore' ? (
        <Card>
          <h2 className="ob-title" style={{ marginBottom: 'var(--s-12)' }}>
            {t('backup.restore.title')}
          </h2>

          {restoreError && <FieldError>{restoreError}</FieldError>}

          {restoreStep === 'pick' && (
            <FormField label={t('backup.restore.chooseFile')}>
              {(id) => (
                <input
                  id={id}
                  type="file"
                  accept=".obbackup"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    if (chosen) void handleRestoreFileChosen(chosen);
                  }}
                />
              )}
            </FormField>
          )}

          {restoreStep === 'preview' && restorePreview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
              <ul className="ob-small" style={{ margin: 0, paddingLeft: 18 }}>
                {restorePreview.summaryLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <FormField label={t('backup.restore.passphraseLabel')}>
                {(id) => (
                  <PasswordInput
                    id={id}
                    value={restorePassphrase}
                    onChange={(event) => setRestorePassphrase(event.target.value)}
                    autoComplete="current-password"
                  />
                )}
              </FormField>
              <Button
                variant="primary"
                busy={restoreBusy}
                disabled={!restorePassphrase}
                onClick={() => void handleRestore()}
              >
                {t('backup.restore.confirm')}
              </Button>
            </div>
          )}

          {restoreStep === 'done' && (
            <>
              <p className="ob-body">{t('backup.restore.donePairAgain')}</p>
              <Button
                variant="primary"
                onClick={() => {
                  setMode('auto');
                  window.location.reload();
                }}
              >
                {t('action.close')}
              </Button>
            </>
          )}
        </Card>
      ) : mode === 'auto' ? (
        <Card>
          <h2 className="ob-title" style={{ marginBottom: 'var(--s-12)' }}>
            {t('connection.auto.title')}
          </h2>
          <ol className="ob-small" style={{ paddingLeft: 18, marginBottom: 'var(--s-16)' }}>
            <li>{t('connection.auto.step1')}</li>
            <li>{t('connection.auto.step2')}</li>
            <li>{t('connection.auto.step3')}</li>
          </ol>

          <FormField label={t('connection.panelName')}>
            {(id) => (
              <Input
                id={id}
                value={panelName}
                onChange={(event) => setPanelName(event.target.value)}
              />
            )}
          </FormField>

          <div style={{ display: 'flex', gap: 'var(--s-8)', marginTop: 'var(--s-16)' }}>
            <Button
              variant="primary"
              busy={busy}
              disabled={!connection.hasNetworkLink}
              onClick={() => void connectAutomatically()}
            >
              {busy ? t('connection.auto.connecting') : t('connection.auto.connect')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void scan()}>
              {t('connection.auto.scanOnly')}
            </Button>
          </div>

          {found && (
            <div style={{ marginTop: 'var(--s-16)' }}>
              {found.length === 0 ? (
                <EmptyState
                  title={t('connection.scan.none.title')}
                  description={t('connection.scan.none.description')}
                  actionLabel={t('connection.auto.scanOnly')}
                  onAction={() => void scan()}
                />
              ) : (
                <DataTable
                  columns={masterColumns}
                  rows={found}
                  rowKey={(master) => master.masterUniqueId}
                  empty={
                    <EmptyState
                      title={t('connection.scan.none.title')}
                      description={t('connection.scan.none.description')}
                      actionLabel={t('connection.auto.scanOnly')}
                      onAction={() => void scan()}
                    />
                  }
                />
              )}
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <form onSubmit={(event) => void connectManually(event)}>
            <h2 className="ob-title" style={{ marginBottom: 'var(--s-8)' }}>
              {t('connection.manual.title')}
            </h2>
            <p className="ob-small" style={{ marginBottom: 'var(--s-16)' }}>
              {t('connection.manual.hint')}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-16)' }}>
              <FormField label={t('connection.manual.address')}>
                {(id) => (
                  <Input
                    id={id}
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="192.168.1.10"
                    required
                  />
                )}
              </FormField>
              <FormField label={t('connection.manual.port')}>
                {(id) => (
                  <Input id={id} value={port} onChange={(event) => setPort(event.target.value)} />
                )}
              </FormField>
            </div>

            <div style={{ marginTop: 'var(--s-16)' }}>
              <FormField label={t('connection.manual.password')}>
                {(id) => (
                  <PasswordInput
                    id={id}
                    value={pairingPassword}
                    onChange={(event) => setPairingPassword(event.target.value)}
                    required
                  />
                )}
              </FormField>
            </div>

            <div style={{ marginTop: 'var(--s-16)' }}>
              <FormField label={t('connection.panelName')}>
                {(id) => (
                  <Input
                    id={id}
                    value={panelName}
                    onChange={(event) => setPanelName(event.target.value)}
                  />
                )}
              </FormField>
            </div>

            <Button
              type="submit"
              variant="primary"
              busy={busy}
              style={{ marginTop: 'var(--s-16)' }}
            >
              {busy ? t('connection.manual.connecting') : t('connection.manual.connect')}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
