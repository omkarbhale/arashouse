# Leases: get, return, status

`src/core/lease.ts` is the lease core, modelled on `treehouse get/return/status`. There is no daemon:
every operation takes the state lock (`src/core/store.ts`), reads the state and writes it back. The
CLI that wraps it is in `docs/cli.md`; the reset that makes a returned slot free again is
`docs/reset.md` (ticket 14).

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever
> took the lease before giving it back."
> "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned
> up. The rest is implementation detail."

So `return` marks the slot `dirty`, starts a detached reset worker and exits. A returned slot is never
handed out until it is `free` again; whoever returns a lease may assume its slot is gone.

## `getLease(deps, { flavor, holder, waitSeconds })`

1. Reads the state and takes the lowest-numbered `free` slot of the flavor. `dirty`, `resetting`,
   `quarantined`, `provisioning` and `disabled` slots are never handed out.
2. **Dirty check**, before the slot is touched (`checkClean`, ticket 32): the host's stamp, the database marker
   the health check reads and the state record must agree on the golden hash, the stamp must name no lease, the
   stamp's and the marker's reset times must be no earlier than the end of the slot's last lease
   (`last_lease_ended_at` in the state, written when the slot leaves `leased`), and the host's `healthCheck` must
   pass (`docs/health.md`). A slot that fails is marked `dirty` (with the reason in the event log) and the next one
   is tried. A `Quarantine` host error quarantines the slot; a `Retryable` one skips it for this attempt.
3. The host's free RAM is asked (`hostInfo`) and the governor gives a first answer on the unlocked
   state, so a caller it refuses does not probe a slot. Under the lock, the governor is asked again and the slot moves `free -> leased` with a fresh lease id
   (128 bits, hex), provided it is still the same free slot that was checked. Two concurrent `get`
   calls therefore never receive the same slot: the loser looks again.
4. After the reservation: a password is generated (128 bits, URL-safe) and stored in the secret store
   as `lease-<lease_id>`; the slot's stamp is written with the lease id (so `doctor --rebuild-state`
   can recover the lease); the host sets the credentials from the handle (`setLeaseCredentials`:
   `root` and `admin` get the password, `docs/lease-credentials.md`; an answer that is not `ok` fails
   the lease too); the
   URL is looked up. If any of this fails the lease is abandoned: the password is deleted and the slot
   goes to `dirty` (or `quarantined` for a `Quarantine` error, and a reset worker is started for a
   dirty one), and the call fails with the error's code.
5. Two `get` calls from one holder get two slots. `status` shows the holder on each.

When no slot can be handed out: `--wait 0` (the default) fails at once with exit 3 and a message such
as `no 12sp9 slot is free: 3 slots, 1 leased, 1 resetting, 1 quarantined`; `--wait N` takes a queue
ticket, polls the state every second for up to N seconds and fails with the same message if none
appears. When none is free but one is `dirty`, `get` resets it (`docs/reset.md`): itself, and waits
on it, with `--wait N`; through a detached worker, failing at once with `...; 12sp9-02 is being
reset`, without.

**The governor** (`docs/governor.md`): `max_active` leased slots across all flavors, the host's
`min_free_ram_mb`, and the `get --wait` queue served in ticket order. A refusal reads, for example,
`max_active 3 reached (3 leased): no 23 slot can be leased now` and exits 3.

### `get --json`: `docs/schemas/get.schema.json`

```json
{ "slot": "23-02", "flavor": "23", "aras": "14.0.9.36073", "engine": "14.0.7",
  "url": "http://172.19.0.1/ah-23-02", "database": "arashouse_23_02", "user": "root",
  "lease_id": "<32 hex>", "holder": "<task>", "password": <shown once, a string> }
```

`aras` is the flavor's server build from the registry (null for a flavor whose build is not known; none today). The password is a `Secret`
inside the core; `renderGetJson` is the one place it becomes text, and it is in no other output, file
or log.

## `returnLease(deps, { target, ifLeaseId, waitSeconds })`

- `target` is a lease id, or a slot id plus `ifLeaseId`. A slot name without the lease id is refused
  (exit 2): a stale caller must not be able to return a later lease of the slot.
- **ABA protection.** If the slot is leased and its lease id is not the one passed, the call exits 4
  and changes nothing (not even the event log). If the slot is no longer leased (returned, being
  reset, free), the caller's lease is already returned.
- Marks the slot `dirty`, deletes the lease's password from the secret store, starts a detached
  reset worker (`arashouse reset-worker --slot <slot>`, `docs/reset.md`) and returns. It does not call
  the host and does not reset. The slot's stamp keeps the lease id until the reset rewrites it.
- Returning twice is a no-op, exit 0, message `already returned`. So is returning a lease id the state
  does not hold.
- `waitSeconds` (the CLI's `--wait`) blocks until the slot is `free` again (or was leased again, which
  means it passed through `free`), for scripts and tests. A slot that is quarantined or disabled, or
  not free within the time, exits 5. The worker `return` started does the reset.

## `leaseStatus(deps)` / `status --json`: `docs/schemas/status.schema.json`

One row per slot (status, flavor, holder, lease age, last reset duration, the quarantine reason),
totals per flavor, `max_active` (limit and leased slots), `max_resets` (limit and resetting slots),
and the live `get --wait` queue (ticket, flavor, holder, when queued). It reads without the lock. It carries no
password and no full lease id: the `lease` column is the first 8 characters, enough to tell leases
apart but not to return or run against one. The state file and the events log hold no password either
(the events log shows a lease id as its first 8 characters).

## Exit codes

Stable; `docs/cli.md` repeats them. `src/core/exit-codes.ts` is the source.

| code | meaning |
|---|---|
| 0 | ok (including `already returned`) |
| 1 | any other failure |
| 2 | usage: unknown flavor, bad holder or wait, `return` by slot name without `--if-lease-id` |
| 3 | no slot available (none free, or the governor refused) |
| 4 | lease mismatch: `return --if-lease-id` named a lease the slot no longer holds |
| 5 | reset failed: the slot is quarantined or disabled, or a `return --wait` timed out |
| 6 | host unreachable (a `Unreachable` or `Retryable` host error) |
| 7 | refused by a guard (a `Refused` host error) |
| 8 | a step needs a secret and no TTY can ask (`licence.ts`) |
