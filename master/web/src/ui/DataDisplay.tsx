/**
 * Small data-rendering primitives (§9 Data): ColourChip, StatusPill, Timeline,
 * KeyValueList, IdField, FingerprintField.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './Button';

interface ColourOption {
  listKey: string;
  label: string;
  value: string;
  hex: string | null;
}

/**
 * `stock.colour` option-list entries carry the real hex a `ColourChip` should
 * show (§3.4) — seeded with `value === label`, so either matches a record's
 * plain `colour: string` field. Every screen that renders a colour chip from
 * live data should resolve through this rather than passing no `hex` (which
 * silently falls back to the two-letter ring for every colour, everywhere).
 */
export function useColourHex(optionLists: ColourOption[]): (colour: string) => string | undefined {
  const map = useMemo(() => {
    const entries = new Map<string, string>();
    for (const option of optionLists) {
      if (option.listKey !== 'stock.colour' || !option.hex) continue;
      entries.set(option.label, option.hex);
      entries.set(option.value, option.hex);
    }
    return entries;
  }, [optionLists]);

  return (colour: string) => map.get(colour);
}

export function ColourChip({ hex, name }: { hex?: string; name: string }) {
  if (!hex) {
    return (
      <span className="ob-colourchip ob-colourchip--empty" title={name} aria-label={name}>
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return <span className="ob-colourchip" style={{ background: hex }} title={name} aria-label={name} />;
}

export function ColourName({ hex, name }: { hex?: string; name: string }) {
  return (
    <span className="ob-colourname">
      <ColourChip hex={hex} name={name} />
      <span>{name}</span>
    </span>
  );
}

export type PillTone = 'default' | 'ok' | 'offline' | 'conflict' | 'accent';

export function StatusPill({ tone = 'default', children }: { tone?: PillTone; children: ReactNode }) {
  const cls = ['ob-pill', tone !== 'default' ? `ob-pill--${tone}` : ''].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}

export interface TimelineEntry {
  id: string;
  label: ReactNode;
  when: string;
  tone?: 'default' | 'ok' | 'offline' | 'conflict';
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ul className="ob-timeline">
      {entries.map((entry) => (
        <li key={entry.id}>
          <span className={`dot${entry.tone && entry.tone !== 'default' ? ` dot--${entry.tone}` : ''}`} />
          <span style={{ flex: 1 }}>
            <div className="ob-small" style={{ color: 'var(--fg-primary)' }}>
              {entry.label}
            </div>
            <div className="when">{entry.when}</div>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function KeyValueList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="ob-kv">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function IdField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ob-idfield">
      <span className="ob-mono">{value}</span>
      <IconButton
        icon={copied ? 'check' : 'copy'}
        label="Copy"
        size={12}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      />
    </span>
  );
}

/** Groups a colon-separated fingerprint into 4-pair chunks, wrapping only at a group boundary. */
export function FingerprintField({ value }: { value: string }) {
  const pairs = value.split(':');
  const groups: string[] = [];
  for (let i = 0; i < pairs.length; i += 4) {
    groups.push(pairs.slice(i, i + 4).join(':'));
  }
  return (
    <span className="ob-fingerprint">
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </span>
  );
}
