/**
 * A value picker drawn as the Arc dropdown menu: a select-looking trigger that
 * opens the kit Popover as a menu, a highlight gliding between items, and a
 * check on the chosen one. Keys come from Popover (arrows, Home/End, Escape,
 * focus back to the trigger); no Radix or motion dependency.
 */

import { useCallback, useState, type CSSProperties } from 'react';

import { Icon } from './icons.js';
import { Popover } from './Popover.js';

export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [glide, setGlide] = useState<CSSProperties | null>(null);
  const chosen = options.find((option) => option.value === value);

  // Moves the one highlight onto the item under the pointer or focus.
  function glideTo(item: HTMLElement): void {
    setGlide({ transform: `translateY(${item.offsetTop}px)`, height: item.offsetHeight });
  }

  // Stable: Popover re-runs its open effect (and refocuses) whenever onClose changes.
  const close = useCallback(() => {
    setOpen(false);
    setGlide(null);
  }, []);

  return (
    <>
      <button
        type="button"
        className={`ob-input ob-select ob-menuselect-trigger${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        data-empty={value === '' || undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="ob-menuselect-text">{chosen?.label ?? value}</span>
      </button>
      <Popover open={open} onClose={close}>
        <div
          role="menu"
          aria-label={ariaLabel}
          className="ob-popover--menu ob-menuselect"
          onPointerLeave={() => setGlide(null)}
        >
          {glide && <span className="ob-menuselect-glide" style={glide} aria-hidden="true" />}
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className="ob-menu-item ob-menuselect-item"
              onPointerEnter={(event) => glideTo(event.currentTarget)}
              onFocus={(event) => glideTo(event.currentTarget)}
              onClick={() => {
                close();
                if (option.value !== value) onChange(option.value);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
