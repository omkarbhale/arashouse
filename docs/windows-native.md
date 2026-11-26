# arashouse on Windows, natively (and from WSL through the launcher)

arashouse runs on Windows Node. The CLI, the pool's state and every pool process (the CLI, the reset workers it starts)
are Windows ones; the broker is reached in the same process; WSL is not involved in any pool operation. `arashouse` typed
in WSL is a launcher that runs the same build on the Windows `node.exe`, so firstmate lanes and libs-js lease as they did.
A copy of the build can be vendored into another Windows tool (aras-mr-envs) and run from there by relative path.

The estimate and the choice behind this are the ahwin-estimate report (option B, one Windows implementation, with the
WSL launcher; not two implementations sharing one state).

## How it works

```
Windows (the worker user, unelevated)
  node dist\cli\index.js <command>            state: %LOCALAPPDATA%\arashouse\  (state.json, events.log, config.json,
     │                                                                            leases\, logs\, recipes\)
     │  host calls, in this process: token from C:\aras_installations\broker\client.token, request down the pipe
     └─ \\.\pipe\arashouse-broker ── ArasHouseBroker (service, NT SERVICE\ArasHouseBroker): IIS, SQL, trees, DPAPI
     reset workers: detached Windows processes of the same build; liveness = pid + a named-pipe beacon

WSL
  arashouse <command>  (dist/cli/index.js, the launcher)
     └─ interop: node.exe %LOCALAPPDATA%\arashouse\runtime\<build>\dist\cli\index.js <command>
        (the first launch of a build copies it there, through dist\launcher\windows-entry.js read from \\wsl.localhost)
     run --lease: the command runs in WSL with the environment `env --lease <id> --json` gives
```

| piece | natively | from WSL (the launcher) |
|---|---|---|
| the CLI | `node <arashouse>\dist\cli\index.js` | `arashouse` (`dist/cli/index.js`), which starts the Windows build |
| the state | `%LOCALAPPDATA%\arashouse` (`ARASHOUSE_HOME` overrides; it must be on a Windows drive) | the same Windows folder |
| the broker | the pipe, in the CLI's process (`pipeTransport`, about 4 ms a call) | the same (the Windows process calls it) |
| paths you give (`--code`, `--restore`, `--to`, `--bootstrap`, manifests, `--out`) | as given; relative to the working folder | `/mnt/c/x` is `C:\x`; any other path is read through `\\wsl.localhost\<distro>\` |
| slot URLs | `http://localhost/ah-<flavor>-<NN>` | `http://<gateway>/ah-...` in NAT mode (Windows reaches its own gateway address too), `localhost` when mirrored |
| `run --lease <id> -- <cmd>` | `<cmd>` runs on Windows (a `.cmd` or `.bat` is refused: run `node <its .js>`, or `powershell.exe -File`) | `<cmd>` runs in WSL, as before |
| `get --password-fd <n>` | refused: use `get --json` | kept in WSL: the password goes to WSL's descriptor `<n>` |

### Process liveness: the beacon

Every lock, reset-worker record and `get --wait` ticket names its process by pid and a token that tells a reused pid
from the holder. On Linux the token is the process's start time from `/proc`. Windows reuses pids quickly and has no
`/proc`, so each arashouse process there listens on a named pipe of its own, `\\.\pipe\arashouse-live-<pid>-<random>`,
before its first lock, and records `pipe:<random>`. The pipe is listed in `\\.\pipe\` (a 1 ms synchronous listing)
while the process runs and is gone the moment it ends, whatever ends it. A record without a beacon (written by an older
build, or another OS) is judged dead on Windows. The state file's format is unchanged: `start_time` was already an
opaque string. (`src/core/lock.ts`.)

### NTFS

NTFS will not replace or link over a name another process has open or is deleting, and an antivirus scanner may hold a
fresh file for a moment (`EPERM`, `EBUSY`). The state file's rename is retried for up to 15 s on Windows; reads and deletes (the state
read, the lock's release and unlink, the lease files) for up to about 2 s, so a real access denial fails fast. A `status` reading `state.json` while a writer replaces it is the
common case. `test/races.test.ts` and the store's concurrency tests run on `windows-latest` in CI.

### The state home and its privacy

On Linux the lease files are 0600 in a 0700 folder. On Windows a mode is not access: the home's ACL is, and
`%LOCALAPPDATA%` inherits the worker user, SYSTEM and the administrators only. `arashouse doctor` reads the home's ACL
(by SID) and warns, `state home`, when it allows anyone else, which a home set with `ARASHOUSE_HOME` somewhere like
`C:\work` would (it inherits `Authenticated Users` from `C:\`). Keep the default.

Run arashouse as the worker user that `arashouse setup` recorded, unelevated, as WSL interop always did: the broker's
token file is the worker user's to read (another account fails `Unreachable`, exit 6), and an elevated process can read
every folder, which `doctor`'s `setup acl` check would then report.

## The WSL launcher

`dist/cli/index.js` in WSL decides, before loading anything else (`src/launcher/applies.ts`): with a Windows Node at
`ARASHOUSE_WINDOWS_NODE` (default `/mnt/c/Program Files/nodejs/node.exe`) and any host but the fake one, it is the
launcher (`src/launcher/launcher.ts`). Without a Windows Node it runs the CLI in WSL, which then cannot reach the broker
(exit 6), as before. `ARASHOUSE_HOST=fake` runs in WSL with its own state (the tests' host).

While WSL's `~/.arashouse/state.json` is still there (the pool's state not moved to Windows), the launcher refuses every
command but `help` and `version` (exit 1, naming the migration below) and starts nothing: the Windows build would see
an empty pool, every slot on the host an orphan (which `prune --yes` would destroy), and the leases held in WSL's state
not held. An `ARASHOUSE_HOME` set on purpose is used as it is.

What crosses to the Windows process, through `WSLENV`:

| variable | as |
|---|---|
| `ARASHOUSE_WSL_DISTRO` | `WSL_DISTRO_NAME`: the Windows side reads the caller's POSIX paths through `\\wsl.localhost\<distro>\` |
| `ARASHOUSE_HOST_ADDR` | yours if set; else the default gateway in NAT mode (`wslinfo --networking-mode`), none when mirrored |
| `ARASHOUSE_MEDIA`, `ARASHOUSE_APKG`, `ARASHOUSE_WINDOWS_GIT`, `ARASHOUSE_LOCAL_ROOT`, `ARASHOUSE_BROKER_TOKEN_FILE`, `LOCALAPPDATA` | the Windows path of the WSL path given |
| `ARASHOUSE_APKG`, when not set | `aras-pkg` on WSL's `PATH`, when it is a link to libs-js's `dist/cli.js` (Windows Node runs it from `\\wsl.localhost`) |
| `ARASHOUSE_CHECKOUT_MEDIA`, when `ARASHOUSE_MEDIA` is not set | the `media/` of the arashouse checkout the launcher runs from (its main checkout's, as the CLI in WSL found it); the Windows side takes it after `ARASHOUSE_MEDIA` and config.json's `"media"` |
| `ARASHOUSE_HOME` | only a folder under `/mnt/<drive>`; one on WSL's disk is refused (exit 2): the pool's state lives on Windows |
| `ARASHOUSE_HOST`, `ARASHOUSE_DEBUG`, `ARASHOUSE_RESET_WORKER`, `ARAS_PKG_ENGINE`, `ARASHOUSE_FAKE_*` | as they are |

The runtime copy: the launcher hashes its build's files (not the source maps) into a 16-character id. The first launch
of a build starts `dist\launcher\windows-entry.js` from `\\wsl.localhost`, which copies `dist\` and `package.json` to
`%LOCALAPPDATA%\arashouse\runtime\<id>\` (a folder of its own, renamed into place, so two first launches end with one
copy) and runs the CLI from there; later launches start it there directly. So the CLI and its reset workers never load a
module through `\\wsl.localhost`, and a `wsl --shutdown` cannot pull one from under them. Runtimes of other builds older
than 14 days are removed when a new one is made. The launcher keeps the Windows `%LOCALAPPDATA%` it asked `cmd.exe` for
in `~/.cache/arashouse/localappdata`.

A start of `node.exe` that WSL's interop could not set up (`<3>WSL (...) ERROR: UtilAcceptVsock...`, tickets 38 and 56)
is tried again, up to three times: the Windows process never ran. Anything the Windows process printed means it ran,
and it is never started twice.

Cost: a launch is a Node start in WSL and a `node.exe` start through interop, about 0.4 to 0.7 s for a `status` here,
against about 0.45 s natively. Host calls themselves are faster than before: in-process on Windows instead of a
`node.exe` per call through interop.

`ARASHOUSE_LAUNCHER=always` launches the Windows build for the fake host too: the launcher's own end-to-end test
(`test/launcher.test.ts`, this host only) runs a fake pool whose state is in a Windows temp folder through it.

## Environment (new and changed)

| variable | effect |
|---|---|
| `ARASHOUSE_HOME` | the state folder; default `%LOCALAPPDATA%\arashouse` on Windows, `~/.arashouse` elsewhere |
| `ARASHOUSE_BROKER_TOKEN_FILE` | where the native transport reads the broker's token instead of `<root>\broker\client.token`; tests point it at a missing file, so "no broker" never reaches this machine's broker |
| `ARASHOUSE_WSL_DISTRO`, `ARASHOUSE_CHECKOUT_MEDIA` | set by the launcher, never by hand |
| `ARASHOUSE_LAUNCHER` | `always`: launch the Windows build for the fake host too (tests) |
| `ARASHOUSE_WINDOWS_NODE` | the launcher's `node.exe` (and the WSL CLI's interop transport), as a WSL path |
| `ARASHOUSE_WINDOWS_GIT` | Git for Windows' `git.exe`; natively a Windows path (default `git.exe` on `PATH`, else `C:\Program Files\Git\cmd\git.exe`) |
| `ARASHOUSE_LOCAL_ROOT` | the install root as the CLI opens it (default `C:\aras_installations` natively) |
| `config.json` `"media"` | the folder holding `<flavor>/` media folders, as an absolute path; after `ARASHOUSE_MEDIA`, before the launcher's checkout's and the build's own checkout's `media/` |

## Build identity and copies sharing one state

Several copies of arashouse share one machine's state and one broker: a checkout's build, the launcher's runtime copy,
a vendored copy. `npm run build` writes `dist/build.json` (the commit, whether the checkout had changes to tracked files,
when). `arashouse version` prints `arashouse 0.0.0 (build <12 hex>[-dirty])`; the broker reports its own build in
`hostInfo`; `doctor` warns (`build`) when the CLI and the broker are different builds, or when the broker is too old to
say, and says how to update it (`arashouse setup`, then `setup-host.ps1 -Apply -UpdateBroker`, elevated).

A copy rewrites `state.json` with only the fields it knows, so any change to them bumps `STATE_VERSION`
(`src/core/state.ts`): an older copy then refuses the file by name ("written by a newer arashouse") instead of dropping
what it does not know. `src/core/state.test.ts` pins the serialiser to the version number, so the bump cannot be missed.

## A vendored copy (aras-mr-envs)

```
npm run vendor -- <dest>          # builds, then copies; <dest> empty, missing, or an earlier vendored copy
```

The payload: `dist/` without source maps, a `package.json` of its own (`"type": "module"`, the version, no scripts or
dependencies; arashouse has no runtime dependencies), `scripts/*.ps1` (setup's), `docs/schemas/*.json` (the contracts of
the JSON output), `media/README.md`, a `README.md` and `VENDORED.json` (the build it is). About 1.3 MB. No source, tests,
`node_modules` or media.

Run it with the caller's own Node 20 or newer, by an absolute path computed from the caller's location, with no shell:
`[process.execPath, <abs>\vendor\arashouse\dist\cli\index.js, ...args]`, unelevated, as the worker user.

- **State:** the machine's (`%LOCALAPPDATA%\arashouse`), shared with every other arashouse there. Do not set
  `ARASHOUSE_HOME`: one pool per machine needs one state.
- **Media:** a copy outside arashouse's checkout never takes the surrounding repository's `media/`; it refuses and says
  so. Set `ARASHOUSE_MEDIA`, or `"media"` in `config.json`. Only `flavors`' media column, `get --restore <profile>`,
  `setup` (which flavors to check), `baseline build` and `media check` need it.
- **Imports:** pass `ARASHOUSE_APKG` (libs-js's `dist\cli.js`), or have libs-js's npm shim `aras-pkg.cmd` on `PATH`
  (its script is run with this Node; Node starts no `.cmd`).
- **The lease's environment:** `env --lease <id> --json` (`docs/schemas/env.schema.json`) instead of
  `run --lease <id> -- printenv`; `run` refuses a `.cmd` or `.bat`.
- **URLs:** `ARAS_URL` is `http://localhost/ah-...`; no address rewrite is needed.
- **Once per machine, still:** `arashouse setup` and `setup-host.ps1 -Apply` (elevated; installs the broker from the
  copy's `dist\`), `setup-sql`, `scripts\store-licence.ps1`, per flavor `baseline build` and `store-ootb-root.ps1`, then
  `provision` (docs/runbook.md, "First-time setup").

## Migrating a pool from WSL's state to Windows

Before this change the state was WSL's `~/.arashouse`. Held leases carry over with their passwords, so the pool need not
be empty, but it should be quiet (no slot `resetting`, no `get --wait` queued), and every WSL caller's `arashouse` must
already be the new build (the launcher): an older WSL build keeps reading WSL's state, and once that is set aside it sees
an empty pool, so a holder using it would find its lease gone.

1. Build the new arashouse and put it where WSL's `arashouse` runs from (the launcher). From that moment the launcher
   refuses every command but `help` and `version` until the state is moved, so do the next step at once.
2. In WSL: `arashouse migrate-state`, a dry run that names the slots and the leases it carries; then
   `arashouse migrate-state --yes`. Under the old state's own lock (which every earlier build takes, so none writes
   meanwhile) it copies `config.json`, `events.log`, `recipes/`, `logs/` and `leases/` to `%LOCALAPPDATA%\arashouse\`,
   `state.json` last, then renames WSL's `state.json` and `leases/` to `*.moved-to-windows-<time>` (never deletes them).
   It refuses a Windows home that already holds a state, and a pool with a reset running or a waiter queued unless
   `--busy-ok` (a WSL reset's slot then reads dead on Windows, goes back to dirty and is reset again). A `config.json`
   `"media"` should name the media's folder if the media moves to Windows.
3. `arashouse doctor`, then `doctor --fix` for anything left dirty. Once the pool works from Windows, delete WSL's
   `*.moved-to-windows-*` copies (the old leases' passwords are in them). The one hazard left is
   `doctor --rebuild-state --yes` from an older WSL build: do not.
4. Optionally, update the broker to the same build: `arashouse setup`, then `setup-host.ps1 -Apply -UpdateBroker`
   (elevated). The CLI works with the installed broker either way (the protocol is unchanged), and `doctor` names the
   difference. Restarting the broker ends any call in flight, so do it when no lane is mid-command.

The fallback when anything is in doubt is the ticket 11 path: drain the pool, natively `doctor --rebuild-state --yes`
and `doctor --fix`; every free slot comes back dirty and is reset (about 46 s each).

## Verification record

On this host (Windows 11, Node 24.13.0 on Windows, WSL 2 Ubuntu, NAT networking), 2026-11-26:

- The whole suite natively under Windows Node (an NTFS mirror of the worktree) and in WSL; CI adds `windows-latest`
  (Node 20 and 22) beside `ubuntu-latest`. The native-only tests: a real child process's beacon read dead the moment it
  is killed and a reused pid not taken for it, a killed holder's lock stolen at once, two processes' 200 updates each
  with none lost on NTFS, a writer replacing `state.json` while readers hold it, the pipe transport against a real named
  pipe, the PowerShell-script tests natively, the state home's ACL read back, and the vendored copy run from outside any
  checkout (`version`, `flavors --json` with its media from `config.json`, `doctor`).
- Broker round trip (`ping`, read-only, against the installed broker): median 3.9 ms natively in-process (20 calls),
  183 ms from WSL through `node.exe` and interop (10 calls).
- The launcher through real interop (`test/launcher.test.ts`): `provision`, `get --json` (the URL with the WSL gateway),
  `run` in WSL with the lease's environment and its exit code passed through, `deploy-code` from a WSL path, `extract
  code --to` a WSL path (a Windows process writes into `\\wsl.localhost` as the worker user), `return`, `status`, on a
  fake pool whose state is on a Windows drive. `status`: about 0.4 to 0.7 s through the launcher, about 0.45 s natively.
- Against the installed broker, natively and read-only (`doctor`, no `--fix`, an empty Windows state): the broker
  answers through the pipe from an unelevated Windows process; `setup acl` passes (the filtered token reads only what
  the worker may); the state home's ACL is the worker user's only; `build` warns that the installed broker (set up
  2026-11-06) is older than build ids; the three baselines verify; the copy outside a checkout finds no media without
  `ARASHOUSE_MEDIA` or `"media"`; and every slot on the host is an orphan of the empty state, which is why the launcher
  refuses until the state is moved.
- Not yet on this host: migrating the live pool and the per-flavor host e2e natively. The pool was not quiet (leases
  held by other lanes), so neither was started; see the procedure above.
