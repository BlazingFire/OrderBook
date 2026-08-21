/**
 * Opaque transaction token for work that must commit or roll back together
 * across repositories (e.g. a status change plus its stock movements).
 *
 * Services receive and pass this token without inspecting it; only the
 * repositories know it is a Knex transaction. This keeps the query builder an
 * implementation detail of the repository layer instead of part of every
 * service signature.
 */

import type { Knex } from 'knex';

export type TransactionContext = Knex.Transaction;
