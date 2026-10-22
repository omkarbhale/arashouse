# The host driver

Every effect on Windows goes through `HostDriver` (`src/host/driver.ts`), so lease and reset logic is
tested without Windows. Two implementations: `FakeHost` (`src/host/fake.ts`, offline) and `BrokerHost`
(the broker client, ticket 20 and the verb tickets).

- Each call takes a resolved slot record (or a flavor), never a user string, and runs the guards first
  (`src/host/owned.ts`: `assertSlotOwned`, `assertStagedPath`, `assertGoldenPath`, `assertFlavorOwned`).
- Each call returns `{ ok, ms, detail }` or throws a `HostError` of kind `Retryable`, `Quarantine`,
  `Refused` or `Unreachable`. A guard refusal is `Refused`. `healthCheck` and `baselineVerify` report a
  failure as `ok: false`, not as an error.
- A secret is never an argument: `setLeaseCredentials` takes a `SecretRef` handle (ticket 23).

## FakeHost

In-memory slots; a `FakeClock` the test moves; `injectFault` (`fail` on the Nth call with a chosen error
kind, `slow` by N ms, `hang` until `releaseHangs()`), `setReachable(false)`, `dirty(slot, part)`,
`inspect(slot)`, and `calls` / `callLog`, a record of every call in order (credential handles are
recorded as `[handle]`).

## Contract suite

`test/host-contract.ts` exports `hostContractSuite(label, make)`. `test/host-contract.test.ts` runs it on
`FakeHost`. Tickets 25 and 35 run the same suite on the real host by importing it from their own
`*.test.ts` and returning a `ContractHarness` (host, root, a free slot, the golden refs, and optional
`failNext` / `dirtyTree` hooks; the tests that need a hook are skipped where it is absent).
