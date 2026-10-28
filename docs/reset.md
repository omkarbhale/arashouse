# The reset policy: when a slot is reset

`src/core/reset.ts` (ticket 14), over the state store and the host driver. The captain's words:

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever
> took the lease before giving it back."
> "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned
> up. The rest is implementation detail."

**The invariant:** a slot that `get` hands out is always clean. **When** the reset runs is a choice,
and it is not "return wipes at once". The holder's duty is to take out anything durable before
returning (`arashouse extract`, `docs/extract.md`); after `return` the holder may assume the slot is gone.

## Who resets, and when

1. **`return`** marks the slot `dirty`, deletes the lease's password and starts a detached
   `arashouse reset-worker --slot <id>` (a short-lived child process, not a daemon). Then it exits:
   nothing is wiped yet, and the lease's data stays on the host until the reset starts. Nobody may
   rely on that window.
2. **The reset worker** takes the slot `dirty -> resetting` through the reset cap, runs the sequence
   below and ends `free` or `quarantined`. Then it resets every other `dirty` slot it can, lowest id
   first, each once. It stops when none is left, when `max_resets` resets are running (those workers
   carry on with the rest), or when the host does not answer.
3. **Lazy reset in `get`.** A `get` that finds no `free` slot of its flavor:
   - sends any `resetting` slot whose worker has ended back to `dirty`;
   - with `--wait N`, resets the first `dirty` slot of its flavor itself (the same code as the
     worker), waits on it, and then takes a free slot. The reset runs to its end even past the
     deadline (about 10 s, below), so a `get` can overrun `--wait` by one reset;
   - without `--wait`, starts a detached worker for that slot and exits 3 at once with a message
     that ends `; 23-01 is being reset`;
   - finding a `resetting` slot, waits for it (polls) instead of starting a second reset.

   So a burst of returns and gets never deadlocks, and a machine shut down with dirty slots still
   works the next day.
4. **Dirty detection before handing out** (belt and braces, `checkClean` in `lease.ts`, ticket 32): a
   `free` slot is handed out only if its stamp, its database marker and the state record agree on the
   golden hash, that hash is the flavor's current golden manifest hash (when the host can name it; a
   slot reset from an older golden is dirty), the stamp names no lease, the stamp's and the marker's
   reset times are no earlier than the end of the slot's last lease (`last_lease_ended_at`), and the
   host's health check passes (`docs/health.md`). A slot that fails goes to `dirty` and is reset
   first: by the same `get` if it waits, by a worker otherwise.

A slot whose `get` failed after it was reserved (a host error while writing the lease's stamp or
credentials) also goes to `dirty`, and a worker is started for it.

## The sequence

Each step is a host-driver call (ticket 12). The same sequence runs in the worker, in `get`'s lazy
path, and in `repair` (`docs/cli.md`).

| step | host call | notes |
|---|---|---|
| `golden` | (none) | Resolves the flavor's golden tree and backup (tickets 28, 30, 31). Both must be the slot's flavor and carry the same hash. On the real host: `baselineVerify` at the `golden` level, its `goldenHash`, and `golden\<key>\db\ootb.bak`; a golden that does not verify gives the slot back as `dirty`. |
| `quiesce` | `quiesce` | Stops the agent and the application pools and waits for the slot's processes (spike 06: the pool stop releases every lock and closes Aras's SQL sessions). Below. |
| `database` | `resetDatabase` | Restores the golden `db\ootb.bak` over the slot database as its owner, maps its users again and writes the marker (ticket 31, `docs/reset-database.md`). |
| `tree` | `resetTree` | Mirrors the golden tree, clears the runtime state, renders the configs, verifies, and writes a fresh stamp (ticket 30). Below. |
| `start` | `startSlot` | Starts the slot's pools and warms them (`Client/`, `Server/DBList.aspx`, OAuth discovery), without the agent (`docs/start-stop.md`; `get --agent` starts it). |
| `health` | `healthCheck`, `readStamp` | The health check must pass: server, tree, configs, marker, version, and `root`'s login with a one-time password, which is what makes the free slot's `root` and `admin` passwords random (`docs/health.md`). The stamp must carry the golden hash, no lease and a reset time. A failed check is retried once, then quarantines the slot with the checks named. |

Then the golden is read again: if its hash changed during the reset (a `baseline build -Replace`
promoted a new one), the slot goes back to `dirty`. Otherwise, under the lock, the slot moves
`resetting -> free` with the golden hash and the reset's duration (`last_reset_ms`, shown by `status`).

**Every step re-derives its target.** Before each attempt the worker re-reads the slot from the state
file: it must still be `resetting` under this worker's pid and start time, and its id must parse to
the flavor and number the record carries (ticket 10). The host driver runs its own guards on the
slot reference (`assertSlotOwned`). A worker that finds the slot is no longer its own (it was judged
dead and the slot was recovered, or an operator moved it) stops with outcome `lost` and calls the
host no more.

## The tree step on the broker (ticket 30)

`src/broker/reset-tree.ts`, through the same `SlotSystem` as provisioning (`docs/provision.md`); the Windows parts are
`slot-steps.ps1`'s `quiesce` and `reset-tree` steps, which derive every path from the flavor and slot number.

**`quiesce`** stops the slot's seven (12.x) or six (14.x) pools, each waited on until IIS reports it stopped, and its
agent service if it has one, then waits up to a minute for the slot's processes to end: its `w3wp.exe` (by pool name)
and anything started from the slot folder. From 14.0 the applications run out of process (`Aras.Server.exe` and the
like next to `w3wp.exe`; spike 07) and a pool stop does not wait for them, so after 30 s those are ended (they are the
slot's own). Anything still running after the wait fails the step `Retryable`, naming it. `app_offline.htm` is not
used: it frees the files but not the SQL sessions (spike 06). No per-file lock check: one took 390 to 725 s.

**`resetTree(slot, golden)`**, in order, the slot folder and its golden named by the slot record only:

| part | what it does | failure |
|---|---|---|
| `golden` | reads `golden\<key>\manifest.json`; its hash must be the `golden.hash` the reset began with | promoting, missing, unusable or another hash: `Retryable`; no slot folder: `Refused`; the slot's stored SQL login passwords gone: `Quarantine` (a reset never makes new ones; `repair --rebuild`) |
| `mirror` | refuses a slot that still runs anything (`Refused`: not quiesced); then `robocopy <golden>\tree <slot> /MIR /XJ /R:2 /W:1 /MT:16`. No `/XF`: robocopy matches it on the source side, so it cannot protect the slot's configs (spike 06), and the mirror takes the old stamp away with everything else golden lacks. Then the runtime state the mirror leaves: the whole runtime folders (`Innovator\Server\temp`, `dll`, `logs`) emptied, the vault folder `vaults\<key>-<NN>` emptied, and ASP.NET's temporary files of the alias removed. A link or junction is removed itself, never followed; a runtime folder or slot folder that is one fails the step. The runtime files golden itself holds (`jsBundles\data.json`, OAuth's SQLite file and keys, the 14.x server's data-protection key in `Innovator\Server\App_Data`) are golden's again after the mirror, and one golden lacks (the 14.x client's key, written at its first request) goes with it | robocopy 8 or more, a junction, no vault folder: `Retryable` |
| `configs` | the edit list rendered from golden's bytes with the slot's names, its stored login passwords and the line's stored `<License>` element (`docs/edits.md`), as a provision does | `Retryable` |
| `verify` | the `fast` verify of the slot tree against the golden manifest (`docs/manifest.md`), with the eight rendered files required present and each read back and compared with its rendering, byte for byte | any difference: `Quarantine`, with the counts and the first paths |
| `stamp` | `.arashouse-slot.json`: the slot id, flavor, golden manifest hash, the reset time, no lease. Only after the four parts before it succeed | `Retryable` |

Every part is idempotent, so the policy's retry runs the whole step again. A reset that fails before the stamp
leaves the slot with none, so neither `checkClean` nor `listSlots` can take it for clean. The quiesce is not lifted
here: the database step runs on the stopped slot, and the start (ticket 33) brings the pools up. The result's detail
gives the robocopy and clearing seconds, the counts cleared, the configs and each part's seconds.

The broker runs one provision, destroy, quiesce, tree reset or stamp write per slot at a time (`SlotLocks`); a second
is `Retryable`.

### Measured on the host (2026-10-27, `12sp9`)

Through firstmate's elevated gate: `setup-host.ps1 -Apply -UpdateBroker` installed a broker built from this ticket (exit
0), then a one-off proof script (exit 0) drove that broker through its Windows client on the throw-away slot `12sp9-30`,
golden `8668e889d5e4`, Defender on:

- `provisionSlot` 29.1 s; the slot served (`/Server/DBList.aspx` 200 listing only `arashouse_12sp9_30`).
- Dirtied as a lease would: a new file under `Innovator\Client`, a line appended to
  `Innovator\Client\BrowserCode\common\javascript\BrowserHelper.js`, 200 files in `Innovator\Server\temp`, a DLL
  deployed into `Innovator\Server\bin` (a copy of `Aras.Server.Core.dll` under a new name, after which `DBList.aspx`
  answered 500), and a vault file.
- `quiesce` **6.1 s** with the slot serving (1.3 s on a stopped slot); `resetTree` **4.2 s** on the broker, 4.4 s round
  trip: golden 0.1, mirror 1.6 (robocopy 0.2, clearing 0.2), configs 0.4 (8 files, 19 edits), the `fast` verify 1.1
  (23,760 files, green), stamp 0.0. Over the clean slot again: 3.7 s. So the tree half of a reset is about 10 s with the
  quiesce, most of it the pool stop and the verify.
- After it: every piece of dirt gone, the edited file equal to golden's, the stamp carrying the golden hash and no lease,
  all seven pools still stopped. Once the proof started them, `DBList.aspx` answered 200 in 8.3 s (the first request
  after the ASP.NET temporary files were cleared) listing only the slot's own database, and `/Client/` 200 in 2.1 s.
- The deny-list fingerprints (35 objects) were unchanged after the resets and again after the slot was destroyed
  (`destroySlot` 17.8 s, nothing left).

Not measured here: the same calls from WSL through `BrokerHost` (the next lane's broker build went on straight after),
and the database step (ticket 31).

## Failure

| what happened | what the reset does |
|---|---|
| A step throws `Retryable` (or any non-host error), or returns `ok: false` | Tries the step once more (every step is idempotent). A second failure quarantines the slot: `reset step <step> failed twice: <error>`. |
| A step throws `Refused` (a guard) or `Quarantine` | Quarantines at once: `reset step <step> was refused: <error>`. |
| The broker answers that it is still running another verb on the slot (`Retryable`, "is being provisioned, destroyed, started, stopped or reset already"; `isSlotBusy`) | Waits for it, polling every 2 s for up to 15 minutes, and does not count it as an attempt. A worker killed mid-reset leaves its broker verb running to its end (the broker does not know the caller died), so the reset that recovers the slot meets it: before ticket 35 that busy answer, twice within 1.5 s, quarantined a healthy slot. Past the 15 minutes it is a failure like any other. |
| The `golden` step throws `Retryable` (the build's `golden-build\<key>.promoting` marker is present: a new golden is being moved into place) | Gives the slot back as `dirty` at once, as for `Unreachable`, so no reset reads a half-moved golden. |
| A step throws `Unreachable` twice | Gives the slot back as `dirty` (the slot is not at fault) and stops; a later worker or `get` tries again, and this reset does not count toward the attempt cap. A lazy reset in `get` exits 6. |
| The slot's reset is started a 4th time after 3 workers died mid-reset (`MAX_RESET_ATTEMPTS`) | Quarantines it: `reset started 4 times without finishing`. |

A quarantined slot is never handed out. `arashouse repair <slot>` resets it from golden through the
same sequence; `repair --rebuild` first recreates its application and database shell (`docs/cli.md`). Reasons are redacted and at most 480 characters.

## Crash safety

The worker records its pid and process start time on the slot (`reset` in the state file, with the
attempt number). Anything that finds a `resetting` slot whose worker has ended treats it as `dirty`
(`recoverDeadResets`): a `get` that finds no free slot, and every worker before it starts. The start
time keeps a reused pid (after a reboot, say) from being taken for the dead worker. The attempt
number survives the recovery, so a reset that keeps dying is quarantined rather than retried forever.

## Concurrency: `max_resets`

At most `max_resets` resets run at once (default 2, `~/.arashouse/config.json`; `docs/governor.md`),
because a reset is I/O-bound on this laptop. Every reset starts through `beginReset`, which counts
the `resetting` slots with a live worker under the state lock. A refused worker exits; the running
ones drain the remaining dirty slots.

## The numbers behind the policy

Spike 06 (`docs/spike-06-reset-mechanics.md`) measured a 12.x reset at about 10 s with Defender on:
the pool stop ~0 s, the mirror 0.3–1.0 s, the restore 1.4–1.7 s, the first request after the start
2.1–2.5 s, plus small config writes and fix-ups. So a background reset after `return` keeps `get`
instant in the normal case, and a lazy reset in `get` costs about 10–15 s. VHDX or ReFS cloning is
not needed; if a reset ever routinely takes minutes, the same machine runs unchanged and a faster
mechanism is a new ticket.

## The CLI

`arashouse reset-worker [--slot <slot>]` is what `return` starts; it is not needed by hand. It prints
one line per slot it touched (`23-01 reset in 9.8 s; free`) and exits 5 if the named slot was
quarantined, 6 if the host did not answer. `ARASHOUSE_RESET_WORKER=off` stops `return` and `get`
from starting a worker (the tests use it); a lazy reset in `get --wait` still runs.
