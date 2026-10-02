# The master key

The owner's own secret for the **Server Master** tier (1.3). It is asked for only on
the Master PC, and it protects the operations that could otherwise lock the owner out
of their own installation.

The plaintext appears nowhere in the repository. The source carries an scrypt
hash of it (`MASTER_KEY_HASH` in `shared/src/domain/master-key.ts`), made with the same
parameters as every password hash (`master/src/lib/password.ts`). No test, comment or
log holds the plaintext: tests swap in a gate built from a hash of their own.

## The key

The key itself is **not stored in the repository**. The owner chose it on 2026-10-01 and
keeps it. The source holds only its scrypt hash (`MASTER_KEY_HASH`), and on 2026-10-03
`verifyPassword` confirmed that the hash matches the owner's key. Recording the
plaintext in a tracked file was left out on purpose: this repository is pushed to
GitHub. Keep the key wherever the owner keeps other site secrets.

There is **no `.env` override**, unlike the developer password
(`docs/DEVELOPER_MODE.md`). A deployment cannot change the key, and the only way to a
different key is a new build with a new hash.

## What it gates

| Operation | Where | What else is required |
|---|---|---|
| Setting up the missing Server Master accounts on an older installation | Master PC sign-in screen, before anyone signs in | Master PC (loopback) |
| Resetting a forgotten Server Master password ("Forgot Server Master password?") | Master PC sign-in screen | Master PC |
| Changing the pairing password | Settings → Connection | A signed-in Server Master, Master PC |
| A Server Master changing their own password | Change password dialog | Signed in as that Server Master |
| Creating a Server Master; changing a Server Master's username, active state or role; moving someone onto the Server Master role; deleting or resetting a Server Master | Roles & users | A signed-in Server Master (tier rank rules out everyone else) |

A display-name edit, an avatar change or a re-save of unchanged fields needs no key.
The server decides which changes need it (`master/src/services/user.service.ts`); the
Roles & users screen asks for the key only when the server answers
`error.unauthorized.masterKeyRequired`, then repeats the call with the token.

What it does **not** gate: the Master ID. It is not changeable at all, because every
paired panel stores it and changing it would orphan every pairing.

## How it works

1. The screen posts the typed key to `POST /api/master-key/verify` (Master PC only).
2. A correct key returns a token that lives **5 minutes**
   (`MASTER_KEY_TOKEN_TTL_MS`). It is held in the Master's memory and in the screen's
   state, never on disk.
3. The guarded call sends the token in the `x-master-key-token` header.

Every attempt is in the activity log: `master_key.verified` and `master_key.failed`,
written detached so a refused attempt is recorded too. Before anyone signs in, the
actor is shown as "Master PC".

### Lockout

Five wrong keys in a row lock the gate for **60 seconds**, the same rule as developer
mode (`DEVELOPER_UNLOCK_MAX_FAILURES`, `DEVELOPER_UNLOCK_LOCKOUT_MS`). During the
lockout every attempt, right or wrong, answers 429 with the seconds left. The counter
is per Master process. It is a separate gate from developer mode: locking one does not
lock the other.

## Recovery on the Master PC

When a Server Master password is forgotten:

1. On the **Master PC**, open the panel (the desktop app, or a browser at
   `localhost`). A browser on another PC is not offered this.
2. On the sign-in screen, choose **Forgot Server Master password?**
3. Enter the master key.
4. Pick the Server Master and type the new password twice (at least 8 characters).
5. Sign in with the new password.

Only the password changes, never the username. The reset also lifts that username's
sign-in lockout and ends any session it still had. It is logged as
`user.password_recovered`.

If **both** Server Master passwords are forgotten **and** the master key is lost, the
product cannot recover the Server Master accounts. Normal Admin accounts keep working
regardless, but nothing in the product can create a Server Master without the key.
What is left is developer mode's erase (`docs/DEVELOPER_MODE.md`) or direct database
access.

## The upgrade flow

An installation set up before 1.3, or restored from a backup made before it, has fewer
than two active Server Masters. `GET /api/setup/status` then reports
`serverMasterSetupNeeded: true`, and on the Master PC the sign-in screen shows
**Set up Server Master accounts** first, with no way to skip it: the master key, then
exactly the missing accounts (suggested `master` and `master-backup`). LAN browsers and
Office panels keep signing in as before while it is pending. It is logged as
`user.server_masters_set_up`.

## Security, stated honestly

The master key is a **shared secret for the whole product**, like the developer
password: every installation has the same one. What keeps it safe is where it can be
used, not that it is unique:

- Every route that takes it is **loopback-only** (`requireLoopback`). A PC on the shop
  LAN gets 403 before the key is even read.
- Server Master accounts themselves sign in only on the Master PC, and an Office never
  caches their credentials, so a stolen Server Master password is useless from a
  shop-floor PC.
- Whoever can sit at the Master PC can already do a great deal (stop the service, copy
  the data folder). The key adds a step to the operations that could lock the owner
  out; it is not meant to stop someone who already controls that machine and has read
  this file.

Keep this file somewhere staff cannot read it.
