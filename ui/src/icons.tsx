/**
 * The one icon set, inline: flat line drawings on a 24-unit grid, a 1.75-unit
 * round-capped stroke in `currentColor`, no fill. The style and most of the
 * drawings are the design artifact's (`.design-ui/project/Sidebar.dc.html`,
 * `Navigation.dc.html` and the component artboards); the rest are drawn the
 * same way. A circle or a rounded rectangle is written as a path, so every
 * icon stays one `d`.
 */

export type IconName =
  | 'home'
  | 'dashboard'
  | 'report'
  | 'leads'
  | 'orders'
  | 'final'
  | 'inventory'
  | 'products'
  | 'parties'
  | 'people'
  | 'conflicts'
  | 'settings'
  | 'reset'
  | 'shield'
  | 'server'
  | 'collapse'
  | 'expand'
  | 'close'
  | 'search'
  | 'plus'
  | 'minus'
  | 'more'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-left'
  | 'chevron-right'
  | 'check'
  | 'calendar'
  | 'copy'
  | 'warning'
  | 'sync'
  | 'update'
  | 'edit'
  | 'eye'
  | 'eye-off'
  | 'trash'
  | 'filter'
  | 'fields'
  | 'drag'
  | 'external'
  | 'upload'
  | 'download'
  | 'bell'
  | 'chat'
  | 'pin'
  | 'notice'
  | 'noticeEdit'
  | 'task'
  | 'print'
  | 'sign-out'
  | 'key'
  | 'lock'
  | 'camera'
  | 'plug'
  | 'log';

/** A circle as a path, for icons that are otherwise one stroke. */
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS: Record<IconName, string> = {
  // Modules, as the Sidebar artboard draws them.
  home: 'M4 11l8-7 8 7v9h-5v-6h-6v6H4z',
  dashboard: 'M4 16a8 8 0 1 1 16 0M12 16l4-5',
  leads: 'M8 4h8v3H8zM6 5.5H5v15h14v-15h-1',
  final: 'M6 3h8l4 4v14H6zM9 14l2 2 4-4',
  conflicts: 'M8 7h11l-3-3M16 17H5l3 3',
  chat: 'M4 5h16v11H9l-5 4z',
  print: 'M7 9V4h10v5M7 16H5V9h14v7h-2M7 14h10v6H7z',
  report: 'M4 20h16M7 16v-5M12 16V7M17 16v-8',
  products: `M4 4h8l8 8-8 8-8-8z${circle(8.5, 8.5, 1.2)}`,
  parties: `${circle(9, 9, 3.2)}M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5`,
  // Roles & users: the Navigation artboard's two people, so Parties keeps its one.
  people: `${circle(9, 9, 3.2)}M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M16 6.5a3 3 0 0 1 0 5.6M17.5 14.8c1.6.6 2.6 2 3 4.2`,
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  task: 'M4 5h16v14H4zM8 12l2 2 4-4',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01',
  fields: `M4 7h10M18 7h2M4 17h4M12 17h8${circle(16, 7, 2)}${circle(10, 17, 2)}`,
  log: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  plug: 'M9 4v5M15 4v5M6 9h12v3a6 6 0 0 1-12 0zM12 18v3',
  settings: `${circle(12, 12, 3.5)}M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8`,
  update: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  // The notice board: a megaphone; managing it, a sheet with a pencil.
  notice: 'M4 10v4h3l7 4V6l-7 4zM17.5 9.5a3.5 3.5 0 0 1 0 5',
  noticeEdit: 'M5 4h11v6M5 4v16h6M8 8h5M8 12h3M14 20v-2.5l5-5 2.5 2.5-5 5z',

  // Everything else, drawn the same way.
  orders: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  inventory: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  reset: 'M4 11a8 8 0 1 1 2.3 5.7M4 4v7h7',
  collapse: 'M15 6l-6 6 6 6',
  expand: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  search: `${circle(11, 11, 6)}M20 20l-4.5-4.5`,
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  // Three small rings, not three stroke-wide dots: at 16 px a dot was barely 1 px and the ⋯ read as faint.
  more: `${circle(6, 12, 1)}${circle(12, 12, 1)}${circle(18, 12, 1)}`,
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7',
  calendar: 'M5.5 5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 10h17M8 3v4M16 3v4',
  copy: 'M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
  warning: 'M12 4l9 16H3zM12 10v4M12 17.5v.01',
  sync: 'M19 8a7.5 7.5 0 0 0-13.3-1.5M5 16a7.5 7.5 0 0 0 13.3 1.5M19 3.5V8h-4.5M5 20.5V16h4.5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  eye: `M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z${circle(12, 12, 3)}`,
  'eye-off':
    'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M6.5 6.6C4 8.3 2.5 12 2.5 12s3.5 7 9.5 7c1.8 0 3.3-.5 4.6-1.2M9.9 5.3A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.3 3.2',
  filter: 'M4 6h16M7 12h10M10 18h4',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  // A tray with an arrow: up out of it to send a file, down into it to save one.
  upload: 'M12 15V4M7 9l5-5 5 5M5 15v4h14v-4',
  download: 'M12 4v11M7 10l5 5 5-5M5 15v4h14v-4',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4',
  pin: 'M14.5 4l5.5 5.5-3 1.5-3 3 .5 4-1.5 1.5-9-9L5.5 9l4 .5 3-3zM8 16l-4 4',
  'sign-out': 'M10 4H5v16h5M9 12h11M16 8l4 4-4 4',
  key: `${circle(8, 15, 4)}M11 12l9-9M17 6l2 2M14.5 8.5l1.5 1.5`,
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  camera: `M4 8h3l1.5-2h7L17 8h3v11H4z${circle(12, 13, 3.2)}`,
};

/**
 * The artboard's stroke: 1.75 at the 16 px of a sidebar row and up, 2 at 14 px and below (a sub-page's
 * 13 px icon, a 14 px chevron), so a small icon does not thin out.
 */
export function iconStroke(size: number): number {
  return size <= 14 ? 2 : 1.75;
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={iconStroke(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
