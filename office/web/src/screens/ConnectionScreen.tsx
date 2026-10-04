/**
 * The Office Panel's first screen. Shows whether this PC is on the network at
 * all, then offers the two ways to reach a Master.
 *
 * Auto connection is presented first and recommended; manual exists for
 * networks where broadcast traffic is blocked.
 *
 * **Nothing here can hang or fail silently.** A search or a pairing shows what it
 * is doing and has a Stop button; every refusal arrives as a code with a message
 * key (`office/src/services/pairing.service.ts`), is shown in the person's own
 * language with its next step beside it, and never follows them to the other tab.
 * Manual entry is checked as it is typed (`parseMasterAddress`, the same function
 * the server uses), can be tried with "Test connection" before anything is paired,
 * and remembers the last address.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ADDRESS_MESSAGE_PARAMS, parseMasterAddress, type MasterAddressProblem } from '@orderbook/shared';
import type { BackupRestorePreview } from '@orderbook/shared';

import {
  api,
  ApiError,
  type ConnectionInfo,
  type ConnectionTest,
  type DiscoveredMaster,
  type PairResult,
} from '../api';
import {
  Button,
  Card,
  ConflictBanner,
  DataTable,
  EmptyState,
  FieldError,
  FormField,
  Input,
  PasswordInput,
  Segmented,
  StatusPill,
  apiErrorText,
  formatDateTime,
  rem,
  t,
  translator,
  type DataTableColumn,
} from '@orderbook/ui';

interface Props {
  connection: ConnectionInfo;
  onConnected: (result?: PairResult) => void;
}

/** What went wrong, in words, and what to offer next. */
interface Failure {
  text: string;
  code: string;
  /** Who did answer, when somebody did. */
  found: FoundMaster[];
}

interface FoundMaster {
  masterUniqueId: string;
  companyName: string | null;
  address: string;
  acceptingPairing: boolean;
}

const LAST_MASTER_KEY = 'ob.office.lastMaster';

interface LastMaster {
  host: string;
  port: string;
  panelName?: string;
}

/** Remembered in this window's own storage: the address is not secret, and the password never is. */
function readLastMaster(): LastMaster | null {
  try {
    const raw = window.localStorage.getItem(LAST_MASTER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastMaster>;
    return typeof parsed.host === 'string' && parsed.host
      ? { host: parsed.host, port: String(parsed.port ?? ''), panelName: parsed.panelName }
      : null;
  } catch {
    return null;
  }
}

function rememberMaster(value: LastMaster): void {
  try {
    window.localStorage.setItem(LAST_MASTER_KEY, JSON.stringify(value));
  } catch {
    // Storage may be blocked; the next visit simply starts empty.
  }
}

function describe(caught: unknown): Failure {
  const error = caught instanceof ApiError ? caught : null;
  const found = (error?.details as { found?: FoundMaster[] } | undefined)?.found ?? [];
  return {
    text: apiErrorText(caught, 'connection.errorFallback'),
    code: error?.code ?? 'unknown',
    found: Array.isArray(found) ? found : [],
  };
}

const ADDRESS_PROBLEM_KEY = {
  empty: 'connection.error.emptyAddress',
  invalid_host: 'connection.error.invalidAddress',
  invalid_port: 'connection.error.invalidPort',
} as const satisfies Record<MasterAddressProblem, string>;

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

  /** What is under way: a search, a pairing, a scan or a test. At most one at a time. */
  const [busy, setBusy] = useState<'auto' | 'scan' | 'manual' | 'test' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [found, setFound] = useState<DiscoveredMaster[] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const stopper = useRef<AbortController | null>(null);

  const last = readLastMaster();
  const removed = connection.removedByMaster ?? null;
  const [host, setHost] = useState(last?.host ?? removed?.host ?? '');
  const [port, setPort] = useState(last?.port ?? (removed ? String(removed.port) : ''));
  const [pairingPassword, setPairingPassword] = useState('');
  const [panelName, setPanelName] = useState(last?.panelName ?? connection.panelName);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [tested, setTested] = useState<ConnectionTest | null>(null);
  /** When the Master's rate limit lets this PC try again. */
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const passwordRef = useRef<HTMLInputElement>(null);

  // A clock for the two things that count: the search's seconds and the rate limit's wait.
  useEffect(() => {
    if (busy === null && waitUntil <= now) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setElapsed((seconds) => (busy === null ? 0 : seconds + 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy, waitUntil, now]);

  // The screen going away stops whatever it started: nothing keeps searching behind a closed window.
  useEffect(() => () => stopper.current?.abort(), []);

  function begin(kind: NonNullable<typeof busy>): AbortSignal {
    stopper.current?.abort();
    stopper.current = new AbortController();
    setBusy(kind);
    setElapsed(0);
    setFailure(null);
    return stopper.current.signal;
  }

  function end(): void {
    setBusy(null);
    setElapsed(0);
  }

  function stop(): void {
    stopper.current?.abort();
  }

  function changeMode(next: typeof mode): void {
    stop();
    // An error about one way of connecting is not an error about the other.
    setFailure(null);
    setMode(next);
  }

  function failed(caught: unknown): Failure | null {
    const next = describe(caught);
    // Stopping on purpose is not a failure.
    if (next.code === 'cancelled' || next.code === 'aborted') return null;
    return next;
  }

  async function connectAutomatically(masterUniqueId?: string) {
    const signal = begin('auto');
    setFound(null);
    try {
      onConnected(await api.pairAuto({ panelName, masterUniqueId, signal }));
    } catch (caught) {
      setFailure(failed(caught));
    } finally {
      end();
    }
  }

  async function scan() {
    const signal = begin('scan');
    setFound(null);
    try {
      const result = await api.scan(signal);
      setFound(result.masters);
      // Prefill the manual form from whatever answered, so the operator rarely
      // has to type an address even when using manual mode.
      const first = result.masters[0];
      if (first) {
        setHost(first.addresses?.[0] ?? first.lanIp);
        setPort(String(first.httpPort));
      }
    } catch (caught) {
      setFailure(
        failed(caught) ?? {
          text: t('connection.scanErrorFallback'),
          code: 'scan_failed',
          found: [],
        },
      );
    } finally {
      end();
    }
  }

  /** The address fields, checked: their errors shown beside them, or the clean values. */
  function checkAddress(): { host: string; port: number } | null {
    const parsed = parseMasterAddress(host, port);
    if (parsed.ok) {
      setAddressError(null);
      setPortError(null);
      return parsed;
    }
    const message = t(ADDRESS_PROBLEM_KEY[parsed.problem], ADDRESS_MESSAGE_PARAMS);
    setAddressError(parsed.problem === 'invalid_port' ? null : message);
    setPortError(parsed.problem === 'invalid_port' ? message : null);
    return null;
  }

  async function testConnection() {
    const address = checkAddress();
    if (!address) return;
    const signal = begin('test');
    setTested(null);
    try {
      setTested(
        await api.testConnection({
          host: String(address.host),
          port: String(address.port),
          signal,
        }),
      );
    } catch (caught) {
      setFailure(failed(caught));
    } finally {
      end();
    }
  }

  async function connectManually(event: FormEvent) {
    event.preventDefault();
    const address = checkAddress();
    const missing = pairingPassword.trim() === '';
    setPasswordError(missing ? t('connection.error.passwordMissing') : null);
    if (!address || missing) return;

    const signal = begin('manual');
    try {
      const result = await api.pairManual({
        host: address.host,
        port: String(address.port),
        pairingPassword: pairingPassword.trim(),
        panelName,
        signal,
      });
      rememberMaster({ host: address.host, port: String(address.port), panelName });
      onConnected(result);
    } catch (caught) {
      const next = failed(caught);
      setFailure(next);
      if (next?.code === 'wrong_password') {
        // The password is the one thing to change: empty the box and put the cursor in it.
        setPairingPassword('');
        passwordRef.current?.focus();
      }
      if (next?.code === 'rate_limited') {
        const seconds = Number((caught as ApiError).params?.seconds) || 60;
        setWaitUntil(Date.now() + seconds * 1000);
        setNow(Date.now());
      }
    } finally {
      end();
    }
  }

  const waitSeconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const searching = busy === 'auto' || busy === 'scan';

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
          {master.addresses?.[0] ?? master.lanIp}:{master.httpPort}
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
    {
      key: 'connect',
      header: '',
      width: rem(120),
      align: 'right',
      render: (master) => (
        <Button
          size="sm"
          variant="primary"
          disabled={!master.acceptingPairing || busy !== null}
          title={master.acceptingPairing ? undefined : t('connection.pick.notAccepting')}
          onClick={() => void connectAutomatically(master.masterUniqueId)}
        >
          {t('connection.pick.connect')}
        </Button>
      ),
    },
  ];

  /** Next steps for a failure, as buttons next to the message. */
  const actions = failure ? (
    <span style={{ display: 'flex', gap: 'var(--s-8)' }}>
      {mode === 'auto' &&
      ['no_master_found', 'not_accepting', 'network_unavailable', 'multiple_masters'].includes(
        failure.code,
      ) ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void connectAutomatically()}
          >
            {t('connection.action.tryAgain')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => changeMode('manual')}>
            {t('connection.action.enterManually')}
          </Button>
        </>
      ) : null}
    </span>
  ) : null;

  return (
    <div style={{ maxWidth: rem(620), margin: 'var(--s-40) auto', padding: '0 var(--s-16)' }}>
      <h1 className="ob-display" style={{ marginBottom: 'var(--s-16)' }}>
        {t('connection.title')}
      </h1>

      {removed ? (
        <div
          className="ob-banner ob-banner--conflict"
          role="alert"
          style={{ marginBottom: 'var(--s-16)', flexDirection: 'column', alignItems: 'flex-start' }}
        >
          <strong>{t('connection.removed.title')}</strong>
          <span>
            {t('connection.removed.body', {
              company: removed.companyName ?? t('connection.scan.defaultName'),
              when: formatDateTime(removed.at),
            })}
          </span>
          {(connection.unsentChanges ?? 0) > 0 ? (
            <span>
              {translator().tCount('connection.removed.unsent', connection.unsentChanges ?? 0)}
            </span>
          ) : null}
        </div>
      ) : null}

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

      {failure ? (
        <div style={{ marginBottom: 'var(--s-16)' }}>
          <ConflictBanner action={actions}>{failure.text}</ConflictBanner>
          {failure.found.length > 0 ? (
            <ul
              className="ob-small"
              style={{
                margin: 'var(--s-6) 0 0',
                paddingLeft: failure.code === 'multiple_masters' ? 0 : 18,
                listStyle: failure.code === 'multiple_masters' ? 'none' : undefined,
              }}
            >
              {failure.found.map((master) => (
                <li
                  key={master.masterUniqueId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--s-8)',
                    marginTop: 'var(--s-4)',
                  }}
                >
                  <span style={{ flex: 1 }}>
                    {master.companyName ?? t('connection.scan.defaultName')}
                    {' · '}
                    <span className="ob-mono">{master.address}</span>
                    {master.acceptingPairing ? '' : ` · ${t('connection.pick.notAccepting')}`}
                  </span>
                  {/* Several answered: the person says which one this PC joins. */}
                  {failure.code === 'multiple_masters' ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!master.acceptingPairing || busy !== null}
                      onClick={() => void connectAutomatically(master.masterUniqueId)}
                    >
                      {t('connection.pick.connect')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div style={{ margin: 'var(--s-16) 0' }}>
        <Segmented
          options={[
            { value: 'auto' as const, label: t('connection.mode.auto') },
            { value: 'manual' as const, label: t('connection.mode.manual') },
            { value: 'restore' as const, label: t('backup.restore.title') },
          ]}
          value={mode}
          onChange={changeMode}
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

          <div
            style={{
              display: 'flex',
              gap: 'var(--s-8)',
              marginTop: 'var(--s-16)',
              alignItems: 'center',
            }}
          >
            <Button
              variant="primary"
              busy={busy === 'auto'}
              disabled={!connection.hasNetworkLink || busy !== null}
              onClick={() => void connectAutomatically()}
            >
              {busy === 'auto' ? t('connection.auto.connecting') : t('connection.auto.connect')}
            </Button>
            <Button variant="secondary" disabled={busy !== null} onClick={() => void scan()}>
              {t('connection.auto.scanOnly')}
            </Button>
            {searching ? (
              <Button variant="ghost" onClick={stop}>
                {t('connection.action.stop')}
              </Button>
            ) : null}
          </div>

          {searching ? (
            <p className="ob-small" role="status" style={{ marginTop: 'var(--s-8)' }}>
              {t('connection.search.progress', { seconds: elapsed })}
            </p>
          ) : null}

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
                <>
                  <h3 className="ob-title" style={{ marginBottom: 'var(--s-8)' }}>
                    {t('connection.pick.title')}
                  </h3>
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
                </>
              )}
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <form onSubmit={(event) => void connectManually(event)} noValidate>
            <h2 className="ob-title" style={{ marginBottom: 'var(--s-8)' }}>
              {t('connection.manual.title')}
            </h2>
            <p className="ob-small" style={{ marginBottom: 'var(--s-16)' }}>
              {t('connection.manual.hint')}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--s-16)' }}>
              <FormField label={t('connection.manual.address')} error={addressError ?? undefined}>
                {(id) => (
                  <Input
                    id={id}
                    value={host}
                    onChange={(event) => {
                      setHost(event.target.value);
                      setAddressError(null);
                      setTested(null);
                    }}
                    onBlur={() => {
                      if (host.trim() !== '') checkAddress();
                    }}
                    placeholder="192.168.1.10"
                    invalid={addressError !== null}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </FormField>
              <FormField label={t('connection.manual.port')} error={portError ?? undefined}>
                {(id) => (
                  <Input
                    id={id}
                    value={port}
                    onChange={(event) => {
                      setPort(event.target.value);
                      setPortError(null);
                      setTested(null);
                    }}
                    placeholder="4100"
                    inputMode="numeric"
                    invalid={portError !== null}
                    autoComplete="off"
                  />
                )}
              </FormField>
            </div>

            <div style={{ marginTop: 'var(--s-16)' }}>
              <FormField label={t('connection.manual.password')} error={passwordError ?? undefined}>
                {(id) => (
                  <PasswordInput
                    id={id}
                    ref={passwordRef}
                    value={pairingPassword}
                    onChange={(event) => {
                      setPairingPassword(event.target.value);
                      setPasswordError(null);
                    }}
                    invalid={passwordError !== null}
                    autoComplete="off"
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

            {tested ? (
              <div
                className={
                  tested.status === 'starting' || tested.standing !== 'same'
                    ? 'ob-banner ob-banner--offline'
                    : 'ob-banner'
                }
                role="status"
                style={{
                  marginTop: 'var(--s-16)',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <strong>
                  {t('connection.test.ok', {
                    address: `${tested.host}:${tested.port}`,
                    version: tested.version,
                  })}
                </strong>
                {tested.status === 'starting' ? <span>{t('connection.test.starting')}</span> : null}
                <span>
                  {tested.standing === 'same'
                    ? t('connection.test.same')
                    : tested.standing === 'behind'
                      ? t('connection.test.masterNewer', {
                          master: tested.version,
                          mine: tested.mine,
                        })
                      : tested.standing === 'ahead'
                        ? t('connection.test.masterOlder', {
                            master: tested.version,
                            mine: tested.mine,
                          })
                        : t('connection.test.unknown')}
                </span>
              </div>
            ) : null}

            <div
              style={{
                display: 'flex',
                gap: 'var(--s-8)',
                marginTop: 'var(--s-16)',
                alignItems: 'center',
              }}
            >
              <Button
                type="submit"
                variant="primary"
                busy={busy === 'manual'}
                disabled={busy !== null || waitSeconds > 0}
              >
                {busy === 'manual'
                  ? t('connection.manual.connecting')
                  : t('connection.manual.connect')}
              </Button>
              <Button
                variant="secondary"
                busy={busy === 'test'}
                disabled={busy !== null}
                onClick={() => void testConnection()}
              >
                {busy === 'test' ? t('connection.manual.testing') : t('connection.manual.test')}
              </Button>
              {busy === 'manual' || busy === 'test' ? (
                <Button variant="ghost" onClick={stop}>
                  {t('action.cancel')}
                </Button>
              ) : null}
            </div>
            {waitSeconds > 0 ? (
              <p className="ob-small" role="status" style={{ marginTop: 'var(--s-8)' }}>
                {t('connection.error.rateLimited', { seconds: waitSeconds })}
              </p>
            ) : null}
          </form>
        </Card>
      )}
    </div>
  );
}
