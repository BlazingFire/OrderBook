/**
 * Basic Home: a launcher of app-style tiles, one per module, grouped as the
 * sidebar is (Work, Catalogue, Admin on the Master, System).
 *
 * The tiles are built from the shell's own permission-filtered `NavGroup[]`,
 * so a module somebody cannot open has no tile, exactly as it has no sidebar
 * row, and a module a later release adds to the sidebar appears here with no
 * change to this file. Absent, never disabled.
 *
 * The look is the owner's mockup, `docs/design/basic-home-mockup.html`: a
 * 104 px face with a 12 px radius, a layered gradient in the module's colour,
 * a white drawing with a long soft shadow, the label under it and the
 * shortcut in a monospace chip. The drawings are copied from the mockup with
 * their colours moved into `--tile-*` tokens. A module the mockup did not
 * draw shows its sidebar icon in white instead.
 */

import { chordFor, type Chord } from '@orderbook/shared';

import type { NavGroup, NavItem } from './AppShell';
import { displayChord } from './CommandPalette';
import { t } from './i18n.js';
import { Icon } from './icons';
import { GLYPHS } from './navGlyphs';
import { useKeyboard } from './KeyboardProvider';
import { EmptyState } from './States';

/**
 * Where somebody lands after signing in. Office and Management people start
 * on Basic Home; everyone else (an Admin, a Server Master, a tier this build
 * does not know yet) starts on the Dashboard.
 */
export function landingScreen(tier: string): 'basicHome' | 'dashboard' {
  return tier === 'office' || tier === 'management' ? 'basicHome' : 'dashboard';
}

/** Each module's face colour. The mockup's ten, plus three in the same style. */
const HUE: Record<string, string> = {
  newLead: 'green',
  dashboard: 'teal',
  leads: 'orange',
  orders: 'blue',
  conflicts: 'red',
  chatroom: 'violet',
  printroom: 'brown',
  reports: 'amber',
  products: 'purple',
  parties: 'pink',
  partyAccess: 'indigo',
  panels: 'cyan',
  access: 'indigo',
  fields: 'teal',
  logs: 'slate',
  recycleBin: 'red',
  integrations: 'purple',
  settings: 'slate',
  updates: 'cyan',
};

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
  const glyph = GLYPHS[id];
  return (
    <button
      type="button"
      className="ob-tile"
      data-hue={HUE[id] ?? 'slate'}
      aria-keyshortcuts={chord ? ariaChord(chord) : undefined}
      onClick={onClick}
    >
      <span className="ob-tile-face">
        {glyph ? (
          <>
            <svg className="ob-tile-art ob-tile-shadow" viewBox="0 0 120 120" aria-hidden="true">
              <path d={glyph.shadow} fill="var(--tile-shade)" />
            </svg>
            <svg className="ob-tile-art" viewBox="0 0 120 120" aria-hidden="true" data-glyph={id}>
              {glyph.art}
            </svg>
          </>
        ) : (
          <span className="ob-tile-icon">
            <Icon name={icon} size={40} />
          </span>
        )}
        <svg className="ob-tile-art" viewBox="0 0 120 120" aria-hidden="true">
          <rect
            x={0.75}
            y={0.75}
            width={118.5}
            height={118.5}
            rx={13.1}
            fill="none"
            stroke="var(--tile-rim)"
            strokeWidth={1.5}
          />
        </svg>
      </span>
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
}: {
  /** The shell's sidebar groups, already filtered by permission. */
  groups: NavGroup[];
  onOpen: (id: string) => void;
  /** Present only for a role that can create a pending order. */
  onNewLead?: () => void;
}) {
  const keyboard = useKeyboard();

  const sections = groups
    .map((group, index) => ({
      label: group.label,
      items: group.items.filter((item) => item.id !== 'basicHome'),
      // The new-pending-order tile leads the first group, which is Work.
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
    <div className="ob-launcher">
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
