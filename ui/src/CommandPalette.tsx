/**
 * The palette, and the shortcut sheet beside it.
 *
 * Both are dialogs, so both are rendered from AppShell's `overlays` slot: that
 * puts them **last** in the document, which is what the innermost-dialog rule
 * in `useOverlay` reads to decide that Escape closes the palette and not the
 * editor it was opened over.
 *
 * Records come from the panel, not from here. `@orderbook/ui` has no `api` — the
 * two panels' clients differ, and the Office one has an offline answer the
 * Master has no use for. The prop reports `offline` rather than throwing so the
 * list can say *why* it is short, which is the normal state of an Office panel
 * and not an error.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '@orderbook/shared';
import {
  COMMANDS_BY_ID,
  chordFor,
  commandsFor,
  findConflicts,
  formatChord,
  formatChordMac,
} from '@orderbook/shared';

import { Input } from './Form';
import { Modal } from './Modal';
import { useDebounced } from './useDebounced';
import { useKeyboard } from './KeyboardProvider';
import { t } from './i18n';

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (navigator.userAgent.includes('Mac') ||
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS');

/** A chord as this machine spells it: glyphs on a Mac, `Ctrl+K` elsewhere. */
export function displayChord(chord: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }): string {
  return IS_MAC ? formatChordMac(chord) : formatChord(chord);
}

export interface PaletteRecords {
  hits: SearchHit[];
  /** True when these came from this panel's cache rather than the Master. */
  offline?: boolean;
}

interface Row {
  key: string;
  label: string;
  hint?: string;
  run: () => void;
}

function CommandPalette({
  searchRecords,
  onOpenRecord,
}: {
  searchRecords?: (term: string) => Promise<PaletteRecords>;
  onOpenRecord?: (hit: SearchHit) => void;
}) {
  const keyboard = useKeyboard();
  const [term, setTerm] = useState('');
  const [records, setRecords] = useState<PaletteRecords>({ hits: [] });
  const [active, setActive] = useState(0);
  const settled = useDebounced(term);

  const open = keyboard.paletteOpen;

  function close(): void {
    keyboard.setPaletteOpen(false);
  }

  // A palette that reopens holding the last query is a palette that opens
  // showing yesterday's answer.
  useEffect(() => {
    if (!open) {
      setTerm('');
      setRecords({ hits: [] });
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const trimmed = settled.trim();
    if (!open || !searchRecords || trimmed.length < 2) {
      setRecords({ hits: [] });
      return;
    }

    let live = true;
    void searchRecords(trimmed)
      .then((result) => {
        if (live) setRecords(result);
      })
      .catch(() => {
        if (live) setRecords({ hits: [] });
      });

    return () => {
      live = false;
    };
  }, [open, settled, searchRecords]);

  const commandRows: Row[] = useMemo(() => {
    const needle = term.trim().toLowerCase();
    // Read as the palette opens: what a screen answers is on the provider's
    // stack, which changes without re-rendering this list, and the palette is
    // a dialog, so nothing under it moves while it is open.
    return commandsFor(keyboard.panel)
      .filter((command) => command.id !== 'palette.open' && command.id !== 'palette.search')
      .filter((command) => keyboard.offers(command.id))
      .map((command) => {
        const chord = chordFor(command.id, keyboard.bindings);
        return {
          key: command.id,
          label: t(command.titleToken),
          hint: chord ? displayChord(chord) : undefined,
          run: () => {
            close();
            keyboard.run(command.id);
          },
        };
      })
      .filter((row) => !needle || row.label.toLowerCase().includes(needle));
    // `close` and `keyboard` are stable enough for this list; `term` is what
    // actually changes it.
    // `close` is a new function every render, so listing it would rebuild this
    // list every render; it and `keyboard.run` only reach stable targets — a
    // useState setter and a useCallback([]).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, term, keyboard.panel, keyboard.bindings, keyboard.offers]);

  const recordRows: Row[] = records.hits.map((hit) => ({
    key: `${hit.kind}:${hit.id}`,
    label: hit.title,
    hint: hit.subtitle ?? undefined,
    run: () => {
      close();
      onOpenRecord?.(hit);
    },
  }));

  const rows = [...commandRows, ...recordRows];
  const clamped = Math.min(active, Math.max(rows.length - 1, 0));

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-palette-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [clamped, rows.length]);

  if (!open) return null;

  return (
    <Modal open onClose={close} title={t('keys.command.palette')} size="lg">
      <Input
        autoFocus
        value={term}
        placeholder={t('keys.palette.placeholder')}
        aria-label={t('keys.palette.placeholder')}
        onChange={(event) => {
          setTerm(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, rows.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            rows[clamped]?.run();
          }
        }}
      />

      {records.offline && (
        <p className="ob-small" style={{ marginTop: 'var(--s-8)' }}>
          {t('keys.palette.offline')}
        </p>
      )}

      <div ref={listRef} style={{ maxHeight: '24rem', overflowY: 'auto', marginTop: 'var(--s-8)' }}>
        {rows.length === 0 && <p className="ob-small">{t('keys.palette.empty')}</p>}

        {commandRows.length > 0 && (
          <p className="ob-eyebrow" style={{ marginTop: 'var(--s-8)' }}>
            {t('keys.palette.commands')}
          </p>
        )}
        {commandRows.map((row, index) => (
          <PaletteRow key={row.key} row={row} active={index === clamped} />
        ))}

        {recordRows.length > 0 && (
          <p className="ob-eyebrow" style={{ marginTop: 'var(--s-8)' }}>
            {t('keys.palette.records')}
          </p>
        )}
        {recordRows.map((row, index) => (
          <PaletteRow key={row.key} row={row} active={commandRows.length + index === clamped} />
        ))}
      </div>
    </Modal>
  );
}

/**
 * A row, on the sidebar's own item style.
 *
 * `.ob-navitem` already is a full-width row with a hover state, a trailing
 * `.count` and an `aria-current` treatment — reusing it means the palette needs
 * no CSS of its own and cannot drift from the chrome around it.
 */
function PaletteRow({ row, active }: { row: Row; active: boolean }) {
  return (
    <button
      type="button"
      className="ob-navitem"
      aria-current={active ? 'page' : undefined}
      data-palette-active={active}
      onClick={row.run}
    >
      <span className="ob-navitem-label">{row.label}</span>
      {row.hint && <span className="count">{row.hint}</span>}
    </button>
  );
}

/**
 * Every shortcut on one sheet, which is also where a clash becomes visible.
 *
 * Read-only. Rebinding lives in Settings, where there is room to explain what a
 * remap does and does not follow — a chord is a property of this machine, not
 * of the person.
 */
function KeyboardHelp() {
  const keyboard = useKeyboard();
  if (!keyboard.helpOpen) return null;

  const conflicts = new Set(
    findConflicts(keyboard.panel, keyboard.bindings).flatMap((conflict) => conflict.commandIds),
  );

  return (
    <Modal open onClose={() => keyboard.setHelpOpen(false)} title={t('keys.help.title')} size="md">
      {/* `.ob-kv` is the two-column definition list the sync popover already
          uses. A shortcut sheet is the same shape: a name and its value. */}
      <dl className="ob-kv">
        {commandsFor(keyboard.panel).flatMap((command) => {
          const chord = chordFor(command.id, keyboard.bindings);
          return [
            <dt key={`${command.id}-name`}>{t(command.titleToken)}</dt>,
            <dd key={`${command.id}-chord`}>
              {chord ? displayChord(chord) : t('keys.help.unbound')}
              {conflicts.has(command.id) && ` · ${t('keys.help.conflict')}`}
            </dd>,
          ];
        })}
      </dl>
    </Modal>
  );
}

/**
 * Both keyboard dialogs, as one line in a panel's `overlays`.
 *
 * Together rather than separately so neither panel can mount one and forget the
 * other — F1 opening nothing is the sort of omission that survives review.
 */
export function KeyboardOverlays({
  searchRecords,
  onOpenRecord,
  subscribeMenu,
}: {
  searchRecords?: (term: string) => Promise<PaletteRecords>;
  onOpenRecord?: (hit: SearchHit) => void;
  /**
   * The desktop shell's menu, if this panel is running inside one. Absent in a
   * plain browser tab, which is the normal case in development and from any
   * other machine on the shop LAN.
   */
  subscribeMenu?: (handler: (id: string) => void) => void;
}) {
  const keyboard = useKeyboard();
  const subscribed = useRef(false);

  useEffect(() => {
    // `onMenuCommand` has no unsubscribe — the preload adds an `ipcRenderer`
    // listener and nothing removes it — so subscribing twice would run every
    // menu command twice. Once per panel, for the life of the page.
    if (!subscribeMenu || subscribed.current) return;
    subscribed.current = true;

    subscribeMenu((id) => {
      /*
       * The shell's menu is panel-agnostic and sends short ids; this maps them
       * on to *this* panel's commands and drops anything it does not recognise.
       *
       * That whitelist is the trust boundary. The menu is built in the main
       * process, but the channel it arrives on is the same one any code in the
       * renderer could post to, so the page decides what a name means — never
       * the message.
       */
      const mapped =
        id === 'help.shortcuts'
          ? 'keys.help'
          : id.startsWith('nav.') && !id.startsWith(`nav.${keyboard.panel}.`)
            ? `nav.${keyboard.panel}.${id.slice('nav.'.length)}`
            : id;

      if (!COMMANDS_BY_ID.has(mapped)) return;
      if (mapped === 'keys.help') {
        keyboard.setHelpOpen(true);
        return;
      }
      keyboard.run(mapped);
    });
  }, [subscribeMenu, keyboard]);

  return (
    <>
      <CommandPalette searchRecords={searchRecords} onOpenRecord={onOpenRecord} />
      <KeyboardHelp />
    </>
  );
}

/**
 * The topbar's way in, for people who do not know the chord yet.
 *
 * It shows the chord beside the label, which is the only reliable way anybody
 * learns one — and it is why this replaces the old always-visible search box
 * rather than sitting next to it: two search affordances in one topbar is a
 * question about which one is the real one.
 */
export function PaletteButton() {
  const keyboard = useKeyboard();
  const chord = chordFor('palette.open', keyboard.bindings);
  const label = t('keys.command.palette');

  return (
    <button
      type="button"
      className="ob-btn ob-btn--ghost"
      aria-label={label}
      title={chord ? `${label} · ${displayChord(chord)}` : label}
      onClick={() => keyboard.setPaletteOpen(true)}
    >
      <span>{t('keys.palette.placeholder')}</span>
      {chord && <span className="ob-small">{displayChord(chord)}</span>}
    </button>
  );
}
