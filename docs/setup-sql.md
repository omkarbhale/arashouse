# SQL Server setup: `arashouse setup-sql`

Ticket 22. The one-time preparation of the host's SQL Server: the broker's login, the utility database
`arashouse_admin` and its five name-checked procedures. Ticket 21 (`docs/setup.md`) must have run first: the
broker's Windows account and `<root>\sqldata\` have to exist.

**No `sa`.** The plan was to prompt for the `sa` password. Spike 05 found `sa` rejected on this host (ticket 09),
and the captain's stated fallback is Windows authentication as their own login. So the script connects with the
Windows login of whoever runs it, which must be a SQL Server `sysadmin`, and nobody types, stores or passes a
password. Map question Q2 (does the broker keep `sa`?) is moot: there is nothing to keep, and `--keep-sa` is not
built. Measured on 2026-10-27: the captain's login `SG\omkarb` is a `sysadmin` by an explicit login, so it is a
`sysadmin` from a non-elevated shell too. The script needs no elevation, only that login. No group (such as
`BUILTIN\Administrators`) has a login on the instance, so the broker's membership of Administrators gives it nothing
in SQL Server.

## Running it

1. From WSL, in the arashouse checkout, after `npm run build`:

   ```
   node dist/cli/index.js setup-sql            # or `arashouse setup-sql`; --out <dir> writes elsewhere
   ```

   It writes `setup-sql.ps1` to `%TEMP%\arashouse-setup-sql\` on Windows and prints the commands below.
2. In Windows PowerShell, as the captain (or another Windows user whose login is a `sysadmin`):

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "<dir>\setup-sql.ps1"                    # the facts and the plan
   powershell -NoProfile -ExecutionPolicy Bypass -File "<dir>\setup-sql.ps1" -Apply             # make the changes, then check them
   powershell -NoProfile -ExecutionPolicy Bypass -File "<dir>\setup-sql.ps1" -Apply -SelfTest   # ... and a round trip as the broker
   ```

3. From WSL: `arashouse doctor`. The `sql` and `sql login` checks should pass. `sql login` needs a broker built
   from ticket 22 or later (`setup-host.ps1 -UpdateBroker`, `docs/setup.md`): an older broker does not report its
   login's roles, and the check warns.

The script connects to the default instance by shared memory (`Data Source=lpc:.`, since TCP is off on the host)
with Windows authentication and `Pooling=False`, so it leaves no pooled session behind to block a later restore
(spike 06). It is idempotent: a second run changes only what differs, and repairs a procedure whose text or
signature changed.

- **Dry run by default.** Without `-Apply` it prints the facts, each change as `would do:`, and runs the checks
  only when everything is already in place. With `-Apply` each change is printed as `do:` and then made.
- **Last, `result:` and the result as JSON**: the facts, what it found, the checks, the changes and the errors.
  No secret is in it.
- **Exit codes:** 0 ok; 1 a step or a check failed; 3 it cannot connect to SQL Server; 4 the login is not
  `sysadmin`.

## The facts it prints

The SQL Server version, level and edition; whether SQL logins work (mixed mode); whether the `sa` login is enabled
(it is not used); the SQL Server service account; the default data folder; the login it connected as and whether
that is `sysadmin`; and the databases named `arashouse_*`. It lists no other database: `sys.databases` is read
only with `LIKE 'arashouse[_]%'`, or for one name the script owns.

On this host (2026-10-27): SQL Server 15.0.2190.7 RTM, Developer Edition (64-bit), mixed mode, service account
`NT Service\MSSQLSERVER`, default data folder under `C:\Program Files\Microsoft SQL Server\` (which the slots never
use: their files go to `<root>\sqldata\`). Three databases named `arashouse_pp_*` were already there; they are not
the pool's, and the procedures' allowlist does not admit their names.

## What it creates

| object | where | what it is |
|---|---|---|
| login `[NT SERVICE\ArasHouseBroker]` | server | The broker's login: its Windows virtual account, by Windows authentication, so no SQL password exists for it. **In no server role** and holding no server permission but `CONNECT SQL`. |
| database `arashouse_admin` | `<root>\sqldata\arashouse_admin.mdf`, `_log.ldf` | The utility database. `TRUSTWORTHY OFF`, `DB_CHAINING OFF`, `AUTO_CLOSE OFF`, simple recovery. Owned by the login that ran the script. |
| user `arashouse_pool` | `arashouse_admin` | The broker login's user. It may `EXECUTE` the five procedures and nothing else (no role, no other permission). |
| the five procedures | `arashouse_admin.dbo` | Below. Each is signed with the certificate. |
| certificate `arashouse_admin_signer` | `arashouse_admin` | Signs the procedures. Its private key is removed once they are signed, so no new code can be signed with it. |
| certificate `arashouse_admin_signer` | `master` | The same certificate's public part. |
| login `arashouse_admin_signer` | server | Made from the certificate, so nobody can log in as it. It holds `CREATE ANY DATABASE`, `ALTER ANY CONNECTION`, `ALTER ANY LOGIN` and `VIEW SERVER STATE`, and those reach only code signed with the certificate: the five procedures. |

The ticket names the pool login `arashouse_pool`. A Windows login cannot be given another name, so the login is the
broker's account and `arashouse_pool` is its user in `arashouse_admin`.

**Why signing, not `EXECUTE AS OWNER`.** An `EXECUTE AS OWNER` procedure in a `TRUSTWORTHY` database owned by a
`sysadmin` would let anyone who can change that database act as `sysadmin`. A signature carries only the
certificate login's four rights, only into the signed procedures (and their dynamic SQL), and with the private key
gone the set of signed code cannot grow. Spike 06 had not proved either route; the rehearsal below proves this one.

**A reset needs none of it.** The broker's login owns each slot database it creates, and an owner restores its
own database `WITH REPLACE` with no server role and stays its owner (spike 06). So ticket 31's reset is a plain
restore by the broker; it calls `kill_connections` only when another session blocks it (`3101`).

## The procedures

| procedure | arguments | does | returns | rights used |
|---|---|---|---|---|
| `create_slot_database` | `@database` | Creates an empty slot database with its files at `<root>\sqldata\<database>.mdf` and `<database>_log.ldf` (`databaseFiles()` in `names.ts`), `AUTO_CLOSE OFF`, owned by the broker's login. Nothing when the broker already owns it. | 1 created, 0 already there | `CREATE ANY DATABASE` |
| `drop_slot_database` | `@database` | Ends the sessions in a slot database the broker owns and drops it. Nothing when there is none. | 1 dropped, 0 absent | `ALTER ANY CONNECTION`, `VIEW SERVER STATE` |
| `kill_connections` | `@database` | Ends every other user session in a slot database the broker owns: those whose database it is and those holding a lock on it. | how many | `ALTER ANY CONNECTION`, `VIEW SERVER STATE` |
| `create_slot_login` | `@login`, `@password` | Creates a slot's SQL login (`CHECK_POLICY` and `CHECK_EXPIRATION` off, default database `master`), or sets the password of the existing one and enables it. | 1 created, 0 password set | `ALTER ANY LOGIN` |
| `drop_slot_login` | `@login` | Ends a slot login's sessions and drops it. Nothing when there is none. | 1 dropped, 0 absent | `ALTER ANY LOGIN`, `ALTER ANY CONNECTION` |

Every procedure first checks its name against the allowlist and refuses anything else with error **50001**, before
it reads the catalog or builds anything:

- a database must be `arashouse_<key>_<NN>` and a login `arashouse_<key>_<NN>_dbo` or `_reg`, for a registered
  flavor key and a slot from `01` to `99`. The patterns are generated from `names.ts` (`databasePatterns()`,
  `loginPatterns()`), one per flavor and role, and compared in a binary collation (so only ASCII digits and lower
  case match), with no trailing space (which `LIKE` would ignore) and not slot `00`. `arashouse_admin`,
  `arashouse_build_<key>`, the captain's databases and every other name are refused.
- then it acts only on what is the pool's: a database the broker's login owns (else **50002**), a login that is a
  plain SQL login in no server role (else **50002**). `kill_connections` on a database that does not exist is
  **50003**; a missing broker login **50004**; a slot login's password under 16 characters **50005**.
- dynamic SQL is built only from a checked name through `QUOTENAME`, from that name inside the fixed
  `<root>\sqldata\` path, from a session id, or from the password with its quotes doubled. `setup-sql.test.ts`
  checks each of these in the generated text.

The procedures take no backup path: a restore is the broker's own (owner restore), and ticket 31's broker verb
checks that a backup is under `golden\` or `staging\`.

## The checks

After `-Apply` (or in a dry run when everything is in place) the script checks, each on a connection of its own as
the broker's login (`EXECUTE AS LOGIN`, which only a `sysadmin` can do; so this is the worker-run negative test
when the worker's login is a `sysadmin`, as on this host):

1. **The login's roles and rights.** Not in `sysadmin`, `dbcreator` or `securityadmin`; no `CONTROL SERVER`; none
   of the certificate login's four rights of its own; may execute all five procedures. A role membership or an
   extra server permission found on the login is reported as an error and not removed: the captain takes it out.
2. **The refusals.** Each procedure called with each made-up name (13 database names and 10 login names: wrong
   flavor, slot `00`, one or three digits, upper case, a leading or trailing space, a quote or bracket injection,
   `arashouse_admin`, the empty string, ...): all 59 calls must fail with 50001. Then a direct `RESTORE DATABASE`
   and `CREATE DATABASE` of the made-up `arashouse_negative_madeup` must fail too (the login lacks
   `CREATE DATABASE`: 262), and none of the made-up names may exist afterwards. Nothing that exists is named.
3. **`-SelfTest`, a round trip** on the throw-away `arashouse_35_99` (the last flavor's slot 99, which no pool
   uses), only when it and its login are absent: create it (1), create it again (0), check its owner is the
   broker's login and its data file is under `sqldata\`, end a `sysadmin` session opened in it (1; the case spike
   06's owner could not clear, `5061`), create its `_dbo` login (1), set its password (0), drop the login (1),
   drop the database (1), drop it again (0). Whatever happens, the two throw-away names are removed at the end.

`arashouse doctor` then reads the same facts live, from the broker's own token: the broker's `hostInfo` reports its
login, whether it is in `sysadmin` or `dbcreator` (through a group too), and how many of the procedures it may
execute (`src/broker/sql-probe.ts`).

## Secrets

None is typed, read or stored. The certificate's private key needs a password while the procedures are signed: the
script makes 32 random bytes for it, hands them to SQL Server only as a parameter (never in a command's text, an
argument list or the output), and the key is then removed, so the password protects nothing afterwards. The
self-test's throw-away login gets a password made the same way. A slot login's password (ticket 25) reaches
`create_slot_login` as a parameter. Any error text is searched for the run's secrets and they are replaced with
`[redacted]` before it is printed.

## Rehearsed on LocalDB (2026-10-27)

Before it ran on the host, the whole script ran against a throw-away LocalDB instance of the worker's own (SQL
Server 2025 Express 17.0.4025.3), with a scratch root, never the host's instance: `-Apply -SelfTest` from nothing,
then again (nothing to change), then with one procedure altered (rebuilt and re-signed), then with the broker's
login put in `dbcreator` (the run failed, as it must). `test/setup-sql.test.ts` repeats the first two with
`ARASHOUSE_TEST_LOCALDB=1` (about 10 s); by default it only parses the script.

One finding: on Express, where a new database has `AUTO_CLOSE ON`, a `DROP DATABASE` by the impersonated owner
after any `CREATE LOGIN` failed with the fatal error 615. With `AUTO_CLOSE OFF` it works, so
`create_slot_database` and the script turn it off. The host's `model` already has it off.

## Installed on the host

Pending: the `-Apply -SelfTest` run on the host's instance, and `arashouse doctor` read back from WSL.

## Not here

Using the procedures: provisioning (ticket 25), the reset's restore and fix-ups (ticket 31). The baseline build's
database `arashouse_build_<key>` (ticket 24) is created in the captain's own session, not through these procedures.
Removing these objects is ticket 49's `teardown`.
