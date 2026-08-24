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
  | 'collapse'
  | 'expand'
  | 'close';

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
  collapse: 'M10 3L5 8l5 5',
  expand: 'M6 3l5 5-5 5',
  close: 'M4 4l8 8M12 4l-8 8',
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
