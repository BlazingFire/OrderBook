/**
 * UserMenu: the account entry point. Avatar trigger, identity header, account
 * rows, inline theme switch, sign out with progress. Built on Popover +
 * Segmented with kit icons, i18n strings and the theme module.
 */

import { useState } from 'react';

import { Avatar, type AvatarSize } from './Avatar.js';
import type { UserAvatar } from '@orderbook/shared';
import { Button } from './Button.js';
import { Icon, type IconName } from './icons.js';
import { t } from './i18n.js';
import { Popover } from './Popover.js';
import { Segmented } from './Tabs.js';
import { applyMotion, applyTheme, loadTheme, motionDisabled, type Theme } from './theme.js';
import { BusyMark } from './BusyMark.js';

export interface UserMenuItem {
  label: string;
  icon?: IconName;
  keys?: string[];
  onSelect?: () => void;
}

export function UserMenu({
  name,
  email,
  avatar,
  highlight,
  role,
  items = [],
  onChangePassword,
  onSignOut,
  theme,
  onThemeChange,
  size = 'sm',
}: {
  name: string;
  email?: string | null;
  avatar?: UserAvatar | null | undefined;
  /** Ring marking a Server Master, wherever their face appears. */
  highlight?: boolean;
  role?: string | null;
  items?: UserMenuItem[];
  onChangePassword?: () => void;
  onSignOut: () => void | Promise<unknown>;
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
  size?: AvatarSize;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<Theme>(theme ?? loadTheme());
  const [motionOn, setMotionOn] = useState(!motionDisabled());

  const pickTheme = (next: Theme): void => {
    setCurrentTheme(next);
    applyTheme(next);
    onThemeChange?.(next);
  };

  const toggleMotion = (): void => {
    const next = !motionOn;
    setMotionOn(next);
    applyMotion(next);
  };

  const signOut = (): void => {
    if (signingOut) return;
    const result = onSignOut();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      setSigningOut(true);
      void (result as Promise<unknown>).then(
        () => setOpen(false),
        () => setSigningOut(false),
      );
    } else {
      setOpen(false);
    }
  };

  return (
    <span className="ob-usermenu">
      <button
        type="button"
        className="ob-usermenu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('userMenu.account', { name })}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar name={name} avatar={avatar} size={size} highlight={highlight} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div role="menu" aria-label={t('userMenu.account', { name })} className="ob-popover--menu ob-usermenu-panel">
          <div className="ob-usermenu-head">
            <Avatar name={name} avatar={avatar} size="md" highlight={highlight} />
            <div className="ob-usermenu-name">
              <strong>{name}</strong>
              {email ? <span className="ob-small">{email}</span> : null}
              {role ? <span className="ob-small">{role}</span> : null}
            </div>
          </div>
          {items.length > 0 ? (
            <div role="group" aria-label={t('userMenu.actions')}>
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className="ob-usermenu-row"
                  onClick={() => {
                    item.onSelect?.();
                    setOpen(false);
                  }}
                >
                  {item.icon ? <Icon name={item.icon} size={16} /> : null}
                  <span>{item.label}</span>
                  {item.keys ? (
                    <span className="ob-usermenu-keys" aria-hidden="true">
                      {item.keys.join(' ')}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {onChangePassword ? (
            <button
              type="button"
              role="menuitem"
              className="ob-usermenu-row"
              onClick={() => {
                onChangePassword();
                setOpen(false);
              }}
            >
              <Icon name="key" size={16} />
              <span>{t('action.changePassword')}</span>
            </button>
          ) : null}
          <div role="group" aria-label={t('userMenu.theme')} className="ob-usermenu-row" style={{ cursor: 'default' }}>
            <Icon name="settings" size={16} />
            <span>{t('userMenu.theme')}</span>
            <span style={{ marginLeft: 'auto' }}>
              <Segmented<Theme>
                label={t('userMenu.theme')}
                options={[
                  { value: 'light', label: t('userMenu.themeLight') },
                  { value: 'dark', label: t('userMenu.themeDark') },
                ]}
                value={currentTheme}
                onChange={pickTheme}
              />
            </span>
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!motionOn}
            className="ob-usermenu-row"
            onClick={toggleMotion}
          >
            <Icon name={motionOn ? 'eye' : 'eye-off'} size={16} />
            <span>{t('userMenu.motion')}</span>
            <span className="ob-usermenu-keys" aria-hidden="true">
              {motionOn ? t('common.on') : t('common.off')}
            </span>
          </button>
          <div role="separator" className="ob-divider" style={{ margin: 'var(--s-4) 0' }} />
          <Button
            variant="ghost"
            className="ob-btn--signout"
            busy={signingOut}
            disabled={signingOut}
            role="menuitem"
            onClick={signOut}
            aria-label={t('action.signOut')}
          >
            {signingOut ? null : <Icon name="sign-out" size={16} />}
            {signingOut ? t('userMenu.signingOut') : t('action.signOut')}
          </Button>
          <span className="ob-sr-only" role="status">
            {signingOut ? t('userMenu.signingOut') : ''}
          </span>
        </div>
      </Popover>
      {signingOut ? <BusyMark size={14} label="" /> : null}
    </span>
  );
}
