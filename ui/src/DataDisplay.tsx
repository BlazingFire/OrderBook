/**
 * Small data-rendering primitives (§9 Data): ColourChip, StatusPill, Timeline,
 * KeyValueList, IdField.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { colourLabeller } from '@orderbook/shared';
import type { ColourLabelOf, PipelineStage, TimelineEntry as RecordTimelineEntry } from '@orderbook/shared';
import { IconButton } from './Button';
import { copyText } from './clipboard.js';
import { t } from './i18n.js';

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

/**
 * A stored colour VALUE in the words the company's colour list uses now (`colourLabeller`):
 * a colour renamed in Fields reads the new way on every record, and a value the list no
 * longer has reads as stored. Inactive colours still label, since old lines keep them.
 */
export function useColourLabel(optionLists: ColourOption[]): ColourLabelOf {
  return useMemo(
    () => colourLabeller(optionLists.filter((option) => option.listKey === 'stock.colour')),
    [optionLists],
  );
}

export function ColourChip({ hex, name }: { hex?: string; name: string }) {
  if (!hex) {
    return (
      <span className="ob-colourchip ob-colourchip--empty" title={name} aria-label={name}>
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="ob-colourchip" style={{ background: hex }} title={name} aria-label={name} />
  );
}

export function ColourName({ hex, name }: { hex?: string; name: string }) {
  return (
    <span className="ob-colourname">
      <ColourChip hex={hex} name={name} />
      <span>{name}</span>
    </span>
  );
}

export type PillTone = 'default' | 'ok' | 'offline' | 'conflict' | 'accent' | 'master';

export function StatusPill({
  tone = 'default',
  children,
}: {
  tone?: PillTone;
  children: ReactNode;
}) {
  const cls = ['ob-pill', tone !== 'default' ? `ob-pill--${tone}` : ''].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}

/**
 * The pill tone nearest a colour an administrator gave a stage (Fields, Stages), by hue:
 * reds read as conflict, ambers as offline (amber), greens as ok, blues and purples as
 * accent, and greys or anything washed out as the neutral default. `null` for no colour
 * or a value that is not a #rgb / #rrggbb hex, so the caller falls back to the flags.
 */
export function toneForColour(colour: string | null | undefined): PillTone | null {
  const digits = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour?.trim() ?? '')?.[1];
  if (!digits) return null;
  const hex = digits.length === 3 ? digits.replace(/./g, '$&$&') : digits;
  const channel = (at: number): number => parseInt(hex.slice(at, at + 2), 16) / 255;
  const r = channel(0);
  const g = channel(2);
  const b = channel(4);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.2) return 'default';
  const hue =
    max === r
      ? (60 * ((g - b) / chroma) + 360) % 360
      : max === g
        ? 60 * ((b - r) / chroma) + 120
        : 60 * ((r - g) / chroma) + 240;
  if (hue < 20 || hue >= 320) return 'conflict';
  if (hue < 70) return 'offline';
  if (hue < 170) return 'ok';
  return 'accent';
}

/**
 * A stage's pill tone. Its configured colour wins, so a "Cancelled" stage seeded red
 * (#C7576B) reads red rather than green; only a stage with no colour falls back to its
 * flags (terminal green, default accent, otherwise neutral). A dispatched order is green.
 */
export function stageTone(
  stage: Pick<PipelineStage, 'colour' | 'isDefault' | 'isTerminal'> | undefined,
  dispatched = false,
): PillTone {
  if (dispatched) return 'ok';
  const fromColour = toneForColour(stage?.colour);
  if (fromColour) return fromColour;
  if (stage?.isTerminal) return 'ok';
  if (stage?.isDefault) return 'accent';
  return 'default';
}

export interface TimelineEntry {
  id: string;
  label: ReactNode;
  when: string;
  tone?: 'default' | 'ok' | 'offline' | 'conflict';
  /** Written by the software rather than a person (a stage change): smaller and italic. */
  system?: boolean;
}

/**
 * A lead's or an order's history as Timeline entries: who and when on the meta line
 * ("Ramesh P. · 10:42"), the message under it, and the software's own entries (stage
 * changes) marked as system so people's remarks stand out.
 */
export function recordTimelineEntries(
  entries: RecordTimelineEntry[],
  formatWhen: (iso: string) => string,
): TimelineEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.message,
    when: entry.actorName
      ? `${entry.actorName} · ${formatWhen(entry.createdAt)}`
      : formatWhen(entry.createdAt),
    system: entry.kind === 'system',
  }));
}

/** Data artboard: a hairline down the left; each entry's meta line over its text. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ul className="ob-timeline">
      {entries.map((entry) => (
        <li
          key={entry.id}
          data-tone={entry.tone && entry.tone !== 'default' ? entry.tone : undefined}
          data-system={entry.system ? 'true' : undefined}
        >
          <span className="when">{entry.when}</span>
          <span className="what">{entry.label}</span>
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
        label={t('common.copy')}
        size={12}
        onClick={() => {
          // The check only when the copy happened — see `clipboard.ts`.
          void copyText(value).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      />
    </span>
  );
}
