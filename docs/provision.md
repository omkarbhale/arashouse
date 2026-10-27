# Provisioning: `arashouse provision`, `provisionSlot` and `destroySlot`

Ticket 25. A slot is made from its flavor's golden (`docs/baselines.md`), never by an installer: its folders, its
IIS application and pools, its agent service (if the golden has one), its database and SQL logins, its rendered
config files and its stamp. Destroying a slot removes exactly what its names derive, and nothing else.

## Running it

From WSL, with the broker installed (`docs/setup.md`), SQL set up (`docs/setup-sql.md`) and the flavor's golden built:

```
arashouse provision 12sp9 3      # the pool holds 12sp9-01 to 12sp9-03 afterwards
arashouse destroy 12sp9-03 --yes # removes one again
```

`provision <flavor> [<count>]` (`src/core/operator.ts`, `provisionPool`) makes sure the pool holds the flavor's
slots `01` to `<count>` (default `slots_per_flavor`), in order, behind the disk gate. For each slot not yet in the
pool it adds a `provisioning` record, calls the broker's `provisionSlot`, then runs the slot's health check: `free`
when it passes, `quarantined` when it fails, `dirty` (a reset worker starts) when the check cannot run. A slot already
in the pool is left alone; one left `provisioning` by an earlier run is finished. A failed provision was rolled back by
the broker, so its record is removed (quarantined instead if the host still lists the slot) and the run stops; when
the broker did not answer, the record stays `provisioning` and the next `provision` finishes it. One `provision` runs
at a time (`provision.lock` next to the state file). `docs/cli.md` has the exit codes.

`destroy` (ticket 16) removes the record first, so the slot can never be handed out while it is being destroyed, and
then calls `destroySlot`.

## `provisionSlot` on the broker

`src/broker/provision.ts` orders the steps; every effect goes through a `SlotSystem`: `src/broker/slot-system.ts` on
the host, `src/broker/slot-system.fixture.ts` in the tests. The Windows operations are one `slot-steps.ps1 -Step
<name>` process each (`src/broker/slot-steps.ts`), which the broker writes from its own code to
`<root>\broker\slot-steps.ps1` (a folder only SYSTEM and the broker may change) and runs with a JSON request on
stdin. The script takes only the flavor and the slot number from the request and derives every name and path from
them by the rules of `src/core/names.ts`, as `baseline-steps.ps1` does; a test fails if the two drift.

| step | what it does |
|---|---|
| (check) | a slot whose folder holds a stamp is provisioned: refused (`Refused`), nothing changed |
| `golden` | `golden\<key>` verifies against its manifest (`golden` level); its `flavor.json` says `ootbOwner` is the broker (below). A golden being promoted (`golden-build\<key>.promoting`) is `Retryable`; one that does not verify, or lacks `ootbOwner`, is `Refused` |
| `snapshot` | the deny-list fingerprints (`docs/baselines.md`, "The deny-list self-check"; the same PowerShell, `src/broker/ps-common.ts`) |
| `folders` | `slots\<key>\<NN>` and `vaults\<key>-<NN>`, refused if either is a junction; `IIS_IUSRS` (every pool identity) modify and `IUSR` read on the slot folder, `IIS_IUSRS` modify on the vault folder, both inheritable |
| `tree` | `robocopy <golden>\tree <slot> /MIR /XJ /R:2 /W:1 /MT:16`: the mirror the reset uses (`docs/reset.md`), with no `/XF` (robocopy matches it on the source side, spike 06). robocopy copies no ACL, so every file inherits the grants above, `OAuthServer\App_Data`'s SQLite file included |
| `iis` | the applications of the golden's `iis.json` under `Default Web Site`: `/ah-<key>-<NN>` and each sub-application, each on its own pool `ah-<key>-<NN>-<role>` with the captured runtime, pipeline mode, bitness, identity and start mode, and an idle timeout of 10 minutes (or what `setup-host.ps1 -SlotIdleTimeoutMinutes` recorded). An existing application or pool is brought to the template |
| `agent` | the agent service of the golden's `service.json`, if it has one: `ArasHouseAgent_<key>_<NN>`, startup Manual, left stopped, its port (`8800 + 100 x flavor index + NN`) refused if it is 8734 to 8736 or something listens there. No golden has one yet (`INSTALL_AGENT_SERVICE=0`), so the step answers `no agent` |
| `database` | the slot's two SQL login passwords from the host's secret store (made and stored on the first provision); then, through the name-checked procedures (ticket 22): `create_slot_database`, `kill_connections`, the broker's own `RESTORE ... WITH REPLACE` of the golden's `db\ootb.bak` with its files moved to `sqldata\arashouse_<key>_<NN>.mdf` and `_log.ldf`, `create_slot_login` for `_dbo` and `_reg`, and `ALTER USER innovator` / `innovator_regular` `WITH LOGIN` to them. The CD's SQL scripts are not run |
| `configs` | the golden's `edits.json` rendered into the slot's config files from the golden's bytes (`docs/edits.md`): the slot's names, its login passwords, and the licence key stored for the flavor's line (`licence-12` or `licence-14`); without one the key stays blank, as in golden, and the result says the slot cannot log in yet |
| `stamp` | `.arashouse-slot.json`: the slot id, flavor, golden manifest hash, the time, no lease. Written last: a slot with a stamp is provisioned |
| `deny-list` | the fingerprints again; any difference fails the provision (`Quarantine`) |

The result's detail names the golden hash, the time and each step's seconds.

**Idempotent.** Each step can run again over its own earlier work: a provision that stopped half way (the broker
restarted, the call timed out) is finished by the next one, which reuses the stored login passwords.

**Rollback.** A failure from `folders` on runs the destroy steps below, re-checks the deny-list, and answers the
step's error with what the rollback left, if anything. A plain error is `Retryable`; a `HostError` keeps its kind.

**One at a time.** The broker runs one `provisionSlot`, `destroySlot`, `startSlot`, `stopSlot` or `resetDatabase` per slot at a time; a second is `Retryable`.
Both verbs may take 30 minutes (`VERB_TIMEOUT_MS`).

## `destroySlot`

The provision's steps in reverse, each run even when one before it failed: `stop` (the slot's pools and agent,
waiting for its processes to end, as the reset's quiesce does), `agent` (the service of its own name), `database` (`drop_slot_database`, then
`drop_slot_login` for both logins; each ends the sessions it must), `iis` (the applications under `/ah-<key>-<NN>`,
the pools named from the slot's roles, ASP.NET's temporary files of the alias), `folders` (the slot and vault folders,
and `slots\<key>` when it is left empty), `secrets` (the two stored passwords). Then it lists what of the slot is left
(folders, applications, pools, service, database, stored secrets; the broker's login cannot see other logins, so the
`database` step's answers stand for them) and compares the deny-list. Anything left is `Retryable` (a second destroy
removes the rest); a deny-list difference is `Quarantine`. A slot that is not there destroys fine.

## The database: why `ootb.bak` must be the broker's

The broker's SQL login is in no server role (ticket 22). It may create a slot database only through
`create_slot_database`, and as that database's owner it restores the golden backup over it (spike 06). Measured as the
broker's login on 2026-10-28 (`EXECUTE AS LOGIN` from a `sysadmin` session, on the throw-away `arashouse_12sp9_98`):

- `sys.databases` keeps the broker as the owner after the restore, but the `dbo` *inside* the database comes from the
  backup. With the golden built before this ticket that is the build's owner, the captain's login, and the broker
  then cannot open the database ("not able to access the database under the current security context"): not to map
  its users, not to `ALTER AUTHORIZATION` it back, not even to drop it through `drop_slot_database`.
- With the build's database handed to the broker before the backup (`ALTER AUTHORIZATION ... TO [NT SERVICE\ArasHouseBroker]`),
  the restore took 0.5 s and the broker created the logins, mapped both users, restored again (as a reset would) and
  dropped the database and logins through the procedures. Nothing was left.

So the baseline build now takes `ootb.bak` that way and records `"ootbOwner": "NT SERVICE\\ArasHouseBroker"` in
`flavor.json`, and `provisionSlot` refuses a golden without it (rebuild it with `arashouse baseline build <key>
--replace`). The reset's restore (ticket 31, `docs/reset-database.md`) depends on the same.

The restore moves the backup's files by their logical names, and `RESTORE FILELISTONLY` needs `CREATE DATABASE`, which
the broker has not (refused with 3013). The names are therefore in the flavor registry (`backupFiles` in
`src/core/flavors.ts`), read from the CD backups with `RESTORE FILELISTONLY` as a `sysadmin`; `ootb.bak` keeps the
logical names of the `CoreAndSolutions*.bak` it was restored from.

## Secrets

- A slot's SQL login passwords (24 letters and digits, no `;`, since one goes into a connection string) are made by the
  broker on the first provision and kept in the host's secret store as `slot-<key>-<NN>-dbo` and `-reg`: machine-scope
  DPAPI blobs in `<root>\secrets\` (`src/broker/dpapi-store.ts`), readable through that folder's ACL by SYSTEM and the
  broker only. They reach SQL Server only on the `database` step's stdin, and the slot only in its rendered configs.
  A destroy deletes them, and the slot's stored random `root` password (`slot-<key>-<NN>-root`, `docs/lease-credentials.md`).
- The licence is read from the same store (`licence-<line>`). Nothing stores one there yet, and a slot that must log in
  needs the whole `<License>` element (`docs/baselines.md`, run 5), not the key alone: storing the licence for slots,
  with its `act_key`, is ticket 34b.
- Nothing secret is in a request's arguments, the audit log, a step's error text (every line goes through `redact`) or
  the result.

## Safety

- Every name and path is derived from the slot record and passes `assertSlotOwned` on both sides of the pipe; the
  script derives them again. Nothing is written under `Program Files`; the only folders written are the slot's own,
  its vault folder, `slots\<key>` and `<root>\broker\slot-steps.ps1`.
- Only the procedures touch SQL Server objects other than the slot database's own users, and they refuse every name
  that is not a slot's (ticket 22).
- The deny-list is fingerprinted before and after every provision and destroy.

## Measured on the host (2026-10-28)

Through firstmate's elevated gate: `setup-host.ps1 -Apply -UpdateBroker` installed a broker built from this ticket
(exit 0), and `baseline-build.ps1 -Apply -Replace` rebuilt the `12sp9` golden with the broker-owned `ootb.bak` (exit 0,
814 s, 35 deny-list objects unchanged; manifest hash `8668e889d5e4`, `ootb.bak` 77.1 MB, no login check). Then, as the
worker from WSL, non-elevated, under a scratch `ARASHOUSE_HOME`:

- `arashouse baseline verify 12sp9`: passes (23,760 files).
- `arashouse provision 12sp9 1`: **22.8 s** on the broker (golden 1.5, snapshot 2.0, folders 0.5, tree 12.2, iis 0.9,
  agent 0.5 (none), database 3.2, configs 0.4 (8 files, 19 edits), stamp 0.0, deny-list 1.6), 23.6 s from WSL. The
  slot went `dirty` with "the health check could not run (the broker has no healthCheck verb yet (ticket 32))", as
  planned. The slot served at once: `/ah-12sp9-01/Server/DBList.aspx` answered 200 listing only
  `arashouse_12sp9_01` (so its rendered config reaches its own database with its own login), OAuth discovery and
  `/Client/` 200. In SQL Server: the database's owner and its `dbo` are `NT SERVICE\ArasHouseBroker`, `innovator`
  maps to `arashouse_12sp9_01_dbo` and `innovator_regular` to `_reg`. The stamp carries the golden hash.
- `arashouse destroy 12sp9-01 --yes`: 17.5 s; the broker's own check found nothing of the slot left and the deny-list
  unchanged. Read back as the worker: no `slots\12sp9` folder, no database or login named `arashouse_12sp9_*`, no
  `ArasHouseAgent_*` service, no ASP.NET temporary folder `ah-12sp9-01*`. (The `arashouse_pp_*` logins and `ah-pp-*`
  folders on the host are not the pool's and were there before.)

## Not here

- The health check (ticket 32): `BrokerHost.healthCheck` is not a verb yet, so on the real host `provision` leaves each
  slot `dirty`, and the reset (tickets 30 to 33; the tree step is in, `docs/reset.md`) brings it to `free`. `FakeHost` checks health, so the offline tests
  cover the `free` path.
- Starting the agent (ticket 33, `docs/start-stop.md`) and an agent in the golden with its configuration (ticket 33b); the
  per-lease password is `docs/lease-credentials.md` (ticket 34).
- The whole contract suite on the real host (ticket 35). `test/host-contract.broker.test.ts` runs it against
  `BrokerHost` with `ARASHOUSE_TEST_BROKER=1` on slot `12sp9-98`. Run on 2026-10-28: `ping`/`hostInfo`, "provisions a
  slot, lists it and destroys it" (40 s) and the refusal of `OLM_Local` and unregistered slots pass; the two tests that
  need a fault or dirt hook return early on the real host; the other five fail `Unreachable` on verbs the broker does
  not have yet (`quiesce` and `writeStamp`, ticket 30; `healthCheck`, ticket 32; `startSlot`, ticket 33; the staged-path
  verbs, tickets 39, 40 and 43). Its teardown left no slot behind.
