/**
 * "Update needed" (1.4 R7e): this Office Panel runs an older version than the
 * Master it is talking to, so it does not enter the app until the two match.
 *
 * Shown after sign-in, in place of everything else, because the update itself
 * comes through the signed-in panel (download from the Master, verify, install).
 * Whoever is signed in may install it: the rule is the owner's and the Windows
 * prompt still needs an administrator.
 *
 * **Offline and Standalone.** The block applies only once this panel *knows* the
 * Master's version, which it learns from the Master's own snapshot. An Office
 * that starts with no connection has nothing to compare against and works
 * offline as it always has; the first snapshot after it reconnects to a newer
 * Master brings this screen. A Standalone `.exe` cannot install itself, so its
 * screen says what to do by hand (`updates.standaloneBody`) and still blocks:
 * an Office on another version than its Master is the thing this prevents.
 */

import { Button, rem, t } from '@orderbook/ui';

import type { ConnectionInfo } from '../api';
import { UpdatesScreen } from './UpdatesScreen';

export function UpdateRequiredScreen({
  connection,
  permissions,
  onSignOut,
}: {
  connection: ConnectionInfo;
  permissions: string[];
  onSignOut: () => void;
}) {
  return (
    <main
      style={{
        maxWidth: rem(760),
        margin: '0 auto',
        padding: 'var(--s-32) var(--s-16)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-16)',
      }}
    >
      <h1 className="ob-title" style={{ margin: 0 }}>
        {t('updates.required.title')}
      </h1>
      <p className="ob-body" style={{ margin: 0 }}>
        {t('updates.required.body', {
          mine: __APP_VERSION__,
          master: connection.masterVersion ?? '',
        })}
      </p>
      <UpdatesScreen connection={connection} permissions={permissions} mandatory />
      <div>
        <Button variant="ghost" onClick={onSignOut}>
          {t('action.signOut')}
        </Button>
      </div>
    </main>
  );
}
