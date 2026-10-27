# The reset's database step: `resetDatabase`

Ticket 31. The database half of "reset to OOTB" (`docs/reset.md`, step `database`): the broker restores the
flavor's golden backup over the slot's database and fixes it up. It runs after `quiesce` has stopped the slot's
pools (spike 06: that closes Aras's own SQL sessions) and before `resetTree`.

## What the broker does

`BrokerHost.resetDatabase(slot, backup)` runs the guards on the WSL side (`assertSlotOwned`, and the backup must be
the slot's flavor and under `golden\<key>\`: `assertGoldenPath`), then sends `{ file, hash }`.
`src/broker/reset-database.ts` on the broker, under the slot's lock (one provision, destroy or database reset per slot
at a time; a second is `Retryable`):

1. **The backup.** It must be `golden\<key>\db\ootb.bak`, the one backup a golden holds, whose logical file names the
   flavor registry records (`docs/provision.md`). Anything else is `Refused`: a leaseholder's own backup is ticket
   39's `restoreDatabase`. The ticket's `CoreAndSolutions*.bak` default is that file: `ootb.bak` is a backup of the
   restored `CoreAndSolutions*.bak`, taken after the build handed the database to the broker.
2. **The golden.** It verifies against its manifest (`golden` level). One being promoted is `Retryable`; one that does
   not verify, or whose `flavor.json` lacks `ootbOwner`, is `Refused`. Its manifest hash must equal `hash`, the hash
   the reset resolved when it began; a golden replaced since is `Retryable` (the reset policy then retries, and the
   slot is reset from the new golden next time).
3. **The restore**, one `slot-steps.ps1 -Step reset-database` process (`src/broker/slot-steps.ts`), which derives
   every name and path from the flavor and slot number and takes from the request only the marker's two values
   (each checked against a pattern):
   - a slot with no database answers `missing`, and the verb is `Refused`: provision the slot;
   - `arashouse_admin.dbo.kill_connections` ends any other session in the database;
   - `RESTORE DATABASE arashouse_<key>_<NN> FROM DISK = '<root>\golden\<key>\db\ootb.bak' WITH REPLACE, MOVE ... TO
     '<root>\sqldata\arashouse_<key>_<NN>.mdf' / '_log.ldf', RECOVERY`, as the database's owner (the owner restore of
     spike 06). If it still fails with **3101** (a session came back in between), `kill_connections` again and the
     restore once more; any other error, or a second failure, fails the step (the reset policy tries the step once
     more, then quarantines the slot);
   - `MULTI_USER`, if the restored database is not;
   - the fix-ups: `ALTER USER innovator WITH LOGIN = arashouse_<key>_<NN>_dbo` and `innovator_regular` to `_reg`
     (after a restore both users are orphaned);
   - **the marker**: the database-level extended properties `arashouse.golden_hash` (the golden manifest hash) and
     `arashouse.reset_at` (the broker's ISO time), added or updated after the restore, because a restored database
     carries the golden's own properties (`DATABASE_MARKER` in `src/core/names.ts`);
   - read back: the marker, and the `innovator.VARIABLE` rows `VersionMajor`, `VersionMinor`,
     `VersionServicePack`, `VersionBuild`.
4. **The checks.** A marker that does not read back as written is `Quarantine`. So is a version whose
   `VersionMajor` and `VersionBuild` are not the flavor's `serverBuild` (`12.0.0.24090`: 12 and 24090). The minor
   version and the service pack are reported, not compared: how each release line writes them is measured only for
   `12sp9` (`0`, `SP9`).

The detail names the golden hash, the time, the restore's own time, how many sessions were ended, whether the database
had to be set back to `MULTI_USER`, the version, and the golden check's time.

### Not done, and why

The ticket's list shrank after the spike (ticket 09's record, plan change):

- **The owner** is not set: the broker's own restore keeps the broker as the owner (`sys.databases`), and the `dbo`
  inside is the broker too, since `ootb.bak` was taken after the build handed its database to the broker.
- **No URL is patched**: the Vault item's `VAULT_URL_PATTERN` is relative to the alias.
- **`root` and `admin` passwords** are not randomised here. SQL cannot do it (an MD5 written into `[USER].password`
  after an edit was refused, spike 06); it is an AML `edit` through the slot's server as `root`, after the pools
  start (ticket 32), and the broker keeps the free slot's random `root` password in the host secret store (ticket 34).
- **The allowlist** is enforced by the broker and the script deriving every name from a registered flavor and a slot
  number, and by SQL Server itself: the restore is not a procedure but the broker's login is in no server role, so it
  can restore only over a database it owns, which only `create_slot_database` (name-checked, ticket 22) makes.
  `kill_connections` checks the name and the owner itself.

## Sessions in the way (measured 2026-10-28)

As the broker's login (`EXECUTE AS LOGIN` from the worker's `sysadmin` session) on the scratch `arashouse_12sp9_31`:

- An **idle** session in the database (a connection parked there, as an Aras pool's would be) does not fail the
  restore at once: the restore waits about **20 s** and then fails with 3101 and 3013. `kill_connections` then ended
  1 session and the restore went through. So the step ends other sessions *before* the first restore, which costs
  nothing when there are none, and keeps the 3101 retry for one that comes back in between.
- A session **running** a statement in the database makes the restore wait until the statement ends (19 s for a
  25 s `WAITFOR`), then the restore goes through.
- With nothing in the way the restore took 0.64 s; the owner stays the broker and the database `MULTI_USER`.
