/** Tabs (§9 Structure) — underline style. Arrow-key roving focus per §10. */

import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface TabItem {
  id: string;
  label: string;
  /** A small figure after the label (Navigation artboard: "Line items 4"); 0 is shown, absent is not. */
  count?: number;
  /** Greyed and skipped by the arrow keys; it cannot be chosen. */
  disabled?: boolean;
}

export function Tabs({
  tabs,
  activeId,
  onChange,
}: {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    let step = 1;
    while (step < tabs.length && tabs[(index + dir * step + tabs.length * step) % tabs.length]?.disabled) step += 1;
    const next = tabs[(index + dir * step + tabs.length * step) % tabs.length];
    // The modulo keeps this in range; the guard is for the type-checker, and
    // costs nothing if `tabs` is ever empty.
    if (!next) return;
    onChange(next.id);
    refs.current[next.id]?.focus();
  }

  return (
    <div className="ob-tabs" role="tablist">
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[tab.id] = el;
          }}
          type="button"
          role="tab"
          className="ob-tab"
          aria-selected={activeId === tab.id}
          disabled={tab.disabled}
          tabIndex={activeId === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ob-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** The bordered button-group variant used for Board/List and similar binary switches. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name ("Access level for Ravi"); without it a screen reader hears only "group". */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="ob-seg" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
