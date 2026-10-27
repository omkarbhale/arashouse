# The reset policy: when a slot is reset

`src/core/reset.ts` (ticket 14), over the state store and the host driver. The captain's words:

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever
> took the lease before giving it back."
> "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned
> up. The rest is implementation detail."

**The invariant:** a slot that `get` hands out is always clean. **When** the reset runs is a choice,
and it is not "return wipes at once". The holder's duty is to take out anything durable before
returning (ticket 43 gives it helpers); after `return` the holder may assume the slot is gone.

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
4. **Dirty detection before handing out** (belt and braces, `checkClean` in `lease.ts`; ticket 32
   owns the markers): a `free` slot is handed out only if its stamp carries the golden hash the state
   recorded, names no lease, records a reset time, and the host's health check (tree and database
   marker against the stamp, applications online) passes. A slot that fails goes to `dirty` and is
   reset first: by the same `get` if it waits, by a worker otherwise.

A slot whose `get` failed after it was reserved (a host error while writing the lease's stamp or
credentials) also goes to `dirty`, and a worker is started for it.

## The sequence

Each step is a host-driver call (ticket 12). The same sequence runs in the worker, in `get`'s lazy
path, and later in `repair` (ticket 16).

| step | host call | notes |
|---|---|---|
| `golden` | (none) | Resolves the flavor's golden tree and backup (tickets 28, 30, 31). Both must be the slot's flavor and carry the same hash. |
| `quiesce` | `quiesce` | Stops the agent and the application pools (spike 06: the pool stop releases every lock and closes Aras's SQL sessions). |
| `database` | `resetDatabase` | Restores the golden backup and fixes it up (ticket 31). |
| `tree` | `resetTree` | Mirrors the golden tree and writes a fresh stamp (ticket 30). |
| `start` | `startSlot` | Brings the applications online, without the agent (ticket 33 owns the agent). |
| `health` | `healthCheck`, `readStamp` | The health check must pass, and the stamp must carry the golden hash, no lease and a reset time (ticket 32). |

Then, under the lock, the slot moves `resetting -> free` with the golden hash and the reset's
duration (`last_reset_ms`, shown by `status`).

**Every step re-derives its target.** Before each attempt the worker re-reads the slot from the state
file: it must still be `resetting` under this worker's pid and start time, and its id must parse to
the flavor and number the record carries (ticket 10). The host driver runs its own guards on the
slot reference (`assertSlotOwned`). A worker that finds the slot is no longer its own (it was judged
dead and the slot was recovered, or an operator moved it) stops with outcome `lost` and calls the
host no more.

## Failure

| what happened | what the reset does |
|---|---|
| A step throws `Retryable` (or any non-host error), or returns `ok: false` | Tries the step once more (every step is idempotent). A second failure quarantines the slot: `reset step <step> failed twice: <error>`. |
| A step throws `Refused` (a guard) or `Quarantine` | Quarantines at once: `reset step <step> was refused: <error>`. |
| A step throws `Unreachable` twice | Gives the slot back as `dirty` (the slot is not at fault) and stops; a later worker or `get` tries again. A lazy reset in `get` exits 6. |
| The slot's reset has been started more than 3 times without finishing (`MAX_RESET_ATTEMPTS`) | Quarantines it: `reset started 4 times without finishing`. |

A quarantined slot is never handed out. `arashouse repair <slot>` (ticket 16) re-provisions it from
golden. Reasons are redacted and at most 480 characters.

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
