/**
 * The product card of the new pending order: a head (code chip, name, category, photo, ✕), a grid
 * of sub-product rows under a header row, and a footer (the Shift+Q hint, this product's pieces and
 * the Add product button).
 *
 * Presentational. The screen owns the rows, their inputs and the Enter walk; this is the frame and
 * the seven-column template, so the Master and the Office draw the same table.
 */

import type { ReactNode } from 'react';

import './order.css';

export function ProductCard({
  head,
  footer,
  children,
}: {
  head: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ob-order-product" data-product-card>
      <div className="ob-order-product__head">{head}</div>
      {children}
      <div className="ob-order-product__foot">{footer}</div>
    </div>
  );
}

export interface SubGridLabels {
  code: string;
  sub: string;
  colour: string;
  weight: string;
  qty: string;
  packaging: ReactNode;
  grade: string;
}

/**
 * The header row and the scrolling body of the grid. `bodyRef` is the screen's handle on the rows
 * (the Enter walk reads the fields inside it in DOM order).
 */
export function SubGrid({
  labels,
  bodyRef,
  children,
}: {
  labels: SubGridLabels;
  bodyRef?: React.Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div className="ob-order-subgrid">
      <div className="ob-order-subrow ob-order-subrow--head" role="presentation">
        <span>{labels.code}</span>
        <span>{labels.sub}</span>
        <span>{labels.colour}</span>
        <span className="ob-order-cell--num">{labels.weight}</span>
        <span className="ob-order-cell--num">{labels.qty}</span>
        <span>{labels.packaging}</span>
        <span>{labels.grade}</span>
      </div>
      <div className="ob-order-subgrid__body" ref={bodyRef}>
        {children}
      </div>
    </div>
  );
}

/** One row of the grid: seven cells in the template's order. */
export function SubRow({
  muted = false,
  rowKey,
  children,
}: {
  muted?: boolean;
  /** The row's key, for the screen's Enter walk to read back from the DOM. */
  rowKey?: string;
  children: ReactNode;
}) {
  return (
    <div className="ob-order-subrow" data-muted={muted ? 'true' : undefined} data-row-key={rowKey}>
      {children}
    </div>
  );
}
