/**
 * The one client request cache both panels' API layers use for list and detail reads.
 *
 * Why it exists: a screen switch, a modal opening a record its list already read, and
 * three components asking `/api/option-lists` in the same second each used to cost a round
 * trip, and a bulk import's burst of change events used to re-read everything once per
 * event. In-flight de-duplication (each `api.ts`) already collapses *simultaneous* identical
 * GETs; this keeps the answer for a short while after, so the next ask is free.
 *
 * Contract, in the order it matters:
 * - **Stale-while-revalidate.** A fresh entry (younger than `freshMs`) is returned with no
 *   network. An older one, still younger than `maxAgeMs`, is returned at once and read again
 *   in the background; if the answer differs, subscribers hear about it (`subscribe`).
 *   Nothing older than `maxAgeMs` is ever served.
 * - **Invalidation is total and immediate.** `invalidate()` drops every entry. The panels call
 *   it on every change event (Master socket `data:changed`, Office stream `change`/`snapshot`
 *   frames), on a reconnect, and after every non-GET request settles, so a screen that saved
 *   something and re-reads always sees its own write. A read that was in flight when the
 *   invalidation happened is *not* stored: it may describe the world from before.
 * - **Only while the change feed is live.** With the feed down nobody can say what moved, so
 *   `setLive(false)` empties the cache and every call goes to the network.
 * - **Callers cannot corrupt it.** Every value handed out is a copy; a screen that edits the
 *   array it was given edits its own.
 *
 * Deliberately not here: persistence (this lives for the page), size limits beyond the entry
 * count (lists are small and entries expire), and any knowledge of what a path means — the
 * caller decides what is cacheable (`isCacheableRead`).
 */

/** An entry younger than this is returned without asking the server. */
export const CACHE_FRESH_MS = 8_000;
/** The oldest an entry may be and still be served (while a refresh runs behind it). */
export const CACHE_MAX_AGE_MS = 60_000;
/** A bound, not a tuning knob: reads are keyed by path and a screen asks few distinct ones. */
const MAX_ENTRIES = 300;

interface Entry {
  value: unknown;
  /** `JSON.stringify(value)`, kept to tell whether a background refresh changed anything. */
  fingerprint: string;
  storedAt: number;
}

export interface RequestCacheOptions {
  freshMs?: number;
  maxAgeMs?: number;
  /** Test seam. */
  now?: () => number;
}

export interface RequestCacheStats {
  hits: number;
  staleHits: number;
  misses: number;
  bypasses: number;
  invalidations: number;
}

export interface RequestCache {
  /**
   * The answer for `key`: from the cache when allowed, else from `load()`.
   * `load` must be the plain network read; it is called at most once per key at a time here.
   */
  get<T>(key: string, load: () => Promise<T>): Promise<T>;
  /** Drop everything, and discard any read that is still on its way. */
  invalidate(): void;
  /** Whether the change feed that invalidates entries is up. Off empties the cache and bypasses it. */
  setLive(live: boolean): void;
  /** Called with the key whose background refresh brought a different answer. */
  subscribe(listener: (key: string) => void): () => void;
  stats(): RequestCacheStats;
  /** Test seam: forget entries and counters. */
  reset(): void;
}

/** A deep copy that does not share structure with the cached original. */
function copyOf<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createRequestCache(options: RequestCacheOptions = {}): RequestCache {
  const freshMs = options.freshMs ?? CACHE_FRESH_MS;
  const maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, Entry>();
  const refreshing = new Set<string>();
  const listeners = new Set<(key: string) => void>();
  let generation = 0;
  let live = false;
  let counters: RequestCacheStats = zeroStats();

  function zeroStats(): RequestCacheStats {
    return { hits: 0, staleHits: 0, misses: 0, bypasses: 0, invalidations: 0 };
  }

  function store(key: string, value: unknown): string {
    const fingerprint = JSON.stringify(value) ?? '';
    // Oldest first: a Map iterates in insertion order and `set` after `delete` re-inserts at the end.
    entries.delete(key);
    entries.set(key, { value, fingerprint, storedAt: now() });
    if (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    return fingerprint;
  }

  function revalidate<T>(key: string, load: () => Promise<T>, previous: string): void {
    if (refreshing.has(key)) return;
    refreshing.add(key);
    const started = generation;
    void load()
      .then((value) => {
        // An invalidation or a live-state change since the read began: the answer may be old.
        if (started !== generation || !live) return;
        const fingerprint = store(key, value);
        if (fingerprint !== previous) listeners.forEach((listener) => listener(key));
      })
      .catch(() => {
        // The stale answer stays until it ages out; the caller already has it.
      })
      .finally(() => refreshing.delete(key));
  }

  return {
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
      if (!live) {
        counters.bypasses += 1;
        return load();
      }

      const entry = entries.get(key);
      if (entry) {
        const age = now() - entry.storedAt;
        if (age < freshMs) {
          counters.hits += 1;
          return Promise.resolve(copyOf(entry.value as T));
        }
        if (age < maxAgeMs) {
          counters.staleHits += 1;
          revalidate(key, load, entry.fingerprint);
          return Promise.resolve(copyOf(entry.value as T));
        }
        entries.delete(key);
      }

      counters.misses += 1;
      const started = generation;
      return load().then((value) => {
        if (started === generation && live) store(key, value);
        // The caller gets a copy of what was stored, never the stored object itself.
        return copyOf(value);
      });
    },

    invalidate() {
      generation += 1;
      counters.invalidations += 1;
      entries.clear();
      refreshing.clear();
    },

    setLive(next) {
      if (next === live) return;
      live = next;
      // Either direction starts from nothing: what was kept while down, or before coming up, is unverified.
      generation += 1;
      entries.clear();
      refreshing.clear();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stats: () => ({ ...counters }),

    reset() {
      generation += 1;
      entries.clear();
      refreshing.clear();
      counters = zeroStats();
    },
  };
}

/**
 * The reads worth keeping: lists and records of the company's data, and the catalogues those
 * screens are built from. Everything not named here (status polls, progress, notifications,
 * chat, presence, sign-in state, setup, the signed-in user) is asked every time on purpose.
 */
const CACHEABLE_PREFIXES: readonly string[] = [
  '/api/leads',
  '/api/orders',
  '/api/parties',
  '/api/products',
  '/api/categories',
  '/api/lead-entry',
  '/api/option-lists',
  '/api/pipelines',
  '/api/fields/',
  '/api/reports/table/',
  '/api/reports/options',
  '/api/party-access',
  '/api/access/roles',
  '/api/access/users',
  '/api/access/permission-catalogue',
  '/api/recycle-bin/counts',
  '/api/logs/facets',
  '/api/conflicts',
  '/api/search',
];

/** Whether a GET of `path` may be answered from the cache. */
export function isCacheableRead(path: string): boolean {
  return CACHEABLE_PREFIXES.some((prefix) => {
    if (!path.startsWith(prefix)) return false;
    if (prefix.endsWith('/')) return true;
    // `/api/leads` and `/api/leads/LD1?x=1`, not `/api/leads-export`.
    const next = path.charAt(prefix.length);
    return next === '' || next === '/' || next === '?';
  });
}
