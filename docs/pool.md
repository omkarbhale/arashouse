# The v1 pool: `12sp9` x3, `23` x2, `35` x2

Ticket 37. The design's option 5(a), per the captain ("5. (a) but no expiry"): seven slots on the laptop, no lease
expiry, at most three leased at once (`max_active` 3, `docs/governor.md`). The counts are the defaults of
`slots_per_flavor` (`src/core/config.ts`), so `arashouse provision <flavor>` with no count makes them.

## Provisioning it (2026-10-28)

From WSL as the worker, non-elevated, against the installed broker and the default state (`~/.arashouse`), with `doctor`
clean before it started (4 slots free: `12sp9-01`/`02` from ticket 35, `23-01`/`02` from ticket 36; licences for lines
12 and 14 stored; `ootb-root-12sp9` and `ootb-root-23` stored; the three goldens verifying).

1. **`35` needed one secret first.** With the line-14 licence stored, every `35` health check logs in as `root`, so the
   golden backup's `root` password had to be stored as for the other flavors (`docs/health.md`): through firstmate's
   elevated gate, `scripts/store-ootb-root.ps1 -Flavor 35 -PasswordFile <the spike's handoff aras.dpapi> -Apply` (exit 0,
   "stored the golden backup's root password for 35"; the same file as for `12sp9` and `23`).
2. `arashouse provision 12sp9 3`: `12sp9-01` and `02` "in the pool already"; `12sp9-03` provisioned from golden
   `d30c857941e3` in **37.1 s** on the broker (golden 2.6, snapshot 2.5, folders 0.5, tree 16.6, iis 0.9, agent 3.7,
   database 5.6, configs 1.4, stamp 0.0, deny-list 3.2; 7 IIS applications, agent on port 8803, 9 config files and 24
   edits), then passed its health check: `free` 95 s after it started.
3. `arashouse provision 23 2`: both "in the pool already", nothing done.
4. `arashouse provision 35 2`: `35-01` from golden `03fb2ba2c5d2` in **37.7 s** (golden 1.8, snapshot 2.5, folders 0.7,
   tree 18.7, iis 1.0, agent 3.0, database 6.1, configs 0.8, stamp 0.1, deny-list 2.9; 5 IIS applications, agent on port
   9001, 7 config files and 21 edits), `free` 108 s after it started; `35-02` in **49.1 s** (tree 20.9, database 11.2,
   agent on port 9002), but its health check lost the broker, which another lane's broker update restarted at that
   moment ("the connection ended before a full line"), so the slot went `dirty`, as designed, and its reset worker could
   not reach the broker either. Once the broker answered, `doctor --fix` started a reset worker and `35-02` went `free`:
   golden 3.7, quiesce 12.1, database 7.0, tree 8.0, start 12.2, **health 207.7 s**, the first login of a fresh `35`
   slot with the host's free RAM under 2 GB (the other lanes held leases at the time).
5. Every one of the seven slots reached `free`. Other lanes leased from the pool as soon as the slots were free (holders
   `import-41-*`, `libsjs-parity`, `explore-52`), so a `status` of the busy pool showed them leased and resetting
   too; the pool at rest is below.

Each provision fingerprinted the deny-list before and after (`docs/provision.md`) and found it unchanged.

## Disk

Measured after the provision (2026-10-28, before 01:52Z) by `test/host/pool-measure.ps1`, run elevated through firstmate's gate
(read only: file sizes; a slot's database files and vault are readable only by Administrators and the broker), at
`e569ea3`. That version measured only the folder named after the alias in `Temporary ASP.NET Files`, not the
sub-applications' (`ah-<key>-<NN>_server`, `_client`), which the broker's destroy also removes; those are readable by
the worker and were measured from WSL the same way (the 14.x applications are ASP.NET Core and have none), and the
script now sums them too.

| slot | tree files | tree | vault | `.mdf` | `.ldf` | ASP.NET temporary | total |
|---|---|---|---|---|---|---|---|
| `12sp9-01` to `03` (each) | 23,821 | 560.7 MB | 0 | 83.1 to 84.1 MB | 23.8 MB | 23.6 MB | about 692 MB |
| `23-01`, `23-02` (each) | 26,393 | 755.0 MB | 0 | 81.1 MB | 23.8 MB | 0 | 859.9 MB |
| `35-01`, `35-02` (each) | 23,655 | 1,117.9 MB | 0 | 136.0 MB | 67.9 MB | 0 | 1,321.8 MB |
| **seven slots** | | | | | | | **6,439 MB, 6.3 GB** |

| | size |
|---|---|
| goldens (`12sp9` 669.7 MB, `23` 861.0 MB, `35` 1,257.8 MB) | 2,788.5 MB, 2.7 GB |
| media in the main checkout's `media/` (WSL's disk) | 2.7 GB |
| **the whole pool** | **about 11.7 GB** |
| C: free afterwards | 204.4 GB of 950.9 GB |

So a slot is 0.7 to 1.3 GB, not the design's 4 to 5 GB, and the pool with its goldens and media about 12 GB, not 45 GB
(sizes in binary units: 1 GB = 1,024 MB). A slot grows with what a leaseholder adds (the vault, the database, the logs), and a reset brings it back to these
sizes. `min_free_disk_gb` (10) is far below what is left.

## RAM

Measured from WSL as the worker, by process tree as ticket 36 does (`slotMemory` in `test/host/e2e-cycle.ts`: a slot's
pools' `w3wp.exe` from IIS's `W3SVC_W3WP` counter instances, their children and the slot's agent service), on
2026-10-28. A slot's pools stop after 10 minutes without a request (the provision's idle timeout), and its agent
service is Manual and stopped unless a lease asks for it (`get --agent`).

| slot | warm (just after a health check) | idle (10 minutes or more after its last request) |
|---|---|---|
| `12sp9` | 4 processes (1 `dotnet.exe`, 3 `w3wp.exe`): 501 to 535 MB working set, 587 to 616 MB private | 0 processes |
| `23` | 7 processes (`Aras.Client.exe`, `Aras.OAuth.Server.exe`, `Aras.Server.exe`, 4 `w3wp.exe`): 769 to 802 MB working set, 734 to 766 MB private | 3 `w3wp.exe`: 54 MB working set, 17 MB private |
| `35` | the same 7: 910 to 947 MB working set, 586 to 642 MB private | 3 `w3wp.exe`: 54 MB working set, 17 MB private |
| SQL Server (shared, all seven databases and the captain's own) | 1,173 to 1,480 MB working set | the same |

So **the idle pool costs about 0.2 GB** in its own processes (4 x 54 MB for the 14.x slots, nothing for `12sp9`), plus SQL
Server's share; all seven slots warm at once would take about 4.9 GB, which the governor never allows (`max_active` 3,
and a free slot idles out). Between 12 and 21 minutes after their reset, the 14.x slots had stopped their out-of-process
applications and one pool, and three of their four pools still had a `w3wp.exe` (54 MB, 17 MB private); that is what
an idle 14.x slot holds (at 12 minutes two of the four were still warm). The host had 4.3 to 6.7 GB of its 32 GB free
while WSL's VM held 12.3 GB.

The readings: warm at 03:44Z, after `doctor`'s health checks; idle at 04:10Z, the `23` and `35` slots 21 to 22 minutes
after their last reset (lane 54's `doctor --fix` reset them at 03:47 to 03:49 when its broker changed their configs),
`12sp9-01` and `12sp9-03` idle, `12sp9-02` warm under another lane's lease.

## A divergence fixed here: `doctor` on a busy pool

`doctor` reads the state once, then checks each slot against the host, one after another. A `get` that leased a free slot
in between has already written its lease into the slot's stamp, so `doctor` reported "free in the state but not clean on
the host: the stamp still names a lease", a failure, for a slot that was fine (seen three times here: on `23-01` and
`35-01` during a `doctor --fix`, and on `35-02` while `import-41-35-a` leased it). `doctor --fix` already re-read the slot before acting and said
"it moved on"; plain `doctor` now re-reads it too before it fails a free slot, and reports `ok` "free when doctor read the
state, leased since" when a `get` leased it or a reset ran in the meantime (`src/core/operator.ts`, with a test).

## The pool at rest (2026-10-28 03:41Z)

Once the other lanes had returned their leases (`doctor` from the build of this branch):

```
SLOT      FLAVOR  STATUS  HOLDER  LEASE  AGE  LAST RESET
12sp9-01  12sp9   free    -       -      -    54.1s
12sp9-02  12sp9   free    -       -      -    58.4s
12sp9-03  12sp9   free    -       -      -    78.0s
23-01     23      free    -       -      -    55.0s
23-02     23      free    -       -      -    70.4s
35-01     35      free    -       -      -    44.6s
35-02     35      free    -       -      -    59.5s
12sp9: 3 free of 3 (0 leased, 0 dirty, 0 resetting, 0 quarantined)
23: 2 free of 2 (0 leased, 0 dirty, 0 resetting, 0 quarantined)
35: 2 free of 2 (0 leased, 0 dirty, 0 resetting, 0 quarantined)
max_active: 0 of 3 in use
max_resets: 0 of 2 running
```

`arashouse doctor`: "every check passed" (7 slots, each "free and clean"; licence lines 12 and 14 present; the three
baselines verify; 204.4 GB free; 8,029 MB of RAM free).

The broker was then updated by another lane (lane 54's build, 03:44Z), whose `doctor --fix` reset the four 14.x slots
once for their new configs (each free again in under 60 s). Against that broker, at 04:10Z, `arashouse doctor` again
passed every check, with `12sp9-01` resetting, `12sp9-02` leased and `12sp9-03` disabled by that lane's e2e run, and
the four 14.x slots free and clean.
