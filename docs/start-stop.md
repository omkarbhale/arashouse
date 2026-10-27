# Starting and stopping a slot: `startSlot`, `stopSlot` and `get --agent`

Ticket 33. A slot's pools idle out on their own (ticket 25's short idle timeout), so an idle slot costs near nothing
and needs no stopping. `stopSlot` takes a slot fully offline; `startSlot` brings it back and warms it; the agent
service runs only for a lease that asked for it.

## The verbs

`src/broker/start-stop.ts` on the broker, through the same `SlotSystem` as provisioning (`docs/provision.md`) and
one `slot-steps.ps1 -Step start` or `-Step stop` process. Both refuse a slot that is not provisioned (no stamp) and run
one at a time per slot with `provisionSlot` and `destroySlot` (a second is `Retryable`).

| verb | what it does |
|---|---|
| `startSlot(slot, { agent })` | Starts each of the slot's pools `ah-<key>-<NN>-<role>` that is not running (waiting out a pool still stopping) and fails if one does not start. With `agent: true` it starts `ArasHouseAgent_<key>_<NN>` and waits until the service runs and something listens on the slot's agent port (`8800 + 100 x flavor index + NN`); a slot with no agent service is `Refused`. Then it requests `Client/`, `Server/DBList.aspx` and `OAuthServer/.well-known/openid-configuration` under `http://localhost/<alias>/` once each, together, with a 2-minute bound: any answer from 200 to 399 is warm; anything else makes the result `ok: false`, naming the URL. |
| `stopSlot(slot)` | Stops the agent service if the slot has one, then the slot's pools, and waits (up to a minute) until no `w3wp.exe` of the slot's pools is left; one that is left is `Retryable`. Idempotent. |

`stopSlot` is the quiesce the spike measured (spike record, section 4: stopping the pools frees every locked file and
closes Aras's SQL sessions), so the reset's `quiesce` (ticket 30) and `destroySlot` stop a slot the same way, and
`arashouse disable` calls it. A stopped pool does not start on a request (IIS answers 503), so a slot stays offline
until `startSlot`: the reset's `start` step, or `get --agent`.

**The agent.** No golden has one yet: every build ran with `INSTALL_AGENT_SERVICE=0`, so `service.json` says
`installed: false`, provisioning makes no service, and `startSlot` with `agent: true` is refused with "slot
`<id>` has no agent service: the `<flavor>` golden was built without one (ticket 33b)". Ticket 33b puts the agent in
the golden, renders its configuration (the slot's port and server URL) and adds its health endpoint to the check.

## `get --agent`

`arashouse get <flavor> --holder <task> --agent` leases a slot as `get` does, then calls `startSlot` with
`agent: true` once the lease is complete (stamp and credentials written). A plain `get` never starts the agent; the
reset stops it again after the lease. If the start fails or is not `ok`, the lease is abandoned like any other `get`
that cannot complete: its password is deleted and the slot goes `dirty` to be reset. A refusal (no agent) exits 7,
anything else 6.

## Safety

- The verbs act only on names derived from the slot record. `startSlot` takes one argument, a boolean `agent`, and
  `stopSlot` none, so a request cannot name a service, a pool or a path; any other argument is `Refused`, and so is
  a slot record that is not a registered flavor and number (`assertSlotOwned` on both sides of the pipe).
- `slot-steps.ps1` derives the service name again and checks it before it starts, stops or deletes a service
  (`Get-SlotService`): it must match `^ArasHouseAgent_[a-z0-9_]+$`, must not start with a deny-listed prefix
  (`ArasInnovatorAgent_`), and a service of that name must run a binary inside the slot's own folder. The captain's
  `ArasInnovatorAgent_*` services cannot be reached through either verb.
- The pools started and stopped are the slot's own, named from its alias and the pool roles.

## Measured on the host (2026-10-28)

Through firstmate's elevated gate, `setup-host.ps1 -Apply -UpdateBroker` installed a broker built from this ticket (exit
0). Then, as the worker from WSL, non-elevated, through `BrokerHost` on the throw-away slot `12sp9-97`:

- `provisionSlot`: 24.4 s (tree 13.7 s), as in `docs/provision.md`; no agent.
- `stopSlot`: 4.8 s (7 pools; no agent); again at once, 1.2 s.
- `startSlot` without the agent, from stopped: 12.5 s: pools 0.4 s, then the warm-up, `Client/` 200 in 1.8 s,
  `OAuthServer/.well-known/openid-configuration` 200 in 3.9 s, `Server/DBList.aspx` 200 in 12.0 s (the server's cold
  start). The agent was not started.
- `startSlot` with the agent: `Refused`, "slot 12sp9-97 has no agent service: the 12sp9 golden was built without one
  (ticket 33b)".
- Four raw requests naming `ArasInnovatorAgent_ArasInnovatorAgent12` were all `Refused` by the broker before any
  step ran: as a `startSlot` argument ("startSlot takes only "agent", not "service""), as a `stopSlot` argument
  ("stopSlot takes no arguments"), as a slot's flavor ("the slot record is not a registered (flavor, number)"), and as
  a flavor target ("stopSlot needs a slot").
- `destroySlot`: 23.6 s (stop 9.0 s); nothing of the slot left, the deny-list unchanged.

The warm-up runs on the broker, so it does not depend on reaching the slot from WSL; in this run the WSL-side address
discovery (`docs/slot-url.md`) found no address that answered, which is the health check's concern (ticket 32).

## Not here

- The agent in the golden, its configuration and its health endpoint (ticket 33b).
- `sc sdset` with `(A;;LCRPWP;;;<user SID>)` would let a non-admin start and stop a slot's service without the broker
  (spike record); nothing uses it, since the broker does it.
