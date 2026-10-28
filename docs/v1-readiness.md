# v1 readiness: the sign-off record

Ticket 51. One page that sets out what arashouse v1 is, with the evidence for each claim, and what is left out. It is
for the captain to read and then either accept v1 or list what is missing; each missing item becomes a ticket on the
map. Every number below comes from a record already in `docs/` (linked), measured on the laptop on 2026-10-27/28 unless
it says otherwise. No secret, licence value or password is in this file.

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever took the lease before
> giving it back."
> "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned up. The rest is
> implementation detail."

## The destination, criterion by criterion

The map's six "done when" lines:

| criterion | status | evidence |
|---|---|---|
| `arashouse get 12sp9\|23\|35` returns a clean instance of that version, with a password that exists only for that lease | **met** | each flavor's lease cycle on the host: [`e2e-12sp9.md`](e2e-12sp9.md), [`e2e-23.md`](e2e-23.md), [`e2e-35.md`](e2e-35.md). A `get` of a clean free slot takes 6.5 to 10.3 s; the lease's password logs in, the golden backup's and the previous lease's are refused |
| a returned slot is provably reset to OOTB before it can be handed out again | **met** | the e2e runs dirty a lease (a package, a Part, a Language, a User, a vault file, a file in `Client`, a changed config, bytes appended to a DLL), return it, and after the reset find none of it, with the tree, the configs and every DLL equal to what the provision rendered (SHA-256), the stamp and the database marker naming the golden. A slot whose reset cannot finish is quarantined and never handed out. Since ticket 54 the old lease's access token is refused too (HTTP 401) |
| three leases active at once on the laptop; the pool holds `12sp9` x3, `23` x2, `35` x2 | **met** | [`pool.md`](pool.md) (seven slots, all `free`, `doctor` clean), [`capacity.md`](capacity.md) (three busy leases of three flavors, a fourth refused or queued) |
| `get --bootstrap <recipe>` restores, deploys and imports in that order | **met** | [`bootstrap.md`](bootstrap.md), "Measured on the host": a recipe with all three sections and `git` passed on each flavor |
| import-export-libs-js can run its live parity against leases of the matching server, and its `AGENTS.md` allows it | **met** | libs-js [#95](https://github.com/omkarbhale/import-export-libs-js/pull/95) (the guard), [#96](https://github.com/omkarbhale/import-export-libs-js/pull/96) (parity on leases: 135, 132 and 192 cases equal, 0 different, for `12.0`, `14.0.7` and `14.35`), [#97](https://github.com/omkarbhale/import-export-libs-js/pull/97) (`AGENTS.md` "Live Aras"), all merged |
| nothing in the tool can name `OLM_Local`, olm, prod or the captain's existing installs; no secret in the repo, printed or logged | **met**, with exceptions for the captain to accept (below) | [`audit.md`](audit.md): an adversarial audit by a worker that did not write the code; every check passes after fixes F1 and F2 and ticket 57, except the network check, which ticket 44 accepted as exception E1 |

## The captain's answers, and what delivered each

| | the captain's words | delivered by | shown by |
|---|---|---|---|
| 1 | "c, i doubt we need a lot of aras' in parallel. 3 most I would guess, or more, just that we need the disposable aspect of it." | the laptop only; `max_active` 3 (ticket 17, #18); capacity proven (38, #51) | [`governor.md`](governor.md); [`capacity.md`](capacity.md): three leases at once, a fourth exits 3 or queues, `max_active` 3 confirmed |
| 2 | "A admin service sounds good, with 'sa' admin creds for sql server, and anything it might require. Aras installed in non-admin directory, such as in c:/aras_installations or something, outside program files." | the broker service `ArasHouseBroker` (20, 21: #27, #28); SQL setup (22, #29); the root `C:\aras_installations` (10, #3) | [`broker.md`](broker.md), [`setup.md`](setup.md), [`setup-sql.md`](setup-sql.md). `sa`: see "The `sa` outcome" below |
| 3 | "I'm fairly confident multiple Aras' can be installed via a single license key, if one is needed, it should ask for it." | the spikes (05, 07, 08: #16, #21, #26); the licence prompt and store (23, #6); the whole licence element per line (34b, #41) | [`spike-record.md`](spike-record.md) section 2, [`secrets.md`](secrets.md). See "The licence outcome" below |
| 4 | "I can provide all versions installers. (I think we keep them in arashouse itself?, probably gitignored.) We can start with a few, 12SP9, 23, and 35." | `media/<flavor>/`, gitignored (01, 02: #1); `arashouse media check` (18, #14); the three goldens (24, 26, 27: #30, #32, #31) | [`../media/README.md`](../media/README.md), [`media-check.md`](media-check.md), [`baselines.md`](baselines.md); `test/tracked-files.test.ts` fails if a vendor file is tracked |
| 5 | "(a) but no expiry." | the slot counts (37, #48); no lease expiry, `status` shows each lease's age, `force-return` (11, 13, 16: #13, #15, #22) | [`pool.md`](pool.md); [`cli.md`](cli.md) |
| 6 | "a." | the libs-js guard (45), parity on leases (46), the `AGENTS.md` amendment (47) | libs-js #95, #96, #97 (above); the block for other repos in [`using-a-lease.md`](using-a-lease.md), "Live Aras" |
| + | "One more feature that I want is some kind of automation to get the Aras going. Perhaps a optional database restore, followed by import/codetree deployments. This is similar to worktree in that sense." | restore (39, #52), code deploy (40, #47), git baseline (53, #53), import (41, #45), the recipe (42, #55) | [`restore.md`](restore.md), [`code-deploy.md`](code-deploy.md), [`git-baseline.md`](git-baseline.md), [`import.md`](import.md), [`bootstrap.md`](bootstrap.md): order restore, code, import, then git, each measured on the host |
| + | "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever took the lease before giving it back." | the lease core (13, #15); extraction helpers and the return reminder (43, #44); the worker guide (48, #56); the repo `AGENTS.md` (01) | [`extract.md`](extract.md) (extracted copies equal by SHA-256 after the return and the reset), [`using-a-lease.md`](using-a-lease.md) |
| + | "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned up. The rest is implementation detail." | the reset policy (14, #20): `return` marks the slot `dirty` and exits; a detached worker resets it; `get` resets lazily if it must; a slot is handed out only when its stamp, database marker and state agree | [`reset.md`](reset.md); `return` exits in 0.08 to 0.14 s; the e2e runs kill a reset worker mid-reset and the slot is recovered, never handed out dirty |

**The setup answers (ticket 03).** "1. Okay": every elevated step went to the captain or to firstmate's elevated gate;
no worker raised a UAC prompt. "2/3. Use 'sa' directly ... If 'root' does not work, use windows authenticated user":
`root` did not work, so Windows authentication was used (below). "4. OK": the root is `C:\aras_installations`. "5. Any
time is fine": the sittings ran on 2026-10-26 to 28.

**The installers.** Taken from `I:\ARAS\ARAS Installables\ARAS Versions` as CD image zips into the main checkout's
`media/12sp9`, `media/23` and `media/35` (gitignored). Release 35 was not deferred.

**Host independence (2026-10-28).** "Build arashouse cleanly, regardless of wherever it will run." Ticket 55 (#50)
removed every applier: no code path of the tool requires, applies or offers to apply the WSL memory cap, SQL Server's
`max server memory`, a Defender exclusion, the firewall or the power plan; `doctor` prints `advice` lines for the WSL cap
and SQL memory and never changes its exit code for them ([`host-tuning.md`](host-tuning.md)). Checked for this record by
a search of every tracked file outside `docs/`:

- `scripts/host-tuning.ps1` reads the settings and can only **undo** what ticket 44's earlier version recorded; it
  refuses the old apply parameters, and `test/host-tuning.test.ts` fails if it gains `Add-MpPreference`,
  `Set-MpPreference`, a firewall cmdlet or a `powercfg` change.
- `setup-host.ps1` and `teardown.ps1` carry the same check (`src/core/setup-host.test.ts`,
  `src/broker/teardown-script.test.ts`), with `sp_configure` and `wslconfig` in it too.
- The broker reads `max server memory` (`src/broker/sql-probe.ts`) and never sets it.
- The app pool idle timeout is set only on arashouse's own pools (`ah-<key>-<NN>-<role>`) and goes with the slot;
  `applicationPoolDefaults` appears nowhere in the code.
- The one other hit is `spike/40-measure.ps1` (slice 0, ticket 06), a measurement script the captain ran once, which
  added a Defender exclusion for its own timing and is not part of the tool.

## The pool as built

| flavor | release | server build (measured) | libs-js engine | slots | slot on disk | golden |
|---|---|---|---|---|---|---|
| `12sp9` | Aras 12.0 SP9 | 12.0.0.24090 | `12.0` | 3 | about 692 MB | 669.7 MB |
| `23` | Release 23 (14.0 SP9) | 14.0.9.36073 | `14.0.7` | 2 | 859.9 MB | 861.0 MB |
| `35` | Release 35 (14.35) | 14.35.0.43890 | `14.35` | 2 | 1,321.8 MB | 1,257.8 MB |

| | value | source |
|---|---|---|
| disk: seven slots | 6.3 GB | [`pool.md`](pool.md) |
| disk: goldens / media (WSL's disk) | 2.7 GB / 2.7 GB | [`pool.md`](pool.md) |
| disk: the whole pool | about 11.7 GB (the design estimated 45 GB); C: had 204.4 GB free afterwards | [`pool.md`](pool.md) |
| `max_active` / `max_resets` | 3 / 2, both confirmed under load | [`capacity.md`](capacity.md) |
| `min_free_ram_mb` / `min_free_disk_gb` | 2048 (kept, not lowered to 1024) / 10 | [`capacity.md`](capacity.md) |
| RAM, one busy lease | 0.7 to 1.1 GB working set (`12sp9` 658 to 670 MB, `23` 896 to 951 MB, `35` 1,112 to 1,134 MB) | [`capacity.md`](capacity.md) |
| RAM, the idle pool | about 0.2 GB in its own processes, plus SQL Server's shared 1.2 to 1.5 GB | [`pool.md`](pool.md) |
| **free RAM with three active slots** | **2,482 MB at the lowest** (three leases busy importing and exporting, all seven slots warm, the WSL VM at 12.3 GB of the laptop's 32 GB); above the 2,048 MB gate, so no `get` was held | [`capacity.md`](capacity.md) |
| reset, one at a time | `12sp9` 58 to 61 s, `23` 48 to 54 s, `35` 50 to 68 s (spike 06's 10 s was the bare stop, mirror, restore and first request) | the three e2e records |
| reset, two at once | up to 98 s each; three returns of one flavor all `free` in 3 to 5 minutes | [`capacity.md`](capacity.md) |
| `return` | 0.08 to 0.14 s (the reset runs in the background) | e2e, [`capacity.md`](capacity.md) |
| `get` of a clean free slot | 6.5 to 10.3 s (28.5 s when the slot's pools had idled out) | the three e2e records |
| three `get`s at once | 14.5 to 25.9 s each | [`capacity.md`](capacity.md) |
| provisioning a slot | 37.1 to 49.1 s on the broker, then its first health check | [`pool.md`](pool.md) |
| bootstrap, restore + code + import + git | `12sp9` 217 s, `23` 294 s, `35` 311 s; without `git`, 67 to 75 s of steps (restore 16 to 28 s, code 14 to 19 s, import 28 to 37 s) | [`bootstrap.md`](bootstrap.md) |
| a broker killed mid-lease and mid-reset | restarted by its service recovery in 6 and 11.5 s; `doctor --fix` restored the pool; no lease lost | [`capacity.md`](capacity.md) |

`arashouse status` as read for this record at about 2026-10-28T20:08Z (2026-10-29 local time), with one slot held by another task:

```
SLOT      FLAVOR  STATUS  HOLDER              LEASE     AGE    LAST RESET  BOOTSTRAP
12sp9-01  12sp9   leased  powerplay-redesign  e8376708  8h34m  83.1s       -
12sp9-02  12sp9   free    -                   -         -      71.2s       -
12sp9-03  12sp9   free    -                   -         -      72.7s       -
23-01     23      free    -                   -         -      74.0s       -
23-02     23      free    -                   -         -      73.8s       -
35-01     35      free    -                   -         -      63.7s       -
35-02     35      free    -                   -         -      61.2s       -
max_active: 1 of 3 in use
max_resets: 0 of 2 running
```

`arashouse doctor` as run for this record from WSL as the worker, non-elevated and without `--fix`, from 2026-10-28T20:12:48Z to 20:15:07Z (2026-10-29 local time), exit 0. The only warning is that `aras-pkg` is not on that shell's PATH, which only `get --import` and `import` need, and the advice line is the operator's choice (docs/host-tuning.md).

```
ok state: 7 slots, revision 1373
ok setup: applied 2026-10-28T15:39:45Z, arashouse 0.0.0: root present, 9 folders with their ACLs, broker Running and answering
ok prerequisites: every prerequisite of the flavors in media/ is installed
ok setup acl: the worker reads slots\, staging\, broker\ and is kept out of the rest
warn aras-pkg: not on PATH and ARASHOUSE_APKG is not set; needed only for get --import and import
ok broker: answers (arashouse-broker 0.0.0)
ok sql: the broker's SQL login connects
ok sql login: NT SERVICE\ArasHouseBroker is neither sysadmin nor dbcreator, and executes the 7 arashouse_admin procedures
ok disk: 188.1 GB free at the install root
ok ram: 8972 MB free
advice sql max server memory: seen 2147483647 MB (SQL Server's default: uncapped); recommended 4096 MB; why: uncapped, SQL Server's buffer pool grows into the RAM active slots need; the setting covers the whole instance, the operator's own databases too
ok media 12sp9: present
ok baseline 12sp9: the 12sp9 baseline verifies (fast): fast verify passed: 23815 files checked
ok media 23: present
ok baseline 23: the 23 baseline verifies (fast): fast verify passed: 26386 files checked
ok media 35: present
ok baseline 35: the 35 baseline verifies (fast): fast verify passed: 23648 files checked
ok licence line 12: present
ok licence line 14: present
ok slot 12sp9-01: leased to powerplay-redesign for 8h40m
ok slot 12sp9-02: free and clean
ok slot 12sp9-03: free and clean
ok slot 23-01: free and clean
ok slot 23-02: free and clean
ok slot 35-01: free and clean
ok slot 35-02: free and clean
doctor: 0 problems, 1 warning; 1 host setting advised, the operator's choice (docs/host-tuning.md)
```

## The licence outcome

**Two keys, one per release line**: line `12` serves `12sp9`, line `14` serves both `23` and `35`. A key is needed to
**log in**, not to install. One key serves every slot of its line (tested with two slots per line, also after recycles
and a full stop and start); the 12.x key is refused by 14.x, and the 14.0 SP18 key is accepted by 14.0.9 and 14.35
([`spike-record.md`](spike-record.md) section 2, [`spike-08-release-35.md`](spike-08-release-35.md)). So the captain's
"single key" held per line, not across lines.

**Where they are held.** Each line's whole `<License>` element (`lic_key`, `act_key`, `lic_type`, `company`) is one
machine-scope DPAPI blob in the broker's store (`secrets\`, readable only by SYSTEM and the broker, not even by an
elevated administrator; audit check 4). They were stored by `scripts/store-licence.ps1` through firstmate's elevated
gate, reading the captain's existing installs' config read-only; `doctor` reports `licence line 12: present` and
`licence line 14: present`, never a value. A provision and every reset render the element into the slot's
`InnovatorServerConfig.xml` ([`secrets.md`](secrets.md)), which the worker user can read (exception E8).

## The `sa` outcome

**Not kept: there was nothing to keep.** The captain's `sa` guess and a typed value were both rejected on this
instance (spike 05). Windows authentication as the elevated captain (a `sysadmin`) works, which is the captain's stated
fallback, so `setup-sql` ran in the captain's elevated session once. The broker runs as the virtual account
`NT SERVICE\ArasHouseBroker` with a SQL login that owns only the `arashouse_*` databases and is in no server role; it
restores a slot as the owner, and reaches everything else (creating and dropping a slot's database and logins, ending a
foreign session in a slot database, reading and adopting a bootstrap's staged backup) only through procedures in
`arashouse_admin` that refuse any name outside the `arashouse_*` allowlist ([`setup-sql.md`](setup-sql.md)). No SQL password is stored anywhere; `--keep-sa` was never
built (map Q2).

## The Release 35 outcome

**Built, not deferred.** The CD image in `media/35/` is ordinary server media; a native slot is built the same way as a
Release 23 slot; the host's runtimes were enough and nothing was installed; the line-14 key serves it
([`spike-08-release-35.md`](spike-08-release-35.md)). Its golden (ticket 27), its lease cycle (ticket 52,
[`e2e-35.md`](e2e-35.md)) and its two slots (ticket 37) are in the pool, and libs-js's `14.35` engine ran its first
parity against a 14.35 server on a `35` lease (192 equal, 0 different).

## For the captain to accept: the audit's exceptions

From [`audit.md`](audit.md), "Exceptions for the captain". Each is a known, recorded property of v1, not fixed in the
tool:

| # | what |
|---|---|
| E1 | slots answer on every interface on port 80, LAN included (narrowing the firewall would be a host-wide setting; since ticket 57 no shipped credential logs in) |
| E2 | a leaseholder's server code runs as its slot's pool identity, which can write its own slot's tree and read what `BUILTIN\Users` may read |
| E3 | any process of the worker user can read the broker's token and call every verb (by design: the workers are that user) |
| E4 | the worker user's SQL login is a `sysadmin` without elevation (the captain's own SQL configuration, outside the tool) |
| E5 | a code deploy has no byte limit (disk only; the reset frees it) |
| E6 | the captain's earlier `setup` sittings were not watched live (covered by the PowerShell event log search) |
| E7 | a look-alike of `OLM` in a backup's recorded database name passes the restore's foreign-origin check (a guard against accidents, not intent) |
| E8 | the worker user can read every slot's tree, with the licence of its line and the slot's two SQL login passwords |

## What is not done

Out of v1 by design (design report sections 4 and 12; the map):

- **The optional accelerators: VHDX and ReFS cloning.** Not needed: a reset is about a minute end to end, of which the
  tree step is 4 to 6 s.
- **Host-header bindings.** Not needed: two slots in one browser keep separate sign-ins, since every sign-in cookie is
  scoped to its own slot's OAuth path ([`capacity.md`](capacity.md), section 5). Not tested: a real browser with two
  slots signed in side by side.
- **A dedicated host.** The pool runs on the laptop (answer 1).
- **Extra flavors.** 14.0 SP18 (Release 28, 14.0.18.39055) is a ready addition: its CD image is on the host and the
  line-14 key already serves it. A new release is code first (a registry entry, its config edit list, a spike of its
install), then the runbook's "Add a flavor to the pool": one ticket. A 14.0 SP22+ flavor would
  exercise the other half of LP-040 in libs-js (`NeedToHandleNullPropertyValues`), which no server in the pool reaches.

Left open by v1, each recorded where it belongs:

- **Teardown's full cycle on the host has not been run** ([`teardown.md`](teardown.md), "On the host"). Teardown is
  built and tested offline and on a throw-away LocalDB, and its dry runs on the host refused correctly. The cycle
  removes every slot of the pool and the broker every lane uses, so it was deferred to a quiet host; it was still not
  quiet for this record (`12sp9-01` is leased). It stays firstmate's to run through its elevated gate when the pool is
  idle, or the captain's whenever everything should go.
- **Host settings.** The WSL memory cap and SQL Server's `max server memory` stay the captain's to apply by hand, if
  ever; `doctor` advises on both. Nothing at the measured load needs them.
- **The loaded-host retries of ticket 56** are proven offline; the host run under load met neither failure they handle
  ([`capacity.md`](capacity.md), last section).
- **A cold-cache reset after a reboot** has not been timed. It would be slower, not wrong.
- **`arashouse licence forget <line>`** does not exist; the function behind it does ([`secrets.md`](secrets.md)).
- **Map Q8**: the captain's own Release 23 install, removed during spike 05 with the captain's consent, has not been
  reinstalled. It is outside arashouse (rule 2).

## How to operate it

- Workers: [`using-a-lease.md`](using-a-lease.md), the worker guide (take, use, take out, give back; the block for
  another repo's `AGENTS.md`).
- Operators: [`runbook.md`](runbook.md) (setup, a quarantined slot, a stuck slot, a lost state file, the broker, disk,
  limits, restarting WSL, logs, uninstall).
- Every command and exit code: [`cli.md`](cli.md).
- Every page, by ticket: the root [`README.md`](../README.md).

## Sign-off

The captain reads this record and answers with one of:

- **"v1 accepted"**, including the audit exceptions E1 to E8 and the open items above as they stand; or
- **what is missing**, each item of which becomes a ticket on the map.

Answer: _(pending)_
