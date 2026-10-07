/**
 * Who is at this panel (docs/ROLES_AND_USERS.md §12).
 *
 * Until this session, an Office Panel authenticated as a *machine* and everyone
 * who walked up to it inherited the panel's role. This screen is what makes the
 * panel ask who is using it, so a lead is raised by a person and the permissions
 * enforced are theirs.
 *
 * It is shown after pairing and before anything else. There is no "continue
 * without signing in" — a panel acting for nobody is exactly the state the
 * per-user model exists to remove.
 *
 * **Faces first, then a password.** A shop PC is used by the same three or four
 * people all day, and making each of them type a username every time is a tax
 * on the till. The panel already remembered who had signed in on it — that is
 * how offline sign-in works at all — so the list is that record with a picture
 * beside it. Picking a face fills the username and asks only for the password;
 * the username form is still there for a first sign-in, or for somebody who is
 * not on the list.
 *
 * The list is **this panel's**, never the company roster. A machine shows the
 * handful of people who actually use it, which is both the useful thing and the
 * smallest disclosure.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MessageKey } from '@orderbook/shared';

import { api, type ConnectionInfo, type PanelProfile, type PanelSession } from '../api';
import {
  Avatar,
  Button,
  CapsLockHint,
  Card,
  DeviceWarning,
  FieldError,
  FormField,
  Input,
  LogoLockup,
  OfflineBanner,
  apiErrorText,
  rem,
  t,
  useConfirm,
  PasswordInput,
  useCapsLock,
  useDeviceInfo,
} from '@orderbook/ui';

import { ConnectionUnpair } from '../components/ConnectionUnpair';
import { StoragePathCard } from '../components/StoragePathCard';

interface Props {
  connection: ConnectionInfo;
  onSignedIn: (session: PanelSession) => void;
  /** Why the window is back here, when it did not get here by signing out. */
  notice?: MessageKey | null;
  /** This PC left its Master from here: the app asks the server who it is now. */
  onLeft: () => void;
}

export function SignInScreen({ connection, onSignedIn, notice, onLeft }: Props) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<PanelProfile[]>([]);
  /** The face somebody picked. `null` means the plain username form. */
  const [chosen, setChosen] = useState<PanelProfile | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const caps = useCapsLock();
  // This panel's own server runs on this PC, so these are this PC's figures.
  const device = useDeviceInfo(api.device);

  // "Not reachable" only once the link has actually failed. While it is still being
  // made (the first seconds after pairing) the old line said the Master was down.
  const offline = connection.state === 'disconnected';
  const connecting = connection.state === 'connecting';

  useEffect(() => {
    // A panel nobody has used yet simply has none, and the screen is then
    // exactly the username form it always was.
    void api
      .profiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { session } = await api.signIn(chosen?.username ?? username, password);
      onSignedIn(session);
    } catch (caught) {
      // Renders the `messageKey` the transport carries, falling back to the
      // coarse `error.<code>` token and only then to English. Every sign-in
      // failure used to show the server's own sentence, because this line read
      // `caught.message` and dropped the key.
      setError(apiErrorText(caught, 'signin.errorFallback'));
      setPassword('');
      // Back in the password box, empty: the next thing to do is type it again.
      window.setTimeout(() => passwordRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }

  async function forget(profile: PanelProfile) {
    // Asked, and asked with the consequence named.
    //
    // The × sits a few pixels from the button that picks a face, on a machine
    // people use in a hurry. Removing somebody takes their offline verifier
    // with them, so while the Master is unreachable — the state this list
    // exists for — the person removed cannot sign in here at all until it
    // comes back. That is right when somebody leaves and wrong as a slip, and
    // nothing else on this screen can undo it.
    // A themed, translated dialog rather than `window.confirm`, which in
    // Electron renders the bare Chromium prompt — untranslated, unthemed, and
    // with the page origin in its title bar on Windows.
    const confirmed = await confirm({
      title: t('signin.forgetConfirm', { name: profile.displayName }),
      confirmLabel: t('signin.forgetAction'),
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await api.forgetProfile(profile.userId);
    } catch (caught) {
      // The row used to disappear whatever happened, so a failed delete left
      // the list claiming a removal the panel had not made.
      setError(apiErrorText(caught, 'signin.forgetFailed'));
      return;
    }

    setProfiles((current) => current.filter((entry) => entry.userId !== profile.userId));
    if (chosen?.userId === profile.userId) setChosen(null);
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--s-24)',
        maxWidth: rem(420),
        margin: '0 auto',
        padding: 'var(--s-56) var(--s-16)',
      }}
    >
      <LogoLockup markSize={28} />

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          <h1 className="ob-title" style={{ margin: 0 }}>
            {t('signin.submit')}
          </h1>
          <p className="ob-small" style={{ margin: 0 }}>
            {connection.companyName ?? t('signin.subtitleFallback')}
          </p>
        </div>

        {/* Which PC this is, so a person can read it out to whoever runs the
            Master. Absent when the panel's server could not read it. */}
        {connection.deviceCode && (
          <p className="ob-small" style={{ textAlign: 'center', margin: 0 }}>
            {`${t('signin.deviceCode')} · `}
            <span className="ob-mono">{connection.deviceCode}</span>
          </p>
        )}

        {/* Above the card: it explains why this screen is here, which is not
            about the fields below. */}
        {notice && (
          <div className="ob-banner" role="status">
            <span>{t(notice)}</span>
          </div>
        )}

        {/*
          Said before the attempt, not after it fails. Offline sign-in only works
          for people who have signed in on this panel before, and discovering that
          through a refusal reads as "my password is wrong".
        */}
        {offline && <OfflineBanner>{t('signin.offlineNotice')}</OfflineBanner>}
        {connecting && (
          <p className="ob-small" role="status">
            {t('connection.setup.connecting', {
              company: connection.companyName ?? t('connection.scan.defaultName'),
            })}
          </p>
        )}
        {connection.notRecognised && connection.state !== 'connected' ? (
          <div className="ob-banner ob-banner--conflict" role="alert">
            <span>{t('office.link.notRecognised', { host: connection.masterHost ?? '—' })}</span>
          </div>
        ) : null}

        {profiles.length > 0 && !chosen && (
          <Card>
            <div className="ob-eyebrow">{t('signin.chooseProfile')}</div>
            <ul className="ob-profile-list">
              {profiles.map((profile) => (
                <li key={profile.userId} className="ob-profile-row">
                  <button
                    type="button"
                    className="ob-profile-pick"
                    title={`${profile.displayName} � ${profile.roleName}`}
                    onClick={() => {
                      setChosen(profile);
                      setError(null);
                      setPassword('');
                    }}
                  >
                    <Avatar
                      name={profile.displayName}
                      avatar={null}
                      size="md"
                      src={profile.hasAvatar ? api.profileAvatarUrl(profile.userId) : undefined}
                    />
                    <span className="ob-profile-name">
                      <span className="ob-body-strong">{profile.displayName}</span>
                      <span className="ob-small">{profile.roleName}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ob-icon-btn"
                    aria-label={t('signin.forgetProfile', { name: profile.displayName })}
                    title={t('signin.forgetProfile', { name: profile.displayName })}
                    onClick={() => void forget(profile)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <form
            onSubmit={(event) => void submit(event)}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}
          >
            {chosen ? (
              // The face stays on screen while they type, so it is obvious who
              // the password is for — the whole point of having picked one.
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
                <Avatar
                  name={chosen.displayName}
                  avatar={null}
                  size="md"
                  src={chosen.hasAvatar ? api.profileAvatarUrl(chosen.userId) : undefined}
                />
                <span style={{ flex: 1 }}>
                  <span className="ob-body-strong" style={{ display: 'block' }}>
                    {chosen.displayName}
                  </span>
                  <span className="ob-small">{chosen.username}</span>
                </span>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setChosen(null);
                    setPassword('');
                    setError(null);
                  }}
                >
                  {t('signin.notYou')}
                </Button>
              </div>
            ) : (
              <FormField label={t('signin.username')}>
                {(id) => (
                  <Input
                    id={id}
                    value={username}
                    autoFocus
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                )}
              </FormField>
            )}

            <FormField label={t('signin.password')}>
              {(id) => (
                <PasswordInput
                  id={id}
                  ref={passwordRef}
                  value={password}
                  // Focused when a face was picked: the only thing left to do.
                  autoFocus={Boolean(chosen)}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  {...caps.handlers}
                />
              )}
            </FormField>
            <CapsLockHint on={caps.on} />

            {/* Stays visible until the next attempt — a failed sign-in must not
                vanish the way a toast would after a few seconds. */}
            {error && <FieldError>{error}</FieldError>}

            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={!(chosen ? chosen.username : username) || !password}
            >
              {busy ? t('signin.submitting') : t('signin.submit')}
            </Button>
          </form>
        </Card>

        {/* Said before signing in, not after it feels slow: this PC is short of memory or cores. */}
        <DeviceWarning device={device} />

        {/*
          Where this panel keeps its files.

          On the sign-in screen because that is when it is needed: setting up a
          new PC happens before there is anybody to sign in as, and until now
          the only way to move a panel's folder was an administrator on the
          Master, over the socket — no help while standing at the new machine.
        */}
        <StoragePathCard />

        {/*
          The way out of a Master that is gone, replaced or wrong. Here, before anybody
          has signed in, because that is when it is needed; the Master cannot be asked.
          Only then: while connected and recognised, leaving needs somebody signed in who
          manages panels (Settings), and the server refuses it otherwise.
        */}
        {connection.state !== 'connected' || connection.notRecognised ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--s-16)' }}>
            <ConnectionUnpair company={connection.companyName} onDone={onLeft} canDiscard={false} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
