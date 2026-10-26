/**
 * Arc action patterns, built natively in the kit (no motion/lucide/radix deps):
 * ActionButton (async commit with success state), ActionSwap (cycling states),
 * HoldToConfirm (press-and-hold destructive), CopyButton (copy with feedback),
 * ButtonGroup (joined related actions).
 *
 * All strings through `t()`; all motion on the kit tokens with reduced-motion
 * branches; icons from the kit set. Both panels import from `@orderbook/ui`.
 */

import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { BusyMark } from './BusyMark.js';
import { Button, IconButton, type ButtonSize, type ButtonVariant } from './Button.js';
import { copyText } from './clipboard.js';
import { Icon, type IconName } from './icons.js';
import { t } from './i18n.js';

/* ---------------------------------------------------------------- ActionButton */

export function ActionButton({
  label,
  pendingLabel,
  successLabel,
  onAction,
  onActionError,
  resetAfterMs = 2400,
  variant = 'primary',
  size = 'md',
  disabled,
  ...rest
}: {
  /** Idle label and accessible name. */
  label: string;
  onAction: () => void | Promise<void>;
  onActionError?: (error: unknown) => void;
  pendingLabel?: string;
  successLabel?: string;
  resetAfterMs?: number;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'type'>) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'success'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const busy = phase === 'pending';
  const shown =
    phase === 'pending' ? (pendingLabel ?? t('common.saving'))
    : phase === 'success' ? (successLabel ?? t('common.saved'))
    : label;

  return (
    <span className="ob-actionbtn" data-phase={phase}>
      <Button
        variant={variant}
        size={size}
        busy={busy}
        disabled={disabled || busy}
        aria-live="off"
        onClick={() => {
          if (phase === 'pending') return;
          let result: void | Promise<void>;
          try {
            result = onAction();
          } catch (error) {
            onActionError?.(error);
            return;
          }
          if (result && typeof (result as Promise<void>).then === 'function') {
            setPhase('pending');
            void (result as Promise<void>).then(
              () => {
                setPhase('success');
                if (resetAfterMs > 0) {
                  if (timer.current !== null) window.clearTimeout(timer.current);
                  timer.current = window.setTimeout(() => setPhase('idle'), resetAfterMs);
                }
              },
              (error: unknown) => {
                onActionError?.(error);
                setPhase('idle');
              },
            );
          }
        }}
        {...rest}
      >
        <span className="ob-actionbtn-label" key={shown} aria-hidden="true">
          {shown}
        </span>
        <span className="ob-sr-only" role="status">
          {shown}
        </span>
      </Button>
    </span>
  );
}

/* ------------------------------------------------------------------ ActionSwap */

export interface ActionSwapState {
  id: string;
  label: string;
  icon?: IconName;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'quiet';
  pendingLabel?: string;
  holdFor?: number;
}

export function ActionSwap({
  states,
  value,
  defaultValue,
  onValueChange,
  onAction,
  failureLabel,
  size = 'md',
  ...rest
}: {
  states: ActionSwapState[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string, state: ActionSwapState) => void;
  onAction?: (next: ActionSwapState, current: ActionSwapState) => void | Promise<unknown>;
  failureLabel?: string;
  size?: ButtonSize;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onChange' | 'children' | 'value'>) {
  const [inner, setInner] = useState(defaultValue ?? states[0]?.id ?? '');
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const holdTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
  }, []);
  const currentId = value ?? inner;
  const at = Math.max(0, states.findIndex((state) => state.id === currentId));
  const current = states[at] ?? states[0]!;
  const next = states[(at + 1) % states.length]!;
  const failText = failureLabel ?? t('common.tryAgain');

  const press = (): void => {
    if (states.length < 2 || working) return;
    if (!onAction) {
      setInner(next.id);
      onValueChange?.(next.id, next);
      if (next.holdFor && next.holdFor > 0) {
        if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
        holdTimer.current = window.setTimeout(() => {
          const back = states[(at + 2) % states.length] ?? states[0]!;
          setInner(back.id);
          onValueChange?.(back.id, back);
        }, next.holdFor);
      }
      return;
    }
    setWorking(true);
    setFailed(false);
    void Promise.resolve()
      .then(() => onAction(next, current))
      .then(
        () => {
          setInner(next.id);
          onValueChange?.(next.id, next);
          setWorking(false);
          if (next.holdFor && next.holdFor > 0) {
            if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
            holdTimer.current = window.setTimeout(() => {
              const back = states[(at + 2) % states.length] ?? states[0]!;
              setInner(back.id);
              onValueChange?.(back.id, back);
            }, next.holdFor);
          }
        },
        () => {
          setWorking(false);
          setFailed(true);
          if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
          holdTimer.current = window.setTimeout(() => setFailed(false), 1800);
        },
      );
  };

  const toneClass =
    current.tone && current.tone !== 'neutral' ? ` ob-swap--${current.tone}` : '';
  const shown = failed ? failText : working && current.pendingLabel ? current.pendingLabel : current.label;
  return (
    <button
      type="button"
      className={`ob-btn ob-swap${toneClass}${size !== 'md' ? ` ob-btn--${size}` : ''}`}
      aria-label={shown}
      aria-busy={working}
      onClick={press}
      {...rest}
    >
      {working && !current.pendingLabel ? (
        <BusyMark size={14} label="" />
      ) : (
        current.icon && <Icon name={current.icon} size={size === 'lg' ? 18 : 16} />
      )}
      <span className="ob-swap-label" key={shown} aria-hidden="true">
        {shown}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------- HoldToConfirm */

export function HoldToConfirm({
  label,
  confirmedLabel,
  duration = 1200,
  tone = 'danger',
  icon = 'trash',
  confirmed,
  onConfirm,
  onHoldChange,
  ...rest
}: {
  label: string;
  onConfirm: () => void;
  confirmedLabel?: string;
  duration?: number;
  tone?: 'danger' | 'neutral';
  icon?: IconName;
  confirmed?: boolean;
  onHoldChange?: (holding: boolean) => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'>) {
  const [holding, setHolding] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState(0);
  const raf = useRef(0);
  const start = useRef(0);
  const isDone = confirmed ?? done;
  const seconds = Math.max(1, Math.round(duration / 1000));

  useEffect(() => () => window.cancelAnimationFrame(raf.current), []);

  const stop = (cancelled: boolean): void => {
    window.cancelAnimationFrame(raf.current);
    setHolding(false);
    setProgress(0);
    onHoldChange?.(false);
    if (cancelled) return;
  };

  const tick = (): void => {
    const elapsed = performance.now() - start.current;
    if (elapsed >= duration) {
      stop(false);
      setDone(true);
      onConfirm();
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(15);
        } catch {
          /* vibration unsupported — the visual state already confirms */
        }
      }
      return;
    }
    setProgress(elapsed / duration);
    raf.current = window.requestAnimationFrame(tick);
  };

  const begin = (event: { preventDefault: () => void }): void => {
    if (isDone) return;
    event.preventDefault();
    start.current = performance.now() - progress * duration;
    setHolding(true);
    onHoldChange?.(true);
    raf.current = window.requestAnimationFrame(tick);
  };

  const shown = isDone ? (confirmedLabel ?? t('common.holdDone')) : label;
  return (
    <button
      type="button"
      className={`ob-btn ob-hold ob-hold--${tone}${holding ? ' ob-hold--holding' : ''}`}
      style={{ ['--ob-hold-p' as string]: progress }}
      aria-label={shown}
      aria-disabled={isDone}
      aria-describedby={undefined}
      onPointerDown={begin}
      onPointerUp={() => stop(true)}
      onPointerCancel={() => stop(true)}
      onPointerLeave={() => {
        if (holding) stop(true);
      }}
      onKeyDown={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) begin(event);
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') stop(true);
      }}
      onBlur={() => {
        if (holding) stop(true);
      }}
      {...rest}
    >
      <span className="ob-sr-only">
        {t('common.holdToConfirm', { seconds })}
      </span>
      {isDone ? <Icon name="check" size={16} /> : <Icon name={icon} size={16} />}
      <span className="ob-hold-label" key={shown} aria-hidden="true">
        {shown}
      </span>
      <span className="ob-sr-only" role="status">
        {shown}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------- CopyButton */

export function CopyButton({
  value,
  label,
  iconOnly = false,
  variant = 'outline',
  disabled,
  onCopied,
  className,
}: {
  value: string;
  label?: string;
  iconOnly?: boolean;
  variant?: 'outline' | 'plain';
  disabled?: boolean;
  onCopied?: () => void;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const name = label ?? t('common.copy');
  const shown =
    state === 'copied' ? t('common.copied') : state === 'failed' ? t('common.copyFailed') : name;

  const copy = (): void => {
    if (state !== 'idle' || disabled) return;
    void copyText(value).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      if (ok) onCopied?.();
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState('idle'), ok ? 1500 : 2000);
    });
  };

  if (iconOnly) {
    return (
      <span className="ob-copywrap">
        <IconButton
          icon={state === 'idle' ? 'copy' : state === 'copied' ? 'check' : 'close'}
          label={state === 'idle' ? name : `${name}: ${shown}`}
          size={14}
          onClick={copy}
        />
        <span className="ob-sr-only" role="status">
          {state === 'idle' ? '' : `${name}: ${shown}`}
        </span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={[
        'ob-btn ob-copy',
        variant === 'plain' ? 'ob-copy--plain' : '',
        state !== 'idle' ? `ob-copy--${state}` : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={state === 'idle' ? name : `${name}: ${shown}`}
      disabled={disabled}
      onClick={copy}
    >
      <Icon name={state === 'idle' ? 'copy' : state === 'copied' ? 'check' : 'close'} size={14} />
      <span className="ob-copy-label" key={shown} aria-hidden="true">
        {shown}
      </span>
      <span className="ob-sr-only" role="status">
        {state === 'idle' ? '' : `${name}: ${shown}`}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------- ButtonGroup */

export interface ButtonGroupItem {
  id: string;
  label: string;
  icon?: IconName;
  iconOnly?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onSelect?: () => void;
  href?: string;
}

export function ButtonGroup({
  items,
  label,
  variant = 'outline',
  size = 'md',
  disabled = false,
  className,
}: {
  items: ButtonGroupItem[];
  label: string;
  variant?: 'outline' | 'solid';
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <div
      role="group"
      aria-label={label}
      className={[
        'ob-btngroup',
        `ob-btngroup--${variant}`,
        size === 'sm' ? 'ob-btngroup--sm' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {items.map((item) => {
        const content = (
          <>
            {item.icon && <Icon name={item.icon} size={size === 'sm' ? 14 : 16} />}
            {!item.iconOnly && (
              <span className="ob-btngroup-label" aria-hidden={false}>
                {item.label}
              </span>
            )}
          </>
        );
        const classes = [
          'ob-btngroup-seg',
          item.destructive ? 'ob-btngroup-seg--destructive' : '',
          focus === item.id ? 'ob-btngroup-seg--focus' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const shared = {
          className: classes,
          'aria-label': item.iconOnly ? item.label : undefined,
          title: item.iconOnly ? item.label : undefined,
          'aria-disabled': disabled || item.disabled || undefined,
          onFocus: () => setFocus(item.id),
          onBlur: () => setFocus((current) => (current === item.id ? null : current)),
          onMouseEnter: () => setFocus(item.id),
          onMouseLeave: () => setFocus((current) => (current === item.id ? null : current)),
        } as const;
        if (item.href) {
          return (
            <a
              key={item.id}
              href={item.href}
              {...shared}
              onClick={(event) => {
                if (disabled || item.disabled) event.preventDefault();
                else item.onSelect?.();
              }}
            >
              {content}
            </a>
          );
        }
        const itemDisabled = disabled || item.disabled || undefined;
        return (
          <button
            key={item.id}
            type="button"
            disabled={itemDisabled}
            {...shared}
            onClick={() => {
              item.onSelect?.();
            }}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
