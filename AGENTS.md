# arashouse

A TypeScript tool that keeps a pool of **disposable, per-version Aras Innovator instances** (code tree + IIS application + SQL database) on the captain's laptop and leases them to workers, like `treehouse` leases worktrees. Flavors: `12sp9`, `23`, `35`.

## Governing principle

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever took the lease before giving it back."

Returning a lease discards everything. The leaseholder extracts exports, code and data first; arashouse never preserves lease state.

> "It doesn't necessarily clean it up ON freeing the lease, but the worker can assume it has cleaned up. The rest is implementation detail."

So a reset may run at return time, in the background, or lazily before the next lease, provided a newly leased slot is always clean.

## Rules

1. **No secrets, anywhere.** Never print, log, commit or put in an argument list a credential: the SQL `sa` password, a licence key, a per-lease Aras password, a token, a hash. Redaction is tested; the secret store is its own module (ticket 23).
2. **Never touch the captain's systems.** Never touch, list, back up, restore over or contact `OLM_Local`, olm, prod, or the captain's existing Aras installs. The deny-list lives in `src/core` (ticket 10); everything the tool touches must match an allowlist.
3. **Offline first.** Lease logic is tested against the fake host driver (`src/host`, ticket 12). Windows-side behaviour is tested on the host and the result recorded in `docs/`.
4. **No Aras code and no vendor binaries in the repo.** Installers, `.bak` files and licence material stay in the ignored `media/<flavor>/` of the main checkout (see `media/README.md`); `test/tracked-files.test.ts` fails if any are tracked.

## Layout

- `src/core/`: flavors, names, guards, state, lease logic. Pure; no I/O to Windows.
- `src/host/`: the host-driver contract, the fake driver, the broker client.
- `src/broker/`: the Windows side (`arashouse-broker`, the admin service).
- `src/cli/`: the WSL CLI (`arashouse`).
- `spike/`: PowerShell scripts for the captain-assisted slice 0 sittings.
- `docs/`: design notes, spike record, runbook.
- `test/`: vitest tests (`src/**/*.test.ts` also run).

## Commands

Node 20 or newer. ES modules; TypeScript with `NodeNext` resolution, so relative imports end in `.js`.

- Setup: `npm install`
- Build: `npm run build` (emits `dist/`)
- Test: `npm test`
- Lint / typecheck: `npm run lint` (an alias of `npm run typecheck`; there is no separate linter)
