/**
 * "What to sell today" (2026-10-08, both panels): the day's entry from Notice board management,
 * in a dialog once per person per day, then they start work.
 *
 * It shows the headline, the message and the products as photo cards (photo, name, code, size,
 * main product). "Start work" closes it, and so do Escape and the close button. When the entry
 * says so it closes by itself: a ring and "Closes in 12 s" count down to it.
 *
 * When it shows: the panel mounts this inside its signed-in shell, and it opens as soon as
 * today's entry (`sellTodayFor`, the newest of those that apply) is one this person has not been
 * shown today on this PC, and `ready` is true. The panel holds `ready` false until the unread
 * notices pop-up has decided and closed, so the two come one after the other, never stacked
 * (`Modal`'s rule). An entry put up while somebody is already signed in opens the same way, the
 * moment it arrives.
 *
 * "Shown today" is remembered per person in this PC's storage the moment it opens, so a
 * navigation, a reload or a second sign-in the same day does not bring it back; a new entry, or
 * the next day, does. Storage blocked (a locked-down profile) and it is remembered for this
 * session only, which is the safe side.
 */

import { useEffect, useRef, useState } from 'react';
import { sellTodayFor, type SellToday, type SellTodayProduct } from '@orderbook/shared';

import { Button } from './Button.js';
import { t } from './i18n.js';
import { Modal } from './Modal.js';
import { ProgressiveImage } from './ProgressiveImage.js';

const keyFor = (userId: string) => `orderbook.sellToday.seen.${userId}`;

/** The entries this person has been shown on `today`, on this PC. */
export function sellTodaySeen(userId: string, today: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(userId)) ?? 'null') as {
      day?: unknown;
      ids?: unknown;
    } | null;
    if (!parsed || parsed.day !== today || !Array.isArray(parsed.ids)) return [];
    return parsed.ids.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

function rememberSeen(userId: string, today: string, id: string): void {
  try {
    // Only today's are kept: yesterday's ids are dropped the first time today's is written.
    const ids = [...new Set([...sellTodaySeen(userId, today), id])];
    localStorage.setItem(keyFor(userId), JSON.stringify({ day: today, ids }));
  } catch {
    // Storage blocked: the component's own state still stops a second opening this session.
  }
}

/**
 * A card's second line: the sub product's own code (OPB-0001, never its main product's code,
 * which `ui/tests/product-label.test.ts` keeps out of labels), its size, and the main product's
 * name when asked for.
 */
export function sellTodayCardLine(
  { code, size, mainProduct }: Pick<SellTodayProduct, 'code' | 'size' | 'mainProduct'>,
  withMainProduct = false,
): string {
  return [code, size, withMainProduct ? mainProduct : null].filter(Boolean).join(' · ');
}

export interface SellTodayPopupProps {
  /** This person's entries (the board's or the snapshot's `sellToday`); undefined before they arrive. */
  entries: readonly SellToday[] | undefined;
  /** Today as `YYYY-MM-DD`. */
  today: string;
  /** Who is signed in: "once a day" is per person. Null: nothing opens. */
  userId: string | null;
  /** False while something else must go first (the unread notices pop-up). */
  ready: boolean;
  /** The company's switch (`notices.showSellToday`). Off: never opens; turned off while open: closes. */
  enabled?: boolean;
  /** Opens a product's screen; the pop-up closes first. Absent: the cards are not buttons. */
  onOpenProduct?: (id: string) => void;
}

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

export function SellTodayPopup({
  entries,
  today,
  userId,
  ready,
  enabled = true,
  onOpenProduct,
}: SellTodayPopupProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  // Opened this session, whatever storage says: a blocked store must not reopen it on every render.
  const shown = useRef(new Set<string>());

  const todays = sellTodayFor(entries, today);
  useEffect(() => {
    if (!ready || !enabled || !userId || !todays || openId) return;
    if (shown.current.has(todays.id) || sellTodaySeen(userId, today).includes(todays.id)) return;
    shown.current.add(todays.id);
    rememberSeen(userId, today, todays.id);
    setLeft(todays.autoCloseSeconds);
    setOpenId(todays.id);
  }, [ready, enabled, userId, todays, today, openId]);

  // The entry as it stands now (an edit shows); removed while open, and it closes.
  const entry = openId ? (entries ?? []).find((each) => each.id === openId) : undefined;
  const total = entry?.autoCloseSeconds ?? 0;
  const open = Boolean(entry) && enabled;

  useEffect(() => {
    if (!open || total <= 0) return undefined;
    const timer = setInterval(() => setLeft((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, [open, total]);

  useEffect(() => {
    if (open && total > 0 && left <= 0) setOpenId(null);
  }, [open, total, left]);

  if (!open || !entry) return null;
  const close = () => setOpenId(null);
  const counting = total > 0;

  return (
    <Modal
      open
      size="lg"
      onClose={close}
      title={entry.title}
      subtitle={<span className="ob-eyebrow">{t('sellToday.popup.eyebrow')}</span>}
      footer={
        <div className="ob-selltoday-foot">
          {counting && (
            <span className="ob-selltoday-countdown" role="timer" aria-live="off">
              <svg viewBox="0 0 36 36" width={22} height={22} aria-hidden="true">
                <circle className="ob-selltoday-ring-track" cx="18" cy="18" r={RING_R} />
                <circle
                  className="ob-selltoday-ring"
                  cx="18"
                  cy="18"
                  r={RING_R}
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - Math.max(0, left) / total)}
                />
              </svg>
              {t('sellToday.popup.closesIn', { seconds: Math.max(0, left) })}
            </span>
          )}
          <Button variant="primary" autoFocus onClick={close}>
            {t('sellToday.popup.start')}
          </Button>
        </div>
      }
    >
      {entry.body.trim() && <p className="ob-selltoday-message">{entry.body}</p>}
      {entry.products.length > 0 && (
        <ul className="ob-selltoday-cards" aria-label={t('sellToday.popup.products')}>
          {entry.products.map((product) => {
            const face = (
              <>
                {product.image ? (
                  <ProgressiveImage
                    className="ob-selltoday-photo"
                    imageId={product.image.id}
                    variant="thumb"
                    slotPx={160}
                    blurhash={product.image.blurhash}
                    width={1}
                    height={1}
                    alt=""
                  />
                ) : (
                  <span className="ob-selltoday-photo ob-selltoday-photo--empty" aria-hidden="true">
                    {product.name.trim().charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="ob-selltoday-name">{product.name}</span>
                <span className="ob-selltoday-meta">
                  {sellTodayCardLine(product)}
                </span>
                {product.mainProduct && <span className="ob-selltoday-main">{product.mainProduct}</span>}
              </>
            );
            return (
              <li key={product.id} data-product={product.id}>
                {onOpenProduct ? (
                  <button
                    type="button"
                    className="ob-selltoday-card"
                    aria-label={t('sellToday.popup.open', { name: product.name })}
                    onClick={() => {
                      close();
                      onOpenProduct(product.id);
                    }}
                  >
                    {face}
                  </button>
                ) : (
                  <span className="ob-selltoday-card">{face}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
