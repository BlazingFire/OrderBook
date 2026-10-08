/**
 * The one limiter: `consume` (api-key-rate-limit.ts) behind an Express middleware and a
 * Socket.IO packet guard. Fixed sixty-second windows, in memory, per process.
 *
 * These are flood guards, not the security boundary (sign-in has its own lockout). The
 * numbers are set so normal shop use never reaches them: every Office reaches the Master
 * from its own PC's address, so one address is one panel, not the whole company.
 */

import type { Request, RequestHandler } from 'express';
import type { Socket } from 'socket.io';

import { AppError } from '../../lib/errors.js';
import { consume, resetRateLimits } from './api-key-rate-limit.js';

/** Per minute. A fresh page load is a few dozen requests, so these are well above a person. */
export const LIMITS = {
  /** Sign-in and every password change/reveal, per source address. */
  passwordPerIp: 60,
  /** Sign-in per attempted username; the account lockout (auth.service.ts) is the strict one. */
  signInPerUsername: 30,
  /** Report/PDF generation: each one reads and formats a whole period. */
  reportPerIp: 60,
  /** Multipart uploads: image, avatar, spreadsheet, backup. */
  uploadPerIp: 120,
  /** `/api/v1` before the key's own limit applies; stops key-guessing floods. */
  publicApiPerIp: 1_200,
  /** The Office setup a new PC downloads (85 MB or more each); one or two is a person. */
  officeSetupPerIp: 10,
  /** Socket.IO commands per connection; a panel flushing its outbox sends a batch per push. */
  socketPerConnection: 1_200,
} as const;

/** `::ffff:192.168.1.5` and `192.168.1.5` are one caller. */
export function sourceKey(req: Request): string {
  return (req.ip ?? 'unknown').replace(/^::ffff:/i, '');
}

/**
 * Limit by source address. `writesOnly` lets a GET through, for a path whose reads are cheap.
 * Namespaced so one route's bucket never counts against another's.
 */
export function limitByIp(name: string, perMin: number, options: { writesOnly?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    if (options.writesOnly && (req.method === 'GET' || req.method === 'HEAD')) return next();
    try {
      consume(`${name}:ip:${sourceKey(req)}`, perMin);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Limit by a string field of the JSON body (the attempted username); a missing field is not counted. */
export function limitByBodyField(name: string, field: string, perMin: number): RequestHandler {
  return (req, _res, next) => {
    const value = (req.body as Record<string, unknown> | undefined)?.[field];
    if (typeof value !== 'string' || !value) return next();
    try {
      consume(`${name}:${field}:${value.trim().toLowerCase().slice(0, 200)}`, perMin);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Limit only multipart requests, wherever they are mounted. */
export function limitUploads(perMin: number): RequestHandler {
  const limiter = limitByIp('upload', perMin);
  return (req, res, next) => (req.is('multipart/form-data') ? limiter(req, res, next) : next());
}

/**
 * Per-connection command limit. Over it, a command with an ack gets the same coded refusal
 * every other command failure carries (`rate_limited` + `retryAfterSeconds`); one without is
 * dropped. Called once per connection; the window is forgotten when the socket goes.
 */
export function limitSocket(socket: Socket, perMin: number = LIMITS.socketPerConnection): void {
  const key = `socket:${socket.id}`;
  socket.use((packet, next) => {
    try {
      consume(key, perMin);
      next();
    } catch (error) {
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function' && error instanceof AppError) {
        ack({
          ok: false,
          error: error.message,
          code: error.code,
          messageKey: error.messageKey,
          params: error.params,
          ...(error.details ? { details: error.details } : {}),
        });
      }
    }
  });
  socket.on('disconnect', () => resetRateLimits(key));
}
