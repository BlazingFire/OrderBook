#!/usr/bin/env node
/**
 * Party-visibility scenario for a SCRATCH Master (never a real one):
 * 3 admins, 5 office users, a few open parties and one party (and one pending
 * order) created by each user, through the Master's own HTTP API, so every
 * rule the real create path applies applies here too.
 *
 *   node tools/seed-party-scenario.mjs --port 4160
 *   node tools/seed-party-scenario.mjs --port 4160 --host 127.0.0.1
 *
 * Run it on the Master PC (setup and the Server Master sign-in are loopback
 * only). Safe to run twice: users, roles and parties are found by name first.
 * It prints usernames, never passwords. The passwords are the constants below;
 * they are for throwaway scratch databases only.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const host = flag('host', '127.0.0.1');
const port = Number(flag('port', ''));
if (!Number.isInteger(port) || port < 1) {
  console.error('usage: node tools/seed-party-scenario.mjs --port <master port> [--host 127.0.0.1]');
  process.exit(2);
}
const base = `http://${host}:${port}`;

// Scratch-only credentials. A user's password is its own username plus a suffix.
const MASTER = { username: 'master', displayName: 'Seed Master', password: 'Seed-master-pass-2026' };
const BACKUP = { username: 'master-backup', displayName: 'Seed Backup Master', password: 'Seed-backup-pass-2026' };
const passwordOf = (username) => `Seed-${username}-pass-2026`;

const ADMINS = ['seed-admin1', 'seed-admin2', 'seed-admin3'];
const OFFICE = ['seed-office1', 'seed-office2', 'seed-office3', 'seed-office4', 'seed-office5'];
const OPEN_PARTIES = ['Open Party Alpha', 'Open Party Beta', 'Open Party Gamma'];

const OFFICE_PERMISSIONS = [
  'parties.view', 'parties.create', 'parties.edit',
  'leads.view', 'leads.create', 'leads.edit',
  'orders.view', 'products.view', 'chat.use',
];
const ADMIN_PERMISSIONS = [
  ...OFFICE_PERMISSIONS,
  'orders.edit', 'leads.delete', 'parties.delete', 'party.accessAll', 'reports.view', 'users.manage',
];

/** One signed-in caller: keeps its own session cookie. */
class Caller {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async call(method, path, body) {
    const reply = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await reply.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!reply.ok) {
      const error = new Error(`${this.label} ${method} ${path} -> ${reply.status} ${data?.message ?? text}`);
      error.status = reply.status;
      throw error;
    }
    const setCookie = reply.headers.getSetCookie?.() ?? [];
    const session = setCookie.map((line) => line.split(';')[0]).find((pair) => pair.startsWith('orderbook_session='));
    if (session) this.cookie = session;
    return data;
  }

  signIn(username, password) {
    return this.call('POST', '/api/auth/sign-in', { username, password });
  }
}

async function main() {
  const anonymous = new Caller('setup');
  const status = await anonymous.call('GET', '/api/setup/status');
  if (!status.setupComplete) {
    await anonymous.call('POST', '/api/setup/initialize', {
      companyName: 'Party Visibility Scratch Co',
      accounts: [MASTER, BACKUP],
    });
    console.log('first-run setup done (scratch Master)');
  }

  const master = new Caller('master');
  await master.signIn(MASTER.username, MASTER.password);

  // Roles, found by name so a second run reuses them.
  const roles = await master.call('GET', '/api/access/roles');
  const ensureRole = async (name, tier, permissions) => {
    const found = roles.find((role) => role.name === name);
    if (found) return found.id;
    return (await master.call('POST', '/api/access/roles', { name, tier, permissions })).id;
  };
  const officeRole = await ensureRole('Seed Office', 'office', OFFICE_PERMISSIONS);
  const adminRole = await ensureRole('Seed Admin', 'admin', ADMIN_PERMISSIONS);

  // Users.
  const users = await master.call('GET', '/api/access/users');
  const ensureUser = async (username, roleId) => {
    if (users.some((user) => user.username === username)) return;
    await master.call('POST', '/api/access/users', {
      username,
      displayName: username,
      roleId,
      password: passwordOf(username),
    });
    console.log(`user ${username} created`);
  };
  for (const username of ADMINS) await ensureUser(username, adminRole);
  for (const username of OFFICE) await ensureUser(username, officeRole);

  // One product every pending order can use.
  const productPage = await master.call('GET', '/api/products?search=Seed%20Basin&limit=5');
  const product =
    productPage.items.find((item) => item.name === 'Seed Basin') ??
    (await master.call('POST', '/api/products', {
      name: 'Seed Basin',
      categoryName: 'Seed Products',
      hasVariants: false,
      variants: [{ code: 'SEED-0001' }],
    }));

  const partyNamed = async (caller, name) => {
    const page = await caller.call('GET', `/api/parties?search=${encodeURIComponent(name)}&limit=50`);
    return page.items.find((party) => party.name === name) ?? null;
  };
  const ensureParty = async (caller, name) =>
    (await partyNamed(caller, name)) ?? (await caller.call('POST', '/api/parties', { name, city: 'Morbi' }));

  // Open parties: made by the Server Master, who holds everything, so no restriction.
  for (const name of OPEN_PARTIES) await ensureParty(master, name);

  // One party and one pending order per user, made by that user.
  for (const username of [...ADMINS, ...OFFICE]) {
    const caller = new Caller(username);
    await caller.signIn(username, passwordOf(username));
    const party = await ensureParty(caller, `Party of ${username}`);
    try {
      await caller.call('POST', '/api/leads', {
        partyId: party.id,
        items: [{ productId: product.id, variantId: product.variants[0].id, quantity: 5, packaging: 'Box' }],
      });
    } catch (error) {
      console.warn(`lead for ${username} not created: ${error.message}`);
    }
  }

  console.log(
    [
      '',
      `scenario ready on ${base}`,
      `  admins : ${ADMINS.join(', ')}   (role Seed Admin, holds party.accessAll)`,
      `  office : ${OFFICE.join(', ')}   (role Seed Office: parties view/create/edit, leads, orders.view)`,
      `  master : ${MASTER.username} (loopback sign-in only)`,
      `  open parties: ${OPEN_PARTIES.join(', ')}`,
      '  each user also has "Party of <username>" and one pending order on it',
      '  passwords: the constants at the top of tools/seed-party-scenario.mjs',
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
