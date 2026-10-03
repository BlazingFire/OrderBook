/**
 * "Update needed" / "Waiting for the Master to update" (1.4 R7e): this Office
 * Panel and the Master it is talking to are on different versions, so it does not
 * enter the app until the two match, in **either direction**:
 *
 *  - **behind** the Master: the update is offered here (below);
 *  - **ahead** of the Master: nothing to install on this PC, so the screen says
 *    it is waiting, and asks the panel for the Master's version again every few
 *    seconds, clearing by itself the moment the Master has been updated to match.
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

import { useEffect } from 'react';

import { Button, rem, t } from '@orderbook/ui';

import type { ConnectionInfo } from '../api';
import { UpdatesScreen } from './UpdatesScreen';

/** How often the waiting screen asks again whether the Master has caught up. */
export const RECHECK_MS = 10_000;

export function UpdateRequiredScreen({
  connection,
  permissions,
  onSignOut,
  ahead = false,
  onRecheck,
}: {
  connection: ConnectionInfo;
  permissions: string[];
  onSignOut: () => void;
  /** This panel is newer than its Master: wait for the Master, do not offer an install. */
  ahead?: boolean;
  /** Re-read the connection (the Master's version comes with it). Called every `RECHECK_MS` while waiting. */
  onRecheck?: () => void;
}) {
  useEffect(() => {
    if (!ahead || !onRecheck) return undefined;
    const timer = setInterval(onRecheck, RECHECK_MS);
    return () => clearInterval(timer);
  }, [ahead, onRecheck]);

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
        {ahead ? t('updates.waiting.title') : t('updates.required.title')}
      </h1>
      <p className="ob-body" style={{ margin: 0 }}>
        {t(ahead ? 'updates.waiting.body' : 'updates.required.body', {
          mine: __APP_VERSION__,
          master: connection.masterVersion ?? '',
        })}
      </p>
      {ahead ? null : <UpdatesScreen connection={connection} permissions={permissions} mandatory />}
      <div>
        <Button variant="ghost" onClick={onSignOut}>
          {t('action.signOut')}
        </Button>
      </div>
    </main>
  );
}
