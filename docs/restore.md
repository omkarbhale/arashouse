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
     libs-js's CLI allows for engines;
   - the slot is started and warmed again (`startSlot`'s warm-up);
   - **the staged copy is deleted**, and the lease's staging folder once it is empty, whether the restore worked or not.
     The CLI then removes the lease's staging folder too.
4. `get` sets the lease's password (ticket 34) and hands the lease over.

If any of it fails, `get` gives the lease back: the password file is deleted and the slot goes `dirty`. The reset restores
the golden backup, so a failed restore leaves a usable slot, after the reset. The broker's reason is the error (exit 7 for a
refusal, 6 for a slot that did not stop or start).

## On return

Nothing changes: `return` marks the slot dirty and the reset restores the golden's `ootb.bak` over the database (ticket 31).
A restored database never reaches another lease. Take out what you need first (the governing principle in `AGENTS.md`).

## Measured on the host

To be recorded by this ticket's host proof (below).
