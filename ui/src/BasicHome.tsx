/**
 * Basic Home: a launcher of app-style tiles, one per module, grouped as the
 * sidebar is (Work, Catalogue, Admin on the Master, System).
 *
 * The tiles are built from the shell's own permission-filtered `NavGroup[]`,
 * so a module somebody cannot open has no tile, exactly as it has no sidebar
 * row, and a module a later release adds to the sidebar appears here with no
 * change to this file. Absent, never disabled.
 *
 * A module with artwork in `TILE_ICONS` shows its colour tile, the one place
 * the chrome carries colour (docs/DESIGN_SYSTEM.md, "Basic Home tiles"); one
 * without keeps its sidebar line icon, drawn large in the accent colour on a
 * plain face with a hairline border. The label sits under the face and the
 * shortcut in a monospace chip.
 */

import { chordFor, type Chord } from '@orderbook/shared';

import { useEffect, useState, type CSSProperties } from 'react';

import type { NavGroup, NavItem } from './AppShell';
import { Button, IconButton } from './Button';
import { displayChord } from './CommandPalette';
import { t } from './i18n.js';
import { Icon } from './icons';
import { useKeyboard } from './KeyboardProvider';
import { EmptyState } from './States';
import { TILE_ICONS } from './tileIcons';

/** Tile size, in percent of the default, kept per signed-in user in this browser (as theme and scale are). */
export const TILE_SCALE = { min: 60, max: 160, step: 10, initial: 100 } as const;

export function tileScaleKey(userId: string): string {
  return `ob.basicHome.tileScale.${userId}`;
}

/** The saved size for `userId`, or the default; a missing, garbled or out-of-range value reads as the default. */
export function readTileScale(userId: string | undefined): number {
  if (!userId) return TILE_SCALE.initial;
  try {
    const raw = Number(window.localStorage.getItem(tileScaleKey(userId)));
    return Number.isFinite(raw) && raw >= TILE_SCALE.min && raw <= TILE_SCALE.max
      ? raw
      : TILE_SCALE.initial;
  } catch {
    return TILE_SCALE.initial; // Private browsing refuses storage; the default still works.
  }
}

/**
 * Where somebody lands after signing in. Office and Management people start
 * on Basic Home; everyone else (an Admin, a Server Master, a tier this build
 * does not know yet) starts on the Dashboard.
 */
export function landingScreen(tier: string): 'basicHome' | 'dashboard' {
  return tier === 'office' || tier === 'management' ? 'basicHome' : 'dashboard';
}

/** `aria-keyshortcuts` spells the modifiers out in full. */
function ariaChord(chord: Chord): string {
  return [
    chord.ctrl && 'Control',
    chord.alt && 'Alt',
    chord.shift && 'Shift',
    chord.meta && 'Meta',
    chord.key.length === 1 ? chord.key.toUpperCase() : chord.key,
  ]
    .filter(Boolean)
    .join('+');
}

function Tile({
  id,
  label,
  icon,
  count,
  chord,
  onClick,
}: {
  id: string;
  label: string;
  icon: NavItem['icon'];
  count?: number;
  chord: Chord | null;
  onClick: () => void;
}) {
  const Art = TILE_ICONS[id as keyof typeof TILE_ICONS];
  return (
    <button
      type="button"
      className="ob-tile"
      data-tile={id}
      aria-keyshortcuts={chord ? ariaChord(chord) : undefined}
      onClick={onClick}
    >
      {Art ? (
        <span className="ob-tile-face ob-tile-face--art">
          <Art size={80} />
        </span>
      ) : (
        <span className="ob-tile-face">
          <Icon name={icon} size={36} />
        </span>
      )}
      <span className="ob-tile-label">{label}</span>
      {/* After the label, so the button reads "Pending Orders 3"; drawn on the face. */}
      {count ? <span className="ob-tile-count">{count}</span> : null}
      {chord && (
        <span className="ob-tile-chord" aria-hidden="true">
          {displayChord(chord)}
        </span>
      )}
    </button>
  );
}

export function BasicHome({
  groups,
  onOpen,
  onNewLead,
  userId,
}: {
  /** The shell's sidebar groups, already filtered by permission. */
  groups: NavGroup[];
  onOpen: (id: string) => void;
  /** Present only for a role that can create a pending order. */
  onNewLead?: () => void;
  /** The signed-in user, whose own tile size is read and saved. Absent: the default size, no Save. */
  userId?: string;
}) {
  const keyboard = useKeyboard();
  const [saved, setSaved] = useState(() => readTileScale(userId));
  const [scale, setScale] = useState(saved);
  // Another person signing in on this PC gets their own size, not the last one's.
  useEffect(() => {
    const next = readTileScale(userId);
    setSaved(next);
    setScale(next);
  }, [userId]);

  const nudge = (by: number): void =>
    setScale((current) => Math.min(TILE_SCALE.max, Math.max(TILE_SCALE.min, current + by)));
  const save = (): void => {
    if (!userId) return;
    try {
      window.localStorage.setItem(tileScaleKey(userId), String(scale));
    } catch {
      // Storage refused: the size still applies for this visit.
    }
    setSaved(scale);
  };
  const launcherStyle = { '--ob-tile-scale': scale / 100 } as CSSProperties;

  const sections = groups
    .map((group, index) => ({
      label: group.label,
      items: group.items.filter((item) => item.id !== 'basicHome'),
      // The New Order tile leads the first group, which is Work.
      withNewLead: index === 0 && Boolean(onNewLead),
    }))
    .filter((section) => section.items.length > 0 || section.withNewLead);

  if (sections.length === 0) {
    return (
      <div className="ob-launcher">
        <EmptyState title={t('shell.noModules')} />
      </div>
    );
  }

  return (
    <div className="ob-launcher" style={launcherStyle}>
      <div className="ob-launcher-size" role="group" aria-label={t('basicHome.tileSize')}>
        <span className="ob-small">{t('basicHome.tileSize')}</span>
        <IconButton
          icon="minus"
          label={t('basicHome.tileSmaller')}
          disabled={scale <= TILE_SCALE.min}
          onClick={() => nudge(-TILE_SCALE.step)}
        />
        <input
          type="range"
          className="ob-launcher-size-range"
          min={TILE_SCALE.min}
          max={TILE_SCALE.max}
          step={TILE_SCALE.step}
          value={scale}
          aria-label={t('basicHome.tileSize')}
          aria-valuetext={`${scale}%`}
          onChange={(event) => setScale(Number(event.target.value))}
        />
        <IconButton
          icon="plus"
          label={t('basicHome.tileLarger')}
          disabled={scale >= TILE_SCALE.max}
          onClick={() => nudge(TILE_SCALE.step)}
        />
        <output className="ob-launcher-size-value">{scale}%</output>
        {userId && (
          <Button size="sm" variant="primary" disabled={scale === saved} onClick={save}>
            {t('basicHome.tileSave')}
          </Button>
        )}
      </div>
      {sections.map((section) => (
        <section key={section.label} className="ob-launcher-section" aria-label={section.label}>
          <h2 className="ob-eyebrow">{section.label}</h2>
          <div className="ob-launcher-tiles">
            {section.withNewLead && onNewLead && (
              <Tile
                id="newLead"
                label={t('basicHome.newLead')}
                icon="plus"
                chord={chordFor('record.new', keyboard.bindings)}
                onClick={onNewLead}
              />
            )}
            {section.items.map((item) => (
              <Tile
                key={item.id}
                id={item.id}
                label={item.label}
                icon={item.icon}
                count={item.count}
                chord={chordFor(`nav.${keyboard.panel}.${item.id}`, keyboard.bindings)}
                onClick={() => onOpen(item.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
