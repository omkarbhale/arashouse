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
   `import-41-*`, `libsjs-parity`, `explore-52`), so a `status` of the busy pool shows them leased and resetting too; see the last section.

Each provision fingerprinted the deny-list before and after (`docs/provision.md`) and found it unchanged.

## Disk

Measured after the provision (2026-10-28 01:5xZ) by `test/host/pool-measure.ps1`, run elevated through firstmate's gate
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

So a slot is 0.7 to 1.3 GB, not the design's 4 to 5 GB, and the pool with its goldens and media about 12 GB, not 45 GB (sizes in binary units: 1 GB = 1,024 MB).
A slot grows with what a leaseholder adds (the vault, the database, the logs), and a reset brings it back to these
sizes. `min_free_disk_gb` (10) is far below what is left.

## A divergence fixed here: `doctor` on a busy pool

`doctor` reads the state once, then checks each slot against the host, one after another. A `get` that leased a free slot
in between has already written its lease into the slot's stamp, so `doctor` reported "free in the state but not clean on
the host: the stamp still names a lease", a failure, for a slot that was fine (seen twice here, on `23-01` and `35-01`,
and once on `35-02` while `import-41-35-a` leased it). `doctor --fix` already re-read the slot before acting and said
"it moved on"; plain `doctor` now re-reads it too before it fails a free slot, and reports `ok` "free when doctor read the
state, leased since" when a `get` leased it or a reset ran in the meantime (`src/core/operator.ts`, with a test).
