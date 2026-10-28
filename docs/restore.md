# Bootstrap step 1: `get --restore`

Ticket 39. The first of the bootstrap steps (this one, then code deployments, ticket 40, then package imports, ticket 41,
tied together by ticket 42's recipe). The captain:

> "some kind of automation to get the Aras going. Perhaps a optional database restore, followed by import/codetree
> deployments. This is similar to worktree in that sense."

A lease can be handed over with the leaseholder's own database in it, as a worktree is checked out at a branch:

```
arashouse get 12sp9 --holder <task> --restore <backup.bak | profile> [--allow-foreign-origin] [--skip-version-check] [--json]
```

## The source

- **A file**: a SQL Server backup, by a WSL path, a relative path or a Windows drive path (`C:\Users\...\x.bak`). Any value
  with a `/` or `\`, or ending in `.bak`, is a file.
- **A profile**: any other value is a name, `media/<flavor>/profiles/<name>.bak` in the main checkout (or under
  `ARASHOUSE_MEDIA`), ignored by git like all media (`media/README.md`). Names are letters, digits, `.`, `_` and `-`.

The CLI checks that the file exists before it leases a slot, so a missing file or profile costs no slot (exit 2). arashouse
makes no backup of any existing database: the caller brings one (ticket 10's rule; ticket 43 backs up only a leased slot).

## What happens

1. `get` leases a free, clean slot as always, and records `bootstrap: { restore: "custom" }` (or `"profile:<name>"`) in the
   lease. That is a label, never a path. `status` shows it as `restore:custom`, in its `BOOTSTRAP` column and in
   `status --json`.
2. The CLI copies the file to `C:\aras_installations\staging\<lease_id>\restore.bak`. The SQL Server service account
   cannot read the WSL filesystem or the user's Downloads. The worker may write `staging\`, and SQL Server and the broker
   may read it (ticket 21, `docs/setup.md`).
3. **The broker's `restoreDatabase`** (`src/broker/restore-database.ts`, under the slot's lock):
   - the slot's stamp must name a lease, and the file must be exactly that lease's `restore.bak`;
   - **the pre-checks**, from `RESTORE VERIFYONLY`, `HEADERONLY` and `FILELISTONLY` of the staged file, read through the
     signed procedure `read_staged_backup` (the broker's login may not read a header itself: that needs `CREATE DATABASE`,
     `docs/setup-sql.md`). Each is in `backupProblems` (`src/core/restore.ts`):
     - one backup set, and a full database backup;
     - written by a SQL Server no newer than the host's. The partner demo's troubleshooting guide says "The backup can not
       be restored on an older version of SQL Server"; an older one is upgraded as it is restored;
     - one data file and one log file, whose sizes fit in the free space of the drive of `sqldata\`;
     - **not taken of a deny-listed database** (`OLM_Local`, `InnovatorSolutions`, any name with `olm` or `prod`, ...).
       arashouse cannot know where the data came from, so the name the backup records is all it checks (map question Q6).
       `--allow-foreign-origin` lets such a backup through.

     A backup refused here leaves the slot untouched;
   - the slot is stopped (its pools close Aras's sessions), and `slot-steps.ps1 -Step restore-staged` restores the backup
     over the slot's database, by its owner, the broker, with the backup's two files moved to `sqldata\arashouse_<key>_<NN>.mdf`
     and `_log.ldf`. Any other session is ended first (`kill_connections`), and again on a 3101, as a reset does. The header
     is read again first and must still name what was checked;
   - **the fix-ups**, so a database from another instance works in this slot:
     - `adopt_slot_database`: a restored backup keeps its own `dbo` inside, and the broker could then neither open nor drop
       it. The procedure makes the broker the `dbo` again (ticket 25 measured the lock-out; `docs/provision.md`);
     - `innovator` and `innovator_regular` are mapped to the slot's logins (`_dbo`, `_reg`). A database without them is not
       an Aras database, and is refused;
     - **`root` and `admin` get the password hashes they had in the database this replaced**, and `root` is enabled. So the
       free slot's stored `root` password (`slot-<key>-<NN>-root`, `docs/health.md`) still logs in, and ticket 34's
       `setLeaseCredentials` then sets the lease's password over whatever password the backup carried, as on any free slot.
       The hashes go from SQL Server to SQL Server as parameters; they are never in a result or a message;
     - the reset marker (`arashouse.golden_hash`, `arashouse.reset_at`) is removed: this database was not reset from the
       golden, and a health check must never take it for one that was. A backup of an arashouse slot carries one;
   - **the version check**: the restored `VersionMajor` and `VersionBuild` must be the flavor's server build. A Release 23
     database in a `12sp9` slot fails with the flavor it belongs to: `it is a 23 database: restore it into a 23 lease
     (arashouse get 23 --restore ...), or pass --skip-version-check to keep it`. `--skip-version-check` keeps it, as
     libs-js's CLI allows for engines. The slot's own server must still be able to serve it: a `12sp9` (12.0) server lets
     `root` log in to a Release 23 database but refuses the password edit (`Invalid column name 'ZONE'`, measured), so
     that `get` fails at step 4 and gives the lease back;
   - the slot is started and warmed again (`startSlot`'s warm-up);
   - **the staged copy is deleted**, and the lease's staging folder once it is empty, whether the restore worked or not.
     The CLI then removes the lease's staging folder too.
4. `get` sets the lease's password (ticket 34) and hands the lease over.

If any of it fails, `get` gives the lease back: the password file is deleted and the slot goes `dirty`. The reset restores
the golden backup, so a failed restore leaves a usable slot, after the reset. A refusal that would quarantine a slot on a
plain `get` (the server refusing the password edit, say) only sends it to be reset once a backup is in: the failure is the
backup's, not the slot's. And `get` does not try the restore on another slot. The broker's reason is the error (exit 7 for a
refusal, 6 for a slot that did not stop or start).

## On return

Nothing changes: `return` marks the slot dirty and the reset restores the golden's `ootb.bak` over the database (ticket 31).
A restored database never reaches another lease. Take out what you need first (the governing principle in `AGENTS.md`).

## Measured on the host (2026-10-28)

Through firstmate's gate, with the captain's approval of the adopter certificate: `setup-sql.ps1 -Apply -SelfTest` (exit 0:
the broker's login in no role and holding no right, `CONTROL SERVER` false, 7 of 7 procedures executable, 84 of 84 made-up
names and paths refused, the direct `RESTORE` and `CREATE DATABASE` refused, the self-test round trip, now with `adopt`, ok),
then `setup-host.ps1 -Apply -UpdateBroker` (exit 0). `arashouse doctor`: `sql login: ... executes the 7 arashouse_admin
procedures`, every slot free and clean.

Then, as the worker from WSL, `get 12sp9 --restore <file> --json` (the times are the whole `get`: the lease, the copy to
staging, the restore and the lease's password), and for each lease handed over: `arashouse run --lease <id> --` a probe that
logs in as `root` with the lease's password and reads `Variable` items, then `return --wait`:

| backup | what it is | result |
|---|---|---|
| `arashouse_t39_scratch.bak` (84 MB) | a 12sp9 scratch database: the CD's `CoreAndSolutions120.bak` restored under another name with a `Variable` row `ARASHOUSE39_MARK` added, backed up on this SQL Server 15 by the worker's own login (so its `dbo` is not the broker) | exit 0 in 104 s; `root` logs in with the lease's password; `ARASHOUSE39_MARK = restored-scratch`, `VersionBuild = 24090`; returned and reset |
| `Core120.bak` (13 MB) | the CD's own backup, written by SQL Server **11.0** (another SQL version path: upgraded as it is restored) | exit 0; `root` logs in; `VersionBuild = 24090`; returned and reset |
| `CoreAndSolutions140.bak` | the Release 23 CD's backup, a 23 database | exit 7 in 27 s: `12sp9-02: the restored database is version 14.0 None build 36073, not the 12sp9 server build 12.0.0.24090; it is a 23 database: restore it into a 23 lease (arashouse get 23 --restore ...), or pass --skip-version-check to keep it`; the slot reset |
| the same, `--skip-version-check` | | restored and started, and `root` logs in, but the 12.0 server refuses the password edit (`Invalid column name 'ZONE'`): exit 7, `the restored database does not work in 12sp9-01, which is reset: ...`; the slot reset, not quarantined |
| the scratch backup cut to its first 20 MB | a corrupt file | exit 7: `the staged backup cannot be read: read-backup failed (exit 1): VERIFY DATABASE is terminating abnormally ...` (`RESTORE VERIFYONLY`, before the slot is touched) |
| `arashouse_t39_prod.bak` | the CD's backup restored as `arashouse_t39_prod` and backed up: recorded under a deny-listed name (`prod`) | exit 7: `the backup was taken of the database "arashouse_t39_prod", which is deny-listed (contains "prod"); ... pass --allow-foreign-origin` |
| the same, `--allow-foreign-origin` | | exit 0 in 123 s (with the wait for a slot); `root` logs in; `VersionBuild = 24090`; returned and reset |

In every case the lease's staging folder was gone afterwards (no `staging\<lease_id>` left), and every slot ended free.
`status` showed the leases as `restore:custom`.

Two things the proof changed: the first `--skip-version-check` run quarantined the slot (the password edit's refusal is a
`Quarantine` on a plain `get`); since the restore is the cause, it now sends the slot to be reset and fails with exit 7. And
the corrupt file's message carries PowerShell's own lines after SQL Server's; it says what failed, not prettily.

The test backups were made by the worker's `sysadmin` login from the CD's backup, as the throw-away databases
`arashouse_t39_scratch` and `arashouse_t39_prod`, which were dropped again at once; nothing else was touched.
