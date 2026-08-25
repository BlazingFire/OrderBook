/**
 * Hand-picked inline icons (~40 budget, §11) — one SVG sprite would also do;
 * individual components keep tree-shaking simple at this size.
 * Stroke style matches the mockups: 16×16 box, 1.4px currentColor stroke.
 */

export type IconName =
  | 'dashboard'
  | 'leads'
  | 'orders'
  | 'inventory'
  | 'products'
  | 'parties'
  | 'conflicts'
  | 'settings'
  | 'shield'
  | 'server'
  | 'collapse'
  | 'expand'
  | 'close'
  | 'search'
  | 'plus'
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
  | 'external';

const PATHS: Record<IconName, string> = {
  dashboard: 'M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z',
  leads: 'M2.5 3h11L9.5 8.5V13l-3-1.8V8.5z',
  orders: 'M3 4h10M3 8h10M3 12h7',
  inventory: 'M3 5.5h10v7H3zM3 5.5L5 3h6l2 2.5M8 5.5V12.5',
  products: 'M8 2.5L13.5 8L8 13.5L2.5 8z',
  parties:
    'M5.5 6.5a2.5 2.5 0 1 0 0-.01M10.5 6.5a2.5 2.5 0 1 0 0-.01M2.5 13c.6-2.2 2-3.2 3.5-3.2M13.5 13c-.6-2.2-2-3.2-3.5-3.2',
  conflicts: 'M8 2.8L13.5 12.5H2.5zM8 6.8v2.6M8 11.6v.01',
  settings: 'M3 5.5h10M3 10.5h10M5.5 4v3M10.5 9v3',
  shield: 'M8 2.2l4.8 1.9v3.6c0 2.9-1.9 4.8-4.8 6-2.9-1.2-4.8-3.1-4.8-6V4.1zM8 6v4M8 10h.01',
  server:
    'M2.5 3h11v4h-11zM2.5 9h11v4h-11zM4.5 5h.01M4.5 11h.01',
  collapse: 'M10 3L5 8l5 5',
  expand: 'M6 3l5 5-5 5',
  close: 'M4 4l8 8M12 4l-8 8',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM13.5 13.5L10.3 10.3',
  plus: 'M8 3v10M3 8h10',
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
  edit: 'M10.5 2.5l3 3L5 14H2v-3zM9 4l3 3',
  eye: 'M2 8s2.3-4.5 6-4.5S14 8 14 8s-2.3 4.5-6 4.5S2 8 2 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  'eye-off': 'M2 2l12 12M6.7 6.8a2 2 0 0 0 2.5 2.5M4 4.4C2.7 5.4 2 8 2 8s2.3 4.5 6 4.5c1.2 0 2.2-.3 3-.8M10.8 3.6C10 3.2 9.1 3 8 3c-.6 0-1.1.1-1.6.2M11.5 5.2C12.9 6.1 14 8 14 8s-.5 1-1.4 2',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M5 4.5v8.5h6V4.5M6.5 7v4M9.5 7v4',
  filter: 'M2.5 3.5h11L9.5 8v4l-3 1.5V8z',
  drag: 'M5.5 4h.01M10.5 4h.01M5.5 8h.01M10.5 8h.01M5.5 12h.01M10.5 12h.01',
  external: 'M6.5 2.5H13v6.5M13 2.5L6.5 9M4.5 4H3v9h9v-1.5',
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
