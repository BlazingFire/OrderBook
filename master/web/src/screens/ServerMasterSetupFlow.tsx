/**
 * The Server Master accounts an older installation owes its owner.
 *
 * A Master set up before 1.3 (or restored from such a backup) has fewer than
 * two active Server Masters. On the Master PC the sign-in screen shows this
 * flow first, and it cannot be skipped: the master key, then exactly the
 * missing accounts. LAN browsers and Office panels keep working meanwhile,
 * because nothing here touches anyone else's session.
 *
 * The account blocks are shared with first-run setup (`FirstRunScreen.tsx`).
 */

import { useState } from 'react';
import {
  SUGGESTED_SERVER_MASTER_USERNAMES,
  type ServerMasterAccountInput,
} from '@orderbook/shared';

import { api } from '../api';
import { MasterKeyForm } from '../components/MasterKeyPrompt';
import {
  Button,
  Card,
  EmptyState,
  FieldError,
  FormField,
  Input,
  LogoLockup,
  apiErrorText,
  rem,
  t,
  PasswordInput,
  SaveTextButton,
} from '@orderbook/ui';

/** The server's own floor (`validation.password.tooShort`), checked here too. */
const MIN_PASSWORD_LENGTH = 8;

/** One account block as typed, before it is checked and sent. */
export interface AccountDraft {
  username: string;
  displayName: string;
  password: string;
  confirm: string;
}

/**
 * `count` blank blocks, each prefilled with a suggested username that no
 * existing Server Master already has.
 */
export function accountDrafts(count: number, taken: readonly string[] = []): AccountDraft[] {
  const free = SUGGESTED_SERVER_MASTER_USERNAMES.filter((name) => !taken.includes(name));
  return Array.from({ length: count }, (_, index) => ({
    username: free[index] ?? '',
    displayName: '',
    password: '',
    confirm: '',
  }));
}

/** The first thing wrong with the blocks, in the reader's language, or null. */
export function accountDraftsError(drafts: readonly AccountDraft[]): string | null {
  for (const draft of drafts) {
    if (!draft.username.trim()) return t('validation.user.username.required');
    if (!draft.displayName.trim()) return t('validation.user.displayName.required');
    if (draft.password.length < MIN_PASSWORD_LENGTH) return t('validation.password.tooShort');
    if (draft.password !== draft.confirm) return t('firstRun.serverMaster.passwordMismatch');
  }
  const names = drafts.map((draft) => draft.username.trim().toLowerCase());
  if (new Set(names).size !== names.length) return t('firstRun.serverMaster.usernamesDistinct');
  return null;
}

export function toAccountInputs(drafts: readonly AccountDraft[]): ServerMasterAccountInput[] {
  return drafts.map((draft) => ({
    username: draft.username.trim(),
    displayName: draft.displayName.trim(),
    password: draft.password,
  }));
}

/** Two blocks are "Main" and "Backup"; a single missing one is the backup. */
function blockTitle(index: number, count: number): string {
  return index === 0 && count > 1
    ? t('firstRun.serverMaster.main')
    : t('firstRun.serverMaster.backup');
}

export function ServerMasterAccountFields({
  drafts,
  onChange,
}: {
  drafts: AccountDraft[];
  onChange: (next: AccountDraft[]) => void;
}) {
  const patch = (index: number, change: Partial<AccountDraft>) =>
    onChange(drafts.map((draft, at) => (at === index ? { ...draft, ...change } : draft)));

  return (
    <>
      {drafts.map((draft, index) => (
        <fieldset
          key={index}
          data-server-master-account={index}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-12)',
            margin: 0,
            padding: 'var(--s-12)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-md)',
          }}
        >
          <legend className="ob-label" style={{ padding: '0 var(--s-4)' }}>
            {blockTitle(index, drafts.length)}
          </legend>
          <FormField label={t('firstRun.serverMaster.username')}>
            {(id) => (
              <Input
                id={id}
                value={draft.username}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => patch(index, { username: event.target.value })}
              />
            )}
          </FormField>
          <FormField label={t('firstRun.serverMaster.displayName')}>
            {(id) => (
              <Input
                id={id}
                value={draft.displayName}
                onChange={(event) => patch(index, { displayName: event.target.value })}
              />
            )}
          </FormField>
          <FormField label={t('firstRun.serverMaster.password')}>
            {(id) => (
              <PasswordInput
                id={id}
                value={draft.password}
                autoComplete="new-password"
                onChange={(event) => patch(index, { password: event.target.value })}
              />
            )}
          </FormField>
          <FormField label={t('firstRun.serverMaster.confirmPassword')}>
            {(id) => (
              <PasswordInput
                id={id}
                value={draft.confirm}
                autoComplete="new-password"
                onChange={(event) => patch(index, { confirm: event.target.value })}
              />
            )}
          </FormField>
        </fieldset>
      ))}
    </>
  );
}

type Step = 'key' | 'accounts' | 'done';

export function ServerMasterSetupFlow({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('key');
  const [token, setToken] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<AccountDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlocked(nextToken: string): Promise<void> {
    setError(null);
    try {
      const { accounts, needed } = await api.serverMasters(nextToken);
      if (needed === 0) {
        // Another window on this PC finished the flow first.
        setStep('done');
        return;
      }
      setToken(nextToken);
      setDrafts(
        accountDrafts(
          needed,
          accounts.map((account) => account.username),
        ),
      );
      setStep('accounts');
    } catch (caught) {
      setError(apiErrorText(caught, 'error.requestFailed'));
    }
  }

  async function create(): Promise<void> {
    const problem = accountDraftsError(drafts);
    if (problem) {
      setError(problem);
      return;
    }
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.setUpServerMasters(toAccountInputs(drafts), token);
      setStep('done');
    } catch (caught) {
      // An expired token sends the owner back to the key rather than leaving a
      // form that can never succeed.
      if (
        (caught as { messageKey?: string }).messageKey === 'error.unauthorized.masterKeyRequired'
      ) {
        setToken(null);
        setStep('key');
      }
      setError(apiErrorText(caught, 'error.requestFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--s-24)',
        maxWidth: rem(480),
        margin: '0 auto',
        padding: 'var(--s-56) var(--s-16)',
      }}
    >
      <LogoLockup markSize={28} />

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
        <h1 className="ob-title" style={{ margin: 0, textAlign: 'center' }}>
          {t('masterKey.setup.title')}
        </h1>
        <p className="ob-small" style={{ textAlign: 'center', margin: 0 }}>
          {t('masterKey.setup.description')}
        </p>

        <Card>
          {step === 'key' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
              {error && <FieldError>{error}</FieldError>}
              <MasterKeyForm onUnlocked={(unlock) => void unlocked(unlock.token)} />
            </div>
          )}

          {step === 'accounts' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-16)' }}>
              <p className="ob-small" style={{ margin: 0 }}>
                {t('firstRun.serverMaster.help')}
              </p>
              <ServerMasterAccountFields drafts={drafts} onChange={setDrafts} />
              {error && <FieldError>{error}</FieldError>}
              <Button variant="primary" busy={busy} onClick={() => void create()}>
                {t('masterKey.setup.submit')}
              </Button>
            </div>
          )}

          {step === 'done' && (
            <>
              <EmptyState
                title={t('masterKey.setup.done')}
                actionLabel={t('signIn.action.signIn')}
                onAction={onDone}
              />
              {drafts.length > 0 && (
                <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'center', justifyContent: 'center' }}>
                  <SaveTextButton
                    title={t('saveText.title.serverMasters')}
                    slug="server-masters"
                    sections={drafts.map((draft) => ({
                      heading: draft.displayName.trim() || draft.username.trim(),
                      values: [
                        { label: t('saveText.label.username'), value: draft.username.trim() },
                        { label: t('saveText.label.password'), value: draft.password },
                      ],
                    }))}
                  />
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
