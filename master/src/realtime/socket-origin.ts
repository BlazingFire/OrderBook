/**
 * Which pages may open a socket to the Master.
 *
 * The hub's own authentication is the real gate — a socket does nothing until
 * it presents a pairing secret or a session token — but that gate should only
 * ever be reached by the Master's clients, not by whatever page somebody on
 * the shop LAN happens to have open. A browser page cannot be kept off a
 * WebSocket by CORS (browsers apply none to one), so the handshake's `Origin`
 * is checked instead, by `hub.ts`'s `allowRequest`, on both transports.
 *
 * Every client the Master has passes without being listed, which is what lets
 * the rule stay this small:
 *
 *  · the Master's own UI in a browser is served by this same server, so its
 *    origin is the address the browser used — `http://localhost:4100` in the
 *    Electron shell, `http://192.168.1.10:4100` from another PC on the LAN;
 *  · the Vite dev server proxies `/socket.io` without rewriting `Host`, so the
 *    page's origin and the forwarded `Host` still agree;
 *  · an Office Panel connects from its *server*, in Node, whose Socket.IO
 *    client sends no `Origin` at all.
 *
 * Not a defence against DNS rebinding: a page on a name that resolves to the
 * Master's address is same-host by construction. It still has no token to
 * present — the Master's session cookie belongs to the Master's own address,
 * not to that name.
 */

/**
 * Whether a handshake carrying this `Origin` may proceed to this `Host`.
 *
 * No `Origin` is let through. A browser always sends one on a WebSocket
 * handshake and on a cross-origin request whose answer the page may read; it
 * leaves it off a same-origin GET, and off a cross-site no-cors GET — an
 * `<img>` or `<script>` pointed at the polling handshake — which does open a
 * session, but one whose id that page can never read, so it can send nothing
 * down it, a token least of all. An Office Panel's server sends none at all,
 * and a client able to choose its headers could equally leave the header off,
 * so refusing the absence would protect nothing and would lock out every
 * Office Panel.
 *
 * Otherwise the page must have been served from exactly the host and port the
 * request was sent to — another site, another port on the same machine and
 * the opaque `null` of a sandboxed frame or a `file://` page are all refused.
 */
export function isAllowedSocketOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) return true;
  if (!host) return false;

  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    // `null`, or a header that is not an origin at all.
    return false;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;

  // `URL` lower-cases the host name and drops a default port, which is also
  // how a browser writes `Host`; only the case is left to line up.
  return page.host === host.toLowerCase();
}
