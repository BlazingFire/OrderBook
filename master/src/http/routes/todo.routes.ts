/**
 * `/api/todos`: the To-do list for the Master's own browser (2026-10-08).
 *
 * An Office Panel reaches the same service through the twinned `todo:*` socket commands, which
 * its own server forwards at these same paths. Reading and marking need `todos.view`, writing
 * and deleting `todos.manage`.
 */

import { Router } from 'express';

import * as todoService from '../../services/todo.service.js';
import { asyncHandler } from '../async-handler.js';
import {
  actorFromRequest,
  requireAuth,
  requirePermissionMiddleware,
} from '../middleware/require-auth.js';

const needs = requirePermissionMiddleware;

export const todoRoutes: Router = Router();
todoRoutes.use(requireAuth);

todoRoutes.get(
  '/',
  needs('todos.view'),
  asyncHandler(async (req, res) => {
    res.json(await todoService.listTodos(actorFromRequest(req)));
  }),
);

todoRoutes.post(
  '/',
  needs('todos.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await todoService.createTodo(req.body ?? {}, actorFromRequest(req)));
  }),
);

todoRoutes.post(
  '/:id/mark',
  needs('todos.view'),
  asyncHandler(async (req, res) => {
    res.json(
      await todoService.markTodo(
        { ...(req.body ?? {}), id: String(req.params.id) },
        actorFromRequest(req),
      ),
    );
  }),
);

todoRoutes.delete(
  '/:id',
  needs('todos.manage'),
  asyncHandler(async (req, res) => {
    res.json(await todoService.deleteTodo(String(req.params.id), actorFromRequest(req)));
  }),
);
