/**
 * Colourful animated dashboard kit (Odoo/Monday-inspired, desktop-first).
 *
 * CSS + inline SVG only: no chart lib, no new deps, offline-safe. Every
 * visual animates on the kit motion tokens with reduced-motion branches;
 * every tile/card is a button when it has somewhere to go (click-through to
 * the list, board or record behind the figure).
 *
 * - DashboardTile: colour-top tile with icon, rolling figure, note, sparkline.
 * - StageBars: animated horizontal pipeline bars, click a stage to open it.
 * - Donut: SVG ring segments with centre total, click a segment to filter.
 * - Sparkline: inline SVG trend line from a number series.
 * - DrillCard: a card whose rows open records (follow-ups, activity, panels).
 */

import type { ReactNode } from 'react';

import { Card } from './Card.js';
import { Icon, type IconName } from './icons.js';
import { t } from './i18n.js';

export type TileAccent = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'teal';

const ACCENTS: Record<TileAccent, { bg: string; fg: string; soft: string }> = {
  blue: { bg: 'var(--glaze-50)', fg: '#ffffff', soft: 'var(--glaze-05)' },
  green: { bg: 'var(--kiln-green)', fg: '#ffffff', soft: 'var(--kiln-green-05)' },
  amber: { bg: 'var(--kiln-amber-fill)', fg: '#ffffff', soft: 'var(--kiln-amber-05)' },
  red: { bg: 'var(--kiln-red)', fg: '#ffffff', soft: 'var(--kiln-red-05)' },
  violet: { bg: '#6d4dbb', fg: '#ffffff', soft: '#efeafa' },
  teal: { bg: '#0f766e', fg: '#ffffff', soft: '#e0f2f0' },
};

export function DashboardTile({
  label,
  value,
  note,
  icon,
  accent = 'blue',
  trend,
  onClick,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  icon: IconName;
  accent?: TileAccent;
  /** Small series drawn as a sparkline under the figure. */
  trend?: number[];
  /** Makes the whole tile a button to the screen behind the figure. */
  onClick?: () => void;
}) {
  const colours = ACCENTS[accent];
  const body = (
    <>
      <span className="ob-dtile-top" style={{ background: colours.bg }} aria-hidden="true" />
      <span className="ob-dtile-head">
        <span className="ob-dtile-icon" style={{ background: colours.soft, color: colours.bg }}>
          <Icon name={icon} size={18} />
        </span>
        <span className="ob-eyebrow">{label}</span>
      </span>
      <span className="ob-dtile-value ob-display" key={String(value)}>
        {value}
      </span>
      {trend && trend.length > 1 ? <Sparkline values={trend} color={colours.bg} /> : null}
      {note && <span className="ob-dtile-note ob-small">{note}</span>}
    </>
  );
  const className = 'ob-card ob-card--pad ob-dtile';
  if (!onClick) return <div className={className}>{body}</div>;
  return (
    <button type="button" className={className} onClick={onClick} aria-label={`${label}: ${typeof value === 'string' || typeof value === 'number' ? value : ''}`}>
      {body}
    </button>
  );
}

export function Sparkline({
  values,
  color = 'var(--accent)',
  width = 120,
  height = 28,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - 3 - ((value - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1]!.split(',');
  return (
    <svg
      className="ob-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill={color} />
    </svg>
  );
}

export interface StageBar {
  id: string;
  label: string;
  count: number;
  color?: string;
}

export function StageBars({
  title,
  stages,
  onOpen,
  onSelect,
}: {
  title: string;
  stages: StageBar[];
  onOpen?: () => void;
  onSelect?: (id: string) => void;
}) {
  const max = Math.max(1, ...stages.map((stage) => stage.count));
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
        <div className="ob-eyebrow" style={{ flex: 1 }}>
          {title}
        </div>
        {onOpen && (
          <button type="button" className="ob-btn ob-btn--ghost ob-btn--sm" onClick={onOpen}>
            {t('dashboard.pipeline.openBoard')}
          </button>
        )}
      </div>
      <div className="ob-stagebars" style={{ marginTop: 'var(--s-12)' }}>
        {stages.map((stage) => (
          <button
            key={stage.id}
            type="button"
            className="ob-stagebar-row"
            disabled={!onSelect}
            onClick={() => onSelect?.(stage.id)}
            aria-label={`${stage.label}: ${stage.count}`}
          >
            <span className="ob-stagebar-label ob-small">{stage.label}</span>
            <span className="ob-stagebar-track">
              <span
                className="ob-stagebar-fill"
                style={{
                  width: `${(stage.count / max) * 100}%`,
                  background: stage.color ?? 'var(--accent)',
                }}
              />
            </span>
            <span className="ob-stagebar-count ob-data" key={stage.count}>
              {stage.count.toLocaleString('en-IN')}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  color: string;
}

export function Donut({
  title,
  total,
  slices,
  onSelect,
}: {
  title: string;
  total: string;
  slices: DonutSlice[];
  onSelect?: (id: string) => void;
}) {
  const sum = slices.reduce((acc, slice) => acc + slice.value, 0) || 1;
  const R = 52;
  const C = 2 * Math.PI * R;
  let angle = -90;
  const arcs = slices.map((slice) => {
    const frac = slice.value / sum;
    const arc = { ...slice, dash: frac * C, rotate: angle };
    angle += frac * 360;
    return arc;
  });
  return (
    <Card>
      <div className="ob-eyebrow">{title}</div>
      <div className="ob-donut-wrap">
        <svg className="ob-donut" width={140} height={140} viewBox="0 0 140 140" aria-hidden="true">
          <circle cx={70} cy={70} r={R} fill="none" stroke="var(--bg-sunken)" strokeWidth={16} />
          {arcs.map((arc) => (
            <circle
              key={arc.id}
              cx={70}
              cy={70}
              r={R}
              fill="none"
              stroke={arc.color}
              strokeWidth={16}
              strokeDasharray={`${arc.dash} ${C - arc.dash}`}
              transform={`rotate(${arc.rotate} 70 70)`}
              strokeLinecap="butt"
              className="ob-donut-arc"
            />
          ))}
          <text x={70} y={66} textAnchor="middle" className="ob-donut-total">
            {total}
          </text>
          <text x={70} y={84} textAnchor="middle" className="ob-donut-cap">
            {t('dashboard.donut.total')}
          </text>
        </svg>
        <ul className="ob-donut-legend">
          {arcs.map((arc) => (
            <li key={arc.id}>
              <button
                type="button"
                className="ob-donut-key"
                disabled={!onSelect}
                onClick={() => onSelect?.(arc.id)}
              >
                <span className="ob-donut-dot" style={{ background: arc.color }} aria-hidden="true" />
                <span className="ob-small">{arc.label}</span>
                <span className="ob-data">{arc.value.toLocaleString('en-IN')}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export interface DrillRow {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
}

export function DrillCard({
  title,
  action,
  rows,
  empty,
  onOpen,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  rows: DrillRow[];
  empty: { title: string; description?: string };
  onOpen: (id: string) => void;
}) {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
        <div className="ob-eyebrow" style={{ flex: 1 }}>
          {title}
        </div>
        {action && (
          <button type="button" className="ob-btn ob-btn--ghost ob-btn--sm" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="ob-small" style={{ color: 'var(--fg-tertiary)', margin: 'var(--s-8) 0 0' }}>
          {empty.title}
          {empty.description ? ` — ${empty.description}` : ''}
        </p>
      ) : (
        <ul className="ob-drill-list">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" className="ob-drill-row" onClick={() => onOpen(row.id)}>
                <span className="ob-drill-title">{row.title}</span>
                {row.meta && <span className="ob-small ob-drill-meta">{row.meta}</span>}
                {row.badge}
                <Icon name="chevron-right" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
