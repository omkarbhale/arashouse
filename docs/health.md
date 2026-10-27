# The health check and dirty detection

Ticket 32. The last steps of a reset, and the check that decides whether a slot may be handed out. The captain:

> "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned up."

So `get` never trusts the state alone: a free slot is handed out only when what the host holds agrees with it.

## The end of a reset

The reset's last two steps (`docs/reset.md`): `start` starts the slot's pools (the quiesce left them stopped; the agent only
for `get --agent`, ticket 33) and warms `Client/`, `Server/DBList.aspx` and the OAuth discovery document with a 2-minute
bound (a cold start took up to 41 s); then `health` runs `healthCheck` and reads the stamp. A failed check is tried once
more, then quarantines the slot with the failed checks named.

## `healthCheck(slot)` on the broker

`src/broker/health.ts`, under the slot's lock (it sets a password). No arguments: everything is derived from the slot
record. Each check is named in the result, with its milliseconds; `ok` only when all pass.

| check | passes when |
|---|---|
| `stamp` | `.arashouse-slot.json` is readable, carries the flavor's golden manifest hash **now**, a reset time, and no lease |
| `client` | `http://localhost/<alias>/Client/` answers 200 to 399 |
| `dblist` | `Server/DBList.aspx` answers 200 and lists exactly the slot's one database |
| `oauth` | `OAuthServer/.well-known/openid-configuration` answers 200 |
| `tree` | the `fast` manifest verify of the slot tree against golden (`docs/manifest.md`), the eight rendered files required present, the stamp left out |
| `configs` | each edit of the edit list holds in the slot's files (`verifyFile`, `docs/edits.md`), with the slot's names, its stored SQL login passwords and the stored licence |
| `marker` | the database carries `arashouse.golden_hash` equal to the stamp's golden hash, and an `arashouse.reset_at` time (one `slot-steps.ps1 -Step read-database` process, read only) |
| `version` | the `innovator.VARIABLE` rows `VersionMajor` and `VersionBuild` are the flavor's server build (`12.0.0.24090`: 12 and 24090) |
| `login` | `root` logs in with a one-time password (below) |

The HTTP, file and database checks run together, so a cold start overlaps the verify; the login runs after them, and not
at all when the server does not answer. The result also carries the marker as read (`{ goldenHash, resetAt }`, or null
when the database is missing), which `get` compares with the state.

A provision writes the marker too (the `database` step, after its restore), so a freshly provisioned slot passes, and
`arashouse provision` admits it `free`.

### The one-time password

After a restore, `root` and `admin` have the golden backup's password. SQL cannot change it (spike 06: an MD5 written into
`[USER].password` was refused); the IOM clients' route works: an AML `edit` of the User through the slot's own server,
logged in as `root`, through ticket 34's `ArasHttp` (`src/broker/aras-http.ts`, the same calls `setLeaseCredentials` makes). So
the `login` check:

1. logs in as `root` (an OAuth password grant on `http://localhost/<alias>/OAuthServer/connect/token`) with the free
   slot's stored password `slot-<key>-<NN>-root`, or failing that with the golden backup's `ootb-root-<key>`, both from
   the host's store;
2. makes a new password (128 random bits, 32 hex characters), stores it as `slot-<key>-<NN>-root` first, then sets it for
   `admin` and `root` (`setPasswords`, logged in as `root` with the password that worked);
3. logs in as `root` with it, and checks that the golden backup's password is now refused.

So a free slot's `root` and `admin` passwords are random and known only to the host's store, and every health check
changes them. Ticket 34's lease credentials log in with the stored one, set the lease's password and delete it; the next
reset restores the golden database, and its health check starts again from the golden backup's password. The check never runs on a stamp that names a
lease, so it cannot change a leaseholder's password. A destroy deletes the stored password.

**Without a licence.** A slot logs in only when its rendered `InnovatorServerConfig.xml` carries the licence of its line
(spike record, section 2: a blank key answers "Missing lic_key directive"). While no key is stored for the line
(`licence-12`, `licence-14`), no slot of it renders one and its server refuses every login, with any password; the check
then passes as `not checked: no licence key is stored for line 12, ...` rather than logging in. Once a key is stored,
every login check runs, and it fails (and quarantines) when neither password works. Storing the whole `<License>`
element and the golden backup's `root` password is left to tickets 34b and 35; nothing stores either yet.

## Dirty detection in `get`

`checkClean` (`src/core/lease.ts`) runs before a free slot is reserved. It refuses the slot unless:

- the slot was reset from the flavor's golden now (the state's `golden_hash`);
- the stamp carries the state's golden hash, names no lease and records a reset;
- the stamp's reset time is no earlier than the end of the slot's last lease (`last_lease_ended_at`, written to the state
  when the slot leaves `leased`);
- the health check passes;
- the marker it read carries the state's golden hash, and its reset time too is no earlier than the lease's end.

So the stamp, the marker and the state must agree on the golden, and both halves of the reset must have run after the
lease. A refused slot goes `dirty` with the reason in the event log, and is reset before anything hands it out (the same
`get` with `--wait`, a worker otherwise). The tests dirty each of the three separately (`src/core/lease.test.ts`,
`src/core/reset.test.ts`), and the times both ways.

## The WSL side

`probeSlot` and `hostAddress` (`docs/slot-url.md`, ticket 29) are the anonymous checks from WSL. They asked
`/<alias>/DBList.aspx`, which 404s on every flavor (`DBList.aspx` is in the `/Server` application, `docs/baselines.md`);
they now ask `/<alias>/Server/DBList.aspx`.

## Measured on the host (2026-10-27, `12sp9`)

Through firstmate's elevated gate: `setup-host.ps1 -Apply -UpdateBroker` installed a broker built from this ticket (exit 0),
and a one-off script provisioned the throw-away slot `12sp9-32` through the broker's own verb and wrote one extra file into
its tree (`Innovator\Client\arashouse-dirt-32.txt`), since the worker may only read `slots\`. Then, as the worker from
WSL, non-elevated, through `BrokerHost`, the repo's own `resetSlot` and `checkClean` over a scratch state home (golden
`d30c857941e3`, no licence stored, Defender on):

- **The extra file:** the health check failed `tree` ("1 extra: extra Innovator/Client/arashouse-dirt-32.txt"); every
  other check passed. The reset removed the file, but the slot was then quarantined: the client writes
  `Innovator\Client\jsBundles\compile.log` when it first compiles its bundles after a start, and golden has no such file.
  It is runtime state now (`RUNTIME_DIRS`, next to `data.json`), and a second broker build went in through the gate.
- **A freshly reset slot passes:** `reset in 30.2 s; free`, then the health check passed all nine checks (2.6 s round
  trip) and `checkClean` found it clean.
- **The marker removed** (`sp_dropextendedproperty` of `arashouse.golden_hash`, as the worker's own SQL login): the
  health check failed `marker` ("the database carries no marker"), `checkClean` refused the slot with that reason, the
  reset (38.9 s) made it free, and `checkClean` found it clean.
- **A stamp from another golden** (through `writeStamp`): the health check failed `stamp` and `marker`, `checkClean`
  refused it at once ("the stamp does not carry the golden hash the state recorded", 76 ms, before any health check),
  the reset (29.3 s) made it free, and `checkClean` found it clean.
- `destroySlot` 22.1 s; `listSlots` empty afterwards; the destroy's own deny-list check passed.

The check's time, warm (seconds): stamp 0.0, client, dblist and oauth 0.01 to 0.02 each, tree 1.2 to 1.4 (the `fast`
verify of 23,815 files), configs 0.9 to 1.7, marker 0.4 to 0.7 (one PowerShell process), version 0.0, login 0.3 to 0.5
(the store lookup that finds no licence); 2.6 to 3.7 s round trip from WSL. The first check after a start waits for the
server's cold start: 15.9 s, `Server/DBList.aspx` alone 15.0 s. `checkClean` takes about 3 s on a clean slot (the
check, the stamp read and the golden's hash). A whole reset took 29 to 39 s here, against the spike's 10 s: the golden is
checked three times (the reset's `golden` step, `resetDatabase`'s and `resetTree`'s), the start warms a cold server, and
the health check follows.

The `login` check reported "not checked": no licence is stored, so the one-time password and the refusal of the golden
backup's password are proven only offline (`src/broker/health.test.ts`, with ticket 34's `src/broker/aras-http.test.ts` for the requests) until a
licence and `ootb-root-<key>` are stored (tickets 34b and 35).

## Safety

- No password, token or MD5 leaves `aras-http.ts` and the request it is sent in: a refusal is the server's own words,
  redacted; the result names only which password was used ("the golden backup's password").
- The broker logs in as `root` and sets passwords for `root` and `admin` only, on `localhost` and the slot's own alias.
- The new password reaches the host only through the DPAPI store's `secret-put` step (stdin), as the SQL login passwords
  do.
