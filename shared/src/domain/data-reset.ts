/**
 * The Master's Delete data screen: its two tools' shapes, shared by the server
 * and the screen.
 *
 * **Start fresh** erases every new order (pending), final order and party, for
 * every user and panel, so the company can begin again on the same install.
 * Products, users, roles, settings, panels and the activity log are kept. It is
 * a hard delete — nothing goes to the Recycle Bin — so the server asks for the
 * person's own password and the typed word `FRESH_START_CONFIRMATION`.
 *
 * **Delete all chat messages** empties every chat group and direct chat but
 * keeps the groups and who is in them; **Clear print room history** deletes the
 * printed and cancelled Printroom jobs and keeps the ones still waiting. Both
 * are hard deletes confirmed like Start fresh.
 *
 * **Delete related data** is the company setting `parties.deleteRelatedData`.
 * On, deleting a party on the Master that still has new or final orders sends
 * those orders to the Recycle Bin with it, after the dialog has listed them
 * (`PartyDeletePreview`). Off, such a delete is refused as before.
 */

/** What the person types to confirm Start fresh. Compared exactly. */
export const FRESH_START_CONFIRMATION = 'DELETE';

/** What Start fresh would remove, and what it keeps, counted now. */
export interface FreshStartSummary {
  /** New (pending) orders: leads not yet made final, binned ones included. */
  pendingOrders: number;
  /** Final orders, binned ones included. */
  finalOrders: number;
  /** Parties, binned ones included. */
  parties: number;
  /** Kept: live sub products. */
  products: number;
  /** Kept: user accounts. */
  users: number;
  /** Chat messages, for "Delete all chat messages" (groups and members stay). */
  chatMessages: number;
  /** Printed and cancelled Printroom jobs, for "Clear print room history". */
  printHistory: number;
  /** Jobs still waiting or printing: that tool keeps them. */
  printWaiting: number;
}

export interface FreshStartInput {
  /** The signed-in person's own password. */
  confirmPassword: string;
  /** Must equal `FRESH_START_CONFIRMATION`. */
  confirmText: string;
}

/** Chat and Print room clears are confirmed the same way as Start fresh. */
export type DataDeleteConfirmInput = FreshStartInput;

export interface ChatClearResult {
  ok: true;
  removed: { messages: number };
}

export interface PrintHistoryClearResult {
  ok: true;
  removed: { jobs: number };
}

export interface FreshStartResult {
  ok: true;
  removed: {
    pendingOrders: number;
    finalOrders: number;
    parties: number;
  };
}

/** One order a party delete would take with it. */
export interface PartyDeleteRelatedRecord {
  id: string;
  /** The number staff know it by (PO / LD / OR), else the id. */
  number: string;
  /** Final orders only: already dispatched. */
  dispatched?: boolean;
}

/**
 * What deleting one party would do, read before the dialog opens.
 *
 * `relatedDeleteEnabled` is the company setting; when it is false and either
 * list is not empty, the delete will be refused.
 */
export interface PartyDeletePreview {
  partyId: string;
  partyName: string;
  relatedDeleteEnabled: boolean;
  pendingOrders: PartyDeleteRelatedRecord[];
  finalOrders: PartyDeleteRelatedRecord[];
}
