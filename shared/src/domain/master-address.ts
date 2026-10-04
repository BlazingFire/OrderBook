/**
 * What a person types to name a Master by hand: an address and, usually, a port.
 *
 * One parser for both ends. The connection screen checks the fields as they are
 * typed, and the Office server checks them again before it makes any request, so
 * a value the screen let through can never turn into a URL nobody meant
 * (`http://http://10.0.0.5:4100`, port `NaN` quietly becoming 4100, `4100abc`).
 *
 * LAN use only: a dotted IPv4 address or a host name. IPv6 is refused rather than
 * half-supported.
 */

export const DEFAULT_MASTER_PORT = 4100;

export type MasterAddressProblem =
  /** Nothing typed. */
  | 'empty'
  /** Not an IPv4 address or a host name (a bad octet, spaces, a stray character). */
  | 'invalid_host'
  /** Not a whole number from 1 to 65535. */
  | 'invalid_port';

export type MasterAddressResult =
  { ok: true; host: string; port: number } | { ok: false; problem: MasterAddressProblem };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** Looks like an IPv4 address (digits and dots only), whether or not it is valid. */
const DOTTED_NUMBER = /^[\d.]+$/;
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isValidHost(host: string): boolean {
  const octets = IPV4.exec(host);
  if (octets) {
    const numbers = octets.slice(1).map(Number);
    // 0.0.0.0 is "nowhere", not an address a Master can be reached at.
    return numbers.every((value) => value <= 255) && numbers.some((value) => value !== 0);
  }
  // `1.2.3` or `999.1.1.1.1` look like addresses and are not host names.
  if (DOTTED_NUMBER.test(host)) return false;
  return HOST_NAME.test(host);
}

/**
 * Reads the two fields. The address may carry a scheme, a path or `:port`
 * (people paste what they see on the Master's screen), which are tolerated; the
 * port field wins when both give one, and an empty port means the default.
 */
export function parseMasterAddress(
  hostInput: string,
  portInput?: string | number | null,
): MasterAddressResult {
  let host = (hostInput ?? '').trim();
  if (host === '') return { ok: false, problem: 'empty' };

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  host = host.split(/[/?#]/, 1)[0] ?? '';

  let embeddedPort: string | undefined;
  const colon = host.indexOf(':');
  if (colon !== -1) {
    // A second colon is IPv6, which is not supported.
    if (host.indexOf(':', colon + 1) !== -1) return { ok: false, problem: 'invalid_host' };
    embeddedPort = host.slice(colon + 1);
    host = host.slice(0, colon);
  }
  host = host.trim().replace(/\.$/, '');

  if (!isValidHost(host)) return { ok: false, problem: host === '' ? 'empty' : 'invalid_host' };

  const typed = portInput === undefined || portInput === null ? '' : String(portInput).trim();
  const raw = typed !== '' ? typed : (embeddedPort ?? '').trim();
  if (raw === '') return { ok: true, host, port: DEFAULT_MASTER_PORT };

  if (!/^\d{1,5}$/.test(raw)) return { ok: false, problem: 'invalid_port' };
  const port = Number(raw);
  if (port < 1 || port > 65535) return { ok: false, problem: 'invalid_port' };

  return { ok: true, host, port };
}
