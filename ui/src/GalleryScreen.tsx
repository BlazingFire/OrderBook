import { rem } from './rem.js';
/**
 * Token gallery (6-UI-DESIGN.md §12 step 1–2): renders every token and every
 * foundation component state in one place. Reached at #/gallery — a developer
 * affordance, linked from the status footer.
 *
 * Ramp swatch values are read through getComputedStyle so this file contains
 * no colour literals of its own (gate UI-1: hex lives only in tokens.css).
 */

import { useEffect, useState } from 'react';
import { t } from './i18n.js';
import { BusyMark } from './BusyMark';
import { Icon } from './icons';
import { Logo, LogoLockup } from './Logo';
import { applyDensity, applyMotion, applyTheme, type Density, type Theme } from './theme';

const RAMPS: Array<{ label: string; tokens: string[] }> = [
  {
    label: 'porcelain — chrome',
    tokens: [
      '--porcelain-00',
      '--porcelain-05',
      '--porcelain-10',
      '--porcelain-20',
      '--porcelain-30',
      '--porcelain-50',
      '--porcelain-70',
      '--porcelain-90',
    ],
  },
  { label: 'glaze — the one accent', tokens: ['--glaze-50', '--glaze-60', '--glaze-05'] },
  {
    label: 'kiln — state only',
    tokens: ['--kiln-amber', '--kiln-red', '--kiln-green'],
  },
];

const SEMANTIC = [
  '--bg-canvas',
  '--bg-surface',
  '--bg-sunken',
  '--bg-hover',
  '--bg-selected',
  '--fg-primary',
  '--fg-secondary',
  '--fg-tertiary',
  '--fg-disabled',
  '--line',
  '--line-strong',
  '--line-focus',
  '--accent',
  '--accent-tint',
  '--state-offline',
  '--state-conflict',
  '--state-ok',
];

const TYPE_ROWS: Array<{ name: string; className: string; sample: string }> = [
  { name: '--t-display', className: 'ob-display', sample: 'Quantity is the interface' },
  { name: '--t-title', className: 'ob-title', sample: 'Convert to order' },
  { name: '--t-eyebrow', className: 'ob-eyebrow', sample: 'Group label only' },
  { name: '--t-body', className: 'ob-body', sample: 'Your work is saved on this machine.' },
  { name: '--t-body-strong', className: 'ob-body-strong', sample: 'Save changes' },
  { name: '--t-data', className: 'ob-data', sample: '1,240 · 86 · 312 · 4,096' },
  { name: '--t-small', className: 'ob-small', sample: 'Saved a moment ago on this machine' },
  { name: '--t-micro', className: 'ob-micro', sample: '4 pending' },
  { name: '--t-mono', className: 'ob-mono', sample: 'LD0000000042 · PT-0001' },
];

/* Sample product colours as hsl() strings — data colours come from Fields
 * Management in the real app; the gallery only needs plausible stand-ins and
 * must not carry hex of its own. */
const SAMPLE_COLOURS = [
  { name: 'White', css: 'hsl(40 20% 93%)' },
  { name: 'Ivory', css: 'hsl(43 39% 79%)' },
  { name: 'Almond', css: 'hsl(200 12% 64%)' },
  { name: 'Black', css: 'hsl(210 14% 15%)' },
];

interface SampleRow {
  id: string;
  code: string;
  product: string;
  colourIndex: number;
  onHand: number;
  reserved: number;
  /** Absent key = redacted by permission (§9.1): must render an em dash. */
  rate?: number;
}

const TABLE_ROWS: SampleRow[] = [
  {
    id: 'r1',
    code: 'PR-0101',
    product: 'Product A',
    colourIndex: 0,
    onHand: 840,
    reserved: 120,
    rate: 26000,
  },
  { id: 'r2', code: 'PR-0101', product: 'Product A', colourIndex: 3, onHand: 0, reserved: 0 },
  {
    id: 'r3',
    code: 'PR-0102',
    product: 'Product B',
    colourIndex: 2,
    onHand: 204,
    reserved: 0,
    rate: 18050,
  },
];

export function GalleryScreen() {
  const [theme, setThemeState] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) ?? 'light',
  );
  const [density, setDensityState] = useState<Density>(
    () => (document.documentElement.dataset.density as Density) ?? 'comfortable',
  );
  const [motionOn, setMotionOn] = useState(document.documentElement.dataset.motion !== 'off');
  const [selected, setSelected] = useState('r1');
  const [, force] = useState(0);

  // Re-read computed ramp values whenever the theme flips.
  useEffect(() => {
    const observer = new MutationObserver(() => force((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  const pickTheme = (next: Theme) => {
    applyTheme(next);
    setThemeState(next);
  };
  const pickDensity = (next: Density) => {
    applyDensity(next);
    setDensityState(next);
  };
  const toggleMotion = () => {
    applyMotion(!motionOn);
    setMotionOn(!motionOn);
  };

  const computed = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const swatchRow = (name: string) => (
    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)' }}>
      <span className="ob-swatch" style={{ background: `var(${name})` }} />
      <span className="ob-mono">{name}</span>
      <span className="ob-micro" style={{ color: 'var(--fg-tertiary)' }}>
        {computed(name)}
      </span>
    </div>
  );

  return (
    <div className="ob-gallery">
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)' }}>
        <LogoLockup />
        <span className="ob-small">Design system — every token, every state</span>
        <span style={{ flex: 1 }} />
        <div className="ob-seg">
          {(['light', 'dark'] as Theme[]).map((value) => (
            <button key={value} aria-pressed={theme === value} onClick={() => pickTheme(value)}>
              {value === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <div className="ob-seg">
          {(['compact', 'comfortable', 'large'] as Density[]).map((value) => (
            <button key={value} aria-pressed={density === value} onClick={() => pickDensity(value)}>
              {value === 'compact' ? 'Compact' : value === 'large' ? 'Large' : 'Comfortable'}
            </button>
          ))}
        </div>
        <label
          className="ob-small"
          style={{ display: 'inline-flex', gap: 'var(--s-8)', alignItems: 'center' }}
        >
          <input type="checkbox" checked={!motionOn} onChange={toggleMotion} />
          Motion off
        </label>
      </header>

      {/* ---- Brand ------------------------------------------------------ */}
      <section className="ob-card ob-card--pad ob-gallery-section">
        <h2 className="ob-eyebrow">01 · The mark — “The Fill”</h2>
        <div className="ob-gallery-row">
          <Logo size={16} color="var(--fg-primary)" />
          <Logo size={24} />
          <Logo size={48} />
          <span style={{ borderLeft: '1px solid var(--line)', paddingLeft: 'var(--s-16)' }}>
            <LogoLockup markSize={24} />
          </span>
          <span style={{ borderLeft: '1px solid var(--line)', paddingLeft: 'var(--s-16)' }}>
            <span className="ob-micro" style={{ display: 'block', marginBottom: 4 }}>
              busy indicator — same asset
            </span>
            <span className="ob-gallery-row">
              <BusyMark size={16} label="" />
              <BusyMark size={24} label="" />
              <BusyMark size={48} label="" />
            </span>
          </span>
        </div>
        <p className="ob-small">
          The splash plays once on cold start only; with motion off it never appears.
        </p>
      </section>

      {/* ---- Colour ----------------------------------------------------- */}
      <section className="ob-card ob-card--pad ob-gallery-section">
        <h2 className="ob-eyebrow">02 · Ramps</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'var(--s-16)',
          }}
        >
          {RAMPS.map((group) => (
            <div key={group.label}>
              <div className="ob-mono ob-small" style={{ marginBottom: 'var(--s-6)' }}>
                {group.label}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
                {group.tokens.map(swatchRow)}
              </div>
            </div>
          ))}
        </div>
        <h2 className="ob-eyebrow" style={{ marginTop: 'var(--s-16)' }}>
          Semantic tokens — follow the toggle above
        </h2>
        <div className="ob-gallery-row">
          {SEMANTIC.map((name) => (
            <span
              key={name}
              className="ob-mono"
              style={{
                fontSize: rem(11),
                padding: '4px 10px',
                borderRadius: 'var(--r-sm)',
                border: '1px solid var(--line)',
                background: `var(${name})`,
                color:
                  name.startsWith('--fg') || name.startsWith('--line')
                    ? 'var(--fg-primary)'
                    : undefined,
              }}
            >
              {name}
            </span>
          ))}
        </div>
        <h2 className="ob-eyebrow" style={{ marginTop: 'var(--s-16)' }}>
          Product colour chips — colour is data, never chrome
        </h2>
        <div className="ob-gallery-row">
          {SAMPLE_COLOURS.map((colour) => (
            <span key={colour.name} className="ob-colourname">
              <span className="ob-colourchip" style={{ background: colour.css }} />
              {colour.name}
            </span>
          ))}
          <span className="ob-colourname">
            <span className="ob-colourchip ob-colourchip--empty">CE</span>
            No known hex
          </span>
        </div>
      </section>

      {/* ---- Type ------------------------------------------------------- */}
      <section className="ob-card ob-gallery-section" style={{ padding: 'var(--s-8) var(--s-20)' }}>
        <h2 className="ob-eyebrow" style={{ paddingTop: 'var(--s-12)' }}>
          03 · Type roles
        </h2>
        {TYPE_ROWS.map((row) => (
          <div
            key={row.name}
            style={{
              display: 'grid',
              gridTemplateColumns: '130px 1fr',
              gap: 'var(--s-16)',
              alignItems: 'baseline',
              padding: 'var(--s-12) 0',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span className="ob-mono" style={{ color: 'var(--accent)', fontSize: rem(11) }}>
              {row.name}
            </span>
            <span className={row.className}>{row.sample}</span>
          </div>
        ))}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '130px 1fr',
            gap: 'var(--s-16)',
            padding: 'var(--s-12) 0',
          }}
        >
          <span className="ob-mono" style={{ color: 'var(--accent)', fontSize: rem(11) }}>
            fingerprint
          </span>
          <span className="ob-fingerprint">
            <span>8B:43:D9:0B</span>
            <span>A5:1C:7E:22</span>
            <span>C4:90:3F:6D</span>
            <span>1E:B7:58:A0</span>
          </span>
        </div>
      </section>

      {/* ---- Space · shape · elevation ----------------------------------- */}
      <section className="ob-card ob-card--pad ob-gallery-section">
        <h2 className="ob-eyebrow">04 · Space · radius · elevation</h2>
        <div className="ob-gallery-row">
          {[2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56].map((step) => (
            <div
              key={step}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
            >
              <span
                style={{
                  width: rem(14),
                  height: `var(--s-${step})`,
                  background: 'var(--accent-tint)',
                  border: '1px solid var(--accent)',
                  borderRadius: 2,
                }}
              />
              <span className="ob-micro">{step}</span>
            </div>
          ))}
          <span
            style={{ borderLeft: '1px solid var(--line)', paddingLeft: 'var(--s-16)' }}
            className="ob-gallery-row"
          >
            {[4, 6, 10].map((radius) => (
              <span
                key={radius}
                className="ob-micro"
                style={{
                  width: rem(44),
                  height: rem(28),
                  border: '1px solid var(--line-strong)',
                  borderRadius: `var(--r-${radius === 10 ? 'lg' : radius === 6 ? 'md' : 'sm'})`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {radius}
              </span>
            ))}
          </span>
        </div>
        <div className="ob-gallery-row">
          {[
            { level: '1 · hairline', cls: '' },
            { level: '2 · popover', cls: 'ob-elevated-2' },
            { level: '3 · modal', cls: 'ob-elevated-3' },
          ].map((elevation) => (
            <div
              key={elevation.level}
              className={`ob-card ${elevation.cls}`}
              style={{
                flex: '0 0 140px',
                height: rem(64),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 'var(--t-small-size)',
                color: 'var(--fg-tertiary)',
                borderRadius: elevation.cls.includes('3') ? 'var(--r-lg)' : 'var(--r-md)',
              }}
            >
              {elevation.level}
            </div>
          ))}
        </div>
      </section>

      {/* ---- Buttons ----------------------------------------------------- */}
      <section className="ob-card ob-card--pad ob-gallery-section">
        <h2 className="ob-eyebrow">
          05 · Buttons — primary / secondary / ghost / danger × sm / md / lg
        </h2>
        <div className="ob-gallery-row">
          <button className="ob-btn ob-btn--primary">Save lead</button>
          <button className="ob-btn ob-btn--secondary">Cancel</button>
          <button className="ob-btn ob-btn--ghost">Dismiss</button>
          <button className="ob-btn ob-btn--danger">Forget pairing</button>
        </div>
        <div className="ob-gallery-row">
          <button className="ob-btn ob-btn--primary ob-btn--sm">Small</button>
          <button className="ob-btn ob-btn--primary">Medium</button>
          <button className="ob-btn ob-btn--primary ob-btn--lg">Large</button>
          <button className="ob-btn ob-btn--primary" disabled>
            Disabled
          </button>
          <button className="ob-btn ob-btn--primary" aria-busy="true">
            <BusyMark size={14} label="" />
            Saving lead
          </button>
        </div>
      </section>

      {/* ---- Fields ------------------------------------------------------ */}
      <section className="ob-card ob-card--pad ob-gallery-section">
        <h2 className="ob-eyebrow">06 · Fields</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--s-16)',
          }}
        >
          <div className="ob-field">
            <label className="ob-label" htmlFor="g-name">
              Party name
            </label>
            <input id="g-name" className="ob-input" placeholder="Type to search parties…" />
            <p className="ob-help">Helper text sits under the field.</p>
          </div>
          <div className="ob-field">
            <label className="ob-label" htmlFor="g-qty">
              Quantity (boxes)
            </label>
            <input
              id="g-qty"
              className="ob-input ob-numinput"
              inputMode="numeric"
              placeholder="—"
              defaultValue={200}
            />
          </div>
          <div className="ob-field">
            <label className="ob-label" htmlFor="g-city">
              City
            </label>
            <select id="g-city" className="ob-select" defaultValue="City A">
              <option>City A</option>
              <option>City B</option>
              <option>City C</option>
            </select>
          </div>
          <div className="ob-field">
            <label className="ob-label" htmlFor="g-phone">
              Phone
            </label>
            <input
              id="g-phone"
              className="ob-input"
              aria-invalid="true"
              defaultValue="98410 22O01"
            />
            <p className="ob-field-error">Digits only — “O” is not a number.</p>
          </div>
          <div className="ob-field">
            <label className="ob-label" htmlFor="g-notes">
              Notes
            </label>
            <textarea
              id="g-notes"
              className="ob-textarea"
              rows={2}
              placeholder="Anything the next person should know…"
            />
          </div>
          <div className="ob-field">
            <label className="ob-label" htmlFor="g-dis">
              Disabled
            </label>
            <input id="g-dis" className="ob-input" disabled defaultValue="Read-only value" />
          </div>
        </div>
      </section>

      {/* ---- DataTable ---------------------------------------------------- */}
      <section className="ob-gallery-section">
        <h2 className="ob-eyebrow">07 · DataTable — hover, selected, numeric, redacted</h2>
        <div className="ob-tablewrap">
          <table className="ob-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Product</th>
                <th>Colour</th>
                <th className="num">On hand</th>
                <th className="num">Reserved</th>
                <th className="num" title="Hidden — your role does not include products.rate.view">
                  Rate
                </th>
              </tr>
            </thead>
            <tbody>
              {TABLE_ROWS.map((row) => {
                const colour = SAMPLE_COLOURS[row.colourIndex] ?? SAMPLE_COLOURS[0]!;
                return (
                  <tr
                    key={row.id}
                    data-selected={selected === row.id}
                    onClick={() => setSelected(row.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td
                      className="ob-mono"
                      style={{ fontSize: rem(12), color: 'var(--fg-secondary)' }}
                    >
                      {row.code}
                    </td>
                    <td>{row.product}</td>
                    <td>
                      <span className="ob-colourname">
                        <span className="ob-colourchip" style={{ background: colour.css }} />
                        {colour.name}
                      </span>
                    </td>
                    <td className="num">{row.onHand.toLocaleString('en-IN')}</td>
                    <td className="num" style={{ color: 'var(--fg-secondary)' }}>
                      {row.reserved.toLocaleString('en-IN')}
                    </td>
                    <td className="num">
                      {row.rate === undefined ? (
                        <span
                          className="ob-redacted"
                          title="Hidden — your role does not include products.rate.view"
                        />
                      ) : (
                        `₹${(row.rate / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Feedback ----------------------------------------------------- */}
      <section className="ob-card ob-card--pad ob-gallery-section">
        <h2 className="ob-eyebrow">08 · Pills · banners · empty state · timeline</h2>
        <div className="ob-gallery-row">
          <span className="ob-pill ob-pill--ok">Healthy</span>
          <span className="ob-pill ob-pill--offline">Low</span>
          <span className="ob-pill ob-pill--conflict">Conflict</span>
          <span className="ob-pill ob-pill--accent">Active</span>
          <span className="ob-pill">Synced</span>
        </div>
        <div className="ob-banner ob-banner--offline">
          <Icon name="conflicts" />
          <span>
            Can&apos;t reach the server. Your work is saved on this machine and will sync when
            it&apos;s back.
          </span>
          <span style={{ flex: 1 }} />
          <button className="ob-btn ob-btn--secondary ob-btn--sm">{t('action.retryNow')}</button>
        </div>
        <div className="ob-empty" style={{ padding: 'var(--s-32) 0 0' }}>
          <h3>No leads yet</h3>
          <p>Leads you create appear here, online or off.</p>
          <button className="ob-btn ob-btn--primary ob-btn--sm">New lead</button>
        </div>
        <ul className="ob-timeline" style={{ maxWidth: rem(380) }}>
          <li>
            <span className="dot dot--ok" />
            <div>
              <div className="ob-data">Order OR00000071 created from LD0000000047</div>
              <div className="when">Today 11:45 · User 1</div>
            </div>
          </li>
          <li>
            <span className="dot dot--offline" />
            <div>
              <div className="ob-data">Lead saved offline on Panel 2</div>
              <div className="when">Today 12:04 · User 1</div>
            </div>
          </li>
        </ul>
      </section>

      {/* ---- Presence rail preview ----------------------------------------- */}
      <section className="ob-card ob-card--pad ob-gallery-section">
        <h2 className="ob-eyebrow">09 · Presence rail — the five states</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 'var(--s-16)',
          }}
        >
          {(
            [
              ['synced', 'Synced', 'var(--line)', 1],
              ['syncing', 'Syncing 12', 'var(--accent)', 1],
              ['offline', 'Offline', 'var(--state-offline)', 0.4],
              ['offlinePending', 'Offline — 4 pending', 'var(--state-offline)', 1],
              ['conflict', '3 fields resolved — review', 'var(--state-conflict)', 1],
            ] as Array<[string, string, string, number]>
          ).map(([id, text, colour, opacity]) => (
            <div
              key={id}
              style={{
                position: 'relative',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-sm)',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  background: colour,
                  opacity,
                }}
              />
              <div
                style={{
                  padding: 'var(--s-12) var(--s-12) var(--s-12) 15px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <span className="ob-skeleton" style={{ width: '70%' }} />
                <span className="ob-skeleton" style={{ width: '50%' }} />
                <span className="ob-skeleton" style={{ width: '60%' }} />
              </div>
              <div
                className="ob-micro"
                style={{
                  borderTop: '1px solid var(--line)',
                  padding: '4px 8px 4px 15px',
                  color: 'var(--fg-secondary)',
                }}
              >
                {text}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
