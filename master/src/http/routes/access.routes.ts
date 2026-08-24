/**
 * Roles & Users endpoints (docs/ROLES_AND_USERS.md §13 error codes).
 *
 * Every handler resolves the actor from the session and never from an argument
 * — identity is not something a caller gets to assert. The services check the
 * same permissions again; this layer refusing early only means a doomed request
 * never opens a transaction.
 */

import { Router } from 'express';

import { ValidationError } from '../../lib/errors.js';
import * as roleService from '../../services/role.service.js';
import * as userService from '../../services/user.service.js';
import * as authService from '../../services/auth.service.js';
import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

export const accessRoutes: Router = Router();

accessRoutes.use(requireAuth);

/**
 * The route-level half of the two-layer check.
 *
 * `requirePermissionMiddleware` was defined, exported, and mounted nowhere —
 * so the two gates the guides describe (`roles-software-flow.md` §1, §3) were
 * in practice one, while this file's own header claimed otherwise. The services
 * check again; this layer refusing early only means a doomed request never opens
 * a transaction.
 */
const needs = requirePermissionMiddleware;

// --- The catalogue the permission grid renders from -----------------------

accessRoutes.get('/permission-catalogue', (_req, res) => {
  res.json(roleService.permissionCatalogue());
});

// --- Roles ----------------------------------------------------------------

accessRoutes.get(
  '/roles',
  needs('roles.view'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.listRoles(actorFromRequest(req)));
  }),
);

accessRoutes.get(
  '/roles/deleted',
  needs('roles.view'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.listDeletedRoles(actorFromRequest(req)));
  }),
);

accessRoutes.get(
  '/roles/:id',
  needs('roles.view'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.getRole(String(req.params.id), actorFromRequest(req)));
  }),
);

accessRoutes.post(
  '/roles',
  needs('roles.create'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await roleService.createRole(req.body, actorFromRequest(req)));
  }),
);

accessRoutes.put(
  '/roles/:id',
  needs('roles.edit'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.updateRole(String(req.params.id), req.body, actorFromRequest(req)));
  }),
);

accessRoutes.delete(
  '/roles/:id',
  needs('roles.delete'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.deleteRole(String(req.params.id), actorFromRequest(req)));
  }),
);

accessRoutes.post(
  '/roles/:id/restore',
  needs('roles.delete'),
  asyncHandler(async (req, res) => {
    res.json(await roleService.restoreRole(String(req.params.id), actorFromRequest(req)));
  }),
);

// --- Users ----------------------------------------------------------------

accessRoutes.get(
  '/users',
  needs('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await userService.listUsers(actorFromRequest(req)));
  }),
);

accessRoutes.get(
  '/users/deleted',
  needs('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await userService.listDeletedUsers(actorFromRequest(req)));
  }),
);

/**
 * Creating a user is the one response in the product that carries a plaintext
 * password, and it carries it exactly once. There is no endpoint to fetch it
 * again — recovery is a reset, which is itself audited.
 */
accessRoutes.post(
  '/users',
  needs('users.manage'),
  asyncHandler(async (req, res) => {
    const { user, secret } = await userService.createUser(req.body, actorFromRequest(req));
    res.status(201).json({ user, secret });
  }),
);

accessRoutes.put(
  '/users/:id',
  needs('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await userService.updateUser(String(req.params.id), req.body, actorFromRequest(req)));
  }),
);

accessRoutes.delete(
  '/users/:id',
  needs('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await userService.deleteUser(String(req.params.id), actorFromRequest(req)));
  }),
);

accessRoutes.post(
  '/users/:id/restore',
  needs('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await userService.restoreUser(String(req.params.id), actorFromRequest(req)));
  }),
);

accessRoutes.post(
  '/users/:id/reset-password',
  needs('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(
      await userService.resetPassword(
        { userId: String(req.params.id), password: req.body?.password },
        actorFromRequest(req),
      ),
    );
  }),
);

/**
 * Changing your own password needs the current one, not `users.manage` —
 * otherwise nobody could change their own without administrative rights.
 */
accessRoutes.post(
  '/me/password',
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      throw new ValidationError('Enter your current and new password');
    }

    const actor = actorFromRequest(req);
    await authService.changeOwnPassword(
      { currentPassword, newPassword },
      actor.userId ?? '',
      actor.tenantId,
    );

    res.status(204).end();
  }),
);
