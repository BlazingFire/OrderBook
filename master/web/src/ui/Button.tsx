/**
 * Button (§9 Foundation): primary / secondary / ghost / danger · sm 26 · md 30 · lg 36.
 * Every state — default/hover/active/focus-visible/disabled/loading — lives in
 * base.css's `.ob-btn*` rules; this component only ever composes those classes.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  icon?: IconName;
  type?: 'button' | 'submit';
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  icon,
  type = 'button',
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = ['ob-btn', `ob-btn--${variant}`, size !== 'md' ? `ob-btn--${size}` : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || busy} aria-busy={busy} {...rest}>
      {icon && <Icon name={icon} size={size === 'lg' ? 18 : 16} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  size = 16,
  className,
  ...rest
}: {
  icon: IconName;
  label: string;
  size?: number;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={['ob-icon-btn', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  variant = 'primary',
  size = 'md',
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const classes = ['ob-btn', `ob-btn--${variant}`, size !== 'md' ? `ob-btn--${size}` : ''].filter(Boolean).join(' ');
  return (
    <a href={href} className={classes}>
      {children}
    </a>
  );
}
