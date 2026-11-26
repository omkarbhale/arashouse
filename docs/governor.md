# The resource governor

`src/core/governor.ts`, with the limits in `src/core/config.ts`. The captain's answer on the host:

> "i doubt we need a lot of aras' in parallel. 3 most I would guess, or more, just that we need the
> disposable aspect of it."

So the governor, not the slot count, is what protects the laptop. It has three rules.

## The config: `config.json` in the state home

Next to the state file, `%LOCALAPPDATA%\arashouse\config.json` on Windows (`$ARASHOUSE_HOME` moves both). Every key is
optional; a missing file is the defaults. An unknown key is refused, so the file holds limits, and where the media is,
and nothing else.

| key | default | what it limits |
|---|---|---|
| `max_active` | 3 | slots `leased` at once, all flavors |
| `max_resets` | 2 | resets running at once (a reset is I/O-bound on the laptop) |
| `min_free_ram_mb` | 2048 | `get` hands out no slot while the host has less free RAM |
| `min_free_disk_gb` | 10 | a provision or a baseline build does not start with less free disk at the install root |
| `slots_per_flavor` | `12sp9` 3, `23` 2, `35` 2 | the pool provisioned for each flavor (ticket 37) |
| `media` | none | not a limit: the folder holding the per-flavor media folders, as an absolute path; after `ARASHOUSE_MEDIA`, before the arashouse checkout's `media/`. A copy outside a checkout (vendored) needs it or `ARASHOUSE_MEDIA` |

```json
{ "max_active": 3, "min_free_ram_mb": 3072, "slots_per_flavor": { "35": 1 } }
```

**Where the defaults come from.** `min_free_ram_mb` is one active slot's memory: the design's planning
figure of about 2 GB per active slot (worker process ~1 GB, other pools, the agent and a share of SQL's
buffer). The OS and SQL are already running and counted in the host's free RAM, so each lease adds
about 2 GB on top. At design time the laptop had 5–6 GB free with a 12.3 GB, uncapped WSL VM, so the design expected
about two leases to fit before this gate held a third. Measured, a busy slot is 0.7 to 1.1 GB, not 2 GB
(tickets 06 and 38), and ticket 38 confirmed these defaults on the host without a WSL cap: three busy leases
with every other slot warm left at least 2,482 MB free (`docs/capacity.md`). A WSL VM cap is the operator's
choice (`arashouse doctor` prints it as advice; ticket 55, `docs/host-tuning.md`).
`min_free_disk_gb` is about two slots' worth (the design's 4–5 GB per slot); disk is not binding on the
laptop (221 GB free at design time).

## Rule 1: `get` and `max_active`, RAM and the queue

Before it hands out a slot, `get` asks the host for its free RAM (`hostInfo`) and the governor decides,
first on the unlocked state (so a refused caller does not probe a slot) and again under the state lock,
immediately before the slot is marked `leased`. In order:

1. **RAM.** Under `min_free_ram_mb` the answer is no: `the host has 1500 MB of free RAM, under
   min_free_ram_mb 2048`.
2. **`max_active`.** It counts `leased` slots only; a `resetting` slot counts toward `max_resets`
   instead. At the limit: `max_active 3 reached (3 leased)`.
3. **The queue.** A `get --wait N` caller takes a ticket in the state file (`queue`, with
   `next_ticket`) when it starts, and leaves it when it is leased, gives up or fails. Callers are
   served in ticket order: each earlier waiter whose flavor has a free slot takes one of the remaining
   `max_active` places and one of those free slots, and the caller goes only if a place and a free slot
   of its flavor are left over (`2 earlier waiters ahead in the queue`). A waiter whose flavor has
   nothing free does not hold up a caller who can use a slot now. A `get` without `--wait` holds no
   ticket and stands behind every waiter, so it cannot jump the queue.

Without `--wait` a refusal exits 3 with the reason (`...: no 23 slot can be leased now`). With `--wait`
the caller keeps polling: when a lease is returned and its slot's reset completes, the first waiter
for that flavor gets it.

**A waiter that is gone.** A ticket records the waiter's pid and liveness token (the process start time on Linux, its
named-pipe beacon on Windows; `docs/reset.md`, "Crash safety"), and when its wait
runs out (plus 30 s of grace). A ticket whose process has ended, or whose wait has run out, no longer
holds a place, and the next `get` that leases a slot drops it from the file (`queue-leave` in the
events log, reason `gone`). The events log records every `queue-join` and `queue-leave`.

## Rule 2: the reset cap, `max_resets`

`beginReset(store, slot, { pid, maxResets })` is the only way into `resetting`: under the state lock
it moves a `dirty` slot to `resetting` for the worker `pid` only while fewer than `max_resets` resets
are running, and otherwise refuses (`max_resets 2 reached (2 resetting)`), leaving the slot `dirty`
for a later try. A `resetting` slot whose worker process has ended (by its pid and liveness token) does
not count, and is recovered as `dirty`. The reset worker and `get`'s lazy reset start every reset
through it (`docs/reset.md`).

## Rule 3: the disk gate, `min_free_disk_gb`

`checkDiskForBuild(host, config)` asks the host for free disk at the install root and refuses under
`min_free_disk_gb`. A provision (ticket 25) and a baseline build (ticket 24) call it before they start.
A lease needs no disk, so `get` does not ask.

## `status`

`status --json` (`docs/schemas/status.schema.json`) shows `max_active` (limit, leased),
`max_resets` (limit, resetting) and the live queue (ticket, flavor, holder, when queued).
