/**
 * How many database queries one HTTP request actually costs.
 *
 * This exists because the expensive thing in this product is not a slow query,
 * it is an *amplifier*: a helper that quietly issues three queries, called once
 * per request, once per socket, and once per recipient per change. Nothing in a
 * profiler makes that obvious — every individual query is a primary-key seek —
 * so the number worth watching is the count per request, and a test can only
 * assert on a number something is publishing.
 *
 * `AsyncLocalStorage` is what makes the count per *request* rather than global:
 * a counter incremented from `knex.on('query')` has no idea which request it
 * belongs to, and on a panel serving several browsers at once a global figure
 * is noise.
 *
 * Off in production. The header is a debugging aid, and a request count is a
 * small amount of information about the shape of the database that the shop LAN
 * has no reason to be told.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';

import { createLogger } from '../lib/logger.js';

const log = createLogger('queries');

interface Scope {
  count: number;
}

const storage = new AsyncLocalStorage<Scope>();

/** Whether the counter reports anything. Never in production. */
export function queryCountingEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Start counting on this Knex instance.
 *
 * Called from `initDatabase`, so every query in the process passes through it
 * whether or not a scope is open — the listener costs one `Map` lookup when
 * there is nothing counting.
 */
export function attachQueryCounter(knex: Knex): void {
  knex.on('query', () => {
    const scope = storage.getStore();
    if (scope) scope.count += 1;
  });
}

/**
 * Run something with its own query count.
 *
 * The direct seam for a test that does not want to go through HTTP. Note that
 * an HTTP request handled by the server does **not** inherit a scope opened
 * around a `supertest` call — the handler runs in the socket's async context,
 * not the caller's — which is exactly why the middleware below exists.
 */
export async function countQueries<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const scope: Scope = { count: 0 };
  const result = await storage.run(scope, run);
  return { result, queries: scope.count };
}

/**
 * Count the queries one request costs and publish it on the response.
 *
 * `writeHead` is patched rather than using a `finish` listener: by the time
 * `finish` fires the headers are already on the wire, and a header set there is
 * silently dropped.
 */
export function queryCountMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!queryCountingEnabled()) {
    next();
    return;
  }

  const scope: Scope = { count: 0 };
  const startedAt = Date.now();
  const originalWriteHead = res.writeHead.bind(res);

  res.writeHead = function patched(this: Response, ...args: unknown[]) {
    const elapsed = Date.now() - startedAt;

    if (!res.headersSent) {
      res.setHeader('X-Query-Count', String(scope.count));
      res.setHeader('X-Duration-Ms', String(elapsed));
    }

    log.debug(`${req.method} ${req.path} ${scope.count}q ${elapsed}ms`);

    return (originalWriteHead as (...a: unknown[]) => Response)(...args);
  } as Response['writeHead'];

  storage.run(scope, next);
}
