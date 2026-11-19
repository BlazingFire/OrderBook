/**
 * A value picker drawn as the Arc dropdown menu: a select-looking trigger that
 * opens the kit Popover as a menu, a highlight gliding between items, and a
 * check on the chosen one. Keys come from Popover (arrows, Home/End, Escape,
 * focus back to the trigger); no Radix or motion dependency.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

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
  const [place, setPlace] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  // Whether the menu was open when this press began: its own outside-press close runs first.
  const wasOpen = useRef(false);
  const chosen = options.find((option) => option.value === value);

  // Placed against the window from the trigger's box: the menu is portalled out of the table
  // cell, whose `contain: layout paint` would otherwise clip it. Opens upward when short of room.
  function openMenu(): void {
    const box = trigger.current?.getBoundingClientRect();
    if (box) {
      const tall = options.length * 36 + 16;
      const below = window.innerHeight - box.bottom >= tall || box.top < tall;
      setPlace({
        position: 'fixed',
        left: Math.min(box.left, window.innerWidth - box.width - 8),
        minWidth: box.width,
        ...(below ? { top: box.bottom + 4 } : { bottom: window.innerHeight - box.top + 4 }),
      });
    }
    setOpen(true);
  }

  // Moves the one highlight onto the item under the pointer or focus.
  function glideTo(item: HTMLElement): void {
    setGlide({ transform: `translateY(${item.offsetTop}px)`, height: item.offsetHeight });
  }

  // Stable: Popover re-runs its open effect (and refocuses) whenever onClose changes.
  const close = useCallback(() => {
    setOpen(false);
    setGlide(null);
  }, []);

  // A fixed menu would stay put while its row scrolls away, so a scroll closes it.
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      // A scroll inside the menu itself (a long list) keeps it open.
      if (!(event.target instanceof Element && event.target.closest('.ob-menuselect'))) close();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open, close]);

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
        ref={trigger}
        onMouseDown={() => {
          wasOpen.current = open;
        }}
        onClick={() => (wasOpen.current || open ? close() : openMenu())}
      >
        <span className="ob-menuselect-text">{chosen?.label ?? value}</span>
      </button>
      {open &&
        createPortal(
          <Popover open onClose={close} anchorStyle={place}>
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
          </Popover>,
          document.body,
        )}
    </>
  );
}
