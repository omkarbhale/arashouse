# The broker

`arashouse-broker` is the Windows-side admin service (`ArasHouseBroker`; `arashouse setup` installs it, ticket 21).
Everything the CLI does on Windows goes through it, as one request and one response per host-driver call.
The CLI side is `BrokerHost` (`src/host/broker-host.ts`), which implements the host-driver contract
(`docs/host-driver.md`).

```
WSL                                    Windows
arashouse ── BrokerHost ── spawn ──▶ node.exe <root>\broker\app\broker\client.js
                 ▲  stdout (JSON)        │ + token from <root>\broker\client.token
                 └───────────────────────┤
                                         ▼ \\.\pipe\arashouse-broker
                                     arashouse-broker (service): guards ─▶ verb ─▶ audit line
```

## Verbs

The verb list is the host-driver method list (`HOST_METHODS`); there is no verb that runs a command, SQL
or a path the client chose. A request names its target as a slot record `{ flavor, slot }` or a flavor.
The broker derives every name and path from it and runs the guards (`assertSlotOwned` or
`assertFlavorOwned`, `src/host/owned.ts`) before the verb runs. `BrokerHost` runs the same guards on the
WSL side first, so a refused name is never sent.

| verb | target | what it does | ticket |
|---|---|---|---|
| `ping` | none | answers with the broker's version | 20 |
| `hostInfo` | none | OS, free RAM, free disk at the root, broker version, whether the broker's SQL login connects, and that login's name, `sysadmin` and `dbcreator` membership and how many `arashouse_admin` procedures it may execute | 20, 22 |
| `readStamp` | slot | reads `<slot folder>\.arashouse-slot.json`; a slot with no folder is `Refused`, an unusable stamp `Quarantine` | 20 |
| `listSlots` | none | every `slots\<key>\<NN>` folder whose name is the tool's and that is not a junction, with its stamp | 20 |
| `provisionSlot` | slot | makes the slot from its flavor's golden: folders, IIS application and pools, agent, database and logins, rendered configs, stamp; refuses a slot with a stamp; a failure is rolled back (`docs/provision.md`) | 25 |
| `destroySlot` | slot | removes everything the slot's names derive (stopped first), and fails while anything is left | 25 |
| `quiesce` | slot | stops the slot's pools and agent and waits, bounded, for its processes to end; `Retryable` when anything still runs (`docs/reset.md`) | 30 |
| `resetTree` | slot | on a quiesced slot, to the golden manifest hash in `args.hash`: the mirror, the runtime state cleared, the configs rendered, the `fast` verify (a mismatch is `Quarantine`), then a fresh stamp (`docs/reset.md`) | 30 |
| `writeStamp` | slot | writes `args.stamp` to `<slot folder>\.arashouse-slot.json`; a stamp of another slot, or a slot with no folder, is `Refused` | 30 |
| `resetDatabase` | slot | restores the golden's `db\ootb.bak` (`args.file`, which must be that file) over the slot database as its owner, after `kill_connections`, and once more on 3101; then `MULTI_USER`, the two users mapped again and the marker (`args.hash`, which must be the golden's manifest hash now) written; a slot without a database is `Refused`, a marker or version that does not read back `Quarantine` (`docs/reset-database.md`) | 31 |
| `healthCheck` | slot | | 32 |
| `startSlot` | slot | starts the slot's pools, its agent service only with `args.agent` (`Refused` when the slot has none), then warms three URLs; `ok: false` when one does not answer (`docs/start-stop.md`) | 33 |
| `stopSlot` | slot | stops the slot's agent, then its pools, and waits for its worker processes to end; the reset's quiesce (`docs/start-stop.md`) | 33 |
| `setLeaseCredentials` | slot | `args.password` (the lease's, 16 to 128 URL-safe characters) for `root` and `admin`: an OAuth login as `root` with the slot's stored random password (`slot-<key>-<NN>-root`), an AML `edit` of both `User` items, a login with the new password, then the stored one deleted; no stored password is `Retryable`, a refusal by the server `Quarantine` (`docs/lease-credentials.md`) | 34 |
| `restoreDatabase`, `deployCode`, `backupDatabase` | slot | | 39, 40, 43 |
| `baselineVerify` | flavor | checks `golden\<key>` against its manifest at `args.level` (`golden`, the default; `fast`; `full`): `ok`, `level`, the diff (counts and paths only) and `goldenHash` (the manifest hash a reset mirrors to); "not built" when there is no manifest | 28, 24, 30 |
| `baselineBuild` | flavor | never served: the build runs in the captain's elevated session, since the broker's SQL login may not create its database (`docs/baselines.md`); `BrokerHost` refuses it without asking | 24 |

The broker answers a verb it does not have `Refused`. Until a verb's ticket lands, `BrokerHost` fails that
method `Unreachable` naming the ticket, without asking the broker, so a reset leaves the slot dirty instead
of quarantining it. A ticket that adds a verb registers it in `src/broker/` the way `registerCoreVerbs`
(`src/broker/verbs.ts`) does, and replaces the pending method in `BrokerHost`.

## Protocol

`src/broker/protocol.ts`. One JSON line each way, then the connection ends.

- Request (stdin of the client): `{ "id", "verb", "slot"? | "flavor"?, "args"? }`. `id` is 1 to 64
  letters, digits or `-` (BrokerHost sends a UUID). Any other field is refused. `args` is a verb's own
  object; a verb that takes none refuses any.
- On the pipe the client wraps it: `{ "v": 1, "token", "request" }`.
- Response: `{ "id", "ok": true, "result": { "ok", "detail", ... } }` or
  `{ "id", "ok": false, "error": { "kind", "message" } }`, `kind` one of the host-error kinds. `ms` is not
  sent: `BrokerHost` measures the round trip on its own clock.
- Limits: a request line of 64 KiB, a response line of 1 MiB; the broker drops a connection that has not
  sent its line within 5 s; each verb has a time bound (`VERB_TIMEOUT_MS`: `ping` 5 s, `readStamp` 10 s,
  `hostInfo` and `listSlots` 20 s, `baselineVerify` 30 minutes (for `full`), `provisionSlot`, `destroySlot` and `resetTree` 30 minutes, `quiesce`, `resetDatabase` and `setLeaseCredentials` 10 minutes, otherwise 30 s) past which it is answered `Retryable`. The client waits
  the bound plus 5 s, and `BrokerHost` the bound plus 10 s, killing the client after that.

| failure | kind |
|---|---|
| a guard refuses, a malformed request, a verb the broker does not have, a missing or wrong token | `Refused` |
| the verb throws a `HostError` | its own kind |
| the verb throws anything else, or overruns its bound | `Retryable` (message redacted) |
| the pipe is not there, or the client or broker does not answer in time, or answers something that is not a response | `Unreachable` (exit code 6; the message ends with the hint to run `arashouse doctor`) |

The client (`src/broker/client.ts`) exits 0 when the broker answered (even with an error), 6 when it could
not reach it (it still prints an `Unreachable` response, and the hint on stderr), and 2 when the request on
its stdin was unusable.

## Transport, and why

Measured from WSL to the Windows Node v24.13.0, 20 runs each, wall time including process start.
Ticket 09 (the spike record) measured the options; this ticket measured the built client.

| call | median | p90 | range |
|---|---|---|---|
| `node.exe` started directly through interop, empty script (09) | 92 ms | 105 | 75–115 |
| `cmd.exe /c node.exe`, empty script (09) | 147 ms | 160 | 131–174 |
| `powershell.exe -Command`, empty script (09) | 446 ms | 484 | 379–489 |
| named-pipe ping through an inline Windows Node client (09) | 191 ms | 199 | 164–200 |
| **`ping` through `client.js` to a broker built from this code** (2026-10-27) | **257 ms** | 283 | 227–287 |
| `BrokerHost.hostInfo()` from WSL, one call | 923 ms | | (of which the PowerShell SQL probe is about 0.67 s) |

So: a named pipe, and the client is `node.exe` started directly (not through `cmd.exe` or PowerShell). The
built client costs about 65 ms more than ticket 09's inline one because it loads its modules from disk; every
call stays well under a second. The client answers on stdout because a Windows process cannot write to a
`\\wsl.localhost\` path. Loopback TCP to the WSL gateway was the second choice and is not used: it would
need a firewall rule and the same token story.

## Who may talk to the pipe

The plan was a pipe DACL naming only the worker user and SYSTEM. Node cannot set that: a Node pipe server
gets the default named-pipe DACL, and its only option (`readableAll`/`writableAll`) adds an ACE for Everyone.
Measured on the host with a throw-away pipe (`NamedPipeClientStream.GetAccessControl()`):

| server | DACL (SDDL) |
|---|---|
| default | `(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)`: Everyone and Anonymous read only |
| `writableAll: true` | `(A;;0x12019f;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)`: Everyone read and write |

The worker runs with a filtered token (`BUILTIN\Administrators` deny-only), so the default DACL would let
it read but not write. The broker therefore opens the pipe with `writableAll` and requires a token:

- At each start the broker makes 32 random bytes and writes them to `<root>\broker\client.token`. Ticket 21
  gives `<root>\broker\` an ACL of SYSTEM and the broker account (modify) and the worker user (read). The
  worker user can read the code under `<root>\broker\app\` but never change it, since the service runs it.
- The client, running as the worker user on Windows, reads the token and puts it in the envelope. The broker
  compares it in constant time (`src/broker/token.ts`) and refuses anything else, auditing it as
  `unauthorised`. The token never crosses to WSL, an argument list or a log, and it is a `Secret`
  (`broker-token`), so `redact` replaces it wherever it would appear.
- So exactly the principals the planned DACL named (the worker user and SYSTEM), plus the broker itself, can
  make a request. Another local user, or a remote SMB client that the Everyone ACE would admit, cannot read
  the token. A token that leaked would be good only until the broker restarts.

## Audit log

`<root>\logs\broker-YYYYMMDD.log` (UTC day), one JSON line per request, these fields only:
`{ time, id, verb, target, outcome, ms }`. `target` is the slot id or flavor; `outcome` is `ok`, `not-ok`
(the verb answered `ok: false`), a host-error kind, `unauthorised` or `malformed`. No arguments, messages
or tokens are written, and the fields are taken from the validated request only (a malformed request is
logged with `id`, `verb` and `target` null). Each line still goes through `redact`. A line that cannot be
written does not stop the answer; the service reports it on stderr.

## SQL

TCP is off on the host's SQL Server, and turning it on would restart the service the captain's other
databases use. So the broker reaches SQL through PowerShell and `System.Data.SqlClient` on shared memory
(`Data Source=lpc:.`) with Windows authentication as its own account (`src/broker/sql-probe.ts`). It never opens
a TCP port to SQL. `hostInfo` runs one fixed query against `master` that reads the login itself: its name,
`IS_SRVROLEMEMBER('sysadmin')` and `('dbcreator')`, and `HAS_PERMS_BY_NAME` on each `arashouse_admin`
procedure. `arashouse doctor` fails a login in either role (`sql login`).

Its login is `[NT SERVICE\ArasHouseBroker]`, created by `arashouse setup-sql` (ticket 22, `docs/setup-sql.md`)
in no server role. It owns the slot databases it creates, so it restores them itself; creating and dropping a
slot database or login, and ending a session that blocks a restore, go through the signed, name-checked
procedures in `arashouse_admin`. A slot database it restores is its own inside too only because the golden's
`ootb.bak` was taken with the broker as its owner (`docs/provision.md`). **The broker keeps no `sa` credential** (map question Q2): `sa` is rejected on
this host, setup runs under the captain's Windows login, and the `--keep-sa` option the plan offered is not built.

## Running it

`index.ts` runs only on Windows. It vets the root (`C:\aras_installations`), writes the token, registers the
verbs and serves the pipe until it is stopped. `arashouse setup` installs it (ticket 21, `docs/setup.md`): the
built `dist\` copied to `<root>\broker\app\` and `package.json` to `<root>\broker\` (where `dist\`'s modules
find it, as in the repo), a small service wrapper `<root>\broker\ArasHouseBroker.exe` that runs
`node.exe <root>\broker\app\broker\index.js`, the service `ArasHouseBroker` as the virtual account
`NT SERVICE\ArasHouseBroker` (a member of Administrators, restarted on failure), and the ACLs above. The wrapper
replaces the planned `node-windows` install, which names its service `<name>.exe` and so could not give the
service the virtual account `NT SERVICE\ArasHouseBroker`. The tests run the same code on Linux: the broker
on a Unix socket, its disk mapped to a temporary folder (`src/broker/*.test.ts`, `src/host/broker-host.test.ts`).
