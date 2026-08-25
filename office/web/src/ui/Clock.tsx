/**
 * The wall clock in the status footer.
 *
 * Not decoration. These machines sit on a shop floor with no internet and no
 * NTP, and every timestamp the app writes — when a lead was raised, when an
 * order was dispatched, the HLC a sync merges on — comes from the local clock.
 * Putting it where an operator already looks is how a machine that has drifted
 * gets noticed before a day of records is stamped wrong.
 */

import { useEffect, useState } from 'react';

/** Fixed-width by construction, so the footer does not shuffle as it ticks. */
const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

export function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Half a second, not one: a one-second timer drifts against the wall clock
    // and eventually skips a visible second. Sampling twice as often costs
    // nothing and keeps every second on screen.
    const tick = window.setInterval(() => setNow(new Date()), 500);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <span className="ob-footer-clock">
      <span>{now.toLocaleDateString(undefined, DATE_FORMAT)}</span>
      <time dateTime={now.toISOString()}>{now.toLocaleTimeString(undefined, TIME_FORMAT)}</time>
    </span>
  );
}
