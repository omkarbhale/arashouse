# Bootstrap step 3: package imports onto a lease (`get --import`, `import`)

Ticket 41. The captain's ask: "Perhaps a optional database restore, followed by import/codetree deployments. This is
similar to worktree in that sense." This step is the imports: a lease can be brought to a working state at checkout by
importing package manifests onto it with import-export-libs-js (`aras-pkg`), which needs Node 20 or newer and no .NET.
It runs as a child of the CLI's Windows process, natively and from WSL alike. Source: `src/cli/import.ts`; the CLI
surface is in `docs/cli.md`.

> "The philosophy is that Aras are disposable, and anything durable should be taken out by whoever took the lease before
> giving it back."

So `--import` takes packages created by libs-js's own `aras-pkg export`: a holder exports from one lease and imports into
another, the "extract, then bring back" loop.

## Usage

```
arashouse get <flavor> --holder <task> [--json] --import <manifest|folder> [<import options>] [--import ...]... [--keep-on-fail]
arashouse import --lease <lease_id> <manifest|folder> [<import options>] [<manifest|folder> [<import options>]]...
```

`<manifest|folder>` is an `imports.mf` or the folder that holds one. The imports run in the order given, after the lease is
taken (and after its agent is started, with `--agent`); the options after an `--import` (or after a manifest, for
`import`) are that import's. The first import that fails stops the run: the ones after it are not started.

Each import is one child process, started as `arashouse run` starts one:

```
aras-pkg import <manifest> --url <lease url> --database <lease database> --user root --log <log> --engine <engine> [options]
```

with `ARAS_URL`, `ARAS_DATABASE`, `ARAS_USER`, `ARAS_PASSWORD`, `ARASHOUSE_SLOT`, `ARASHOUSE_FLAVOR` and `ARAS_PKG_ENGINE` in
its environment only. The password is never a flag (libs-js has none) and never a file. aras-pkg's own output goes to
stderr, through `redact`, so `get --json` keeps stdout for the lease contract.

| import option | passed as | |
|---|---|---|
| `--merge`, `--no-merge` | the same | merge into existing items, or skip them (aras-pkg's default) |
| `--release <text>`, `--description <text>` | the same | the DatabaseUpgrade rows' `target_release` and description |
| `--package <name>` (repeatable) | the same | only these packages of the manifest |
| `--os-user <name>` | the same | the rows' `os_user` |
| `--languages <codes\|*>` | the same | engine `14.35` only |
| `--collect-errors`, `--batch` | the same | engine `14.35` only |
| `--timeout <ms>` | `--timeout=<ms>` | 0 keeps the engine's default, -1 waits for ever |
| `--engine <version>` | replaces the flavor's | `12.0`, `14.0.7` or `14.35` |
| `--skip-version-check` | the same | refused unless the import names `--engine` |

The global `--verbose` also passes `--verbose` to aras-pkg.

### Checked before the lease is taken

So a mistake costs no slot (exit 2), as libs-js's CLI checks before it sends anything:

- the manifest exists (a folder must hold `imports.mf`);
- `--languages`, `--collect-errors` and `--batch` on an engine other than `14.35` (libs-js refuses them too);
- `--skip-version-check` without `--engine`: an engine run against a server outside its window is a bug here;
- an `ARAS_PKG_ENGINE` in the caller's environment that is not the flavor's engine, unless the import names `--engine`;
- an `--engine` that is not one of the three, `--merge` with `--no-merge`, a `--timeout` that is not a whole number, an
  import option before any `--import`, and `--keep-on-fail` without `--import`.

`aras-pkg` itself must be found (exit 1 otherwise, with no lease taken).

## The engine per flavor

From the flavor registry (`src/core/flavors.ts`, `libsJsEngine`); `get` passes it as `--engine`, so it wins over any
`ARAS_PKG_ENGINE` the child inherits.

| flavor | server | engine |
|---|---|---|
| `12sp9` | 12.0 SP9, 12.0.0.24090 | `12.0` |
| `23` | Release 23, 14.0.9.36073 | `14.0.7` |
| `35` | Release 35, 14.35.0.43890 | `14.35` |

## Where aras-pkg comes from

`ARASHOUSE_APKG`, a path to the libs-js CLI (a checkout's `dist/cli.js`, run with the Node that runs arashouse, or any
executable), else `aras-pkg` on `PATH`. `arashouse doctor` reports which, and its `--version` (a `warn` when there is none:
only `get --import` and `import` need it).

Node starts no `.cmd` without a shell, so on Windows an npm shim is followed to its script, which this Node runs:
`ARASHOUSE_APKG` may name libs-js's `aras-pkg.cmd`, and on `PATH` `aras-pkg.cmd` (then `aras-pkg.exe`) is what is
looked for. From WSL the launcher passes `ARASHOUSE_APKG` on as its Windows path, and when it is not set, `aras-pkg` on
WSL's `PATH` when that is a link to libs-js's `dist/cli.js`, which the Windows Node then runs from `\\wsl.localhost`
(`docs/windows-native.md`).

**Pinned:** import-export-libs-js commit `c920b429` ("allow the live test, the oracle and parity to run on an arashouse
lease", #95; package version `0.0.0`), built with `npm ci && npm run build`. That is the commit this ticket was proven with
on the host (below).

## Logs

Each import's libs-js log goes to `$ARASHOUSE_HOME/logs/<lease_id>-import-<n>.log` (in the state home, the worker user's; 0700 outside Windows), `n` counting on from
the lease's earlier imports, so `arashouse import` after `get --import` does not overwrite a log. libs-js never writes the
password to its log ("Connection and credentials" in its README). `get --json` lists each import as
`{ manifest, exit_code, log }` under `imports` (`docs/schemas/get.schema.json`).

## A failed import

aras-pkg exits 0 when done, 1 when it failed, 2 when it finished but the engine reported errors, 64 on a usage error. Any
code but 0 fails the import, and the run stops there.

- **`get --import`** is atomic by default: the lease is returned (the slot is reset as after any `return`, before it is
  handed out again) and `get` exits **9**, with aras-pkg's exit code and the log's path on stderr. Nothing is printed on
  stdout: the lease is gone.
- **`get --import ... --keep-on-fail`** keeps the lease so a human can look: it prints the lease as usual (with `imports`,
  the last one failed) and still exits 9.
- **`import --lease`** exits 9 and keeps the lease: it is the holder's.

An import that cannot start at all (aras-pkg missing after the checks) returns the lease too.

## Host proof (2026-10-28)

`test/host/e2e-import.ts`, run by `test/host/e2e-import.test.ts` (`ARASHOUSE_TEST_IMPORT=1`; the variables are in its
header), from WSL, non-elevated, against the installed broker and the pool's free slots, with libs-js `c920b429`.

### What it checks, per flavor

1. `get <flavor> --json --import <folder>` of libs-js's own `s1-base` fixture for the flavor's engine
   (`fixtures/<engine>/import/s1-base/step-1/input`, package `LIBSJS-SCRATCH-BASE`, 19 item files); the lease reports the
   flavor's engine and the log is `$ARASHOUSE_HOME/logs/<lease_id>-import-1.log`. Then `arashouse run --lease <id> --
   aras-pkg export --package LIBSJS-SCRATCH-BASE`, and the export must hold the same item files, each with the same id.
2. `get <flavor> --json --import <good> --import <bad>`: `good` adds one `LIBSJS-SCRATCH-I41-<tag>` Variable, `bad` names a
   package folder that is not there (the engine fails it and marks its DatabaseUpgrade row failed). The get must exit 9, print nothing on stdout, name aras-pkg's exit code and the second
   log, and return the lease. Once that slot is `free` again it is leased again: the Variable and its PackageDefinition are
   gone.
3. The lease passwords are in none of `state.json`, `events.log`, `logs/*`, `leases/*`, the run's libs-js logs or anything
   the CLI printed (except `get --json`'s stdout).

### Results

Run 3 (2026-10-28 02:13Z to 02:26Z), the run of record: **every check passed for all three flavors**, while a libs-js
parity run held `12sp9-01` alongside. Each step is a line in `<ARASHOUSE_E2E_OUT>/import-<flavor>.log` and `.json`.

| flavor | engine | 1. `get --import` s1-base | export vs import | 2. `get --import good --import bad` | slot reset | Variable and package gone | 3. password found in |
|---|---|---|---|---|---|---|---|
| `12sp9` | `12.0` | exit 0, 33.0 s (`12sp9-02`) | 19 of 19 item files, ids equal | exit 9, 28.4 s, lease of `12sp9-03` returned | free in 70.5 s | yes | none of 94 places |
| `23` | `14.0.7` | exit 0, 57.7 s (`23-01`) | 19 of 19, ids equal | exit 9, 60.8 s, `23-02` returned | free in 54.9 s | yes | none of 83 places |
| `35` | `14.35` | exit 0, 58.3 s (`35-01`) | 19 of 19, ids equal | exit 9, 50.4 s, `35-02` returned | free in 55.0 s | yes | none of 85 places |

The `get --import` times include taking the slot (a lazy reset when no slot was free) and the import itself.

Earlier runs, for the record: run 1 passed step 1 on `12sp9` and `23`, but its step-2 scratch Variable name was 34
characters and the server refused it ("String or binary data would be truncated": a Variable's name holds 32), so the
first import failed instead of the second; the get still exited 9 and returned the lease. Run 2, on a loaded host, passed
step 1 on `12sp9` and `35` and step 2's exit 9 on `35`, and lost the rest to WSL interop timeouts reaching the broker
(exit 6, `UtilAcceptVsock: accept4 failed 110`); the proof now retries a `get` that fails that way before any import
started.
