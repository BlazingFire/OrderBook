/**
 * HTTP pairing handshake. Runs after UDP discovery has told the Office Panel
 * where the Master lives (auto mode), or after an operator typed the Master's
 * address by hand (manual mode).
 *
 * Both modes hit the same endpoint and end with the Master issuing the panel a
 * permanent id + secret, which the Office Panel stores locally and presents on
 * every future reconnect.
 */

export const PAIRING_ENDPOINT = '/api/pairing/request';

export type PairingMode = 'auto' | 'manual';

export interface PairingRequest {
  mode: PairingMode;
  /** Human-readable name for this panel, shown in the Master's panel list. */
  panelName: string;
  hostname: string;
  /**
   * Echoes the discovery nonce in auto mode, proving this request follows the
   * HELLO the Master just sent rather than arriving out of nowhere.
   */
  nonce?: string;
  /** Required in manual mode: the pairing password from the Master's setup screen. */
  pairingPassword?: string;
  /** Required in manual mode: guards against pairing with the wrong Master. */
  masterUniqueId?: string;
  /**
   * The id this PC was paired under before it was removed, when it still knows it. The Master
   * gives that row back (same id, name and device code) if it is removed; it never takes an
   * active row over, and it grants nothing on its own: the window or the password still decides.
   */
  previousPanelId?: string;
}

export interface PairingSuccess {
  panelId: string;
  /** Shown to the Master only once; the Master stores a bcrypt hash of it. */
  panelSecret: string;
  masterUniqueId: string;
  companyName: string | null;
}

