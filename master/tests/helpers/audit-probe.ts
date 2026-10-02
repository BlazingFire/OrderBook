/**
 * Forces every insert into `activity_log` to fail, for the suites that prove
 * an audited write rolls back with its entry. A trigger rather than a stub:
 * the property is about the database transaction, and a stub would pass
 * whichever connection the real insert went out on.
 */

import { db } from '../../src/db/knex.js';

/**
 * Every insert into `activity_log` fails from here until `acceptAuditEntries`.
 * Given an action, only entries with that action fail, so a test can refuse
 * the one closing entry and prove it really is the last statement.
 */
export async function refuseAuditEntries(action?: string): Promise<void> {
  const when = action === undefined ? '' : `WHEN (NEW.action = '${action.replace(/'/g, "''")}')`;
  await db().raw(`
    CREATE OR REPLACE FUNCTION audit_probe_refuse() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit probe: refused';
    END $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS audit_probe_refuse ON activity_log;
    CREATE TRIGGER audit_probe_refuse BEFORE INSERT ON activity_log
      FOR EACH ROW ${when} EXECUTE FUNCTION audit_probe_refuse();
  `);
}

export async function acceptAuditEntries(): Promise<void> {
  await db().raw('DROP TRIGGER IF EXISTS audit_probe_refuse ON activity_log');
}
