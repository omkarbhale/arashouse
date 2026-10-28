# Capacity: three leases at once on the laptop

Ticket 38. The captain's expectation, answer 1: "3 most I would guess". This page proves three leases work at once on
this laptop, that a fourth and a burst of returns are handled, that a broker killed mid-lease or mid-reset leaves a pool
`doctor --fix` puts right, and it records the memory three busy leases take. It confirms or changes the governor's
defaults (`docs/governor.md`).

## The races, offline: `test/races.test.ts`

Several `arashouse` processes at once on the v1 pool (`12sp9` x3, `23` x2, `35` x2) against the fake host
(`ARASHOUSE_HOST=fake`), sharing only the state file and its lock, as workers on the laptop share it. Each process
builds its fake host from the state when it starts. A `slow` fault in `ARASHOUSE_FAKE_FAULTS` waits that long in real
time there (`LiveClock.elapse`), so the resets of several reset workers overlap as they do on the host.

| test | what it proves |
|---|---|
| four gets at once, three flavors (`12sp9`, `23`, `35`, `12sp9`) | three distinct slots and lease ids; the fourth exits 3, `max_active 3 reached (3 leased)` |
| four gets at once, one flavor (`12sp9` x4) | three distinct slots; the fourth exits 3, `no 12sp9 slot is free: 3 slots, 3 leased` |
| a fourth `get --wait` behind three leases | it stands in the queue; when one lease is returned it takes that slot, only after the slot's reset ended `free` |
| three returns at once, and a `get 12sp9 --wait` 0.3 s into the burst (each reset step 1.5 s) | the most resets running at once is `max_resets` (2), with the third slot waiting `dirty` meanwhile; the `get` gets a slot whose reset ended after its last lease; every slot ends `free` and `doctor` passes |
| a reset whose worker died (its host call never answered), then the host gone while a lease is held | with the host gone, `doctor --fix` fails "broker: did not answer" and a `get` exits 6, and the lease is untouched; with the host back, `doctor --fix --yes` restarts the dead reset, the slot ends `free`, and the lease is the same one (id and holder) and `run --lease` still works |

**Ten times in a row.** `for i in $(seq 1 10); do npx vitest run test/races.test.ts || break; done` passed all ten
runs (2026-10-28, on the laptop's WSL, about 27 s each).
