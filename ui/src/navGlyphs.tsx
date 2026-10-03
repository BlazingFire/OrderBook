/**
 * The Basic Home drawings, one per module, on a 120-unit box.
 *
 * The tiles draw them in colour. The sidebar draws the same art, in one colour,
 * at 16 px (`NavGlyph`), so a module has one icon on both and the sidebar's is
 * the tile's, scaled down (1.4 R18). The colours are `--tile-*` tokens; the
 * sidebar's `.ob-navglyph` rule remaps them to the text colour.
 */

import type { ReactNode } from 'react';

export interface Glyph {
  /** The long shadow, cast down and to the right and faded by a mask. */
  shadow: string;
  art: ReactNode;
}

/** The mockup's drawings, on a 120-unit box. */
export const GLYPHS: Record<string, Glyph> = {
  newLead: {
    shadow: 'M66 26L176 136L149.17 202.83L39.17 92.83Z',
    art: (
      <>
        <path
          d="M38 30a4 4 0 0 1 4-4h24l14 14v50a4 4 0 0 1-4 4H42a4 4 0 0 1-4-4z"
          fill="var(--tile-paper)"
        />
        <path d="M66 26v10a4 4 0 0 0 4 4h10z" fill="var(--tile-tint-green)" />
        <rect x={46} y={34} width={12} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={46} y={46} width={26} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={46} y={56} width={26} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={46} y={66} width={16} height={4} rx={2} fill="var(--tile-ink)" />
        <circle cx={80} cy={84} r={17} fill="var(--tile-paper)" />
        <circle cx={80} cy={84} r={13.5} fill="var(--tile-spark)" />
        <rect x={73} y={82} width={14} height={4} rx={1.5} fill="var(--tile-ink)" />
        <rect x={78} y={77} width={4} height={14} rx={1.5} fill="var(--tile-ink)" />
      </>
    ),
  },
  leads: {
    shadow: 'M84.83 25.17L194.83 135.17L145.17 200.83L35.17 90.83Z',
    art: (
      <>
        <rect x={46} y={24} width={40} height={56} rx={4} fill="var(--tile-tint-orange)" />
        <rect x={34} y={34} width={42} height={58} rx={4} fill="var(--tile-paper)" />
        <rect x={42} y={46} width={26} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={42} y={55} width={26} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={42} y={64} width={16} height={4} rx={2} fill="var(--tile-ink)" />
        <circle cx={78} cy={82} r={18} fill="var(--tile-paper)" />
        <circle cx={78} cy={82} r={12.5} fill="none" stroke="var(--tile-ink)" strokeWidth={3.2} />
        <path
          d="M78 75.5V82l5 3.2"
          fill="none"
          stroke="var(--tile-ink)"
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
  orders: {
    shadow: 'M82.24 31.76L192.24 141.76L145.76 202.24L35.76 92.24Z',
    art: (
      <>
        <rect x={34} y={30} width={50} height={64} rx={6} fill="var(--tile-paper)" />
        <rect x={48} y={23} width={22} height={13} rx={4} fill="var(--tile-ink)" />
        <rect x={42} y={46} width={30} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={42} y={56} width={22} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={42} y={66} width={18} height={4} rx={2} fill="var(--tile-ink)" />
        <circle cx={80} cy={82} r={17} fill="var(--tile-paper)" />
        <circle cx={80} cy={82} r={13.5} fill="var(--tile-tick)" />
        <path
          d="M73.2 82.4l4.6 4.6l9-9.6"
          fill="none"
          stroke="var(--tile-paper)"
          strokeWidth={3.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
  dashboard: {
    shadow: 'M85.46 46.54L195.46 156.54L134 182L24 72Z',
    art: (
      <>
        <path
          d="M24 72A36 36 0 0 1 40.92 41.47L47.81 52.49A23 23 0 0 0 37 72Z"
          fill="var(--tile-paper)"
        />
        <path
          d="M43.1 40.21A36 36 0 0 1 76.9 40.21L70.8 51.69A23 23 0 0 0 49.2 51.69Z"
          fill="var(--tile-paper)"
        />
        <path
          d="M79.08 41.47A36 36 0 0 1 96 72L83 72A23 23 0 0 0 72.19 52.49Z"
          fill="var(--tile-spark)"
        />
        <path
          d="M63.45 74.89L79.93 48.25L56.55 69.11Z"
          fill="var(--tile-ink)"
          stroke="var(--tile-ink)"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        <circle cx={60} cy={72} r={8} fill="var(--tile-ink)" />
        <circle cx={60} cy={72} r={3} fill="var(--tile-paper)" />
      </>
    ),
  },
  conflicts: {
    shadow: 'M84.58 37.5L194.58 147.5L137.42 180.5L27.42 70.5Z',
    art: (
      <>
        <path
          d="M33.45 45.79A24 24 0 0 1 76.78 42"
          fill="none"
          stroke="var(--tile-paper)"
          strokeWidth={9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polygon points="81.78,50.66 84.58,37.5 68.99,46.5" fill="var(--tile-paper)" />
        <path
          d="M78.55 62.21A24 24 0 0 1 35.22 66"
          fill="none"
          stroke="var(--tile-paper)"
          strokeWidth={9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polygon points="30.22,57.34 27.42,70.5 43.01,61.5" fill="var(--tile-paper)" />
        <polygon
          points="84,64 102,96 66,96"
          fill="var(--tile-paper)"
          stroke="var(--tile-paper)"
          strokeWidth={8}
          strokeLinejoin="round"
        />
        <polygon
          points="84,64 102,96 66,96"
          fill="var(--tile-spark)"
          stroke="var(--tile-spark)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <rect x={82} y={74.5} width={4} height={12} rx={2} fill="var(--tile-ink)" />
        <circle cx={84} cy={91} r={2.4} fill="var(--tile-ink)" />
      </>
    ),
  },
  products: {
    shadow:
      'M94.68 57.32L204.68 167.32L156.88 212.12L46.88 102.12ZM71.12 20.88L181.12 130.88L166 166L56 56Z',
    art: (
      <>
        <rect x={48} y={20} width={24} height={6} rx={3} fill="var(--tile-ink)" />
        <rect x={56} y={24} width={8} height={32} rx={0} fill="var(--tile-ink)" />
        <path d="M60 30h16a6 6 0 0 1 6 6v6h-8v-4H60z" fill="var(--tile-ink)" />
        <path
          d="M78 46c-2 2.8-3.2 4.7-3.2 6.2a3.2 3.2 0 0 0 6.4 0c0-1.5-1.2-3.4-3.2-6.2z"
          fill="var(--tile-water)"
        />
        <path d="M29 63h62c0 16-12.5 25-31 25s-31-9-31-25z" fill="var(--tile-paper)" />
        <rect x={24} y={56} width={72} height={9} rx={4.5} fill="var(--tile-paper)" />
        <rect x={30} y={65} width={60} height={3} rx={0} fill="var(--tile-tint-purple)" />
        <path d="M52 86h16l-2.5 13h-11z" fill="var(--tile-paper)" />
        <rect x={46} y={97} width={28} height={6} rx={3} fill="var(--tile-paper)" />
      </>
    ),
  },
  parties: {
    shadow: 'M94.24 28.76L204.24 138.76L137.76 192.24L27.76 82.24Z',
    art: (
      <>
        <rect x={40} y={27} width={56} height={42} rx={6} fill="var(--tile-tint-pink)" />
        <rect x={26} y={40} width={60} height={44} rx={6} fill="var(--tile-paper)" />
        <circle cx={44} cy={56} r={7} fill="var(--tile-ink)" />
        <path d="M32 76c0-7.5 5.4-11.5 12-11.5s12 4 12 11.5z" fill="var(--tile-ink)" />
        <rect x={62} y={52} width={16} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={62} y={61} width={16} height={4} rx={2} fill="var(--tile-ink)" />
        <rect x={62} y={70} width={10} height={4} rx={2} fill="var(--tile-ink)" />
      </>
    ),
  },
  partyAccess: {
    shadow: 'M88 32L198 142L153 194L43 84Z',
    art: (
      <>
        <path
          d="M60 22l28 10v24c0 19-11.5 32-28 40c-16.5-8-28-21-28-40V32z"
          fill="var(--tile-paper)"
        />
        <circle cx={60} cy={50} r={8} fill="var(--tile-ink)" />
        <path d="M45 76c0-9 6.7-13.5 15-13.5s15 4.5 15 13.5z" fill="var(--tile-ink)" />
        <circle cx={86} cy={86} r={16} fill="var(--tile-paper)" />
        <circle cx={86} cy={86} r={12.5} fill="var(--tile-spark)" />
        <path
          d="M81.5 85v-3a4.5 4.5 0 0 1 9 0v3"
          fill="none"
          stroke="var(--tile-ink)"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x={79} y={84.5} width={14} height={10} rx={2} fill="var(--tile-ink)" />
        <circle cx={86} cy={89.2} r={1.7} fill="var(--tile-spark)" />
      </>
    ),
  },
  settings: {
    shadow: 'M75.92 32.08L185.92 142.08L142.08 185.92L32.08 75.92Z',
    art: (
      <>
        <path
          d="M48.6 30.62L49.15 23.38A31 31 0 0 1 58.85 23.38L59.4 30.62A24 24 0 0 1 66.72 33.65L72.22 28.92A31 31 0 0 1 79.08 35.78L74.35 41.28A24 24 0 0 1 77.38 48.6L84.62 49.15A31 31 0 0 1 84.62 58.85L77.38 59.4A24 24 0 0 1 74.35 66.72L79.08 72.22A31 31 0 0 1 72.22 79.08L66.72 74.35A24 24 0 0 1 59.4 77.38L58.85 84.62A31 31 0 0 1 49.15 84.62L48.6 77.38A24 24 0 0 1 41.28 74.35L35.78 79.08A31 31 0 0 1 28.92 72.22L33.65 66.72A24 24 0 0 1 30.62 59.4L23.38 58.85A31 31 0 0 1 23.38 49.15L30.62 48.6A24 24 0 0 1 33.65 41.28L28.92 35.78A31 31 0 0 1 35.78 28.92L41.28 33.65A24 24 0 0 1 48.6 30.62ZM64 54A10 10 0 1 0 44 54A10 10 0 1 0 64 54Z"
          fill="var(--tile-paper)"
          fillRule="evenodd"
        />
        <path
          d="M88.3 74.57L90.09 70.81A15.5 15.5 0 0 1 95.56 73.07L94.16 77A11.5 11.5 0 0 1 96 78.84L99.93 77.44A15.5 15.5 0 0 1 102.19 82.91L98.43 84.7A11.5 11.5 0 0 1 98.43 87.3L102.19 89.09A15.5 15.5 0 0 1 99.93 94.56L96 93.16A11.5 11.5 0 0 1 94.16 95L95.56 98.93A15.5 15.5 0 0 1 90.09 101.19L88.3 97.43A11.5 11.5 0 0 1 85.7 97.43L83.91 101.19A15.5 15.5 0 0 1 78.44 98.93L79.84 95A11.5 11.5 0 0 1 78 93.16L74.07 94.56A15.5 15.5 0 0 1 71.81 89.09L75.57 87.3A11.5 11.5 0 0 1 75.57 84.7L71.81 82.91A15.5 15.5 0 0 1 74.07 77.44L78 78.84A11.5 11.5 0 0 1 79.84 77L78.44 73.07A15.5 15.5 0 0 1 83.91 70.81L85.7 74.57A11.5 11.5 0 0 1 88.3 74.57ZM91.6 86A4.6 4.6 0 1 0 82.4 86A4.6 4.6 0 1 0 91.6 86Z"
          fill="var(--tile-spark)"
          fillRule="evenodd"
        />
      </>
    ),
  },
  updates: {
    shadow:
      'M66.41 19.59L176.41 129.59L170 179L60 69ZM90.83 67.17L200.83 177.17L139.17 202.83L29.17 92.83Z',
    art: (
      <>
        <rect x={53} y={19} width={14} height={30} rx={2} fill="var(--tile-paper)" />
        <path
          d="M38 45h44L60 69z"
          fill="var(--tile-paper)"
          stroke="var(--tile-paper)"
          strokeWidth={3}
          strokeLinejoin="round"
        />
        <path
          d="M28 70a4 4 0 0 1 4-4h12l6 8h20l6-8h12a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H32a4 4 0 0 1-4-4z"
          fill="var(--tile-paper)"
        />
        <rect x={36} y={82.5} width={24} height={3} rx={1.5} fill="var(--tile-ink)" />
        <circle cx={83} cy={84} r={2.8} fill="var(--tile-led)" />
      </>
    ),
  },
};

/**
 * A module's Basic Home drawing as a sidebar icon. The box is cropped to the
 * art (the drawings sit inside 20..105) so it fills 16 px the way a line icon does.
 */
export function NavGlyph({ id, size = 16 }: { id: string; size?: number }) {
  const glyph = GLYPHS[id];
  if (!glyph) return null;
  return (
    <svg
      className="ob-navglyph"
      width={size}
      height={size}
      viewBox="14 14 96 96"
      aria-hidden="true"
      data-glyph={id}
    >
      {glyph.art}
    </svg>
  );
}
