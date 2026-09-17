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

import { useEffect, useState, type FormEvent } from 'react';
import type { MessageKey } from '@orderbook/shared';

import { api, type ConnectionInfo, type PanelProfile, type PanelSession } from '../api';
import {
  Avatar,
  Button,
  Card,
  FieldError,
  FormField,
  Input,
  LogoLockup,
  OfflineBanner,
  apiErrorText,
  rem,
  t,
  useConfirm,
} from '@orderbook/ui';

import { StoragePathCard } from '../components/StoragePathCard';

interface Props {
  connection: ConnectionInfo;
  onSignedIn: (session: PanelSession) => void;
  /** Why the window is back here, when it did not get here by signing out. */
  notice?: MessageKey | null;
}

export function SignInScreen({ connection, onSignedIn, notice }: Props) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<PanelProfile[]>([]);
  /** The face somebody picked. `null` means the plain username form. */
  const [chosen, setChosen] = useState<PanelProfile | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offline = connection.state !== 'connected';

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
      // failure used to show the server's English sentence — on a Hindi panel
      // too — because this line read `caught.message` and dropped the key.
      setError(apiErrorText(caught, 'signin.errorFallback'));
      setPassword('');
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
        <p className="ob-small" style={{ textAlign: 'center' }}>
          {connection.companyName ?? t('signin.subtitleFallback')}
        </p>

        {/* Above the card: it explains why this screen is here, which is not
            about the fields below. */}
        {notice && (
          <p className="ob-small" style={{ textAlign: 'center', margin: 0, color: 'var(--accent)' }}>
            {t(notice)}
          </p>
        )}

        {/*
          Said before the attempt, not after it fails. Offline sign-in only works
          for people who have signed in on this panel before, and discovering that
          through a refusal reads as "my password is wrong".
        */}
        {offline && <OfflineBanner>{t('signin.offlineNotice')}</OfflineBanner>}

        {profiles.length > 0 && !chosen && (
          <Card>
            <div className="ob-eyebrow">{t('signin.chooseProfile')}</div>
            <ul className="ob-profile-list">
              {profiles.map((profile) => (
                <li key={profile.userId} className="ob-profile-row">
                  <button
                    type="button"
                    className="ob-profile-pick"
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
                <Input
                  id={id}
                  type="password"
                  value={password}
                  // Focused when a face was picked: the only thing left to do.
                  autoFocus={Boolean(chosen)}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </FormField>

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

        {/*
          Where this panel keeps its files.

          On the sign-in screen because that is when it is needed: setting up a
          new PC happens before there is anybody to sign in as, and until now
          the only way to move a panel's folder was an administrator on the
          Master, over the socket — no help while standing at the new machine.
        */}
        <StoragePathCard />
      </div>
    </div>
  );
}
