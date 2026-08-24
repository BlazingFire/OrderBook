/**
 * `AppError.message` is DERIVED from the English catalogue
 * (`docs/backend-modules/09-I18N.md` §7, Option A) — proving it here is what
 * keeps existing integration tests' English assertions byte-identical without
 * having to re-type the same sentence in two places. Pure: constructing an
 * error touches no I/O.
 */

import { describe, expect, it } from 'vitest';

import { t } from '@orderbook/shared';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TenantViolationError,
  UnauthorizedError,
  ValidationError,
} from '../src/lib/errors.js';

describe('every AppError subclass derives .message from its messageKey', () => {
  it('AppError (direct)', () => {
    const error = new AppError('error.internal.panelNoTenant', {}, 500, 'internal');
    expect(error.message).toBe(t('en', 'error.internal.panelNoTenant'));
  });

  it('ValidationError with params', () => {
    const error = new ValidationError('validation.lead.quantityRequired', { productName: 'Basin' });
    expect(error.message).toBe(t('en', 'validation.lead.quantityRequired', { productName: 'Basin' }));
    expect(error.message).toBe('Add a quantity for Basin');
  });

  it('NotFoundError', () => {
    const error = new NotFoundError('Order');
    expect(error.message).toBe('Order not found');
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('not_found');
  });

  it('ForbiddenError carries the permission in both the message and details', () => {
    const error = new ForbiddenError('leads.create');
    expect(error.message).toBe('Missing permission: leads.create');
    expect(error.details).toEqual({ permission: 'leads.create' });
    expect(error.permission).toBe('leads.create');
  });

  it('UnauthorizedError defaults to the generic token when no messageKey is given', () => {
    const error = new UnauthorizedError();
    expect(error.messageKey).toBe('error.unauthorized');
    expect(error.message).toBe('Not signed in');
  });

  it('UnauthorizedError with an explicit token', () => {
    const error = new UnauthorizedError('error.unauthorized.accountDeactivated');
    expect(error.message).toBe('This account has been deactivated');
  });

  it('ConflictError with params', () => {
    const error = new ConflictError('error.conflict.productCodeTaken', { productCode: 'B-100' });
    expect(error.message).toBe('Product code "B-100" is already in use');
    expect(error.statusCode).toBe(409);
  });

  it('TenantViolationError', () => {
    const error = new TenantViolationError('Role');
    expect(error.message).toBe('Role does not belong to this company');
    expect(error.statusCode).toBe(403);
  });

  it('every subclass sets .name to its own class name, not "AppError"', () => {
    expect(new ValidationError('validation.role.nameRequired').name).toBe('ValidationError');
    expect(new NotFoundError('X').name).toBe('NotFoundError');
  });
});
