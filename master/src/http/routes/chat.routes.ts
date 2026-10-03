/**
 * `/api/chat`: the Chatroom for the Master's own browser (1.3 Phase 6).
 *
 * An Office Panel reaches the same service through the twinned `chat:*` socket
 * commands, which its own server forwards at these same paths. Every handler
 * is guarded by `chat.use`; the service enforces the finer keys
 * (`chat.directMessages`, `chat.shareRecords`, `chat.tasks`,
 * `chat.createGroups`, `chat.manage`) and room membership.
 *
 * Mounted **before** `dataRoutes`, whose `requireAuth` catch-all would
 * otherwise answer first.
 */

import { Router } from 'express';

import * as chatService from '../../services/chat.service.js';
import { asyncHandler } from '../async-handler.js';
import { actorFromRequest, requireAuth, requirePermissionMiddleware } from '../middleware/require-auth.js';

export const chatRoutes: Router = Router();

chatRoutes.use(requireAuth);

const needs = requirePermissionMiddleware;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

chatRoutes.get(
  '/people',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(await chatService.listPeople(actorFromRequest(req)));
  }),
);

chatRoutes.get(
  '/rooms',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.listRooms(
        { all: req.query.all === '1', includeArchived: req.query.archived === '1' },
        actorFromRequest(req),
      ),
    );
  }),
);

chatRoutes.post(
  '/rooms',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await chatService.createRoom(req.body, actorFromRequest(req)));
  }),
);

chatRoutes.get(
  '/rooms/:id',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(await chatService.getRoom(String(req.params.id), actorFromRequest(req)));
  }),
);

chatRoutes.put(
  '/rooms/:id',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.updateRoom({ roomId: req.params.id, input: req.body }, actorFromRequest(req)),
    );
  }),
);

chatRoutes.post(
  '/rooms/:id/members',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { userId?: unknown; role?: unknown };
    res.json(
      await chatService.setMember(
        { roomId: req.params.id, userId: body.userId, role: body.role },
        actorFromRequest(req),
      ),
    );
  }),
);

chatRoutes.get(
  '/rooms/:id/messages',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.listMessages(
        { roomId: req.params.id, beforeSeq: count(req.query.before), limit: count(req.query.limit) },
        actorFromRequest(req),
      ),
    );
  }),
);

chatRoutes.post(
  '/rooms/:id/messages',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await chatService.postMessage(String(req.params.id), req.body, actorFromRequest(req)));
  }),
);

chatRoutes.post(
  '/rooms/:id/read',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.markRead({ roomId: req.params.id, seq: (req.body ?? {}).seq }, actorFromRequest(req)),
    );
  }),
);

chatRoutes.post(
  '/rooms/:id/mute',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.setMuted({ roomId: req.params.id, muted: (req.body ?? {}).muted }, actorFromRequest(req)),
    );
  }),
);

chatRoutes.post(
  '/direct',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(await chatService.openDirect({ userId: (req.body ?? {}).userId }, actorFromRequest(req)));
  }),
);

chatRoutes.put(
  '/messages/:id',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { body?: unknown; mentions?: unknown };
    res.json(
      await chatService.editMessage(
        { messageId: req.params.id, body: body.body, mentions: body.mentions },
        actorFromRequest(req),
      ),
    );
  }),
);

chatRoutes.delete(
  '/messages/:id',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(await chatService.deleteMessage(String(req.params.id), actorFromRequest(req)));
  }),
);

chatRoutes.post(
  '/messages/:id/pin',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.pinMessage(
        { messageId: req.params.id, pinned: (req.body ?? {}).pinned },
        actorFromRequest(req),
      ),
    );
  }),
);

chatRoutes.post(
  '/messages/:id/done',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.setTaskDone(
        { messageId: req.params.id, done: (req.body ?? {}).done },
        actorFromRequest(req),
      ),
    );
  }),
);

chatRoutes.get(
  '/search',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.search({ q: text(req.query.q), roomId: text(req.query.roomId) }, actorFromRequest(req)),
    );
  }),
);

chatRoutes.get(
  '/tasks',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(
      await chatService.listTasks(
        { scope: text(req.query.scope), includeDone: req.query.includeDone === '1' },
        actorFromRequest(req),
      ),
    );
  }),
);

chatRoutes.post(
  '/access-requests',
  needs('chat.use'),
  asyncHandler(async (req, res) => {
    res.json(await chatService.requestAccess(req.body, actorFromRequest(req)));
  }),
);
