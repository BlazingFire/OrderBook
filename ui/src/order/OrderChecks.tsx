/** The ok / to-do list above the total: what is done and what still blocks the save. */

import { Icon } from '../icons.js';
import './order.css';

export interface OrderCheck {
  key: string;
  label: string;
  /** `ok` ticked, `todo` something to do (amber), `idle` not yet relevant (muted). */
  state: 'ok' | 'todo' | 'idle';
  title?: string;
}

export function OrderChecks({ items }: { items: OrderCheck[] }) {
  return (
    <ul className="ob-order-checks">
      {items.map((item) => (
        <li key={item.key} data-state={item.state} title={item.title}>
          {item.state === 'idle' ? (
            <span aria-hidden="true" style={{ width: 14, textAlign: 'center' }}>
              ·
            </span>
          ) : (
            <Icon name={item.state === 'ok' ? 'check' : 'warning'} size={14} />
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}
