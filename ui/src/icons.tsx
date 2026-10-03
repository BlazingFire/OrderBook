/**
 * Hand-picked inline icons (~40 budget, §11) — one SVG sprite would also do;
 * individual components keep tree-shaking simple at this size.
 * Stroke style matches the mockups: 16×16 box, 1.4px currentColor stroke.
 */

export type IconName =
  | 'home'
  | 'dashboard'
  | 'report'
  | 'leads'
  | 'orders'
  | 'inventory'
  | 'products'
  | 'parties'
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
  | 'edit'
  | 'eye'
  | 'eye-off'
  | 'trash'
  | 'filter'
  | 'drag'
  | 'external'
  | 'upload'
  | 'download'
  | 'bell'
  | 'chat'
  | 'pin'
  | 'task'
  | 'print'
  | 'sign-out'
  | 'key'
  | 'plug'
  | 'log'
  | 'updates';

const PATHS: Record<IconName, string> = {
  // The Basic Home launcher, as drawn in the owner's mockup.
  home: 'M2.5 7.3L8 2.8l5.5 4.5M4 6.2v7.3h8V6.2M6.6 13.5V9.8h2.8v3.7',
  dashboard: 'M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l3-4M3.2 8h1M8 3.2v1M12.8 8h-1',
  report: 'M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5',
  leads: 'M5 2.5h7.5v9H5zM3 4.5v9h7.5M8.5 6.2v2.4l1.6 1',
  orders: 'M3.5 3.5h9v10h-9zM6 2.5h4v2H6zM5.8 8.5l1.6 1.6 3-3.2',
  inventory: 'M3 5.5h10v7H3zM3 5.5L5 3h6l2 2.5M8 5.5V12.5',
  products: 'M3 8h10c0 3-2.2 4.5-5 4.5S3 11 3 8zM8 8V5.5M6 3.5h3a1.5 1.5 0 0 1 1.5 1.5v.5M6.5 14h3',
  parties: 'M2.5 4h11v8h-11zM5.6 7.4a1.2 1.2 0 1 0 0-.01M4 10.6c.3-1 1-1.6 1.6-1.6s1.3.6 1.6 1.6M8.7 7h3M8.7 9.5h2',
  conflicts: 'M3.2 6.5A5 5 0 0 1 11.6 4.2M12.8 9.5A5 5 0 0 1 4.4 11.8M12 2v2.5H9.5M4 14v-2.5h2.5M8 6.2l1.8 3.3H6.2z',
  settings: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.8l.9 1.6 1.8-.5.5 1.8 1.7.9-.9 1.6.9 1.6-1.7.9-.5 1.8-1.8-.5-.9 1.6-.9-1.6-1.8.5-.5-1.8-1.7-.9.9-1.6-.9-1.6 1.7-.9.5-1.8 1.8.5z',
  shield: 'M8 2.2l4.8 1.9v3.6c0 2.9-1.9 4.8-4.8 6-2.9-1.2-4.8-3.1-4.8-6V4.1zM8 6.2a1.2 1.2 0 1 0 0-.01M5.9 10.2c.3-1.1 1.2-1.7 2.1-1.7s1.8.6 2.1 1.7',
  server: 'M2.5 3h11v4h-11zM2.5 9h11v4h-11zM4.5 5h.01M4.5 11h.01',
  collapse: 'M10 3L5 8l5 5',
  expand: 'M6 3l5 5-5 5',
  close: 'M4 4l8 8M12 4l-8 8',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM13.5 13.5L10.3 10.3',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  more: 'M4 8h.01M8 8h.01M12 8h.01',
  'chevron-down': 'M3.5 6l4.5 4.5L12.5 6',
  'chevron-up': 'M3.5 10l4.5-4.5L12.5 10',
  'chevron-left': 'M10 3L5 8l5 5',
  'chevron-right': 'M6 3l5 5-5 5',
  check: 'M3 8.5l3.2 3.2L13 4.5',
  calendar: 'M3 4.5h10v9H3zM3 6.5h10M5.5 2.5v3M10.5 2.5v3',
  copy: 'M6 6h6.5v6.5H6zM3.5 3.5h6.5v2M3.5 3.5v6.5h2',
  warning: 'M8 2.8L13.5 12.5H2.5zM8 6.8v2.6M8 11.6v.01',
  sync: 'M12.5 5.5A5 5 0 0 0 3.6 4M3.5 10.5A5 5 0 0 0 12.4 12M12.5 2.5v3h-3M3.5 13.5v-3h3',
  // Distinct from `sync`, which is already the Updates nav glyph — a counter-
  // clockwise arrow reads as "start over", not "fetch again".
  reset: 'M3.5 8a4.5 4.5 0 1 0 1.6-3.4M3 3v3h3',
  edit: 'M10.5 2.5l3 3L5 14H2v-3zM9 4l3 3',
  eye: 'M2 8s2.3-4.5 6-4.5S14 8 14 8s-2.3 4.5-6 4.5S2 8 2 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  'eye-off':
    'M2 2l12 12M6.7 6.8a2 2 0 0 0 2.5 2.5M4 4.4C2.7 5.4 2 8 2 8s2.3 4.5 6 4.5c1.2 0 2.2-.3 3-.8M10.8 3.6C10 3.2 9.1 3 8 3c-.6 0-1.1.1-1.6.2M11.5 5.2C12.9 6.1 14 8 14 8s-.5 1-1.4 2',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M5 4.5v8.5h6V4.5M6.5 7v4M9.5 7v4',
  filter: 'M2.5 3.5h11L9.5 8v4l-3 1.5V8z',
  drag: 'M5.5 4h.01M10.5 4h.01M5.5 8h.01M10.5 8h.01M5.5 12h.01M10.5 12h.01',
  external: 'M6.5 2.5H13v6.5M13 2.5L6.5 9M4.5 4H3v9h9v-1.5',
  // A tray with an arrow: up out of it to send a file, down into it to save one.
  upload: 'M8 10.5V3M4.8 6.2L8 3l3.2 3.2M3 10.5v2.5h10v-2.5',
  download: 'M8 3v7.5M4.8 7.3L8 10.5l3.2-3.2M3 10.5v2.5h10v-2.5',
  // The notification bell in the topbar.
  bell: 'M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0',
  // The Chatroom: a speech bubble with its tail at the lower left.
  chat: 'M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z',
  // A pinned message.
  pin: 'M9.8 2.5l3.7 3.7-2 1-2 2 .4 2.6-1.1 1.1-6-6 1.1-1.1 2.6.4 2-2zM5.2 10.8L2.5 13.5',
  // A task: a box with a tick in it.
  task: 'M3 3.5h10v9H3zM5.5 8l1.8 1.8L10.5 6.5',
  // The Printroom: a printer, paper in at the top and out at the foot.
  print: 'M4.5 6V2.5h7V6M4.5 11.5H2.5V6h11v5.5h-2M4.5 9h7v4.5h-7z',
  // 1.4 R12: sign-out, a door with an arrow leaving it.
  'sign-out': 'M6.5 2.5h-3v11h3M6 8h7M10.5 5.3L13.2 8l-2.7 2.7',
  key: 'M5.2 11a3 3 0 1 0 0-.01M7.4 9.2L13.5 3.3M11.5 5.3l1.5 1.5M9.6 7.1l1.2 1.2',
  plug: 'M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5V14',
  log: 'M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3',
  updates: 'M2.5 9.5h11v4h-11zM8 2.5v5M5.8 5.5L8 7.7l2.2-2.2M11.5 11.5h.01',
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
